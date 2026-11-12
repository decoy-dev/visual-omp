import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import type { ShellFailureReason } from "@shared/shell-visualization";
import type { ShellVizPreferences } from "@shared/tsp/shell";
import { SHELL_VISUALIZATION_EXTENSION } from "./shell-visualization-extension";
import { OMP_DISCOVERY_ISOLATION } from "./discovery-isolation";
import { createWindowsShellJob, type WindowsShellJob } from "./shell-visualization-windows";
import { SHELL_WINDOWS_MONITOR } from "./shell-visualization-windows-source";

export const SHELL_WORKER_LIMITS = { startupMs: 15_000, requestMs: 2_000, rssBytes: 512 * 1024 * 1024, monitorRssBytes: 160 * 1024 * 1024, sampleMs: 100, responseBytes: 2 * 1024 * 1024 } as const;
export class ShellWorkerFailure extends Error {
	constructor(readonly reason: ShellFailureReason) { super(`Shell presentation ${reason}`); }
}
/** A native or response-shape refusal affects one request; the bridge remains usable. */
export class ShellWorkerRefusal extends ShellWorkerFailure {}
export type ShellWorkerRequest = { op: "restore"; handle: string; json: string }
	| { op: "present"; handle: string; options: ShellVizPreferences & { cursorSeq?: number } }
	| { op: "release"; handle: string };
export interface ShellPresentationWorker {
	request(request: ShellWorkerRequest): Promise<unknown>;
	close(): Promise<void>;
}
export interface InstalledShellWorkerOptions {
	executable: string;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal;
	onLoss(reason: ShellFailureReason): void;
}

/** Explicit OS/runtime allowlist. No provider keys, proxy config, preload hooks or ambient omp settings. */
export function shellWorkerEnvironment(source: NodeJS.ProcessEnv, root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	const allowed: Record<string, true> = { PATH: true, SYSTEMROOT: true, WINDIR: true, COMSPEC: true, PATHEXT: true, LANG: true, LC_ALL: true, LC_CTYPE: true, TZ: true };
	for (const [key, value] of Object.entries(source)) if (Object.hasOwn(allowed, key.toUpperCase()) && value !== undefined) env[key.toUpperCase()] = value;
	return { ...env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
		XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
		XDG_RUNTIME_DIR: join(root, "runtime"), APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "data"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
		NO_COLOR: "1", TERM: "dumb", CI: "1" };
}

