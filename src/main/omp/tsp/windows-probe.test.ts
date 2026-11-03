import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn as spawnPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWindowsProbeReport, runWindowsProbe, runWindowsProbes } from "./windows-probe";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function scratch() {
	const root = await mkdtemp(join(tmpdir(), "vomp-probe-test-"));
	roots.push(root);
	return root;
}

const complete = { status: "complete", hello: true, frames: 1, acks: 1, edit: true, send: true, useConptyDll: true, cleanupErrors: [], traffic: [] };

describe("Windows probe failure evidence", () => {
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
		expect(report.results[1]).toMatchObject({ framing: "osc877", status: "complete", send: true });
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
