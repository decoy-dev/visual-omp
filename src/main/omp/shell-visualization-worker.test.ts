import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ShellFailureReason } from "@shared/shell-visualization";
import { createInstalledShellWorker, shellWorkerEnvironment, SHELL_WORKER_LIMITS, ShellWorkerFailure, ShellWorkerRefusal, type ShellPresentationWorker } from "./shell-visualization-worker";
import { SHELL_VISUALIZATION_EXTENSION } from "./shell-visualization-extension";

type FakeChild = EventEmitter & { pid: number; kill: Mock; abort: AbortController };
const state = vi.hoisted(() => ({
	children: [] as FakeChild[], launches: [] as { executable: string; args: string[]; options: SpawnOptions }[],
	mode: "ready" as "ready" | "missing" | "stall" | "startup-stall" | "oversized" | "stale" | "malformed" | "native-unavailable" | "native-too-large" | "invalid-failure", rss: 64 * 1024 * 1024, rssUnavailable: false,
	monitorRss: 16 * 1024 * 1024,
	dispatched: undefined as (() => void) | undefined,
	onLaunch: undefined as (() => void) | undefined,
	requests: [] as Record<string, unknown>[],
	execs: [] as { executable: string; args: string[]; options: Record<string, unknown> }[],
	windowsJobs: [] as { child: FakeChild; sample: Mock; stop: Mock; cancelSample: Mock; onLoss(reason: ShellFailureReason): void }[],
	windowsStopError: false,
	windowsStopGate: undefined as PromiseWithResolvers<void> | undefined,
	windowsStartGate: undefined as PromiseWithResolvers<void> | undefined,
	windowsSample: undefined as (() => Promise<number>) | undefined,
	observePs: undefined as ((callback: (error: Error | null, stdout: string) => void) => void) | undefined,
	psQueries: [] as { kill: Mock }[],
}));
vi.mock("node:child_process", () => ({
	spawn(executable: string, args: string[], options: SpawnOptions) {
		const child = new EventEmitter() as FakeChild;
		child.pid = 910_000 + state.children.length;
		child.abort = new AbortController();
		child.kill = vi.fn(() => { child.abort.abort(); queueMicrotask(() => child.emit("exit", null, "SIGKILL")); return true; });
		state.children.push(child);
		state.launches.push({ executable, args, options });
		state.onLaunch?.();
		queueMicrotask(() => { void emulateExtension(child, options.env!); });
		return child as unknown as ChildProcess;
	},
	execFile(executable: string, args: string[], optionsOrCallback: unknown, maybeCallback?: (error: Error | null, stdout: string) => void) {
		const callback = (maybeCallback ?? optionsOrCallback) as (error: Error | null, stdout: string) => void;
		const child = state.children.at(-1)!;
		const pid = child.pid;
		state.execs.push({ executable, args, options: optionsOrCallback as Record<string, unknown> });
		const query = { kill: vi.fn() };
		state.psQueries.push(query);
		if (state.observePs) { state.observePs(callback); return query; }
		if (state.rssUnavailable) { queueMicrotask(() => callback(new Error("RSS unavailable"), "")); return query; }
		queueMicrotask(() => callback(null, `${pid} ${state.rss / 1024}\n999999 999999999\n`));
		return query;
	},
}));
vi.mock("./shell-visualization-windows", async () => {
	// Vitest evaluates this hoisted mock before the static child-process bindings initialize.
	const { readFileSync } = await import("node:fs");
	const { spawn } = await import("node:child_process");
	return { createWindowsShellJob(options: { config: string; env: NodeJS.ProcessEnv; cwd: string; onLoss(reason: ShellFailureReason): void }) {
		const configuration = JSON.parse(readFileSync(options.config, "utf8")) as { executable: string; args: string[] };
		// This seam emulates the job owner, while the separate protocol suite tests its real transport.
		const child = spawn(configuration.executable, configuration.args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true }) as unknown as FakeChild;
		const job = { child, onLoss: options.onLoss, cancelSample: vi.fn(),
			started: state.windowsStartGate?.promise ?? Promise.resolve(),
			sample: vi.fn(async () => {
				if (state.rssUnavailable) throw new Error("Unknown job RSS");
				const jobRssBytes = state.windowsSample ? await state.windowsSample() : state.rss;
				return { jobRssBytes, monitorRssBytes: state.monitorRss, totalRssBytes: jobRssBytes + state.monitorRss };
			}),
			stop: vi.fn(async () => {
				state.windowsStartGate?.reject(new Error("Cancelled job startup"));
				if (state.windowsStopError) throw new Error("The shell presentation process tree could not be confirmed stopped.");
				if (state.windowsStopGate) await state.windowsStopGate.promise;
				child.kill();
			}),
		};
		state.windowsJobs.push(job);
		return job;
	} };
});

