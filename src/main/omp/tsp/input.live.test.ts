import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root = "";
let recorder = "";
describe.skipIf(!process.env.OMP_BIN || process.platform === "win32")("live scripted TSP composer input", () => {
	beforeAll(async () => {
		// An ancestor node_modules resolves the recorder's external native node-pty package.
		root = await mkdtemp(join(process.cwd(), ".tsp-input-live-"));
		recorder = join(root, "recorder.mjs");
		await build({ entryPoints: [resolve("src/main/omp/tsp/record-fixtures.ts")], outfile: recorder, bundle: true, platform: "node", format: "esm", external: ["node-pty"],
			alias: { "@shared": resolve("src/shared"), "@oh-my-pi/pi-wire": resolve("src/renderer/src/collab/wire/index.ts") },
			banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
		});
	});
	afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

	it("delivers a queued follow-up and an image, and denies approval when sending a steer", async () => {
		const run = Promise.withResolvers<void>();
		execFile(process.execPath, [recorder, "follow-up-queue", "image-attach", "approval-send-denies"], {
			cwd: process.cwd(), env: { PATH: process.env.PATH, OMP_BIN: resolve(process.env.OMP_BIN!), VOMP_TSP_FIXTURE_DIR: root }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
		}, (error, stdout, stderr) => error ? run.reject(new Error(`${error.message}\n${stdout}\n${stderr}`)) : run.resolve());
		await run.promise;
		const follow = JSON.parse(await readFile(join(root, "follow-up-queue.provider.json"), "utf8"));
		expect(follow[1].messages.at(-1).content).toContainEqual({ type: "text", text: "Fixture follow-up text" });
		const collab = JSON.parse(await readFile(join(root, "image-attach.collab.json"), "utf8"));
		expect(collab.some((entry: { type: string; message?: { role: string; content: { type: string }[] } }) => entry.type === "message" && entry.message?.role === "user" && entry.message.content.some(part => part.type === "image"))).toBe(true);
		const approval = JSON.parse(await readFile(join(root, "approval-send-denies.provider.json"), "utf8"));
		expect(approval[1].messages).toContainEqual(expect.objectContaining({ role: "tool", content: "Tool call denied by user: bash" }));
		expect(approval[1].messages.at(-1).content).toContainEqual(expect.objectContaining({ type: "text", text: expect.stringContaining("Fixture deny and steer") }));
	}, 100_000);
});
