import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { AnnouncementTracker } from "./announcements";

const base = (id: string) => ({ id, parentId: null, timestamp: "2026-10-29T12:00:00Z" });
const choice: SessionEntry = { ...base("choice"), type: "model_change", model: "anthropic/primary", resolvedModelIsFallback: false };
const fallback: SessionEntry = { ...base("fallback"), type: "model_change", model: "openai/backup", resolvedModelIsFallback: true };
const response: AssistantMessage = {
	role: "assistant", provider: "anthropic", model: "backup", timestamp: 12345, stopReason: "stop",
	content: [{ type: "fallback", from: { model: "primary" }, to: { model: "backup" } }],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
};
const reply: SessionEntry = { ...base("reply"), type: "message", message: response };

describe("transcript announcements", () => {
	it("announces a newly recorded fallback once, including before the first prompt", () => {
		const tracker = new AnnouncementTracker();
		expect(tracker.update([choice], null, true, "chat")).toEqual([]);
		expect(tracker.update([choice, fallback], null, true, "chat")).toEqual([{ id: "fallback", fallback: { from: "anthropic/primary", to: "openai/backup", source: "retry" } }]);
		expect(tracker.update([choice, { ...fallback }], null, true, "chat")).toEqual([]);
	});

	it("keeps history, the current stream on joining, and a different session's history silent", () => {
		const tracker = new AnnouncementTracker();
		expect(tracker.update([choice, fallback], response, true, "chat")).toEqual([]);
		expect(tracker.update([choice, fallback, reply], null, true, "chat").filter(item => "fallback" in item)).toEqual([]);
		expect(tracker.update([choice, fallback, reply], null, true, "other-chat")).toEqual([]);
	});

	it("silences reconnect snapshots, including new events received while disconnected", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([choice], null, true, "chat");
		tracker.update([choice], null, false, "chat");
		expect(tracker.update([choice, fallback], response, true, "chat")).toEqual([]);
		expect(tracker.update([choice, fallback, reply], null, true, "chat").filter(item => "fallback" in item)).toEqual([]);
		const next = { ...fallback, id: "second-fallback", model: "other/backup" };
		expect(tracker.update([choice, fallback, reply, next], null, true, "chat").filter(item => "fallback" in item)).toHaveLength(1);
	});

	it("announces streamed provider fallback once without repeating it in the saved entry", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([choice], null, true, "chat");
		expect(tracker.update([choice], response, true, "chat").filter(item => "fallback" in item)).toHaveLength(1);
		expect(tracker.update([choice], { ...response, content: [...response.content, { type: "text", text: "Continuing." }] }, true, "chat")).toEqual([]);
		const saved = tracker.update([choice, reply], null, true, "chat");
		expect(saved.filter(item => "fallback" in item)).toEqual([]);
		expect(saved.filter(item => "message" in item)).toHaveLength(1);
	});

	it("does not replace a fallback announcement with a reply received in the same update", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([choice], null, true, "chat");
		const ordinary: SessionEntry = { ...reply, message: { ...response, content: [{ type: "text", text: "Done." }] } };
		const next = tracker.update([choice, fallback, ordinary], null, true, "chat");
		expect(next.map(item => "fallback" in item ? "fallback" : "reply")).toEqual(["fallback", "reply"]);
	});

	it("keeps manual choices, primary restoration and ordinary setup silent", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([], null, true, "chat");
		expect(tracker.update([choice, { ...fallback, resolvedModelIsFallback: false }], null, true, "chat")).toEqual([]);
	});
});

describe("interim reply announcements", () => {
	const frame = (replies: unknown[]) => new Map([["bash", { toolCallId: "bash", toolName: "bash", args: {}, startedAt: 1000, partialResult: { details: { replies } } }]]);
	const saved = (replies: unknown[]): SessionEntry => ({ ...base("result"), type: "message", message: { role: "toolResult", toolCallId: "bash", toolName: "bash", timestamp: 2000, content: [], details: { replies }, isError: false } });

	it("announces each foreground reply once across repeated frames and its saved result", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([], null, true, "chat");
		expect(tracker.update([], null, true, "chat", frame(["First."]))).toEqual([{ id: "tool-reply:bash:0", text: "First." }]);
		expect(tracker.update([], null, true, "chat", frame(["First."]))).toEqual([]);
		expect(tracker.update([], null, true, "chat", frame(["First.", "Second."]))).toEqual([{ id: "tool-reply:bash:1", text: "Second." }]);
		expect(tracker.update([saved(["First.", "Second."])], null, true, "chat")).toEqual([]);
	});

	it("keeps history and reconnect reply frames silent", () => {
		const tracker = new AnnouncementTracker();
		expect(tracker.update([], null, true, "chat", frame(["Already shown."]))).toEqual([]);
		tracker.update([], null, false, "chat");
		expect(tracker.update([saved(["Already shown.", "While disconnected."])], null, true, "chat", frame(["Already shown.", "While disconnected."]))).toEqual([]);
		expect(tracker.update([], null, true, "chat", frame(["Already shown.", "While disconnected.", "New reply."]))).toEqual([{ id: "tool-reply:bash:2", text: "New reply." }]);
	});

	it("announces complete write replies without repeating them as ordinary assistant text", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([], null, true, "chat");
		const out: SessionEntry = { ...base("out"), type: "message", message: { ...response, content: [{ type: "toolCall", id: "out-call", name: "write", arguments: { path: "out://status", content: "The **report**." } }] } };
		const update = tracker.update([out], null, true, "chat");
		expect(update.filter(item => "text" in item)).toEqual([{ id: "write-reply:out-call", text: "The **report**." }]);
		expect(update.filter(item => "message" in item).map(item => item.message.content)).toEqual([[]]);
		expect(tracker.update([out], null, true, "chat")).toEqual([]);
	});

	it("ignores malformed and empty reply payloads", () => {
		const tracker = new AnnouncementTracker();
		tracker.update([], null, true, "chat");
		expect(tracker.update([], null, true, "chat", frame([null, "", " ", {}, "Report."]))).toEqual([{ id: "tool-reply:bash:0", text: "Report." }]);
	});
});
