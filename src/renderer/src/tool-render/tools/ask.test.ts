import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { friendlySummary } from "../../chat/friendly";
import { ToolCard } from "../../chat/transcript/ToolCard";
import { ToolView } from "../ToolView";
import "../../i18n";

const args = { questions: [{ id: "db", question: "Which database?", options: [{ label: "SQLite" }] }] };
const interrupted = { content: [{ type: "text", text: "Ask interrupted by message" }], isError: true };

describe("ask closed by a message", () => {
	it("shows a neutral closed row and explanation in the app instead of a failure or raw interruption text", () => {
		const call = { name: "ask", args, result: interrupted, running: false };
		expect(friendlySummary(call)).toMatchObject({ key: "ask.closed", status: "neutral", statusLabel: "ask.closedLabel" });
		const html = renderToStaticMarkup(createElement(ToolCard, { ...call, verbose: true }));
		expect(html).toContain("Question closed after a message");
		expect(html).toContain('aria-label="Closed"');
		expect(html).toContain("The reply can continue.");
		expect(html).not.toContain("Ask interrupted by message");
		expect(html).not.toContain('aria-label="Failed"');
	});
	it("keeps the standalone renderer calm while preserving other ask errors", () => {
		const html = renderToStaticMarkup(createElement(ToolView, { name: "ask", args, result: interrupted, defaultOpen: true }));
		expect(html).toContain("tv-status--closed");
		expect(html).not.toContain("tv-card--error");
		expect(html).not.toContain("Ask interrupted by message");
		const result = { content: [{ type: "text", text: "Ask input was cancelled" }], isError: true };
		expect(friendlySummary({ name: "ask", args, result, running: false }).status).toBe("error");
		const cancelled = renderToStaticMarkup(createElement(ToolView, { name: "ask", args, result, defaultOpen: true }));
		expect(cancelled).toContain("Ask input was cancelled");
		expect(cancelled).toContain("tv-card--error");
	});
});
