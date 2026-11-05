import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./guard-renderer-bundle.mjs", import.meta.url));
const baseline = { schemaVersion: 1, tag: "v0.7.4", commit: "233c28252a211081e30202d4b0a41e02f45cad97", entryBytes: 100, maxGrowthBytes: 20000 };
const entry = overrides => ({ fileName: "assets/entry.js", isEntry: true, bytes: 100, modules: ["/checkout/src/renderer/src/App.tsx"], imports: [], dynamicImports: [], ...overrides });
const view = overrides => ({ fileName: "assets/tsp.js", isEntry: false, bytes: 80, modules: ["/checkout/src/renderer/src/features/tsp/OmpScreenSheet.tsx"], imports: [], dynamicImports: [], ...overrides });

async function fixture(t, chunks = [entry()], classic = baseline) {
	const dir = await mkdtemp(join(tmpdir(), "vomp-renderer-guard-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const metadataPath = join(dir, "renderer-chunks.json"), baselinePath = join(dir, "classic.json");
	for (const chunk of chunks) {
		const file = join(dir, chunk.fileName);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, Buffer.alloc(chunk.bytes, "x"));
	}
	const metadata = { schemaVersion: 1, chunks };
	await writeFile(metadataPath, JSON.stringify(metadata));
	await writeFile(baselinePath, JSON.stringify(classic));
	return {
		dir, metadataPath, baselinePath, metadata,
		run: () => spawnSync(process.execPath, [cli, metadataPath, baselinePath], { encoding: "utf8" }),
		report: async () => JSON.parse(await readFile(join(dir, "renderer-bundle-size.json"), "utf8")),
	};
}
function failed(result, message) {
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, message);
}

test("CLI records emitted entry bytes beside the grounded classic baseline and permits lazy TSP views", async t => {
	const setup = await fixture(t, [entry({ bytes: 101, dynamicImports: ["assets/tsp.js"] }), view()]);
	const result = setup.run();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(await setup.report(), {
		schemaVersion: 1, entry: "assets/entry.js", entryBytes: 101,
		classic: { tag: baseline.tag, commit: baseline.commit, entryBytes: 100 },
		growthBytes: 1, maxGrowthBytes: 20000, acceptedGrowth: null, lazy: [],
	});
	assert.match(result.stdout, /Renderer entry: 101 bytes; v0\.7\.4 classic: 100 bytes/);
});

for (const module of [
	"/checkout/src/renderer/src/features/tsp/nodes/NodeView.tsx",
	"C:\\checkout\\src\\renderer\\src\\features\\tsp\\nodes\\NodeView.tsx",
	"src/renderer/src/features/tsp/OmpScreenSheet.tsx?used=true",
]) {
	test(`CLI rejects an eager TSP view module: ${module}`, async t => {
		const setup = await fixture(t, [entry({ modules: [module] })]);
		failed(setup.run(), /Initial renderer chunk assets\/entry\.js contains TSP view modules/);
		await assert.rejects(setup.report(), { code: "ENOENT" });
	});
}

test("CLI cannot evade the lazy boundary by extracting TSP views into a static shared chunk", async t => {
	const setup = await fixture(t, [entry({ imports: ["assets/tsp.js"] }), view()]);
	failed(setup.run(), /Initial renderer chunk assets\/tsp\.js contains TSP view modules/);
});

test("CLI follows cyclic static dependencies and permits genuinely shared non-view state", async t => {
	const setup = await fixture(t, [entry({ imports: ["assets/state.js"] }), view({ fileName: "assets/state.js", modules: ["src/renderer/src/state/tsp/presentation-claims.tsx"], imports: ["assets/entry.js"] })]);
	assert.equal(setup.run().status, 0);
});

test("CLI permits exactly 20,000 bytes of growth and rejects one byte more", async t => {
	const boundary = await fixture(t, [entry({ bytes: 20100 })]);
	assert.equal(boundary.run().status, 0);
	assert.equal((await boundary.report()).growthBytes, 20000);
	const excess = await fixture(t, [entry({ bytes: 20101 })]);
	failed(excess.run(), /grew 20001 bytes.*limit is 20000 bytes/);
});

