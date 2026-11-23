import { describe, expect, it } from "vitest";
import { partitionToolCommandImages, type ToolCommandRecord } from "./toolCommands";
import type { ToolResultBlock } from "./types";

const image = (data: string): ToolResultBlock => ({ type: "image", data, mimeType: "image/png" });
// omp 19.1.1 `generate_image` details carry `imageCount` and `imagePaths` (coding-agent/src/tools/image-gen.ts).
const generated = (count: number): ToolCommandRecord => ({
	tool: "generate_image", mode: "execute", exitCode: 0, args: {},
	inner: { imageCount: count, imagePaths: Array.from({ length: count }, (_, index) => `/tmp/gen-${index}.png`) },
});

describe("partitionToolCommandImages", () => {
	it("gives a lone generate_image call the bash result's images", () => {
		const images = [image("a"), image("b")];
		const { byIndex, remaining } = partitionToolCommandImages("generate_image --subject 'owl && cat'", { content: images }, [generated(2)]);
		expect(byIndex.get(0)).toEqual(images);
		expect(remaining).toEqual([]);
	});

	it.each([
		["another program's image with a redirected generator", "generate_image --subject owl > /dev/null && render-kitty", [generated(1)], 1],
		["two generate_image calls", "generate_image --subject owl; generate_image --subject cat", [generated(1), generated(1)], 2],
		["a count that differs from imageCount", "generate_image --subject owl", [generated(1)], 2],
		["a call without details", "generate_image --subject owl", [{ ...generated(1), inner: undefined }], 1],
	] as const)("keeps every image on the bash card for %s", (_, command, records, count) => {
		const images = Array.from({ length: count }, (__, index) => image(`i${index}`));
		const { byIndex, remaining } = partitionToolCommandImages(command, { content: images }, records);
		expect(byIndex.size).toBe(0);
		expect(remaining).toEqual(images);
	});
});