async function emulateExtension(child: FakeChild, env: NodeJS.ProcessEnv): Promise<void> {
	const bridge = env.VOMP_SHELL_PRESENTATION_BRIDGE!;
	const signal = child.abort.signal;
	try {
		if (state.mode === "startup-stall") return;
		await fetch(`${bridge}/ready`, { method: "POST", body: JSON.stringify({ capable: state.mode !== "missing" }), signal });
		if (state.mode === "missing") return;
		for (;;) {
			const response = await fetch(`${bridge}/next`, { signal });
			if (!response.ok) return;
			const request = await response.json() as Record<string, unknown>;
			state.requests.push(request);
			state.dispatched?.();
			if (state.mode === "stall") return;
			if (state.mode === "malformed") { await fetch(`${bridge}/result`, { method: "POST", body: "{broken", signal }); return; }
			if (state.mode === "stale") await fetch(`${bridge}/result`, { method: "POST", body: JSON.stringify({ id: "obsolete-request", data: "stale presentation" }), signal });
			if (state.mode.startsWith("native-") || state.mode === "invalid-failure") {
				await fetch(`${bridge}/result`, { method: "POST", body: JSON.stringify({ id: request.id, failure: state.mode === "invalid-failure" ? "invalid" : state.mode.slice(7) }), signal });
				continue;
			}
			await fetch(`${bridge}/result`, { method: "POST", body: JSON.stringify({ id: request.id, data: state.mode === "oversized" ? "x".repeat(SHELL_WORKER_LIMITS.responseBytes + 1024) : null }), signal });
		}
	} catch { /* The test child exits by closing its private bridge. */ }
}
const executable = process.platform === "win32" ? "C:\\isolated\\omp.exe" : "/isolated/omp";
let workers: ShellPresentationWorker[];
let retainedRoots: string[];
beforeEach(() => {
	state.children = []; state.launches = []; state.requests = []; state.mode = "ready"; state.rss = 64 * 1024 * 1024; state.rssUnavailable = false; state.dispatched = undefined; state.onLaunch = undefined;
	state.monitorRss = 16 * 1024 * 1024;
	state.execs = []; state.windowsJobs = []; state.windowsStopError = false; state.windowsStopGate = undefined; state.windowsStartGate = undefined; state.windowsSample = undefined;
	state.observePs = undefined; state.psQueries = [];
	retainedRoots = [];
	workers = [];
	vi.spyOn(process, "kill").mockImplementation(pid => {
		const child = state.children.find(item => item.pid === Math.abs(pid));
		if (!child) throw new Error("Attempted to terminate an unrelated process");
		child.kill();
		return true;
	});
});
afterEach(async () => {
	for (const worker of workers) await worker.close();
	for (const child of state.children) child.abort.abort();
	for (const root of retainedRoots) await rm(root, { recursive: true, force: true });
	vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function start(onLoss: (reason: ShellFailureReason) => void = () => {}, signal = new AbortController().signal) {
	const worker = await createInstalledShellWorker({ executable: process.platform === "win32" ? "C:\\isolated\\omp.exe" : "/isolated/omp", env: { PATH: "/safe/bin", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "must not reach worker", NODE_OPTIONS: "--require owner-code", PI_CODING_AGENT_DIR: "/owner/agent", HOME: "/owner" }, onLoss, signal });
	workers.push(worker);
	return worker;
}
function expectStopped(child: FakeChild): void {
	expect(child.abort.signal.aborted).toBe(true);
	if (process.platform === "win32") expect(state.windowsJobs.find(job => job.child === child)?.stop).toHaveBeenCalledOnce();
	else expect(child.kill).toHaveBeenCalledOnce();
}

describe("installed omp presentation bridge", () => {
	it("boots the extension before model/session startup with private filesystem roots and an OS-only environment", async () => {
		const worker = await start();
		const launch = state.launches[0]!;
		expect(launch.executable).toBe(executable);
		expect(launch.args).toEqual(expect.arrayContaining(["--no-session", "--no-tools", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-title", "--no-lsp"]));
		expect(launch.args).not.toContain("--model");
		expect(launch.options.stdio).toEqual(["ignore", "ignore", "ignore"]);
		expect(launch.options).not.toHaveProperty("shell");
		expect(launch.options.env).not.toHaveProperty("OPENAI_API_KEY");
		expect(launch.options.env).not.toHaveProperty("NODE_OPTIONS");
		expect(launch.options.env!.HOME).not.toBe("/owner");
		expect(isAbsolute(launch.options.cwd as string)).toBe(true);
		const config = JSON.parse(await readFile(join(launch.options.env!.PI_CODING_AGENT_DIR!, "config.yml"), "utf8"));
		expect(config).toMatchObject({ startup: { setupWizard: false }, update: { auto: false }, memory: { backend: "off" }, recap: { enabled: false }, collab: { autoStart: "off" }, mcp: { enableProjectConfig: false } });
		expect(await worker.request({ op: "release", handle: "opaque" })).toBeNull();
		expect(state.requests).toHaveLength(1);
		await worker.close();
		expectStopped(state.children[0]!);
	});

	it("fails missing native capability without loading a provider or returning raw errors", async () => {
		state.mode = "missing";
		const loss = vi.fn();
		await expect(start(loss)).rejects.toMatchObject({ reason: "unavailable", message: "Shell presentation unavailable" });
		expect(loss).toHaveBeenCalledWith("unavailable");
		expectStopped(state.children[0]!);
		expect(state.requests).toEqual([]);
	});

	it("enforces the parent request deadline while native work is stalled and targets only its child tree", async () => {
		const loss = vi.fn(); const worker = await start(loss);
		state.mode = "stall";
		const dispatched = Promise.withResolvers<void>(); state.dispatched = dispatched.resolve;
		const response = worker.request({ op: "release", handle: "cancel-test" });
		const rejected = expect(response).rejects.toMatchObject({ reason: "timeout" });
		await dispatched.promise;
		// The request timer is native; this test intentionally waits for the production two-second deadline.
		await rejected;
		expect(loss).toHaveBeenCalledWith("timeout");
		await worker.close(); expectStopped(state.children[0]!);
		if (process.platform !== "win32") expect(process.kill).toHaveBeenCalledWith(-state.children[0]!.pid, "SIGKILL");
	}, 5000);

	it("terminates immediately on cancellation, rejects pending work and never accepts a caller pid", async () => {
		const abort = new AbortController(); const loss = vi.fn(); const worker = await start(loss, abort.signal);
		state.mode = "stall";
		const dispatched = Promise.withResolvers<void>(); state.dispatched = dispatched.resolve;
		const response = worker.request({ op: "release", handle: "opaque" });
		const rejected = expect(response).rejects.toMatchObject({ reason: "cancelled" });
		await dispatched.promise;
		abort.abort();
		await rejected;
		await worker.close(); expectStopped(state.children[0]!);
		expect(loss).toHaveBeenCalledWith("cancelled");
	});

	it("rejects startup cancellation before any installed process is launched", async () => {
		const abort = new AbortController(); abort.abort();
		await expect(start(() => {}, abort.signal)).rejects.toMatchObject({ reason: "cancelled" });
		expect(state.launches).toEqual([]);
	});

	it("enforces the production startup deadline without allowing an agent turn", async () => {
		state.mode = "startup-stall";
		const timers = vi.spyOn(globalThis, "setTimeout");
		const launched = Promise.withResolvers<void>(); state.onLaunch = launched.resolve;
		const pending = start();
		const rejected = expect(pending).rejects.toMatchObject({ reason: "timeout" });
		await launched.promise;
		const deadline = timers.mock.calls.find(([, milliseconds]) => milliseconds === SHELL_WORKER_LIMITS.startupMs)?.[0];
		expect(typeof deadline).toBe("function");
		if (typeof deadline === "function") deadline();
		await rejected;
		expect(state.requests).toEqual([]);
		expectStopped(state.children[0]!);
	});

	it("reports child crashes and permits a fresh explicit worker", async () => {
		const loss = vi.fn(); const worker = await start(loss);
		state.children[0]!.abort.abort(); state.children[0]!.emit("exit", 1, null);
		expect(loss).toHaveBeenCalledWith("crash");
		await expect(worker.request({ op: "release", handle: "old" })).rejects.toMatchObject({ reason: "crash" });
		await worker.close();
		const retry = await start();
		expect(await retry.request({ op: "release", handle: "new" })).toBeNull();
		expect(state.children).toHaveLength(2);
	});

	it("samples RSS independently of native progress and refuses memory excess", async () => {
		const loss = Promise.withResolvers<ShellFailureReason>(); const worker = await start(loss.resolve);
		state.rss = SHELL_WORKER_LIMITS.rssBytes + 1024;
		expect(await loss.promise).toBe("memory");
		await expect(worker.request({ op: "release", handle: "old" })).rejects.toMatchObject({ reason: "memory" });
		await worker.close(); expectStopped(state.children[0]!);
	});

	it("refuses concurrent native operations on one process", async () => {
		const worker = await start(); state.mode = "stall";
		const dispatched = Promise.withResolvers<void>(); state.dispatched = dispatched.resolve;
		const response = worker.request({ op: "release", handle: "first" });
		const rejected = expect(response).rejects.toMatchObject({ reason: "cancelled" });
		await dispatched.promise;
		await expect(worker.request({ op: "release", handle: "second" })).rejects.toMatchObject({ reason: "unavailable" });
		await worker.close(); await rejected;
	});

	it("bounds the worker response before parsing or returning presentation data", async () => {
		const loss = vi.fn(); const worker = await start(loss);
		state.mode = "oversized";
		await expect(worker.request({ op: "release", handle: "large" })).rejects.toMatchObject({ reason: "too-large" });
		expect(loss).toHaveBeenCalledWith("too-large");
		await worker.close(); expectStopped(state.children[0]!);
	});

	it("ignores a response for another request id before accepting the current response", async () => {
		const worker = await start();
		state.mode = "stale";
		expect(await worker.request({ op: "release", handle: "current" })).toBeNull();
		expect(state.children[0]!.kill).not.toHaveBeenCalled();
	});

	it("fails closed when the private bridge returns malformed JSON", async () => {
		const loss = vi.fn(); const worker = await start(loss);
		state.mode = "malformed";
		await expect(worker.request({ op: "release", handle: "malformed" })).rejects.toMatchObject({ reason: "unavailable" });
		expect(loss).toHaveBeenCalledWith("unavailable");
		await worker.close(); expectStopped(state.children[0]!);
	});

	it("fails closed when the OS cannot establish the private worker RSS", async () => {
		const loss = Promise.withResolvers<ShellFailureReason>(); const worker = await start(loss.resolve);
		state.rssUnavailable = true;
		expect(await loss.promise).toBe("unavailable");
		await expect(worker.request({ op: "release", handle: "unknown-rss" })).rejects.toMatchObject({ reason: "unavailable" });
		await worker.close(); expectStopped(state.children[0]!);
	});

	it.each(["omp", "relative/omp", "/isolated/omp\0invalid"])("refuses an unsafe executable path before launch (%s)", async path => {
		await expect(createInstalledShellWorker({ executable: path, env: {}, signal: new AbortController().signal, onLoss: () => {} })).rejects.toMatchObject({ reason: "unavailable" });
		expect(state.launches).toEqual([]);
	});

	it.each(["omp.cmd", "omp.bat", "omp.ps1"])("refuses a Windows shell launcher (%s)", async name => {
		vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "win32" : Reflect.get(target, key) }));
		await expect(createInstalledShellWorker({ executable: `C:\\isolated\\${name}`, env: {}, signal: new AbortController().signal, onLoss: () => {} })).rejects.toMatchObject({ reason: "unavailable" });
		expect(state.launches).toEqual([]);
	});

	it("contains only canonical restoration/presentation/release in the production extension", () => {
		expect(SHELL_VISUALIZATION_EXTENSION).toContain("await import('@oh-my-pi/pi-natives')");
		expect(SHELL_VISUALIZATION_EXTENSION).toContain("new Native(request.json)");
		expect(SHELL_VISUALIZATION_EXTENSION).not.toContain("new natives.Shell");
		expect(SHELL_VISUALIZATION_EXTENSION).not.toContain("pi.on(");
		expect(SHELL_VISUALIZATION_EXTENSION).not.toContain("registerProvider");
		expect(SHELL_VISUALIZATION_EXTENSION).not.toContain("op === 'capture'");
	});

	it.each(["unavailable", "too-large"] as const)("refuses native %s per request without losing sibling handles", async reason => {
		const loss = vi.fn(); const worker = await start(loss);
		state.mode = `native-${reason}`;
		const error = await worker.request({ op: "release", handle: "refused" }).catch(error => error);
		expect(error).toBeInstanceOf(ShellWorkerRefusal);
		expect(error).toBeInstanceOf(ShellWorkerFailure);
		expect(error).toMatchObject({ reason });
		expect(loss).not.toHaveBeenCalled();
		expect(state.children[0]!.kill).not.toHaveBeenCalled();
		state.mode = "ready";
		expect(await worker.request({ op: "release", handle: "sibling" })).toBeNull();
	});

	it("treats an unknown result failure as fatal protocol loss", async () => {
		const loss = vi.fn(); const worker = await start(loss); state.mode = "invalid-failure";
		const error = await worker.request({ op: "release", handle: "invalid" }).catch(error => error);
		expect(error).toBeInstanceOf(ShellWorkerFailure);
		expect(error).not.toBeInstanceOf(ShellWorkerRefusal);
		expect(loss).toHaveBeenCalledWith("unavailable");
	});
});

describe("POSIX presentation worker sampling", () => {
	beforeEach(() => {
		vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "darwin" : Reflect.get(target, key) }));
	});

	it("terminates known excessive group RSS immediately without a fallback or counting unrelated groups", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = vi.fn(); const worker = await start(loss);
		const pid = state.children[0]!.pid;
		state.observePs = callback => callback(null, `${pid} ${300 * 1024}\n${pid} ${220 * 1024}\n999999 999999999\n`);
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick();
		expect(loss).toHaveBeenCalledExactlyOnceWith("memory");
		expect(state.psQueries).toHaveLength(1);
		expect(state.execs[0]).toMatchObject({ executable: "/bin/ps", args: ["-axo", "pgid=,rss="], options: { timeout: 1000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 } });
		expect(state.execs[0]!.options).not.toHaveProperty("shell");
		await worker.close(); expectStopped(state.children[0]!);
		expect(process.kill).toHaveBeenCalledWith(-pid, "SIGKILL");
	});

	it.each(["empty", "missing-group", "zero", "error"] as const)("recovers an unknown %s observation with one independent group snapshot", async unknown => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = vi.fn(); const worker = await start(loss);
		const pid = state.children[0]!.pid;
		const callbacks: ((error: Error | null, stdout: string) => void)[] = [];
		state.observePs = callback => callbacks.push(callback);
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick();
		callbacks.shift()!(unknown === "error" ? new Error("Query failed") : null, unknown === "missing-group" ? "999999 999999999\n" : unknown === "zero" ? `${pid} 0\n` : "");
		expect(state.psQueries).toHaveLength(2);
		expect(loss).not.toHaveBeenCalled();
		tick();
		expect(state.psQueries).toHaveLength(2);
		// Both private group members count, while another group's larger RSS does not.
		callbacks.shift()!(null, `${pid} ${32 * 1024}\n${pid} ${32 * 1024}\n999999 999999999\n`);
		expect(loss).not.toHaveBeenCalled();
		expect(state.children[0]!.kill).not.toHaveBeenCalled();
		tick();
		expect(state.psQueries).toHaveLength(3);
		callbacks.shift()!(null, `${pid} ${64 * 1024}\n`);
		expect(await worker.request({ op: "release", handle: "healthy-after-fallback" })).toBeNull();
		expect(loss).not.toHaveBeenCalled();
	});

	it.each(["empty", "error"] as const)("fails closed on an unknown fallback %s without a third observation or trace refusal", async unknown => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = vi.fn(); const worker = await start(loss);
		let observations = 0;
		state.observePs = callback => callback(++observations === 2 && unknown === "error" ? new Error("Fallback failed") : null, "");
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick();
		expect(state.psQueries).toHaveLength(2);
		expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
		const error = await worker.request({ op: "release", handle: "unknown-memory" }).catch(error => error);
		expect(error).toBeInstanceOf(ShellWorkerFailure);
		expect(error).not.toBeInstanceOf(ShellWorkerRefusal);
		expect(error).toMatchObject({ reason: "unavailable" });
		tick();
		expect(state.psQueries).toHaveLength(2);
		await worker.close(); expectStopped(state.children[0]!);
	});

	it("enforces the unchanged memory limit on a successful fallback", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = vi.fn(); const worker = await start(loss);
		const pid = state.children[0]!.pid;
		let observations = 0;
		state.observePs = callback => callback(null, ++observations === 1 ? "" : `${pid} ${SHELL_WORKER_LIMITS.rssBytes / 1024 + 1}\n`);
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick();
		expect(state.psQueries).toHaveLength(2);
		expect(loss).toHaveBeenCalledExactlyOnceWith("memory");
		await worker.close(); expectStopped(state.children[0]!);
	});

	it("bounds both observations and ignores completions after their deadlines", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = vi.fn(); const worker = await start(loss);
		const timers = vi.spyOn(globalThis, "setTimeout");
		const callbacks: ((error: Error | null, stdout: string) => void)[] = [];
		state.observePs = callback => callbacks.push(callback);
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick();
		const firstDeadline = timers.mock.calls.find(([, ms]) => ms === 1000)![0] as () => void;
		firstDeadline();
		expect(state.psQueries[0]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		expect(state.psQueries).toHaveLength(2);
		callbacks[0]!(null, `${state.children[0]!.pid} ${SHELL_WORKER_LIMITS.rssBytes / 1024 + 1}\n`);
		expect(loss).not.toHaveBeenCalled();
		tick();
		expect(state.psQueries).toHaveLength(2);
		const fallbackDeadline = timers.mock.calls.filter(([, ms]) => ms === 1000).at(-1)![0] as () => void;
		fallbackDeadline();
		expect(state.psQueries[1]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		expect(loss).toHaveBeenCalledExactlyOnceWith("unavailable");
		callbacks[1]!(null, `${state.children[0]!.pid} 65536\n`);
		expect(loss).toHaveBeenCalledTimes(1);
		await worker.close(); expectStopped(state.children[0]!);
	});

	it("cancels immediately while fallback is pending and ignores its late completion", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const abort = new AbortController(); const loss = vi.fn(); const worker = await start(loss, abort.signal);
		const callbacks: ((error: Error | null, stdout: string) => void)[] = [];
		state.observePs = callback => callbacks.push(callback);
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick(); callbacks.shift()!(null, "");
		expect(state.psQueries).toHaveLength(2);
		abort.abort();
		expect(loss).toHaveBeenCalledExactlyOnceWith("cancelled");
		expect(state.psQueries[1]!.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
		callbacks.shift()!(null, `${state.children[0]!.pid} ${SHELL_WORKER_LIMITS.rssBytes / 1024 + 1}\n`);
		tick();
		expect(state.psQueries).toHaveLength(2);
		expect(loss).toHaveBeenCalledTimes(1);
		await expect(worker.request({ op: "release", handle: "cancelled-fallback" })).rejects.toMatchObject({ reason: "cancelled" });
		await worker.close(); expectStopped(state.children[0]!);
	});
});

