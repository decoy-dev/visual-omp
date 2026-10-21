import type { AssistantMessage, SessionEntry, WireMessage } from "@oh-my-pi/pi-wire";
import { describe, expect, it, vi } from "vitest";
import { ThoughtChoices, thoughtKey, thoughtOpen, writingThought } from "./thoughtChoices";
import { liveLayoutEntries, STREAM_ENTRY, transcriptLayout } from "./turns";

const context = { cwd: "/repo", home: "/home/me" };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } };
const message = (content: AssistantMessage["content"], timestamp: number): AssistantMessage => ({ role: "assistant", content, model: "m", usage, stopReason: "toolUse", timestamp });
const entry = (id: string, m: WireMessage): SessionEntry => ({ id, parentId: null, timestamp: "2026-01-01T00:00:00Z", type: "message", message: m });
const user = entry("u", { role: "user", content: "go", timestamp: 0 });
const tool = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, arguments: {} });
const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });
const result = (toolCallId: string) => entry(`res-${toolCallId}`, { role: "toolResult", toolCallId, toolName: "read", content: [], isError: false, timestamp: 0 });

describe("thought identity", () => {
	it("is the same for the streamed reply, its saved entry and the thought inside a step group", () => {
		const saved = [user, entry("a0", message([tool("r0")], 1000)), result("r0")];
		// The thought streams after r0, then omp starts r1: the thought joins r0's group from the stream row.
		const stream = message([thinking("hm"), tool("r1")], 5000);
		const streaming = transcriptLayout(liveLayoutEntries(saved, stream, null, true), { live: true, group: true, context });
		const fromStream = streaming.entries.get("a0")?.groups.get(0)?.items.find(item => item.block.type === "thinking");
		expect(fromStream?.entryId).toBe(STREAM_ENTRY);

		// omp saves the reply: a different entry holding the same message.
		const after = transcriptLayout([...saved, entry("a1", message([thinking("hm"), tool("r1")], 5000))], { live: true, group: true, context });
		const fromSaved = after.entries.get("a0")?.groups.get(0)?.items.find(item => item.block.type === "thinking");
		expect(fromSaved?.entryId).toBe("a1");

		const rowKey = thoughtKey(stream.timestamp, 0);
		expect(fromStream && thoughtKey(fromStream.messageTime, fromStream.index)).toBe(rowKey);
		expect(fromSaved && thoughtKey(fromSaved.messageTime, fromSaved.index)).toBe(rowKey);
		expect(thoughtKey(5000, 1)).not.toBe(rowKey);
		expect(thoughtKey(6000, 0)).not.toBe(rowKey);
	});
});

describe("thoughtOpen", () => {
	it("opens the thought omp is writing and folds it once a call or text follows or the reply ends", () => {
		const writing = message([thinking("hm")], 1);
		expect(writingThought(writing, true, true)).toBe(0);
		expect(thoughtOpen("normal", undefined, writingThought(writing, true, true) === 0)).toBe(true);
		const movedOn = message([thinking("hm"), tool("r1")], 1);
		expect(writingThought(movedOn, true, true)).toBe(-1);
		expect(thoughtOpen("normal", undefined, writingThought(movedOn, true, true) === 0)).toBe(false);
		expect(writingThought(message([thinking("hm"), { type: "text", text: "ok" }], 1), true, true)).toBe(-1);
		expect(writingThought(writing, false, true)).toBe(-1);
	});

	it("starts every thought collapsed in Normal view with the setting off", () => {
		expect(writingThought(message([thinking("hm")], 1), true, false)).toBe(-1);
		expect(thoughtOpen("normal", undefined, false)).toBe(false);
	});

	it("lets the reader's choice win over the thought being written, in both directions", () => {
		expect(thoughtOpen("normal", false, true)).toBe(false);
		expect(thoughtOpen("normal", true, false)).toBe(true);
	});

	it("opens every thought in Thinking and Verbose, whatever the reader chose", () => {
		for (const mode of ["thinking", "verbose"] as const) {
			expect(thoughtOpen(mode, false, false)).toBe(true);
			expect(thoughtOpen(mode, undefined, false)).toBe(true);
		}
	});
});

describe("ThoughtChoices", () => {
	it("records a click in Normal view as the opposite of what showed, and keeps it by key", () => {
		const choices = new ThoughtChoices();
		const listener = vi.fn();
		choices.subscribe(listener);
		const key = thoughtKey(5000, 0);
		// The reader closes the thought omp is writing (it showed open), then reopens it.
		choices.toggle("normal", key, true);
		expect(choices.snapshot().get(key)).toBe(false);
		expect(thoughtOpen("normal", choices.snapshot().get(key), true)).toBe(false);
		choices.toggle("normal", key, false);
		// Once omp moved on the thought is no longer being written, and the choice still holds, saved or grouped.
		expect(thoughtOpen("normal", choices.snapshot().get(thoughtKey(5000, 0)), false)).toBe(true);
		expect(listener).toHaveBeenCalledTimes(2);
	});

	it("records nothing for a click in Thinking or Verbose", () => {
		const choices = new ThoughtChoices();
		const listener = vi.fn();
		choices.subscribe(listener);
		choices.toggle("thinking", thoughtKey(5000, 0), true);
		choices.toggle("verbose", thoughtKey(5000, 0), true);
		expect(choices.snapshot().size).toBe(0);
		expect(listener).not.toHaveBeenCalled();
	});
});
