import { execFile } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { IPty, spawn as spawnPty } from "node-pty";
import type { TspEvent } from "../../../shared/tsp";
import { walkNodes } from "../../../shared/tsp/view-state";
import { composerFacts } from "./composer";
import { encodeTspJson } from "./encode";
import { TspSession } from "./session";
import { TspStream } from "./stream";

export type WindowsFraming = "apc" | "osc877";
export interface WindowsProbeResult {
	useConptyDll: boolean;
	framing: WindowsFraming;
	status: "running" | "complete";
	hello: boolean;
	frames: number;
	acks: number;
	edit: boolean;
	send: boolean;
	error?: string;
	cleanupErrors: string[];
	traffic: { direction: "in" | "out"; base64: string; at: number }[];
	trafficTruncated?: boolean;
}

// Per probe: 20s work + two 2s cleanup waits. Coordinator: two 30s subprocesses.
// Live and packaged parents allow 90s; Vitest allows 100s.
const PROBE_TIMEOUT_MS = 20_000;
const CHILD_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 2_000;

function diagnostic(error: unknown): string {
	return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 8192);
}

async function bounded<T>(work: Promise<T>, timeout: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = Promise.withResolvers<never>();
	timer = setTimeout(() => expired.reject(new Error(label)), Math.max(1, timeout));
	try { return await Promise.race([work, expired.promise]); }
	finally { clearTimeout(timer); }
}

type ProbeDependencies = {
	spawn?: typeof spawnPty;
	mkdir?: typeof mkdir;
	rm?: typeof rm;
	timeoutMs?: number;
	cleanupTimeoutMs?: number;
};

