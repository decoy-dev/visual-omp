import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const baselinePath = fileURLToPath(new URL("./renderer-classic-baseline.json", import.meta.url));
const defaultMetadataPath = fileURLToPath(new URL("../out/renderer/renderer-chunks.json", import.meta.url));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
const tspModule = id => /(?:^|\/)src\/renderer\/src\/features\/tsp\//.test(id.replaceAll("\\", "/"));
/** The bundled changelog loads with the release notes viewer; in the entry, every release would grow startup. */
const changelogModule = id => /(?:^|\/)CHANGELOG\.md(?:\?|$)/.test(id.replaceAll("\\", "/"));
/** Transcript implementation, helper controls and their text load on demand; focus state may remain eager. */
const conversationModule = id => /(?:^|\/)src\/renderer\/src\/(?:chat\/transcript\/Transcript\.tsx|features\/panes\/(?:HelperFocusView\.tsx|helperConversation\.ts)|state\/sessionFiles\.ts|i18n\/[^/]+\/helperFocus\.json)(?:\?|$)/.test(id.replaceAll("\\", "/"));

/** Validate emitted Rollup membership, including synchronous dependencies of the entry. */
export function inspectRendererBundle(metadata, baseline) {
	if (metadata?.schemaVersion !== 1 || !Array.isArray(metadata.chunks) || !metadata.chunks.length) throw new Error("Missing or unsupported renderer chunk metadata.");
	if (baseline?.schemaVersion !== 1 || !integer(baseline.entryBytes) || !integer(baseline.maxGrowthBytes) || typeof baseline.tag !== "string" || typeof baseline.commit !== "string") throw new Error("Invalid classic renderer baseline.");
	const chunks = new Map();
	for (const chunk of metadata.chunks) {
		if (!chunk || typeof chunk.fileName !== "string" || !chunk.fileName || typeof chunk.isEntry !== "boolean" || !integer(chunk.bytes) || !strings(chunk.modules) || !chunk.modules.length || !strings(chunk.imports) || !strings(chunk.dynamicImports)) throw new Error("Incomplete renderer chunk metadata.");
		if (chunks.has(chunk.fileName)) throw new Error(`Duplicate renderer chunk: ${chunk.fileName}`);
		chunks.set(chunk.fileName, chunk);
	}
	const entries = metadata.chunks.filter(chunk => chunk.isEntry);
	if (entries.length !== 1) throw new Error(`Expected one renderer entry chunk, received ${entries.length}.`);
	const entry = entries[0];
	const initial = new Set();
	const visit = chunk => {
		if (initial.has(chunk.fileName)) return;
		initial.add(chunk.fileName);
		const forbidden = chunk.modules.filter(tspModule);
		if (forbidden.length) throw new Error(`Initial renderer chunk ${chunk.fileName} contains TSP view modules:\n${forbidden.join("\n")}`);
		const changelog = chunk.modules.filter(changelogModule);
		if (changelog.length) throw new Error(`Initial renderer chunk ${chunk.fileName} contains the bundled changelog, which must load with the release notes viewer:\n${changelog.join("\n")}`);
		const conversations = chunk.modules.filter(conversationModule);
		if (conversations.length) throw new Error(`Initial renderer chunk ${chunk.fileName} contains conversation view modules, which must load lazily:\n${conversations.join("\n")}`);
		for (const name of chunk.imports) {
			const dependency = chunks.get(name);
			if (!dependency) throw new Error(`Missing renderer chunk metadata for static import ${name}.`);
			visit(dependency);
		}
	};
	visit(entry);
	const growthBytes = entry.bytes - baseline.entryBytes;
	const acceptance = baseline.acceptedGrowth;
	if (acceptance !== undefined && (!integer(acceptance.entryBytes) || typeof acceptance.reason !== "string" || !acceptance.reason.trim())) throw new Error("Accepted renderer growth requires entryBytes and a nonempty approval reason.");
	const accepted = growthBytes > baseline.maxGrowthBytes && acceptance !== undefined && entry.bytes <= acceptance.entryBytes;
	if (growthBytes > baseline.maxGrowthBytes && !accepted) throw new Error(`Renderer entry grew ${growthBytes} bytes from ${baseline.tag} (${baseline.entryBytes} bytes) to ${entry.bytes} bytes. The limit is ${baseline.maxGrowthBytes} bytes. Explicit approval must be recorded as acceptedGrowth.entryBytes and acceptedGrowth.reason in the baseline file.`);
	return { schemaVersion: 1, entry: entry.fileName, entryBytes: entry.bytes, classic: { tag: baseline.tag, commit: baseline.commit, entryBytes: baseline.entryBytes }, growthBytes, maxGrowthBytes: baseline.maxGrowthBytes, acceptedGrowth: accepted ? acceptance : null };
}

/** Check metadata against the emitted files so stale sizes cannot approve an oversized build. */
export async function guardRendererBundle(metadataPath = defaultMetadataPath, classicPath = baselinePath) {
	const [metadata, baseline] = await Promise.all([metadataPath, classicPath].map(async path => JSON.parse(await readFile(path, "utf8"))));
	const report = inspectRendererBundle(metadata, baseline);
	const outputDir = dirname(resolve(metadataPath));
	for (const chunk of metadata.chunks) {
		const output = resolve(outputDir, chunk.fileName);
		const path = relative(outputDir, output);
		if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) throw new Error(`Renderer chunk escapes the output directory: ${chunk.fileName}`);
		const file = await stat(output);
		if (!file.isFile() || file.size !== chunk.bytes) throw new Error(`Renderer chunk size disagrees with metadata: ${chunk.fileName}`);
	}
	await writeFile(resolve(outputDir, "renderer-bundle-size.json"), `${JSON.stringify(report, null, 2)}\n`);
	return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		if (process.argv.length > 4) throw new Error("Usage: node scripts/guard-renderer-bundle.mjs [metadata.json] [baseline.json]");
		const report = await guardRendererBundle(process.argv[2], process.argv[3]);
		console.log(`Renderer entry: ${report.entryBytes} bytes; ${report.classic.tag} classic: ${report.classic.entryBytes} bytes; growth: ${report.growthBytes} bytes; limit: ${report.maxGrowthBytes} bytes${report.acceptedGrowth ? `; approved: ${report.acceptedGrowth.reason}` : ""}.`);
	} catch (error) {
		console.error(`Renderer bundle guard: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
