import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { languageFromPath, splitReadQuery } from "../util";
import { readRenderer, splitPathSel } from "./read";
import { friendlySummary, resolveToolCall, toolContextReference } from "../../chat/friendly";

describe("read jq selectors", () => {
	it("separates selectors and decodes filters while preserving jq plus and modulo", () => {
		expect(splitPathSel("data.json:2-4:raw?q=.count+1&limit=2")).toEqual({ path: "data.json", sel: "2-4:raw", query: ".count+1" });
		expect(splitReadQuery("data.json?q=.[]%26select(.active)").query).toBe(".[]&select(.active)");
		expect(splitReadQuery("data.json?q=.count % 2").query).toBe(".count % 2");
		expect(splitReadQuery("data.json?q=").query).toBe(".");
	});
	it("retains web URL query strings and unrelated local query names", () => {
		expect(splitReadQuery("https://example.com/data.json?q=search")).toEqual({ path: "https://example.com/data.json?q=search", query: null });
		expect(splitReadQuery("data.json?cache=1")).toEqual({ path: "data.json?cache=1", query: null });
		expect(splitReadQuery("image.png?q=What is this?").query).toBeNull();
		expect(splitReadQuery("data.db?q=SELECT * FROM rows").query).toBeNull();
	});
	it.each(["data.json?q=.a", "data.jsonl?q=.[]", "data.ndjson?query=.a"])('keeps JSON highlighting for %s', path => {
		expect(languageFromPath(path)).toBe("json");
	});
	it("does not put the query into the file reference", () => {
		const html = renderToStaticMarkup(createElement(readRenderer.Summary, { name: "read", args: { path: "data.json?q=.items+[]" } }));
		expect(html).toContain('data-context-tool-path="data.json"');
		expect(html).toContain("jq: .items+[]");
	});
	it("keeps the filter out of the normal transcript summary", () => {
		const summary = friendlySummary(resolveToolCall({ name: "read", args: { path: "data.json?q=.items" }, running: true }));
		expect(summary.values.file).toBe("data.json");
	});
	it("strips jq from the normal transcript context-menu target without changing other targets", () => {
		expect(toolContextReference(resolveToolCall({ name: "read", args: { path: "data.json?q=.items&limit=4" }, running: false }))).toEqual({ path: "data.json" });
		expect(toolContextReference(resolveToolCall({ name: "read", args: { file_path: "data.jsonl?q=.[]" }, running: false }))).toEqual({ path: "data.jsonl" });
		expect(toolContextReference(resolveToolCall({ name: "read", args: { path: "https://example.com/?q=search" }, running: false }))).toEqual({ url: "https://example.com/?q=search" });
		expect(toolContextReference(resolveToolCall({ name: "write", args: { path: "data.json?q=literal" }, running: false }))).toEqual({ path: "data.json?q=literal" });
		expect(toolContextReference(resolveToolCall({ name: "read", args: { path: "out://reply?q=.a" }, running: false }))).toEqual({});
	});
	it("highlights filtered JSON without a global highlighter and escapes untrusted content", () => {
		const html = renderToStaticMarkup(createElement(readRenderer.Body!, { name: "read", args: { path: "data.json?q=." }, result: { content: [{ type: "text", text: '{"name":"<script>","count":2}' }] } }));
		expect(html).toContain("text-(--syn-string)");
		expect(html).toContain("text-(--syn-number)");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
});