/** Each child writes an initial snapshot, a traffic journal, and snapshots before and after cleanup. */
export async function runWindowsProbe(bin: string, useConptyDll: boolean, framing: WindowsFraming, destination: string, deps: ProbeDependencies = {}): Promise<WindowsProbeResult> {
	const result: WindowsProbeResult = { useConptyDll, framing, status: "running", hello: false, frames: 0, acks: 0, edit: false, send: false, cleanupErrors: [], traffic: [] };
	await mkdir(dirname(resolve(destination)), { recursive: true });
	const persist = () => writeFileSync(destination, JSON.stringify(result));
	persist();
	const deadline = Date.now() + (deps.timeoutMs ?? PROBE_TIMEOUT_MS);
	const cleanupTimeout = deps.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS;
	let root: string | undefined;
	let child: IPty | undefined;
	let exited = false;
	let recordedBytes = 0;
	const exit = Promise.withResolvers<void>();
	const record = (direction: "in" | "out", bytes: Buffer) => {
		recordedBytes += bytes.length;
		if (recordedBytes > 8 * 1024 * 1024) { result.trafficTruncated = true; return; }
		const entry = { direction, base64: bytes.toString("base64"), at: Date.now() };
		// Synchronous append retains complete records even if the parent kills this process.
		appendFileSync(`${destination}.traffic.jsonl`, `${JSON.stringify(entry)}\n`);
		result.traffic.push(entry);
	};
	const write = (data: string) => {
		const apc = data.replaceAll("\x1b]877;tsp;", "\x1b_tsp;");
		const framed = framing === "osc877" ? apc.replaceAll("\x1b_tsp;", "\x1b]877;tsp;") : apc;
		record("in", Buffer.from(framed));
		child!.write(framed);
	};
	const session = new TspSession({ cols: 110, dark: false, reduceMotion: true, write,
		onError: error => { result.error ??= diagnostic(error); } });
	let queries = "";
	const stream = new TspStream({ onMessage: message => {
		if (message.verb === "q") result.hello = true;
		if (message.verb === "f") result.frames++;
		session.receive(message);
	}, onData: data => {
		queries += data.toString("utf8");
		if (queries.includes("\x1b[c")) { session.terminalReply("\x1b[?62;22c"); queries = queries.replaceAll("\x1b[c", ""); }
		if (queries.includes("\x1b[6n")) { session.terminalReply("\x1b[1;1R"); queries = queries.replaceAll("\x1b[6n", ""); }
		queries = queries.slice(-16);
	} });
	const outgoing = new TspStream({ onMessage: message => {
		if (message.verb === "e" && JSON.parse(message.body).ev === "ack") result.acks++;
	}, onData: () => { /* Terminal replies are recorded but are not protocol credits. */ } });
	const until = async (predicate: () => boolean, label: string) => {
		while (!predicate()) {
			if (exited || Date.now() >= deadline) throw new Error(`${label}; hello=${result.hello}, frames=${result.frames}`);
			await sleep(20);
		}
	};
	try {
		await bounded((async () => {
			root = await mkdtemp(join(tmpdir(), "vomp-windows-tsp-"));
			const home = join(root, "home");
			const agent = join(root, "agent");
			await Promise.all([(deps.mkdir ?? mkdir)(home), (deps.mkdir ?? mkdir)(agent)]);
			await writeFile(join(agent, "config.yml"), JSON.stringify({
				startup: { setupWizard: false, checkUpdate: false, changelogMode: "hidden", quiet: true },
				marketplace: { autoUpdate: "off" }, worktree: { onStart: "off", onExit: "keep" },
				autocomplete: { enabled: false }, recap: { enabled: false }, composer: { predictions: false },
			}));
		})(), deadline - Date.now(), "Profile setup exceeded the probe deadline");
		const home = join(root!, "home");
		const agent = join(root!, "agent");
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/i.test(key)) env[key] = value;
		}
		Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"),
			LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
			PI_CODING_AGENT_DIR: agent, PI_CONFIG_DIR: agent, TERM_PROGRAM: "tern", TERM: "xterm-256color",
			COLORTERM: "truecolor", OMP_SKIP_SETUP: "1" });
		let nativeSpawn = deps.spawn;
		if (!nativeSpawn) {
			// node-pty exposes this runtime API from the selected native installation.
			const native: { spawn: typeof spawnPty } = createRequire(import.meta.url)(process.env.VOMP_NODE_PTY ?? "node-pty");
			nativeSpawn = native.spawn;
		}
		child = nativeSpawn(bin, ["--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--session-dir", join(root!, "sessions")],
			{ name: "xterm-256color", cols: 110, rows: 32, cwd: root!, env, encoding: null, useConptyDll });
		child.onData(data => {
			try { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data); record("out", bytes); stream.push(bytes); }
			catch (error) { result.error ??= diagnostic(error); }
		});
		child.onExit(() => { exited = true; exit.resolve(); });
		await until(() => result.hello && composerFacts(session.snapshot().surfaces).sendable, "No ready TSP editor");
		const send = async (event: TspEvent) => {
			const encoded = encodeTspJson("e", event, undefined, 48);
			for (const part of encoded.match(/[^]*?\x1b\\/g) ?? []) {
				if (Date.now() >= deadline) throw new Error("Chunked input exceeded the probe deadline");
				write(part); await sleep(5);
			}
		};
		const text = `Windows ${framing} café 漢字 😀 ` + "é日本語🙂".repeat(12);
		let facts = composerFacts(session.snapshot().surfaces);
		await send({ ev: "edit", sf: facts.surfaceId!, id: facts.editorId!, from: 0, to: facts.text.length, text, cursor: text.length, len: facts.text.length });
		await until(() => composerFacts(session.snapshot().surfaces).text === text, "Chunked non-ASCII edit was not reflected exactly");
		result.edit = true;
		facts = composerFacts(session.snapshot().surfaces);
		await send({ ev: "send", sf: facts.surfaceId!, id: facts.editorId!, text: `/rename ${text}` });
		await until(() => session.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "toast" && node.p?.text === `Session renamed to "${text}".`)), "Chunked non-ASCII send did not rename the session exactly");
		result.send = true;
		await bounded(session.drain(), deadline - Date.now(), "Protocol writes exceeded the probe deadline");
	} catch (error) {
		result.error = diagnostic(error);
	} finally {
		try {
			for (const entry of result.traffic) if (entry.direction === "in") outgoing.push(Buffer.from(Buffer.from(entry.base64, "base64").toString().replaceAll("\x1b]877;tsp;", "\x1b_tsp;")));
		} catch (error) { result.error ??= diagnostic(error); }
		persist();
		try {
			if (child && !exited) { child.kill(); await bounded(exit.promise, cleanupTimeout, "PTY exit was not observed after kill"); }
		} catch (error) { result.cleanupErrors.push(diagnostic(error)); }
		persist();
		try { if (root) await bounded((deps.rm ?? rm)(root, { recursive: true, force: true }), cleanupTimeout, "Profile cleanup timed out"); }
		catch (error) { result.cleanupErrors.push(diagnostic(error)); }
		result.status = "complete";
		persist();
	}
	return result;
}

