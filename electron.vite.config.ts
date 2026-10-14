import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const shared = resolve(__dirname, "src/shared");

/** Phosphor weights the renderer draws: `regular` (App's IconContext default), plus `bold` and `fill` props. */
const ICON_WEIGHTS: Record<string, true> = { regular: true, bold: true, fill: true };
/** One weight's entry in a Phosphor icon definition module (`dist/defs/*.es.js`): `[ "bold", <svg body> ],`. */
const ICON_WEIGHT_ENTRY = /\n {2}\[\n {4}"(\w+)",\n[\s\S]*?\n {2}\],?/g;

/**
 * Every Phosphor icon module carries all six weights. This drops the weights missing from `ICON_WEIGHTS`,
 * about half of the icons' share of the startup chunk. An icon drawn in a dropped weight renders empty:
 * add the weight to `ICON_WEIGHTS` before using it.
 */
function phosphorWeights(): Plugin {
	return {
		name: "vomp:phosphor-weights",
		transform(code, id) {
			if (!/@phosphor-icons\/react\/dist\/defs\/\w+\.es\.js$/.test(id)) return null;
			const entries = code.match(ICON_WEIGHT_ENTRY);
			if (entries?.length !== 6) this.error(`unexpected Phosphor icon definition format in ${id}`);
			return { code: code.replace(ICON_WEIGHT_ENTRY, (entry, weight: string) => (ICON_WEIGHTS[weight] ? entry : "")), map: null };
		},
	};
}

// Main and preload externalize only package.json `dependencies` (electron-vite's default
// `build.externalizeDeps`), which is node-pty alone: its native addon cannot be bundled. Every
// other package they import is a devDependency and is bundled into out/, so electron-builder
// ships no node_modules copy of it.
export default defineConfig({
	main: {
		resolve: {
			alias: {
				"@shared": shared,
				// The package's `module` field names lib/xterm.mjs, which it does not ship.
				"@xterm/headless": "@xterm/headless/lib-headless/xterm-headless.mjs",
			},
		},
		build: {
			// ws loads these optional native helpers inside try/catch. Bundled, Vite stubs them as empty
			// modules, ws takes the stub for the helper and its mask/validate calls throw. Left external,
			// the require fails as they are not installed and ws uses its JS fallbacks.
			externalizeDeps: { include: ["bufferutil", "utf-8-validate"] },
		},
	},
	preload: {
		resolve: { alias: { "@shared": shared } },
		build: { rollupOptions: { output: { format: "cjs" } } },
	},
	renderer: {
		plugins: [react(), tailwindcss(), phosphorWeights()],
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
