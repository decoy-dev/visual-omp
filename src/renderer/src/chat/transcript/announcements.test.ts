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