/** Node-only production seam. The caller supplies the existing omp locator's result and environment. */
export async function createInstalledShellWorker(options: InstalledShellWorkerOptions): Promise<ShellPresentationWorker> {
	// Never pass a batch file through cmd.exe. Native installers provide omp.exe; shell launchers fail closed.
	if (!(process.platform === "win32" ? win32.isAbsolute(options.executable) : isAbsolute(options.executable)) || options.executable.includes("\0") || (process.platform === "win32" && !/\.(exe|com)$/i.test(options.executable))) throw new ShellWorkerFailure("unavailable");
	const root = await mkdtemp(join(tmpdir(), "vomp-shell-presentation-"));
	const env = shellWorkerEnvironment(options.env, root);
	let child: ChildProcess | undefined;
	let windowsJob: WindowsShellJob | undefined;
	let next: ServerResponse | undefined;
	let outgoing: string | undefined;
	let pending: { id: string; resolve(value: unknown): void; reject(error: ShellWorkerFailure): void; timer?: NodeJS.Timeout } | undefined;
	let closed = false;
	let exited = false;
	let loss: ShellFailureReason | undefined;
	let sample: NodeJS.Timeout | undefined;
	let sampling = false;
	let cancelSample: (() => void) | undefined;
	let startup: NodeJS.Timeout | undefined;
	const ready = Promise.withResolvers<void>();
	// Cancellation can precede the first await of startup readiness.
	void ready.promise.catch(() => {});
	let cleanupPromise: Promise<void> | undefined;
	let terminationPromise: Promise<void> | undefined;
	const childExit = Promise.withResolvers<void>();
	const token = randomUUID();
	const server = createServer(async (request, response) => {
		if (closed || !request.url?.startsWith(`/${token}/`)) { response.writeHead(404).end(); return; }
		const path = request.url.slice(token.length + 1);
		if (path === "/next" && request.method === "GET") {
			if (next) { response.writeHead(409).end(); return; }
			next = response;
			response.on("close", () => { if (next === response) next = undefined; });
			dispatch();
			return;
		}
		if (request.method !== "POST" || (path !== "/ready" && path !== "/result")) { response.writeHead(404).end(); return; }
		try {
			let bytes = 0;
			const chunks: Buffer[] = [];
			for await (const chunk of request) {
				bytes += chunk.length;
				if (bytes > SHELL_WORKER_LIMITS.responseBytes + 1024) { response.writeHead(413).end(); fail("too-large"); return; }
				chunks.push(Buffer.from(chunk));
			}
			const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!value || typeof value !== "object") throw new Error();
			if (path === "/ready") {
				if (!("capable" in value) || value.capable !== true) fail("unavailable");
				else { clearTimeout(startup); ready.resolve(); }
			} else if ("id" in value && value.id === pending?.id) {
				const item = pending!;
				pending = undefined;
				clearTimeout(item.timer);
				if ("failure" in value && (value.failure === "too-large" || value.failure === "unavailable")) item.reject(new ShellWorkerRefusal(value.failure));
				else if (!("failure" in value) && "data" in value) item.resolve(value.data);
				else { item.reject(new ShellWorkerFailure("unavailable")); fail("unavailable"); }
			}
			response.end("{}");
		} catch { response.writeHead(400).end(); fail("unavailable"); }
	});

	function dispatch(): void {
		if (!next || !outgoing || !pending || closed) return;
		// The parent deadline is already armed before handing work to the long poll.
		const response = next;
		next = undefined;
		const json = outgoing;
		outgoing = undefined;
		response.end(json);
	}
	function terminate(): Promise<void> {
		if (terminationPromise) return terminationPromise;
		const stopped = Promise.withResolvers<void>();
		terminationPromise = stopped.promise;
		// Failure can precede the caller's awaited cleanup, including during startup.
		void terminationPromise.catch(() => {});
		clearInterval(sample);
		cancelSample?.();
		cancelSample = undefined;
		if (!child?.pid) { stopped.resolve(); return terminationPromise; }
		const target = child;
		if (process.platform === "win32") {
			if (!windowsJob) stopped.reject(new Error("The shell presentation process tree could not be confirmed stopped."));
			else void windowsJob.stop().then(stopped.resolve, stopped.reject);
		} else {
			try { process.kill(-target.pid!, "SIGKILL"); } catch { try { target.kill("SIGKILL"); } catch {} }
			stopped.resolve();
		}
		return terminationPromise;
	}
	function cleanup(): Promise<void> {
		cleanupPromise ??= (async () => {
			clearTimeout(startup);
			clearInterval(sample);
			cancelSample?.();
			cancelSample = undefined;
			next?.end();
			next = undefined;
			server.closeAllConnections();
			const stopped = Promise.withResolvers<void>();
			server.close(() => stopped.resolve());
			await stopped.promise;
			await terminate();
			// Windows confirmation already includes the helper's exit and the empty native job.
			if (child && !exited && process.platform !== "win32") {
				const stopped = Promise.withResolvers<void>();
				const deadline = setTimeout(stopped.resolve, 250);
				void childExit.promise.then(() => { clearTimeout(deadline); stopped.resolve(); });
				await stopped.promise;
			}
			await rm(root, { recursive: true, force: true }).catch(() => {});
		})();
		return cleanupPromise;
	}
	function fail(reason: ShellFailureReason): void {
		if (closed) return;
		closed = true;
		loss = reason;
		void terminate().catch(() => {});
		clearTimeout(pending?.timer);
		pending?.reject(new ShellWorkerFailure(reason));
		pending = undefined;
		ready.reject(new ShellWorkerFailure(reason));
		options.onLoss(reason);
		if (child) void cleanup().catch(() => {});
	}
	const abort = (): void => fail("cancelled");
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		await Promise.all(["home", "agent", "config", "cache", "data", "state", "runtime", "tmp", "work"].map(name => mkdir(join(root, name), { mode: 0o700 })));
		const extension = join(root, "presentation.mjs");
		const config = join(root, "agent", "config.yml");
		await writeFile(extension, SHELL_VISUALIZATION_EXTENSION, { mode: 0o600 });
		await writeFile(config, JSON.stringify({ ...OMP_DISCOVERY_ISOLATION, startup: { setupWizard: false }, update: { auto: false }, recap: { enabled: false }, memory: { backend: "off" }, autolearn: { enabled: false },
			collab: { autoStart: "off" }, gc: { autoCompress: false }, skills: { enabled: false }, lsp: { enabled: false } }), { mode: 0o600 });
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", listening.reject); listening.resolve(); });
		await listening.promise;
		if (options.signal.aborted || closed) throw new ShellWorkerFailure("cancelled");
		const address = server.address();
		if (!address || typeof address === "string") throw new ShellWorkerFailure("unavailable");
		env.VOMP_SHELL_PRESENTATION_BRIDGE = `http://127.0.0.1:${address.port}/${token}`;
		const args = ["--mode", "rpc", "--no-session", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-lsp", "--no-title", "--no-tools", "-e", extension];
		startup = setTimeout(() => fail("timeout"), SHELL_WORKER_LIMITS.startupMs);
		if (process.platform === "win32") {
			const windows = env.SYSTEMROOT ?? env.WINDIR;
			if (!windows || !win32.isAbsolute(windows)) throw new ShellWorkerFailure("unavailable");
			const script = join(root, "monitor.ps1");
			const monitorConfig = join(root, "monitor.json");
			await Promise.all([writeFile(script, SHELL_WINDOWS_MONITOR, { mode: 0o600 }), writeFile(monitorConfig, JSON.stringify({ executable: options.executable, args, cwd: join(root, "work") }), { mode: 0o600 })]);
			if (closed || options.signal.aborted) throw new ShellWorkerFailure("cancelled");
			windowsJob = createWindowsShellJob({ powerShell: win32.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), script, config: monitorConfig, cwd: join(root, "work"), env, onLoss: fail });
			child = windowsJob.child;
			child.once("exit", () => { exited = true; childExit.resolve(); });
			await windowsJob.started;
		} else {
			child = spawn(options.executable, args, { cwd: join(root, "work"), env, stdio: ["ignore", "ignore", "ignore"], detached: true, windowsHide: true });
			child.once("error", () => { exited = true; childExit.resolve(); fail("unavailable"); });
			child.once("exit", () => { exited = true; childExit.resolve(); fail("crash"); });
		}
		// Sample outside the native event loop, so a synchronous native stall cannot defeat the watchdog.
		sample = setInterval(() => {
			if (sampling || closed || !child?.pid || exited) return;
			sampling = true;
			const pid = child.pid;
			const observed = (bytes: number | undefined): void => {
				sampling = false;
				if (closed || exited) return;
				if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) fail("unavailable");
				else if (bytes > SHELL_WORKER_LIMITS.rssBytes) fail("memory");
			};
			if (process.platform === "linux" || process.platform === "darwin") {
				// A POSIX executable may be a launcher. Count the private process group, including its native child.
				const observeGroup = (fallback: boolean): void => {
					let finished = false;
					let query: ChildProcess | undefined;
					const finish = (error: Error | null, stdout: string): void => {
						if (finished) return;
						finished = true;
						clearTimeout(deadline);
						cancelSample = undefined;
						if (closed || exited) { sampling = false; return; }
						let bytes = 0;
						if (!error) for (const row of stdout.matchAll(/^\s*(\d+)\s+(\d+)\s*$/gm)) if (Number(row[1]) === pid) bytes += Number(row[2]) * 1024;
						const known = !error && Number.isFinite(bytes) && bytes > 0;
						// Empty/error observations are unknown, never zero RSS. Require one
						// fresh OS snapshot before failing closed, without overlapping samples.
						if (!known && !fallback) observeGroup(true);
						else observed(known ? bytes : undefined);
					};
					const stop = (): void => {
						try { query?.kill("SIGKILL"); } catch {}
					};
					const deadline = setTimeout(() => {
						stop();
						finish(new Error("Process sampling timed out"), "");
					}, 1000);
					cancelSample = () => { finished = true; clearTimeout(deadline); stop(); sampling = false; };
					try {
						query = execFile("/bin/ps", ["-axo", "pgid=,rss="], { timeout: 1000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, finish);
					} catch { finish(new Error("Process sampling failed"), ""); }
				};
				observeGroup(false);
			} else if (process.platform === "win32" && windowsJob) {
				const job = windowsJob;
				cancelSample = () => { job.cancelSample(); sampling = false; };
				void job.sample().then(memory => {
					cancelSample = undefined;
					if (closed || exited) { sampling = false; return; }
					if (memory.monitorRssBytes > SHELL_WORKER_LIMITS.monitorRssBytes) { sampling = false; fail("memory"); }
					else observed(memory.jobRssBytes);
				}, () => {
					cancelSample = undefined;
					observed(undefined);
				});
			} else observed(undefined);
		}, SHELL_WORKER_LIMITS.sampleMs);
		sample.unref();
		await ready.promise;
		return {
			async request(request) {
				if (closed) throw new ShellWorkerFailure(loss ?? "crash");
				if (pending) throw new ShellWorkerFailure("unavailable");
				const item = Promise.withResolvers<unknown>();
				const id = randomUUID();
				pending = { id, resolve: item.resolve, reject: item.reject, timer: setTimeout(() => fail("timeout"), SHELL_WORKER_LIMITS.requestMs) };
				outgoing = JSON.stringify({ ...request, id });
				dispatch();
				return item.promise;
			},
			async close() {
				options.signal.removeEventListener("abort", abort);
				if (!closed) {
					closed = true;
					void terminate().catch(() => {});
					clearTimeout(pending?.timer);
					pending?.reject(new ShellWorkerFailure("cancelled"));
					pending = undefined;
					ready.reject(new ShellWorkerFailure("cancelled"));
				}
				await cleanup();
			},
		};
	} catch (error) {
		if (!closed) fail(error instanceof ShellWorkerFailure ? error.reason : "unavailable");
		// Observe bootstrap rejection even when setup failed before awaiting ready.
		await ready.promise.catch(() => {});
		options.signal.removeEventListener("abort", abort);
		await cleanup();
		throw new ShellWorkerFailure(loss ?? "unavailable");
	}
}
