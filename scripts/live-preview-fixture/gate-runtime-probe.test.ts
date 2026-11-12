import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type * as WorkerThreads from "node:worker_threads";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createGateRuntimeProbe, type GateRuntimeProbe, type GateRuntimeProbeVersion } from "./gate-runtime-probe.mjs";

const roots: string[] = [];
const probes: GateRuntimeProbe[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(probes.splice(0).map(probe => probe.stop()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "vomp-gate-probe-test-"));
	roots.push(root);
	const files = [join(root, "worker.mjs"), join(root, "omp.exe")];
	const contents = [Buffer.from("export const fixture = true;\n"), Buffer.from([0, 255, 128, 65, 13, 10])];
	await Promise.all(files.map((file, index) => writeFile(file, contents[index]!)));
	const probe = await createGateRuntimeProbe(files);
	probes.push(probe);
	return { files, contents, probe };
}

it("hashes exact file bytes on an isolated thread and retains an independent clock", async () => {
	const { probe, contents } = await fixture();
	for (let index = 0; index < contents.length; index++) expect(await probe.hash(index)).toBe(createHash("sha256").update(contents[index]!).digest("hex"));
	await sleep(65);
	const stopping = probe.stop();
	expect(probe.stop()).toBe(stopping);
	const result = await stopping;
	expect(result.hashExecutionThread).toBe("worker");
	expect(result.inheritedEnvironmentKeys).toBe(0);
	expect(result.inheritedExecArgv).toEqual([]);
	expect(result.threadStopped).toBe(true);
	expect(result.ticks).toBeGreaterThan(0);
	expect(result.timeOrigin).toBeGreaterThan(0);
	expect(result.stoppedAt).toBeGreaterThanOrEqual(result.startedAt);
	expect(result.gaps.length).toBeLessThanOrEqual(result.recordLimit);
	expect(result.hashes.map(row => row.bytes)).toEqual(contents.map(value => value.length));
	expect(result.hashes.every(row => row.threadCpuMs === null || row.threadCpuMs >= 0)).toBe(true);
	await expect(probe.hash(0)).rejects.toThrow("Invalid gate runtime probe hash request");
});

it("refuses invalid file selectors without closing the diagnostic thread", async () => {
	const { probe } = await fixture();
	await expect(probe.hash(-1)).rejects.toThrow("Invalid gate runtime probe hash request");
	await expect(probe.hash(2)).rejects.toThrow("Invalid gate runtime probe hash request");
	await expect(probe.hash(0.5)).rejects.toThrow("Invalid gate runtime probe hash request");
	expect(await probe.hash(0)).toMatch(/^[0-9a-f]{64}$/);
});

it("rejects an oversized sparse file before reading its contents", async () => {
	const { files, probe } = await fixture();
	const file = await open(files[1]!, "w");
	try { await file.truncate(512 * 1024 * 1024 + 1); } finally { await file.close(); }
	await expect(probe.hash(1)).rejects.toThrow("Preflight file exceeds the probe limit");
	expect((await probe.stop()).hashes).toEqual([]);
});

it("reports a file failure and still confirms diagnostic-thread shutdown", async () => {
	const { files, probe } = await fixture();
	await rm(files[1]!);
	await expect(probe.hash(1)).rejects.toThrow();
	expect((await probe.stop()).threadStopped).toBe(true);
});

it("rejects an invalid fixture file list before creating a worker", async () => {
	await expect(createGateRuntimeProbe([])).rejects.toThrow("Invalid gate probe files");
});

async function executableFixture(body: string) {
	const root = await mkdtemp(join(tmpdir(), "vomp-gate-version-test-"));
	roots.push(root);
	const executable = join(root, "version-fixture");
	await writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
	const probe = await createGateRuntimeProbe([executable, executable]);
	probes.push(probe);
	return { root, executable, probe };
}