interface ProbeRunOptions {
	bin: string;
	destination: string;
	system: boolean;
	executable?: string;
	entry?: string;
	childTimeoutMs?: number;
}

/** One subprocess per framing ensures an APC crash, cleanup error or timeout cannot skip OSC. */
export async function runWindowsProbes(options: ProbeRunOptions) {
	const results: WindowsProbeResult[] = [];
	const report = { platform: process.platform, arch: process.arch, node: process.versions, nodePty: process.env.VOMP_NODE_PTY ?? "node-pty", results };
	await mkdir(dirname(resolve(options.destination)), { recursive: true });
	const persist = () => writeFileSync(options.destination, JSON.stringify(report, null, 2));
	persist();
	for (const framing of options.system ? ["apc"] as const : ["apc", "osc877"] as const) {
		const destination = `${options.destination}.${framing}.json`;
		const done = Promise.withResolvers<{ error: Error | null; stdout: string; stderr: string }>();
		execFile(options.executable ?? process.execPath, [options.entry ?? fileURLToPath(import.meta.url), "--probe", framing, ...(options.system ? ["--system"] : [])], {
			env: { ...process.env, OMP_BIN: options.bin, VOMP_TSP_WINDOWS_REPORT: destination },
			timeout: options.childTimeoutMs ?? CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024,
		}, (error, stdout, stderr) => done.resolve({ error, stdout, stderr }));
		const output = await done.promise;
		let result: WindowsProbeResult;
		try { result = JSON.parse(await readFile(destination, "utf8")); }
		catch (error) {
			result = { useConptyDll: !options.system, framing, status: "running", hello: false, frames: 0, acks: 0, edit: false, send: false, cleanupErrors: [], traffic: [],
				error: `No readable probe report: ${diagnostic(error)}` };
		}
		if (output.error) result.error = [result.error, `Probe subprocess: ${diagnostic(output.error)}; stdout=${output.stdout.slice(0, 4096)}; stderr=${output.stderr.slice(0, 4096)}`].filter(Boolean).join("\n");
		if (result.status !== "complete") result.error ??= "Probe subprocess ended without a completed report; consult its traffic journal.";
		results.push(result);
		persist();
	}
	return report;
}

/** Preserve the subprocess failure when startup or timeout prevented a completed report. */
export async function readWindowsProbeReport(path: string, output: { error: Error | null; stdout: string; stderr: string }) {
	const details = `${output.error ? diagnostic(output.error) : "Probe subprocess exited successfully"}\nstdout=${output.stdout.slice(0, 4096)}\nstderr=${output.stderr.slice(0, 4096)}\nReport: ${path}`;
	let evidence;
	try { evidence = JSON.parse(await readFile(path, "utf8")); }
	catch (error) { throw new Error(`${details}\nNo readable completed report: ${diagnostic(error)}`); }
	if (output.error) throw new Error(`${details}\nProbe errors: ${JSON.stringify(evidence.results?.map((result: WindowsProbeResult) => result.error)).slice(0, 8192)}`);
	if (!Array.isArray(evidence.results) || evidence.results.some((result: WindowsProbeResult) => result.status !== "complete")) {
		throw new Error(`${details}\nNo completed probe report; partial captures remain in the evidence directory.`);
	}
	return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.platform !== "win32") throw new Error("The Windows TSP probe requires Windows.");
	const bin = process.env.OMP_BIN;
	const destination = process.env.VOMP_TSP_WINDOWS_REPORT;
	if (!bin || !destination) throw new Error("OMP_BIN and VOMP_TSP_WINDOWS_REPORT are required.");
	const system = process.argv.includes("--system");
	const probeArg = process.argv.indexOf("--probe");
	if (probeArg !== -1) {
		const framing = process.argv[probeArg + 1];
		if (framing !== "apc" && framing !== "osc877") throw new Error(`Invalid probe framing: ${framing}`);
		await runWindowsProbe(resolve(bin), !system, framing, destination);
	} else {
		const report = await runWindowsProbes({ bin: resolve(bin), system, destination });
		console.log(JSON.stringify(report.results.map(({ traffic, ...result }) => ({ ...result, trafficChunks: traffic.length }))));
		if (!system && report.results.some(result => result.status !== "complete" || !result.hello || !result.frames || !result.acks || !result.edit || !result.send || result.error || result.cleanupErrors.length)) process.exitCode = 1;
	}
}