test("CLI requires a recorded approval reason and enforces its byte ceiling", async t => {
	const approved = { ...baseline, acceptedGrowth: { entryBytes: 20200, reason: "Owner approved this measured entry size." } };
	const allowed = await fixture(t, [entry({ bytes: 20200 })], approved);
	assert.equal(allowed.run().status, 0);
	assert.deepEqual((await allowed.report()).acceptedGrowth, approved.acceptedGrowth);
	const beyond = await fixture(t, [entry({ bytes: 20201 })], approved);
	failed(beyond.run(), /Explicit approval must be recorded/);
	const unexplained = await fixture(t, [entry({ bytes: 20200 })], { ...approved, acceptedGrowth: { entryBytes: 20200, reason: " " } });
	failed(unexplained.run(), /nonempty approval reason/);
});

test("growth approval never permits an eager TSP module", async t => {
	const setup = await fixture(t, [entry({ modules: ["src/renderer/src/features/tsp/nodes/Code.tsx"] })], { ...baseline, acceptedGrowth: { entryBytes: 9999999, reason: "Size approval only." } });
	failed(setup.run(), /contains TSP view modules/);
});

test("CLI keeps the bundled changelog out of the entry and its static dependencies", async t => {
	const direct = await fixture(t, [entry({ modules: ["src/renderer/src/App.tsx", "CHANGELOG.md?raw"] })]);
	failed(direct.run(), /Initial renderer chunk assets\/entry\.js contains the bundled changelog/);
	const shared = await fixture(t, [entry({ imports: ["assets/notes.js"] }), entry({ fileName: "assets/notes.js", isEntry: false, modules: ["CHANGELOG.md?raw"] })]);
	failed(shared.run(), /Initial renderer chunk assets\/notes\.js contains the bundled changelog/);
	const windows = await fixture(t, [entry({ modules: ["C:\\checkout\\CHANGELOG.md?raw"] })]);
	failed(windows.run(), /contains the bundled changelog/);
	const approved = await fixture(t, [entry({ modules: ["CHANGELOG.md?raw"] })], { ...baseline, acceptedGrowth: { entryBytes: 9999999, reason: "Size approval only." } });
	failed(approved.run(), /contains the bundled changelog/);
	const lazy = await fixture(t, [entry({ dynamicImports: ["assets/notes.js"] }), entry({ fileName: "assets/notes.js", isEntry: false, modules: ["CHANGELOG.md?raw"] })]);
	const result = lazy.run();
	assert.equal(result.status, 0, result.stderr);
});

for (const module of [
	"src/renderer/src/chat/transcript/Transcript.tsx",
	"src/renderer/src/features/panes/HelperFocusView.tsx",
	"src/renderer/src/features/panes/helperConversation.ts",
	"src/renderer/src/state/sessionFiles.ts",
	"src/renderer/src/i18n/en/helperFocus.json",
	"C:\\checkout\\src\\renderer\\src\\features\\panes\\HelperFocusView.tsx",
]) {
	test(`CLI preserves the conversation lazy boundary: ${module}`, async t => {
		const direct = await fixture(t, [entry({ modules: [module] })]);
		failed(direct.run(), /contains conversation view modules/);
		const chunk = entry({ fileName: "assets/conversation.js", isEntry: false, modules: [module] });
		const shared = await fixture(t, [entry({ imports: [chunk.fileName] }), chunk]);
		failed(shared.run(), /contains conversation view modules/);
		const lazy = await fixture(t, [entry({ dynamicImports: [chunk.fileName] }), chunk]);
		assert.equal(lazy.run().status, 0);
	});
}

test("CLI rejects stale byte counts and counts UTF-8 bytes rather than characters", async t => {
	const setup = await fixture(t, [entry({ bytes: Buffer.byteLength("🙂", "utf8") })]);
	await writeFile(join(setup.dir, "assets/entry.js"), "🙂");
	assert.equal(setup.run().status, 0);
	assert.equal((await setup.report()).entryBytes, 4);
	await writeFile(join(setup.dir, "assets/entry.js"), "🙂🙂");
	failed(setup.run(), /size disagrees with metadata/);
});