const posixExecutableUnavailable = process.platform === "win32" || process.execPath.includes(" ");
async function hangingFixture() {
	const fixture = await executableFixture(`
const fs = require("node:fs");
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.READY + ".tmp", JSON.stringify({ pid: process.pid }));
fs.renameSync(process.env.READY + ".tmp", process.env.READY);
process.stdin.resume();
`);
	const ready = join(fixture.root, "ready.json");
	return { ...fixture, ready, options: { env: { READY: ready }, cwd: fixture.root } };
}
async function childStarted(path: string) {
	// The native child has no Vitest clock; wait for its startup file before cancellation.
	const until = Date.now() + 5000;
	while (Date.now() < until) {
		try { return JSON.parse(await readFile(path, "utf8")) as { pid: number }; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await sleep(10);
		}
	}
	throw new Error("Version fixture did not start");
}
function expectChildClosed(pid: number) {
	// Signal zero checks liveness without sending a signal to the child.
	expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

it("runs the fixed Node version command and preserves the hash API", async () => {
	const root = await mkdtemp(join(tmpdir(), "vomp-gate-node-version-test-"));
	roots.push(root);
	const first = join(root, "worker.mjs");
	await writeFile(first, "worker fixture");
	const probe = await createGateRuntimeProbe([first, process.execPath]);
	probes.push(probe);
	expect(await probe.hash(0)).toBe(createHash("sha256").update("worker fixture").digest("hex"));
	const version = await probe.version({ env: {}, cwd: root });
	expect(version.stdout.trim()).toBe(process.version);
	expect(version.stderr).toBe("");
	expect(version.error).toBeUndefined();
	await expect(probe.version({ env: {}, cwd: root })).rejects.toThrow("Invalid gate runtime probe version request");
	const snapshot = await probe.stop();
	expect(snapshot.version).toMatchObject({
		executionThread: "worker", timeoutMs: 15000, maxBuffer: 64 * 1024,
		windowsHide: true, environmentKeys: 0, childClosed: true, timedOut: false,
	});
	expect(snapshot.hashes).toHaveLength(1);
	expect(snapshot.threadStopped).toBe(true);
});

it("rejects extra command options and malformed environments before consuming the version request", async () => {
	const { probe, files } = await fixture();
	const invalid = [
		{ env: {}, cwd: tmpdir(), command: process.execPath },
		{ env: {}, cwd: tmpdir(), args: ["-e", "process.exit()"] },
		{ env: {}, cwd: tmpdir(), timeout: 30000 },
		{ env: { SECRET: 7 }, cwd: tmpdir() },
		{ env: {}, cwd: "" },
	];
	for (const options of invalid) {
		await expect(probe.version(options as Parameters<GateRuntimeProbe["version"]>[0])).rejects.toThrow("Invalid gate runtime probe version request");
	}
	await rm(files[1]!);
	const result = await probe.version({ env: {}, cwd: tmpdir() });
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("");
	expect(result.error).toBeInstanceOf(Error);
	expect(result.error?.code).toBe("ENOENT");
	expect((await probe.stop()).version?.childClosed).toBe(true);
});

it.skipIf(posixExecutableUnavailable)("passes only the supplied environment, cwd and fixed version argument", async () => {
	const { root, probe } = await executableFixture(`
process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd(), args: process.argv.slice(2) }));
process.stderr.write("fixture stderr");
process.exitCode = 7;
`);
	const result = await probe.version({ env: { FIXTURE_ONLY: "private-value" }, cwd: root });
	const reported = JSON.parse(result.stdout) as { env: Record<string, string>; cwd: string; args: string[] };
	expect(reported.cwd).toBe(await realpath(root));
	expect(reported.args).toEqual(["--version"]);
	expect(reported.env.FIXTURE_ONLY).toBe("private-value");
	// macOS may inject this one native runtime variable into a spawned process.
	expect(Object.keys(reported.env).sort()).toEqual(process.platform === "darwin" && "__CF_USER_TEXT_ENCODING" in reported.env
		? ["FIXTURE_ONLY", "__CF_USER_TEXT_ENCODING"].sort() : ["FIXTURE_ONLY"]);
	expect(reported.env.NODE_OPTIONS).toBeUndefined();
	expect(result.stderr).toBe("fixture stderr");
	expect(result.error).toBeInstanceOf(Error);
	expect(result.error).toMatchObject({ code: 7, killed: false, signal: null });
	const snapshot = await probe.stop();
	expect(snapshot.version).toMatchObject({ environmentKeys: 1, childClosed: true });
	expect(JSON.stringify(snapshot)).not.toContain("private-value");
	expect(JSON.stringify(snapshot)).not.toContain(root);
});

it.skipIf(posixExecutableUnavailable)("bounds version output and waits for the child to close after buffer failure", async () => {
	const { root, probe } = await executableFixture('process.stdout.write("x".repeat(128 * 1024)); process.stdin.resume();');
	const result = await probe.version({ env: {}, cwd: root });
	expect(result.error?.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
	expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
	expect((await probe.stop()).version?.childClosed).toBe(true);
});

it.skipIf(posixExecutableUnavailable)("kills and awaits its direct child before confirming stop", async () => {
	const { probe, ready, options } = await hangingFixture();
	const running = probe.version(options);
	const { pid } = await childStarted(ready);
	const stopping = probe.stop();
	expect(probe.stop()).toBe(stopping);
	const snapshot = await stopping;
	const result = await running;
	expect(result.error).toMatchObject({ killed: true, signal: "SIGKILL" });
	expect(snapshot.version?.childClosed).toBe(true);
	expect(snapshot.threadStopped).toBe(true);
	expectChildClosed(pid);
});

it.skipIf(posixExecutableUnavailable)("cleans up on the original request deadline without a retry budget", async () => {
	const { probe, ready, options } = await hangingFixture();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const running: Promise<GateRuntimeProbeVersion | Error> = probe.version(options).catch((error: Error) => error);
	const { pid } = await childStarted(ready);
	await vi.advanceTimersByTimeAsync(15000);
	const result = await running;
	expect(result).toBeInstanceOf(Error);
	expect((result as Error).message).toBe("Gate runtime probe request timed out");
	const snapshot = await probe.stop();
	expect(snapshot.version?.childClosed).toBe(true);
	expect(snapshot.threadStopped).toBe(true);
	expectChildClosed(pid);
	await expect(probe.version(options)).rejects.toThrow("Invalid gate runtime probe version request");
});

it.each([
	{ label: "missing stop acknowledgment", pendingVersion: false },
	{ label: "missing child-close confirmation", pendingVersion: true },
])("reports $label within a bound while retaining cleanup ownership", async ({ pendingVersion }) => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	let worker: ProtocolWorker | undefined;
	class ProtocolWorker extends EventEmitter {
		stdout = new EventEmitter();
		stderr = new EventEmitter();
		postMessage = vi.fn((_message: { op: string }) => {});
		terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
		constructor() {
			super();
			worker = this;
			queueMicrotask(() => this.emit("message", { event: "ready" }));
		}
	}
	vi.resetModules();
	vi.doMock("node:worker_threads", async () => ({
		...await vi.importActual<typeof WorkerThreads>("node:worker_threads"),
		Worker: ProtocolWorker,
	}));
	let probe: GateRuntimeProbe | undefined;
	try {
		// Reload after installing the protocol facade; a static import would retain the native Worker.
		const isolated = await import("./gate-runtime-probe.mjs");
		probe = await isolated.createGateRuntimeProbe(["fixed-worker", "fixed-native"]);
		if (pendingVersion) {
			const running = probe.version({ env: {}, cwd: tmpdir() }).catch((error: Error) => error);
			await vi.advanceTimersByTimeAsync(15000);
			expect(await running).toMatchObject({ message: "Gate runtime probe request timed out" });
			await expect(probe.version({ env: {}, cwd: tmpdir() })).rejects.toThrow("Invalid gate runtime probe version request");
			expect(worker!.postMessage.mock.calls.filter(([message]) => message.op === "version")).toHaveLength(1);
		}
		const stopping = probe.stop();
		const reported = stopping.catch((error: Error & { cleanupPending?: boolean }) => error);
		expect(probe.stop()).toBe(stopping);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await reported).toMatchObject({
			message: "Gate runtime probe cleanup confirmation timed out", cleanupPending: true,
		});
		expect(worker!.terminate).not.toHaveBeenCalled();
		let cleaned = false;
		const barrier = probe.cleanup().then(value => { cleaned = true; return value; });
		await Promise.resolve();
		expect(cleaned).toBe(false);
		// Only a later child-close acknowledgment permits termination, with no retry.
		worker!.emit("message", { event: "stopped", value: { version: { childClosed: true } } });
		expect((await barrier).threadStopped).toBe(true);
		expect(worker!.terminate).toHaveBeenCalledTimes(1);
		expect(worker!.postMessage.mock.calls.filter(([message]) => message.op === "stop")).toHaveLength(1);
	} finally {
		if (probe) {
			const barrier = probe.cleanup();
			worker!.emit("message", { event: "stopped", value: {} });
			await barrier;
		}
		vi.doUnmock("node:worker_threads");
		vi.resetModules();
	}
});
