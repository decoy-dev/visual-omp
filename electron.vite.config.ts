import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const shared = resolve(__dirname, "src/shared");

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		resolve: { alias: { "@shared": shared } },
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		resolve: { alias: { "@shared": shared } },
		build: { rollupOptions: { output: { format: "cjs" } } },
	},
	renderer: {
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				"@shared": shared,
				"@": resolve(__dirname, "src/renderer/src"),
				"@oh-my-pi/pi-wire": resolve(__dirname, "src/renderer/src/collab/wire/index.ts"),
				"@oh-my-pi/pi-utils/marked": "marked",
				"@oh-my-pi/pi-utils/math-delimiters": resolve(__dirname, "src/renderer/src/collab/math-delimiters.ts"),
			},
		},
	},
});