describe("Windows presentation worker job integration", () => {
	beforeEach(() => {
		vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "win32" : Reflect.get(target, key) }));
	});

	it("uses the private job owner and keeps the existing worker startup and memory budgets", async () => {
		const worker = await start();
		const root = join(state.launches[0]!.options.env!.PI_CODING_AGENT_DIR!, "..");
		const configuration = JSON.parse(await readFile(join(root, "monitor.json"), "utf8"));
		expect(configuration).toMatchObject({ executable: "C:\\isolated\\omp.exe", args: expect.arrayContaining(["--no-session", "--no-tools", "-e"]) });
		expect(await readFile(join(root, "monitor.ps1"), "utf8")).toContain("CreateProcessW");
		expect(state.execs).toEqual([]);
		expect(state.windowsJobs).toHaveLength(1);
		await worker.close();
		expect(state.windowsJobs[0]!.stop).toHaveBeenCalledOnce();
		expect(process.kill).not.toHaveBeenCalled();
		await expect(readFile(join(root, "monitor.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each([false, true])("enforces the unchanged aggregate job RSS budget (unknown: %s)", async unknown => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = Promise.withResolvers<ShellFailureReason>(); const worker = await start(loss.resolve);
		state.rss = SHELL_WORKER_LIMITS.rssBytes + 1; state.rssUnavailable = unknown;
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick();
		expect(await loss.promise).toBe(unknown ? "unavailable" : "memory");
		await worker.close();
		expect(state.windowsJobs[0]!.stop).toHaveBeenCalledOnce();
		expect(state.execs).toEqual([]);
	});

	it("awaits empty-job and helper-exit confirmation before removing scratch ownership", async () => {
		const worker = await start();
		const root = join(state.launches[0]!.options.env!.PI_CODING_AGENT_DIR!, "..");
		state.windowsStopGate = Promise.withResolvers<void>();
		const closing = worker.close();
		let settled = false; void closing.then(() => { settled = true; });
		expect(settled).toBe(false);
		expect(await readFile(join(root, "monitor.json"), "utf8")).toContain("omp.exe");
		state.windowsStopGate.resolve();
		await closing;
		await expect(readFile(join(root, "monitor.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("preserves scratch ownership and propagates unconfirmed job cleanup", async () => {
		const worker = await start(); state.windowsStopError = true;
		const root = join(state.launches[0]!.options.env!.PI_CODING_AGENT_DIR!, "..");
		retainedRoots.push(root); workers.splice(workers.indexOf(worker), 1);
		await expect(worker.close()).rejects.toThrow("process tree could not be confirmed stopped");
		await expect(worker.close()).rejects.toThrow("process tree could not be confirmed stopped");
		expect(state.windowsJobs[0]!.stop).toHaveBeenCalledOnce();
		expect(state.children[0]!.kill).not.toHaveBeenCalled();
		expect(await readFile(join(root, "monitor.json"), "utf8")).toContain("omp.exe");
	});

	it("cancels an active sample without accepting late RSS or resuming polling", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const abort = new AbortController(); const loss = vi.fn(); const worker = await start(loss, abort.signal);
		const sample = Promise.withResolvers<number>(); state.windowsSample = () => sample.promise;
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick(); tick();
		expect(state.windowsJobs[0]!.sample).toHaveBeenCalledOnce();
		abort.abort(); await worker.close();
		sample.resolve(SHELL_WORKER_LIMITS.rssBytes + 1); await Promise.resolve();
		tick();
		expect(loss).toHaveBeenCalledExactlyOnceWith("cancelled");
		expect(state.windowsJobs[0]!.cancelSample).toHaveBeenCalled();
		expect(state.windowsJobs[0]!.sample).toHaveBeenCalledOnce();
	});

	it("cancels during helper startup and stops the owned helper before returning", async () => {
		state.windowsStartGate = Promise.withResolvers<void>();
		const abort = new AbortController();
		const launched = Promise.withResolvers<void>(); state.onLaunch = launched.resolve;
		const pending = start(() => {}, abort.signal);
		const rejected = expect(pending).rejects.toMatchObject({ reason: "cancelled" });
		await launched.promise; abort.abort(); await rejected;
		expect(state.windowsJobs[0]!.stop).toHaveBeenCalledOnce();
		expect(state.children[0]!.abort.signal.aborted).toBe(true);
	});

	it("refuses a missing absolute Windows host path before launching any target", async () => {
		await expect(createInstalledShellWorker({ executable: "C:\\isolated\\omp.exe", env: {}, signal: new AbortController().signal, onLoss: () => {} })).rejects.toMatchObject({ reason: "unavailable" });
		expect(state.launches).toEqual([]);
		expect(state.execs).toEqual([]);
	});
});

describe("production extension startup gate", () => {
	it.each(["no-bridge", "ready-fetch", "ready-status", "next-fetch", "next-status", "next-json", "result-fetch", "result-status", "missing-native"] as const)("never settles the factory after %s", async failure => {
		class Native { present() { return "{}"; } }
		const reached = Promise.withResolvers<void>();
		const bridgeFetch = vi.fn(async (url: string) => {
			const path = new URL(url).pathname;
			const atFailure = failure.startsWith(path.slice(1));
			if (atFailure) {
				reached.resolve();
				if (failure.endsWith("fetch")) throw new Error("Bridge disconnected");
				if (failure.endsWith("status")) return { ok: false };
				if (failure.endsWith("json")) return { ok: true, json: async () => { throw new Error("Invalid request"); } };
			}
			if (path === "/ready" && failure === "missing-native") reached.resolve();
			return { ok: true, json: async () => ({ op: "release", handle: "opaque", id: "request" }) };
		});
		// Only the installed-native import is injected; execute the production factory's
		// transport and pending-gate behavior verbatim, without loading omp in this test.
		const factory = new Function("process", "fetch", "Buffer", "nativeModule",
			SHELL_VISUALIZATION_EXTENSION.replace("export default async function", "return async function")
				.replace("await import('@oh-my-pi/pi-natives')", "await nativeModule"))(
			{ env: failure === "no-bridge" ? {} : { VOMP_SHELL_PRESENTATION_BRIDGE: "http://127.0.0.1" } },
			bridgeFetch, Buffer, failure === "missing-native" ? {} : { ShellVisualization: Native },
		) as () => Promise<void>;
		let settled = false;
		void factory().then(() => { settled = true; }, () => { settled = true; });
		if (failure === "no-bridge") await Promise.resolve();
		else await reached.promise;
		for (let turn = 0; turn < 12; turn++) await Promise.resolve();
		expect(settled).toBe(false);
		for (const [url, options] of bridgeFetch.mock.calls as unknown as [string, { timeout?: boolean }][]) {
			expect(options.timeout).toBe(false);
			if (url.endsWith("/next")) expect(options).toEqual({ timeout: false });
		}
		if (failure === "no-bridge") expect(bridgeFetch).not.toHaveBeenCalled();
	});
});

describe("safe presentation environment", () => {
	it("retains only explicit OS values and replaces all user data roots", () => {
		const root = join(process.cwd(), "private-test-root");
		const env = shellWorkerEnvironment({ PATH: "safe", OPENAI_API_KEY: "private", ANTHROPIC_API_KEY: "private", HOME: "owner", USERPROFILE: "owner", PI_CODING_AGENT_DIR: "owner", BUN_OPTIONS: "preload", NODE_OPTIONS: "preload", HTTP_PROXY: "private", OMP_CONFIG: "owner" }, root);
		expect(env.PATH).toBe("safe");
		for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BUN_OPTIONS", "NODE_OPTIONS", "HTTP_PROXY", "OMP_CONFIG"]) expect(env).not.toHaveProperty(key);
		for (const key of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP"]) expect(env[key]).toContain(root);
	});
});

describe("Windows native-tree and fixed-monitor watchdogs", () => {
	beforeEach(() => { vi.stubGlobal("process", new Proxy(process, { get: (target, key) => key === "platform" ? "win32" : Reflect.get(target, key) })); });

	it("keeps a below-limit native tree alive when its separately capped monitor makes the aggregate exceed 512 MiB", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = vi.fn(); const worker = await start(loss);
		state.rss = 500 * 1024 ** 2; state.monitorRss = 150 * 1024 ** 2;
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick(); await Promise.resolve(); await Promise.resolve();
		expect(loss).not.toHaveBeenCalled();
		expect(await worker.request({ op: "release", handle: "separate-budgets" })).toBeNull();
	});

	it("stops the native job and monitor when the monitor alone breaches its explicit cap", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval");
		const loss = Promise.withResolvers<ShellFailureReason>(); const worker = await start(loss.resolve);
		state.rss = 64 * 1024 ** 2; state.monitorRss = SHELL_WORKER_LIMITS.monitorRssBytes + 1;
		const tick = intervals.mock.calls.find(([, ms]) => ms === SHELL_WORKER_LIMITS.sampleMs)![0] as () => void;
		tick(); expect(await loss.promise).toBe("memory");
		await worker.close();
		expect(state.windowsJobs[0]!.stop).toHaveBeenCalledOnce();
	});

	it("retains the exact 512 MiB native-tree and 160 MiB per-window monitor thresholds", () => {
		expect(SHELL_WORKER_LIMITS.rssBytes).toBe(512 * 1024 ** 2);
		expect(SHELL_WORKER_LIMITS.monitorRssBytes).toBe(160 * 1024 ** 2);
	});
});
