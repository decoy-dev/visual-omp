import { spawn, type ChildProcess } from "node:child_process";
import type { ShellFailureReason } from "@shared/shell-visualization";

const SAMPLE_MS = 1000;
const STOP_MS = 200;
/** The complete close window: acknowledgement within STOP_MS, then the helper's exit within what remains of it. */
const CLOSE_MS = 250;
const LINE_BYTES = 64 * 1024;
const cleanupError = () => new Error("The shell presentation process tree could not be confirmed stopped.");
interface WindowsShellJobOptions {
	powerShell: string;
	script: string;
	config: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	onLoss(reason: ShellFailureReason): void;
}
export interface WindowsShellMemorySample {
	jobRssBytes: number;
	monitorRssBytes: number;
	totalRssBytes: number;
}
export interface WindowsShellJob {
	child: ChildProcess;
	started: Promise<void>;
	sample(): Promise<WindowsShellMemorySample>;
	cancelSample(): void;
	stop(): Promise<void>;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function unsigned(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** Optional evidence fields must agree with the same complete working-set total used by the watchdog. */
function workingSetBreakdown(value: Record<string, unknown>, pids: unknown[]): boolean {
	if (!unsigned(value.helperRssBytes) || value.helperRssBytes === 0 || !unsigned(value.rssBytes) || value.helperRssBytes > value.rssBytes) return false;
	if (pids.length > 256) return value.breakdownOmitted === true && value.memberRssBytes === undefined;
	if (value.breakdownOmitted !== undefined || !Array.isArray(value.memberRssBytes) || value.memberRssBytes.length !== pids.length) return false;
	let total = value.helperRssBytes;
	for (const bytes of value.memberRssBytes) {
		if (!unsigned(bytes) || bytes === 0 || !Number.isSafeInteger(total + bytes)) return false;
		total += bytes;
	}
	return total === value.rssBytes;
}

/** One private native job owner, with no per-sample process launch or PID-targeted termination. */
export function createWindowsShellJob(options: WindowsShellJobOptions): WindowsShellJob {
	const child = spawn(options.powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", options.script, options.config],
		{ cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
	const started = Promise.withResolvers<void>();
	void started.promise.catch(() => {});
	let authorized = false;
	let spawned = false;
	let exited = false;
	let stopping = false;
	let failed = false;
	let sequence = 0;
	let text = "";
	let pending: { id: number; result: PromiseWithResolvers<WindowsShellMemorySample>; deadline: NodeJS.Timeout } | undefined;
	let stopResult: { id: number; result: PromiseWithResolvers<void>; deadline: NodeJS.Timeout; acknowledged: boolean; requestedAt: number } | undefined;
	let stopped: Promise<void> | undefined;
	const cancelSample = () => {
		if (!pending) return;
		clearTimeout(pending.deadline);
		pending.result.reject(new Error("Windows shell sampling cancelled"));
		pending = undefined;
	};
	const fail = (reason: ShellFailureReason) => {
		if (failed || stopping) return;
		failed = true;
		cancelSample();
		started.reject(new Error("Windows shell job unavailable"));
		options.onLoss(reason);
	};
	const finishStop = (confirmed: boolean) => {
		if (!stopResult) return;
		clearTimeout(stopResult.deadline);
		const result = stopResult.result;
		// A delayed event loop can deliver the exit before an overdue deadline timer runs; the elapsed time still decides.
		const inTime = performance.now() - stopResult.requestedAt <= (stopResult.acknowledged ? CLOSE_MS : STOP_MS);
		stopResult = undefined;
		if (confirmed && inTime) result.resolve(); else result.reject(cleanupError());
	};
	const killHelper = () => { try { child.kill("SIGKILL"); } catch { /* Confirmation still requires exit. */ } };
	const pipeFailed = () => {
		if (exited || stopping && !stopResult) return;
		if (!stopping) fail("unavailable");
		else if (!stopResult?.acknowledged) { killHelper(); finishStop(false); }
	};
	const send = (line: string) => {
		try {
			if (!child.stdin || !child.stdin.writable) throw new Error();
			child.stdin.write(line, error => { if (error) pipeFailed(); });
		} catch { pipeFailed(); }
	};
	const receive = (value: unknown) => {
		if (!record(value) || typeof value.event !== "string") { fail("unavailable"); return; }
		if (value.event === "stopped") {
			if (!stopResult || stopResult.acknowledged || value.id !== stopResult.id || !authorized) return;
			// An acknowledgement read after the 200 ms deadline, before its overdue timer ran, is still late.
			if (performance.now() - stopResult.requestedAt > STOP_MS) { killHelper(); finishStop(false); return; }
			stopResult.acknowledged = true;
			clearTimeout(stopResult.deadline);
			// The job is already empty, so only the helper's exit remains; it may use the rest of the close window,
			// which leaves it at least the 50 ms after a 200 ms acknowledgement.
			stopResult.deadline = setTimeout(() => finishStop(false), CLOSE_MS - (performance.now() - stopResult.requestedAt));
			// The job is confirmed empty. Kill only the retained helper process handle.
			killHelper();
			return;
		}
		if (stopping) return;
		if (value.event === "ready") {
			if (authorized || spawned || failed) { fail("unavailable"); return; }
			// This flag precedes the write: after authorization, missing job confirmation fails closed.
			authorized = true;
			send("start\n");
		} else if (value.event === "spawned") {
			if (!authorized || spawned || !unsigned(value.pid) || value.pid === 0 || value.pid === child.pid) { fail("unavailable"); return; }
			spawned = true;
			started.resolve();
		} else if (value.event === "sample") {
			if (!pending || value.id !== pending.id) return;
			if (!unsigned(value.rssBytes) || value.rssBytes === 0 || !Array.isArray(value.pids) || value.pids.length > 4096
				|| value.pids.some(pid => !unsigned(pid) || pid === 0 || pid === child.pid) || new Set(value.pids).size !== value.pids.length
				|| typeof value.cpuMs !== "number" || !Number.isFinite(value.cpuMs) || value.cpuMs < 0 || !workingSetBreakdown(value, value.pids)
				|| !unsigned(value.helperRssBytes) || value.helperRssBytes === 0 || value.helperRssBytes > value.rssBytes) { fail("unavailable"); return; }
			if (!value.pids.length) { fail("crash"); return; }
			clearTimeout(pending.deadline);
			pending.result.resolve({ jobRssBytes: value.rssBytes - value.helperRssBytes, monitorRssBytes: value.helperRssBytes, totalRssBytes: value.rssBytes });
			pending = undefined;
		} else if (value.event === "error") fail("unavailable");
		else fail("unavailable");
	};
	child.stdout?.on("data", (chunk: Buffer | string) => {
		if (exited) return;
		if (Buffer.byteLength(text) + (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength) > LINE_BYTES) { text = ""; fail("unavailable"); return; }
		text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		let newline: number;
		while ((newline = text.indexOf("\n")) >= 0) {
			const line = text.slice(0, newline).trim(); text = text.slice(newline + 1);
			if (!line) continue;
			try { receive(JSON.parse(line)); } catch { fail("unavailable"); }
		}
	});
	child.stdin?.on("error", pipeFailed);
	child.once("error", () => {
		if (!child.pid) exited = true;
		if (!stopping) fail("unavailable");
		else if (exited) finishStop(!authorized || stopResult?.acknowledged === true);
		// A failed helper kill can race its natural exit. The existing exit deadline still applies.
	});
	child.once("exit", () => {
		exited = true;
		if (stopping) finishStop(!authorized || stopResult?.acknowledged === true);
		else fail(spawned ? "crash" : "unavailable");
	});
	return {
		child, started: started.promise, cancelSample,
		sample() {
			if (!spawned || stopping || failed || pending) return Promise.reject(new Error("Windows shell sampling unavailable"));
			const result = Promise.withResolvers<WindowsShellMemorySample>();
			const id = ++sequence;
			pending = { id, result, deadline: setTimeout(() => fail("unavailable"), SAMPLE_MS) };
			send(`sample:${id}\n`);
			return result.promise;
		},
		stop() {
			if (stopped) return stopped;
			stopping = true;
			cancelSample();
			started.reject(new Error("Windows shell job cancelled"));
			const result = Promise.withResolvers<void>();
			stopped = result.promise;
			void stopped.catch(() => {});
			if (exited) { if (authorized) result.reject(cleanupError()); else result.resolve(); return stopped; }
			const id = ++sequence;
			stopResult = { id, result, acknowledged: false, requestedAt: performance.now(), deadline: setTimeout(() => { killHelper(); finishStop(false); }, STOP_MS) };
			if (!authorized) killHelper(); else send(`stop:${id}\n`);
			return stopped;
		},
	};
}
