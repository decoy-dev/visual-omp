import type { AssistantContent, SessionEntry, WireMessage } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { matchesQuery } from "./helpContent";
import { outcomeSummary } from "./outcome";

let seq = 0;
const entry = (message: WireMessage): SessionEntry => ({
	type: "message",
	id: `e${seq++}`,
	parentId: null,
	timestamp: "2026-01-01T00:00:00Z",
	message,
});
const user = (text: string) => entry({ role: "user", content: text, timestamp: 0 } as WireMessage);
const assistant = (...content: AssistantContent[]) =>
	entry({
		role: "assistant",
		content,
		model: "m",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: 0,
	} as WireMessage);
const text = (value: string): AssistantContent => ({ type: "text", text: value });
const toolCall = { type: "toolCall", id: "c1", name: "edit", arguments: {} } as AssistantContent;

describe("outcomeSummary", () => {
	it("uses the first line of the newest reply, without markdown", () => {
		const entries = [user("fix it"), assistant(text("\n## **Fixed** the `checkout` total\n\nMore detail."))];
		expect(outcomeSummary(entries)).toBe("Fixed the checkout total");
	});

	it("skips tool-call-only replies and falls back to earlier text in the same turn", () => {
		const entries = [user("go"), assistant(text("- Edited [3 files](src/a.ts)")), assistant(toolCall)];
		expect(outcomeSummary(entries)).toBe("Edited 3 files");
	});

	it("never reaches back past the latest user message", () => {
		const entries = [assistant(text("Old answer")), user("new question"), assistant(toolCall)];
		expect(outcomeSummary(entries)).toBeNull();
	});

	it("caps long lines at 100 characters with an ellipsis", () => {
		const summary = outcomeSummary([assistant(text("word ".repeat(40)))]);
		expect(summary).toHaveLength(100);
		expect(summary?.endsWith("…")).toBe(true);
	});
});

describe("matchesQuery", () => {
	it("requires every word, case-insensitively, anywhere in the text", () => {
		expect(matchesQuery("Plan MODE", ["plan mode", "shows a plan first"])).toBe(true);
		expect(matchesQuery("plan rewind", ["plan mode"])).toBe(false);
		expect(matchesQuery("   ", ["anything"])).toBe(true);
	});
});
