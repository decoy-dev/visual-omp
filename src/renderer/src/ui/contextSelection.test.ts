import { describe, expect, it } from "vitest";
import { selectionContainsTarget } from "./contextSelection";

function selection(nodes: string[], rectangles = [{ left: 20, right: 120, top: 10, bottom: 30 }]) {
	return {
		isCollapsed: false,
		rangeCount: 1,
		toString: () => "selected text",
		getRangeAt: () => ({ intersectsNode: (node: string) => nodes.includes(node), getClientRects: () => rectangles }),
	};
}

describe("selected text takes precedence at the context-menu target", () => {
	it("defers when a selection spans ordinary text and a link", () => {
		const current = selection(["paragraph", "link"]);
		expect(selectionContainsTarget(current, "link", { x: 60, y: 20 })).toBe(true);
		expect(selectionContainsTarget(current, "paragraph", { x: 30, y: 20 })).toBe(true);
	});
	it("defers for selected link text, including keyboard invocation", () => {
		const current = selection(["file-link"]);
		expect(selectionContainsTarget(current, "file-link", { x: 50, y: 20 })).toBe(true);
		expect(selectionContainsTarget(current, "file-link")).toBe(true);
	});
	it("defers for selected viewer code but retains the file menu elsewhere in the viewer", () => {
		const current = selection(["viewer", "code"]);
		expect(selectionContainsTarget(current, "code", { x: 50, y: 20 })).toBe(true);
		expect(selectionContainsTarget(current, "viewer", { x: 50, y: 80 })).toBe(false);
	});
	it("keeps target menus when the selection is elsewhere", () => {
		const current = selection(["other-paragraph"]);
		expect(selectionContainsTarget(current, "link", { x: 50, y: 20 })).toBe(false);
		expect(selectionContainsTarget(current, "explicit-file-row")).toBe(false);
	});
	it("uses the selected glyph rectangles rather than the entire intersecting element", () => {
		const current = selection(["partially-selected-link"]);
		expect(selectionContainsTarget(current, "partially-selected-link", { x: 140, y: 20 })).toBe(false);
	});
	it("ignores collapsed and empty selections", () => {
		expect(selectionContainsTarget(null, "link")).toBe(false);
		expect(selectionContainsTarget({ ...selection(["link"]), isCollapsed: true }, "link")).toBe(false);
		expect(selectionContainsTarget({ ...selection(["link"]), toString: () => "" }, "link")).toBe(false);
	});
});
