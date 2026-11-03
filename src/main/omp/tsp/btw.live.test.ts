import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root = "";
let recorder = "";
let version = "";
describe.skipIf(!process.env.OMP_BIN || process.platform === "win32")("live scripted TSP side questions", () => {
	beforeAll(async () => {
		root = await mkdtemp(join(process.cwd(), ".tsp-btw-live-"));
		recorder = join(root, "recorder.mjs");
		const reported = execFileSync(resolve(process.env.OMP_BIN!), ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root, PI_CODING_AGENT_DIR: root, PI_CONFIG_DIR: root, TMPDIR: root } }).trim();
		const matched = /^omp\/(\d+\.\d+\.\d+)$/.exec(reported);
		if (!matched) throw new Error(`Unrecognized omp version: ${reported}`);
		version = matched[1]!;
		await build({ entryPoints: [resolve("src/main/omp/tsp/record-fixtures.ts")], outfile: recorder, bundle: true, platform: "node", format: "esm", external: ["node-pty"],
			alias: { "@shared": resolve("src/shared"), "@oh-my-pi/pi-wire": resolve("src/renderer/src/collab/wire/index.ts") },
			banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		});
	});
	afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
	it("asks, follows up and keeps the side answer independent of a collab main-turn abort", async () => {
		const run = Promise.withResolvers<void>();
		execFile(process.execPath, [recorder, "btw-ask", "btw-follow-up", "btw-open-main-abort"], {
			cwd: process.cwd(), env: { PATH: process.env.PATH, OMP_BIN: resolve(process.env.OMP_BIN!), VOMP_TSP_FIXTURE_VERSION: version, VOMP_TSP_FIXTURE_DIR: root }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
		}, (error, stdout, stderr) => error ? run.reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : run.resolve());
		await run.promise;
		const abort = JSON.parse(await readFile(join(root, "btw-open-main-abort.btw.json"), "utf8"));
		expect(abort.version).toBe(`omp/${version}`);
		expect(abort.observation).toContain("No side-question action was sent at abort");
		const events = (await readFile(join(root, "btw-open-main-abort.events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
		const collabAbort = events.find(event => event.collab?.t === "abort");
		expect(collabAbort).toBeDefined();
		expect(events.some(event => event.afterMessage <= collabAbort.afterMessage && event.body?.ev === "action")).toBe(false);
		const followUp = JSON.parse(await readFile(join(root, "btw-follow-up.btw.json"), "utf8"));
		const final = followUp.stages.at(-1).files.find((file: { path: string }) => file.path.endsWith(".json"));
		const record = JSON.parse(final.text);
		expect(record.followUps).toContainEqual(expect.objectContaining({ question: "Explain the fixture answer in one more sentence.", answer: "The follow-up fixture answer preserves the first topic.", status: "complete" }));
	}, 100_000);
});
