import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { evalOutputParts, evalRenderer } from "./eval";

// Math readiness is a browser subscription; exercise the actual Markdown renderer with math still loading.
vi.mock("../../transcript/math", async importOriginal => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, useMathReady: () => false };
});

const json = { kind: "json", value: { count: 2 } };
const markdown = { kind: "markdown", text: "**Finished**" };
const table = { kind: "table", columns: [{ head: "Name" }, { head: "Count", numeric: true }], rows: [["Ada", "2"]] };

describe("eval pretty output", () => {
	it("replaces matching spans in print order and keeps surrounding stdout", () => {
		expect(evalOutputParts("before\nvalue\nbetween\nvalue\nafter", [{ text: "value", view: json }, { text: "value", view: markdown }])).toEqual([
			{ text: "before\n" }, { view: json }, { text: "\nbetween\n" }, { view: markdown }, { text: "\nafter" },
		]);
	});
	it("keeps text when the view was truncated away or malformed", () => {
		expect(evalOutputParts("value", [{ text: "missing", view: json }, { text: "value", view: { kind: "table", columns: [], rows: [[1]] } }])).toEqual([{ text: "value" }]);
		expect(evalOutputParts("value", [{ text: "", view: json }, { text: "value", view: { kind: "future" } }])).toEqual([{ text: "value" }]);
	});
	it("renders a table, field tree and Markdown without their original printed spans", () => {
		const output = "table-plain\njson-plain\nmarkdown-plain\nkept stdout";
		const html = renderToStaticMarkup(createElement(evalRenderer.Body!, {
			name: "eval", args: { language: "python", code: "print(data)" },
			result: { content: [], details: { cells: [{ index: 0, output, status: "complete", views: [{ text: "table-plain", view: table }, { text: "json-plain", view: json }, { text: "markdown-plain", view: markdown }] }] } },
		}));
		expect(html).toContain("<table>");
		expect(html).toContain("tv-numeric");
		expect(html).toContain("count: ");
		expect(html).toContain("<strong>Finished</strong>");
		expect(html).toContain("kept stdout");
		expect(html).not.toContain("table-plain");
		expect(html).not.toContain("json-plain");
		expect(html).not.toContain("markdown-plain");
	});
	it("shows MCP progress in the running cell without inventing a percentage", () => {
		const props = { name: "eval", args: { code: "await tool.search()" }, result: { content: [], details: { cells: [{ index: 0, output: "", status: "running", statusEvents: [{ op: "mcp_progress", id: "a", tool: "search", progress: 4, message: "Fetching records" }] }] } } };
		const html = renderToStaticMarkup(createElement(evalRenderer.Body!, { ...props, running: true }));
		expect(html).toContain("Fetching records");
		expect(html).not.toContain("4%");
		expect(renderToStaticMarkup(createElement(evalRenderer.Body!, { ...props, running: false }))).not.toContain("Fetching records");
	});
});
