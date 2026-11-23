// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { editRenderer } from "./edit";
import { isMagicInput, mergeMagicSections, splitMagicSections } from "./magicSections";

describe("omp 19.1 magic edit sections", () => {
	it("merges repeated sections naming the same path", async () => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		const input = "# src/app.ts\nFirst change.\n\n# src/other.ts\nOther change.\n\n# src/app.ts\nSecond change.\n";
		expect(isMagicInput(input)).toBe(true);
		const merged = mergeMagicSections(splitMagicSections(input).runs);
		expect(merged).toEqual([
			{ path: "src/app.ts", text: "First change.\n\nSecond change." },
			{ path: "src/other.ts", text: "Other change." },
		]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(createElement(editRenderer.Body!, {
				name: "edit",
				args: { input },
				running: true,
			})));
			expect(container.textContent?.match(/src\/app\.ts/g)).toHaveLength(1);
			expect(container.textContent).toContain("First change.");
			expect(container.textContent).toContain("Second change.");
			expect(container.textContent).toContain("Other change.");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
