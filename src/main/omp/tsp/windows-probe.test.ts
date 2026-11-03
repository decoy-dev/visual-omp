import { execFile, type ExecFileException } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { spawn as spawnPty } from "node-pty";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWindowsProbeReport, runWindowsProbe, runWindowsProbes, windowsProbeFailed } from "./windows-probe";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function scratch() {
	const root = await mkdtemp(join(tmpdir(), "vomp-probe-test-"));
	roots.push(root);
	return root;
}

const complete = { status: "complete", hello: true, frames: 1, acks: 1, edit: true, send: true, useConptyDll: true, cleanupErrors: [], traffic: [] };

describe("Windows probe failure evidence", () => {
	it("supplies scratch configuration at omp's default home-derived path without absolute config-name overrides", async () => {
		const path = join(await scratch(), "profile-layout.json");
		vi.stubEnv("PI_CONFIG_DIR", "C:\\owner\\config");
		vi.stubEnv("PI_CODING_AGENT_DIR", "C:\\owner\\agent");
		vi.stubEnv("XDG_STATE_HOME", "C:\\owner\\state");
		const spawn = vi.fn<typeof spawnPty>((_bin, _args, options) => {
			const env = options!.env!;
			expect(env.USERPROFILE).toBe(env.HOME);
			expect(env.PI_CONFIG_DIR).toBeUndefined();
			expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(env.XDG_STATE_HOME).toBeUndefined();
			const configRoot = join(env.USERPROFILE!, env.PI_CONFIG_DIR || ".omp");
			const agent = env.PI_CODING_AGENT_DIR || join(configRoot, "agent");
			const config = JSON.parse(readFileSync(join(agent, "config.yml"), "utf8"));
			expect(config.startup).toMatchObject({ setupWizard: false, checkUpdate: false });
			expect(config.worktree).toEqual({ onStart: "off", onExit: "keep" });
			expect(join(configRoot, "run", "daemons")).toContain(join("home", ".omp", "run", "daemons"));
			throw new Error("scratch configuration consumed");
		});
		const result = await runWindowsProbe("unused", true, "apc", path, { spawn });
		expect(spawn).toHaveBeenCalledOnce();
		expect(result.error).toBe("Error: scratch configuration consumed");
	});

	it.each([false, true])("distinguishes a live system ConPTY observation from an unexpected omp exit (%s)", async unexpectedExit => {
		const path = join(await scratch(), "system.json");
		let onExit: ((event: { exitCode: number }) => void) | undefined;
		const spawn = vi.fn<typeof spawnPty>(() => ({
			pid: 0, cols: 110, rows: 32, process: "probe-fixture", handleFlowControl: false,
			resize: vi.fn(), clear: vi.fn(), write: vi.fn(), pause: vi.fn(), resume: vi.fn(),
			onData(listener: (data: string) => void) {
				queueMicrotask(() => {
					listener(unexpectedExit ? "ENOENT: mkdir scratch-home/absolute-agent/run/daemons/clients" : "classic TUI output");
					if (unexpectedExit) onExit!({ exitCode: 1 });
				});
				return { dispose() {} };
			},
			onExit(listener: (event: { exitCode: number }) => void) { onExit = listener; return { dispose() {} }; },
			kill() { onExit!({ exitCode: 0 }); },
		}));
		const result = await runWindowsProbe("unused", false, "apc", path, { spawn, timeoutMs: 100 });
		expect(result).toMatchObject({ status: "complete", hello: false, frames: 0, cleanupErrors: [] });
		expect(result.traffic.length).toBeGreaterThan(0);
		expect(result.earlyExit).toEqual(unexpectedExit ? { exitCode: 1 } : undefined);
		expect(windowsProbeFailed(result, true)).toBe(unexpectedExit);
		expect(windowsProbeFailed({ ...result, subprocessError: "child failed" }, true)).toBe(true);
	});

	it("saves profile setup errors as a completed result before returning", async () => {
		const path = join(await scratch(), "profile.json");
		const result = await runWindowsProbe("unused", true, "apc", path, {
			mkdir: vi.fn().mockRejectedValue(new Error("profile directory denied")),
		});
		expect(result).toMatchObject({ status: "complete", framing: "apc", error: "Error: profile directory denied" });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
	});

	it("persists partial traffic before kill and retains independent kill and removal failures", async () => {
		const path = join(await scratch(), "cleanup.json");
		const spawn = vi.fn<typeof spawnPty>(() => ({
			pid: 0, cols: 110, rows: 32, process: "probe-fixture", handleFlowControl: false,
			resize: vi.fn(), clear: vi.fn(), write: vi.fn(), pause: vi.fn(), resume: vi.fn(),
			onData(listener: (data: string) => void) { queueMicrotask(() => listener("partial output café")); return { dispose() {} }; },
			onExit() { return { dispose() {} }; },
			kill() {
				expect(JSON.parse(readFileSync(path, "utf8")).traffic).toHaveLength(1);
				throw new Error("kill denied");
			},
		}));
		const remove = vi.fn<typeof rm>(async path => {
			roots.push(String(path));
			throw new Error("profile file locked");
		});
		const result = await runWindowsProbe("unused", true, "apc", path, { spawn, rm: remove, timeoutMs: 100 });
		expect(spawn).toHaveBeenCalledOnce();
		expect(result.error).toContain("No ready TSP editor");
		expect(result.cleanupErrors).toEqual(["Error: kill denied", "Error: profile file locked"]);
		expect(result.status).toBe("complete");
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
		const journal = (await readFile(`${path}.traffic.jsonl`, "utf8")).trim().split("\n").map(line => JSON.parse(line));
		expect(Buffer.from(journal[0].base64, "base64").toString()).toBe("partial output café");
	});

	it("bounds hung profile setup and records its deadline", async () => {
		const path = join(await scratch(), "setup-timeout.json");
		const pending = Promise.withResolvers<void>();
		const result = await runWindowsProbe("unused", true, "apc", path, {
			mkdir: vi.fn().mockReturnValue(pending.promise), timeoutMs: 20,
		});
		expect(result.error).toContain("Profile setup exceeded the probe deadline");
		expect(result.status).toBe("complete");
	});

	it("exits an isolated native-worker process promptly with success or failure determined by the completed probe", async () => {
		const entry = join(await scratch(), "exit-probe.mjs");
		await build({ stdin: { contents: `
import { Worker } from "node:worker_threads";
import { exitWindowsProbe } from ${JSON.stringify(resolve("src/main/omp/tsp/windows-probe.ts"))};
// A real referenced worker models the native ConPTY worker that outlives PTY onExit.
new Worker("setInterval(() => {}, 1000)", { eval: true });
exitWindowsProbe(JSON.parse(process.env.PROBE_RESULT), process.env.SYSTEM_PROBE === "1");
`, resolveDir: process.cwd(), sourcefile: "exit-probe.ts" }, outfile: entry, bundle: true, platform: "node", format: "esm", external: ["node-pty"] });
		const healthy = { ...complete, framing: "apc", traffic: [{ direction: "out", base64: "b3V0cHV0", at: 1 }] };
		for (const [result, system, code] of [
			[healthy, false, 0],
			[{ ...healthy, send: false }, false, 1],
			[{ ...healthy, cleanupErrors: ["PTY did not exit"] }, false, 1],
			[{ ...healthy, hello: false, frames: 0, acks: 0, edit: false, send: false, error: "No ready TSP editor" }, true, 0],
			[{ ...healthy, earlyExit: { exitCode: 1 } }, true, 1],
			[{ ...healthy, subprocessError: "child failed" }, true, 1],
		] as const) {
			const done = Promise.withResolvers<ExecFileException | null>();
			execFile(process.execPath, [entry], { env: { ...process.env, PROBE_RESULT: JSON.stringify(result), SYSTEM_PROBE: system ? "1" : "0" }, timeout: 3000 },
				error => done.resolve(error));
			const error = await done.promise;
			// This integration test requires a real worker and OS process termination.
			expect(error?.killed ?? false).toBe(false);
			expect(error?.code ?? 0).toBe(code);
		}
	}, 20_000);

	it("keeps an APC timeout's partial capture and still completes the independent OSC subprocess", async () => {
		const root = await scratch();
		const entry = join(root, "fake-probe.mjs");
		await writeFile(entry, `import {writeFileSync,appendFileSync} from 'node:fs';
const framing=process.argv[3]; const path=process.env.VOMP_TSP_WINDOWS_REPORT;
const result={...${JSON.stringify(complete)},framing};
if(framing==='apc'){result.status='running';writeFileSync(path,JSON.stringify(result));appendFileSync(path+'.traffic.jsonl',JSON.stringify({direction:'out',base64:'cGFydGlhbA=='})+'\\n');setInterval(()=>{},1000);}
else writeFileSync(path,JSON.stringify(result));`);
		const destination = join(root, "report.json");
		const report = await runWindowsProbes({ bin: "unused", system: false, destination, entry, childTimeoutMs: 500 });
		expect(report.results).toHaveLength(2);
		expect(report.results[0]).toMatchObject({ framing: "apc", status: "running" });
		// This integration case needs a real OS child timeout and kill; fake timers cannot deliver that signal.
		expect(report.results[0]!.error).toContain("Probe subprocess:");
		expect(report.results[0]!.subprocessExit).toMatchObject({ killed: true, timeoutMs: 500 });
		expect(report.results[0]!.subprocessExit!.signal !== null || report.results[0]!.subprocessExit!.code !== null).toBe(true);
		expect(report.results[0]!.subprocessExit!.elapsedMs).toBeGreaterThanOrEqual(500);
		expect(report.results[1]).toMatchObject({ framing: "osc877", status: "complete", send: true });
		expect(report.results[1]!.subprocessExit).toMatchObject({ code: 0, signal: null, killed: false });
		expect(await readFile(`${destination}.apc.json.traffic.jsonl`, "utf8")).toContain("cGFydGlhbA==");
		expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(report);
	}, 5000);

	it("records a subprocess startup failure without a report and still runs OSC", async () => {
		const root = await scratch();
		const entry = join(root, "failing-probe.mjs");
		await writeFile(entry, `import {writeFileSync} from 'node:fs';
if(process.argv[3]==='apc') throw new Error('APC startup failure');
writeFileSync(process.env.VOMP_TSP_WINDOWS_REPORT,JSON.stringify({...${JSON.stringify(complete)},framing:'osc877'}));`);
		const report = await runWindowsProbes({ bin: "unused", system: false, destination: join(root, "report.json"), entry });
		expect(report.results[0]!.error).toContain("APC startup failure");
		expect(report.results[0]!.error).toContain("No readable probe report");
		expect(report.results[0]!.subprocessExit).toMatchObject({ code: 1, signal: null, killed: false });
		expect(report.results[1]).toMatchObject({ status: "complete", framing: "osc877" });
	});

	it("reports the subprocess error rather than masking it with a missing report read", async () => {
		const path = join(await scratch(), "missing.json");
		await expect(readWindowsProbeReport(path, { error: new Error("probe killed after deadline"), stdout: "", stderr: "native load failed" }))
			.rejects.toThrow(/probe killed after deadline[\s\S]*native load failed[\s\S]*No readable completed report/);
	});

	it("rejects an incomplete report even when its subprocess exits successfully", async () => {
		const path = join(await scratch(), "incomplete.json");
		await writeFile(path, JSON.stringify({ results: [{ ...complete, status: "running" }] }));
		await expect(readWindowsProbeReport(path, { error: null, stdout: "", stderr: "" })).rejects.toThrow("No completed probe report");
	});
});
