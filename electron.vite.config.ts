import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { phosphorExtraWeights } from "./scripts/phosphor-weights";

const shared = resolve(__dirname, "src/shared");

/** One weight's entry in a Phosphor icon definition module (`dist/defs/*.es.js`): `[ "bold", <svg body> ],`. */
const ICON_WEIGHT_ENTRY = /\n {2}\[\n {4}"(\w+)",\n[\s\S]*?\n {2}\],?/g;

/**
 * Every Phosphor icon module carries all six weights. Keep regular plus only the extra weights
 * drawn for this definition. The renderer source check rejects missing and unused allowances.
 */
function phosphorWeights(): Plugin {
	return {
		name: "vomp:phosphor-weights",
		transform(code, id) {
			const definition = /@phosphor-icons\/react\/dist\/defs\/(\w+)\.es\.js$/.exec(id)?.[1];
			if (!definition) return null;
			const entries = code.match(ICON_WEIGHT_ENTRY);
			if (entries?.length !== 6) this.error(`unexpected Phosphor icon definition format in ${id}`);
			const extraWeights = phosphorExtraWeights[definition] ?? [];
			return { code: code.replace(ICON_WEIGHT_ENTRY, (entry, weight: string) => (weight === "regular" || extraWeights.includes(weight) ? entry : "")), map: null };
		},
	};
}

interface WorkerChunk { fileName: string; modules: string[]; imports: string[]; dynamicImports: string[]; isEntry: false }
const workerChunks: WorkerChunk[] = [];

/** Worker builds are emitted as assets, so collect their module membership in their own Rollup build. */
function rendererWorkerMetadata(): Plugin {
	const root = `${__dirname.replaceAll("\\", "/")}/`;
	return {
		name: "vomp:renderer-worker-metadata",
		enforce: "post",
		generateBundle(_options, bundle) {
			for (const chunk of Object.values(bundle)) if (chunk.type === "chunk") workerChunks.push({
				fileName: chunk.fileName, isEntry: false, imports: chunk.imports, dynamicImports: chunk.dynamicImports,
				modules: Object.keys(chunk.modules).map(id => id.replaceAll("\\", "/").replaceAll(root, "").replace(/^.*\/node_modules\//, "node_modules/")).sort(),
			});
		},
	};
}
/** Rollup's module membership is needed by the renderer guard; Vite's manifest omits it. */
function rendererChunkMetadata(): Plugin {
	const root = `${__dirname.replaceAll("\\", "/")}/`;
	return {
		name: "vomp:renderer-chunk-metadata",
		apply: "build",
		async writeBundle(options, bundle) {
			if (!options.dir) this.error("Renderer chunk metadata requires an output directory.");
			const chunks = await Promise.all(Object.values(bundle).filter(output => output.type === "chunk").map(async chunk => ({
				fileName: chunk.fileName,
				isEntry: chunk.isEntry,
				bytes: (await stat(resolve(options.dir!, chunk.fileName))).size,
				imports: chunk.imports,
				dynamicImports: chunk.dynamicImports,
				modules: Object.keys(chunk.modules).map(id => id.replaceAll("\\", "/").replaceAll(root, "").replace(/^.*\/node_modules\//, "node_modules/")).sort(),
			})));
			for (const worker of workerChunks) chunks.push({ ...worker, bytes: (await stat(resolve(options.dir, worker.fileName))).size });
			workerChunks.length = 0;
			await writeFile(resolve(options.dir, "renderer-chunks.json"), `${JSON.stringify({ schemaVersion: 1, chunks }, null, 2)}\n`);
		},
	};
}

// Main and preload externalize only package.json `dependencies` (electron-vite's default
// `build.externalizeDeps`), which is node-pty alone: its native addon cannot be bundled. Every
// other package they import is a devDependency and is bundled into out/, so electron-builder
// ships no node_modules copy of it.
export default defineConfig({
	main: {
		// Compile ws's optional native loaders out before shipping. CommonJS leaves these two
		// requires untouched so define can fold their guarded branches without resolving packages.
		define: {
			"process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
			"process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
		},
		plugins: [{
			name: "vomp:no-ws-native-loaders",
			generateBundle(_options, bundle) {
				for (const output of Object.values(bundle)) {
					if (output.type === "chunk" && /\brequire\s*\(\s*["'](?:bufferutil|utf-8-validate)["']\s*\)/.test(output.code)) {
						this.error(`Optional ws native loader remains in ${output.fileName}`);
					}
				}
			},
		}],
		resolve: {
			alias: {
				"@shared": shared,
				// The package's `module` field names lib/xterm.mjs, which it does not ship.
				"@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.mjs",
			},
		},
		build: {
			commonjsOptions: { ignore: ["bufferutil", "utf-8-validate"] },
		},
	},
	preload: {
		resolve: { alias: { "@shared": shared } },
		build: { rollupOptions: { output: { format: "cjs" } } },
	},
	renderer: {
		plugins: [react(), tailwindcss(), phosphorWeights(), rendererChunkMetadata()],
		worker: { plugins: () => [rendererWorkerMetadata()] },
		resolve: {
			alias: {
				"@shared": shared,
				"@": resolve(__dirname, "src/renderer/src"),
				"@oh-my-pi/pi-wire": resolve(__dirname, "src/renderer/src/collab/wire/index.ts"),
				"@oh-my-pi/pi-utils/marked": "marked",
				"@oh-my-pi/pi-utils/math-delimiters": resolve(__dirname, "src/renderer/src/collab/math-delimiters.ts"),
			},
		},
		// electron-vite leaves the renderer unminified by default; minified, the startup chunk the window parses
		// is less than half the size. Source maps are not shipped, so stack traces name minified functions.
		build: { minify: true },
	},
});
