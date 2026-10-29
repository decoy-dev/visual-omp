import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { evalMcpProgress, mcpProgressOf, mcpRenderer, McpProgressLine } from "./mcp";
import { friendlySummary, resolveToolCall } from "../../chat/friendly";

describe("MCP progress", () => {
	it("requires a finite progress counter and preserves optional totals", () => {
		expect(mcpProgressOf({ progress: Number.NaN })).toBeNull();
		expect(mcpProgressOf({ progress: "4" })).toBeNull();
		expect(mcpProgressOf({ progress: 0, total: Number.POSITIVE_INFINITY, message: "  Preparing\nrecords " })).toEqual({ progress: 0, total: null, message: "Preparing records" });
	});
	it("coalesces eval events by request id, not by tool name", () => {
		const events = evalMcpProgress([{ op: "mcp_progress", id: "one", tool: "search", progress: 1 }, { op: "read", id: "x" }, { op: "mcp_progress", id: "two", tool: "search", progress: 2 }, { op: "mcp_progress", id: "one", tool: "search", progress: 3 }]);
		expect(events.map(event => [event.id, event.value.progress])).toEqual([["one", 3], ["two", 2]]);
	});
	it("shows bounded progress while running and replaces it with the final output", () => {
		const live = renderToStaticMarkup(createElement(mcpRenderer.Body!, { name: "mcp_search", args: {}, running: true, result: { content: [{ type: "text", text: "duplicate progress" }], details: { progress: { progress: 4, total: 10, message: "Fetching records" } } } }));
		expect(live).toContain("4/10");
		expect(live).toContain("Fetching records");
		expect(live).not.toContain("duplicate progress");
		const final = renderToStaticMarkup(createElement(mcpRenderer.Body!, { name: "mcp_search", args: {}, running: false, result: { content: [{ type: "text", text: "Found records" }], details: { progress: { progress: 4, total: 10 } } } }));
		expect(final).toContain("Found records");
		expect(final).not.toContain("4/10");
	});
	it("keeps a live progress result in the running state", () => {
		const call = resolveToolCall({ name: "mcp_search", args: {}, running: true, result: { content: [], details: { progress: { progress: 4 } } } });
		expect(friendlySummary(call).status).toBe("running");
	});
	it.each([0, 4])("shows message and unbounded count %s in both presentations", progress => {
		const value = { progress, total: null, message: "Fetching records" };
		const summary = renderToStaticMarkup(createElement(mcpRenderer.Summary, { name: "mcp_search", args: {}, running: true, result: { content: [], details: { progress: value } } }));
		const line = renderToStaticMarkup(createElement(McpProgressLine, { value }));
		expect(summary).toContain(`Fetching records · ${progress}`);
		expect(line).toContain(`tv-mcp-progress-amount">${progress}</span>`);
		expect(line).toContain("Fetching records");
		expect(summary + line).not.toContain("%");
	});
});
