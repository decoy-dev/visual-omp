import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@shared": resolve(__dirname, "src/shared"),
			"@": resolve(__dirname, "src/renderer/src"),
			"@oh-my-pi/pi-wire": resolve(__dirname, "src/renderer/src/collab/wire/index.ts"),
			"@oh-my-pi/pi-utils/marked": "marked",
			"@oh-my-pi/pi-utils/math-delimiters": resolve(__dirname, "src/renderer/src/collab/math-delimiters.ts"),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
	},
});
