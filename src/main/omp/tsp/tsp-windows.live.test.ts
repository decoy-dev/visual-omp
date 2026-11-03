import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readWindowsProbeReport } from "./windows-probe";

let root = "";
let probe = "";
describe.skipIf(!process.env.OMP_BIN || process.platform !== "win32")("Windows ConPTY TSP transport", () => {
	beforeAll(async () => {
		root = await mkdtemp(join(process.cwd(), ".tsp-windows-live-"));
		probe = join(root, "probe.mjs");
		await build({ entryPoints: [resolve("src/main/omp/tsp/windows-probe.ts")], outfile: probe,
			bundle: true, platform: "node", format: "esm", external: ["node-pty"],
		});
	});
	afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

	async function run(system: boolean) {
		const directory = resolve(process.env.VOMP_TSP_WINDOWS_EVIDENCE ?? root);
		await mkdir(directory, { recursive: true });
		const report = join(directory, system ? "system-conpty.json" : "bundled-conpty.json");
		const done = Promise.withResolvers<{ error: Error | null; stdout: string; stderr: string }>();
		execFile(process.execPath, [probe, ...(system ? ["--system"] : [])], {
			env: { ...process.env, OMP_BIN: resolve(process.env.OMP_BIN!), VOMP_TSP_WINDOWS_REPORT: report },
			timeout: 90_000, maxBuffer: 1024 * 1024,
		}, (error, stdout, stderr) => done.resolve({ error, stdout, stderr }));
		const output = await done.promise;
		return readWindowsProbeReport(report, output);
	}

	it("completes hello, credits, chunked Unicode edit and send through APC then OSC 877 with bundled ConPTY", async () => {
		const evidence = await run(false);
		expect(evidence.results.map((result: { framing: string }) => result.framing)).toEqual(["apc", "osc877"]);
		for (const result of evidence.results) {
			expect(result).toMatchObject({ useConptyDll: true, status: "complete", hello: true, edit: true, send: true, cleanupErrors: [] });
			expect(result.frames).toBeGreaterThan(0);
			expect(result.acks).toBeGreaterThan(0);
			expect(result.traffic.some((chunk: { direction: string }) => chunk.direction === "in")).toBe(true);
			expect(result.traffic.some((chunk: { direction: string }) => chunk.direction === "out")).toBe(true);
		}
	}, 100_000);

	it("records system ConPTY whether it drops APC or delivers the exchange", async () => {
		const evidence = await run(true);
		expect(evidence.results).toHaveLength(1);
		expect(evidence.results[0]).toMatchObject({ useConptyDll: false, framing: "apc" });
		expect(evidence.results[0].traffic.length).toBeGreaterThan(0);
	}, 100_000);
});