for (const [name, change, message] of [
	["absent module lists", metadata => { delete metadata.chunks[0].modules; }, /Incomplete renderer chunk metadata/],
	["empty module lists", metadata => { metadata.chunks[0].modules = []; }, /Incomplete renderer chunk metadata/],
	["multiple entries", metadata => { metadata.chunks.push(entry({ fileName: "assets/second.js" })); }, /Expected one renderer entry/],
	["absent entries", metadata => { metadata.chunks[0].isEntry = false; }, /Expected one renderer entry/],
	["duplicate chunks", metadata => { metadata.chunks.push(metadata.chunks[0]); }, /Duplicate renderer chunk/],
	["missing static dependencies", metadata => { metadata.chunks[0].imports = ["assets/missing.js"]; }, /Missing renderer chunk metadata/],
	["unsupported schema", metadata => { metadata.schemaVersion = 2; }, /unsupported renderer chunk metadata/],
	["negative sizes", metadata => { metadata.chunks[0].bytes = -1; }, /Incomplete renderer chunk metadata/],
]) {
	test(`CLI fails closed for ${name}`, async t => {
		const setup = await fixture(t);
		change(setup.metadata);
		await writeFile(setup.metadataPath, JSON.stringify(setup.metadata));
		failed(setup.run(), message);
	});
}

test("CLI fails when metadata is missing or a chunk was not emitted", async t => {
	const missingMetadata = await fixture(t);
	await rm(missingMetadata.metadataPath);
	failed(missingMetadata.run(), /ENOENT/);
	const missingChunk = await fixture(t);
	await rm(join(missingChunk.dir, "assets/entry.js"));
	failed(missingChunk.run(), /ENOENT/);
});

for (const name of ["docx-preview", "jszip", "xlsx", "fflate", "pako", "@xmldom/xmldom"]) {
	test(`Office package ${name} cannot enter the initial renderer graph`, async t => {
		const module = `node_modules/${name}/index.js`;
		const direct = await fixture(t, [entry({ modules: [module] })]);
		failed(direct.run(), /contains Office preview modules/);
		const shared = await fixture(t, [entry({ imports: ["assets/office.js"] }), view({ fileName: "assets/office.js", modules: [module] })]);
		failed(shared.run(), /contains Office preview modules/);
		const lazy = await fixture(t, [entry({ dynamicImports: ["assets/office.js"] }), view({ fileName: "assets/office.js", modules: [module] })]);
		assert.equal(lazy.run().status, 0);
	});
}

test("lazy Office budgets measure adapters and workers and require approval for growth", async t => {
	const module = "src/renderer/src/features/live-preview/formats/xlsx.worker.ts";
	const chunk = view({ fileName: "assets/xlsx.worker.js", modules: [module], bytes: 1000 });
	const budget = { name: "XLSX worker", module, bytes: 1000 };
	const measured = await fixture(t, [entry(), chunk], { ...baseline, lazyBudgets: [budget] });
	assert.equal(measured.run().status, 0);
	assert.deepEqual((await measured.report()).lazy, [{ name: "XLSX worker", fileName: chunk.fileName, bytes: 1000, baselineBytes: 1000 }]);
	const growth = await fixture(t, [entry(), { ...chunk, bytes: 1001 }], { ...baseline, lazyBudgets: [budget] });
	failed(growth.run(), /Lazy renderer chunk XLSX worker grew/);
	const approved = await fixture(t, [entry(), { ...chunk, bytes: 1001 }], { ...baseline, lazyBudgets: [{ ...budget, acceptedGrowth: { bytes: 1001, reason: "Owner approved measured worker growth." } }] });
	assert.equal(approved.run().status, 0);
	const missing = await fixture(t, [entry()], { ...baseline, lazyBudgets: [budget] });
	failed(missing.run(), /Expected one lazy chunk/);
	const eager = await fixture(t, [entry({ imports: [chunk.fileName] }), chunk], { ...baseline, lazyBudgets: [budget] });
	failed(eager.run(), /is loaded initially/);
});
