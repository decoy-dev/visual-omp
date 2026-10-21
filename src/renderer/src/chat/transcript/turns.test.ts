import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { liveLayoutEntries, STREAM_ENTRY, TAIL_ENTRY, transcriptLayout, unsavedToolsMessage } from "./turns";

let seq = 0;
const base = () => ({ id: `e${++seq}`, parentId: null, timestamp: "2026-01-01T00:00:00Z" });
const context = { cwd: "/repo", home: "/home/me" };

function user(text: string): SessionEntry {
	return { ...base(), type: "message", message: { role: "user", content: text, timestamp: 0 } };
}

function assistant(content: AssistantMessage["content"], timestamp = 0, id?: string): SessionEntry {
	return {
		...base(),
		...(id ? { id } : {}),
		type: "message",
		message: {
			role: "assistant",
			content,
			model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp,
		},
	};
}

const tool = (id: string, name: string, args: Record<string, unknown> = {}) => ({ type: "toolCall" as const, id, name, arguments: args });
const text = (value: string) => ({ type: "text" as const, text: value });
const thinking = (value: string) => ({ type: "thinking" as const, thinking: value });

function result(toolCallId: string, toolName: string, details?: unknown, isError = false, timestamp = 0): SessionEntry {
	return { ...base(), type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: "" }], details, isError, timestamp } };
}

const board = (status: string) => ({ phases: [{ name: "P", tasks: [{ content: "a", status }] }] });

describe("transcriptLayout", () => {
	it("folds a finished turn's run of tool steps, thoughts between them included, into one group", () => {
		const entries = [
			user("go"),
			assistant([text("Looking"), tool("r1", "read", { path: "a.ts" })], 1000, "a1"),
			result("r1", "read", undefined, false, 2000),
			assistant([thinking("hm"), tool("r2", "grep")], 2500, "a2"),
			result("r2", "grep", undefined, true, 3000),
			assistant([tool("e1", "edit", { path: "a.ts" })], 3500, "a3"),
			result("e1", "edit", { diff: "+x\n-y\n+z" }, false, 4000),
			assistant([text("Done")], 4500, "a4"),
		];
		const layout = transcriptLayout(entries, { live: false, group: true, context });
		const plan = layout.entries.get("a1")?.groups.get(1);
		expect(plan).toMatchObject({ key: "r1", calls: 3, failed: 1, elapsedMs: 3000 });
		expect(plan?.items.map(item => `${item.entryId}:${item.index}`)).toEqual(["a1:1", "a2:0", "a2:1", "a3:0"]);
		expect([...(layout.entries.get("a2")?.hidden ?? [])]).toEqual([0, 1]);
		expect([...(layout.entries.get("a3")?.hidden ?? [])]).toEqual([0]);
		expect(layout.entries.has("a4")).toBe(false);
	});

	it("groups a lone call too, in a finished turn, and leaves other views alone", () => {
		const entries = [user("go"), assistant([tool("r1", "read"), tool("r2", "read")], 0, "a1"), result("r1", "read"), result("r2", "read")];
		expect(transcriptLayout(entries, { live: false, group: false, context }).entries.size).toBe(0);
		// Text ends a run, so each call is a group of one, and nothing changes shape when the turn ends.
		const single = [user("go"), assistant([tool("r1", "read"), text("ok"), tool("r2", "read")], 0, "a1"), result("r1", "read"), result("r2", "read")];
		const groups = transcriptLayout(single, { live: false, group: true, context }).entries.get("a1")?.groups;
		expect([...(groups?.values() ?? [])].map(plan => [plan.key, plan.calls, plan.running])).toEqual([
			["r1", 1, false],
			["r2", 1, false],
		]);
		expect(transcriptLayout(single, { live: true, group: true, context }).entries.get("a1")?.groups.size).toBe(2);
	});

	it("groups a live turn's calls from the first one, running calls included, and reports them running", () => {
		// Only the first call has started: it is already a group of one.
		const first = [user("go"), assistant([tool("r1", "read")], 5000, "a1")];
		expect(transcriptLayout(first, { live: true, group: true, context }).entries.get("a1")?.groups.get(0)).toMatchObject({
			key: "r1",
			calls: 1,
			running: true,
			startedAt: 5000,
			elapsedMs: null,
		});

		const entries = [
			user("go"),
			assistant([tool("r1", "read"), thinking("hm"), tool("r2", "grep")], 0, "a1"),
			result("r1", "read"),
			result("r2", "grep"),
			assistant([thinking("next"), tool("b1", "bash"), tool("r3", "read")], 0, "a2"),
			result("r3", "read"),
		];
		// b1 has no result yet: it and everything around it join the group led by r1, which runs.
		const layout = transcriptLayout(entries, { live: true, group: true, context });
		expect(layout.entries.get("a1")?.groups.get(0)).toMatchObject({ key: "r1", calls: 4, running: true });
		expect([...(layout.entries.get("a2")?.hidden ?? [])]).toEqual([0, 1, 2]);

		// Once b1 finishes, the same group stops running and nothing else changes.
		const later = transcriptLayout([...entries, result("b1", "bash")], { live: true, group: true, context });
		expect(later.entries.get("a1")?.groups.get(0)).toMatchObject({ key: "r1", calls: 4, running: false });
		expect([...(later.entries.get("a2")?.hidden ?? [])]).toEqual([0, 1, 2]);

		// A thought after the last call stays outside until a call follows it.
		const trailing = transcriptLayout([...entries, result("b1", "bash"), assistant([thinking("then")], 0, "a3")], { live: true, group: true, context });
		expect(trailing.entries.has("a3")).toBe(false);
	});

	it("never reports a finished turn's call without a result as running", () => {
		const entries = [user("go"), assistant([tool("r1", "read"), tool("b1", "bash")], 0, "a1"), result("r1", "read"), user("next")];
		expect(transcriptLayout(entries, { live: true, group: true, context }).entries.get("a1")?.groups.get(0)).toMatchObject({ calls: 2, running: false });
		expect(transcriptLayout(entries.slice(0, 3), { live: false, group: true, context }).entries.get("a1")?.groups.get(0)?.running).toBe(false);
	});

	it("keeps a step the reader is using as its own row when its run finishes around it, folding the steps either side", () => {
		// The reader is using b1 as a row (it was left out of the run); then the steps around it finished.
		const entries = [
			user("go"),
			assistant([tool("r1", "read"), tool("r2", "read"), tool("b1", "bash"), tool("r3", "read"), tool("r4", "read")], 0, "a1"),
			result("r1", "read"),
			result("r2", "read"),
			result("b1", "bash"),
			result("r3", "read"),
			result("r4", "read"),
		];
		const held = transcriptLayout(entries, { live: true, group: true, context, hold: new Set(["b1"]) }).entries.get("a1");
		expect([...(held?.groups.keys() ?? [])]).toEqual([0, 3]);
		expect(held?.hidden.has(2)).toBe(false);
		// The same holds as the turn finishes; once the reader lets go, the run folds into the first group again.
		expect(transcriptLayout(entries, { live: false, group: true, context, hold: new Set(["b1"]) }).entries.get("a1")?.hidden.has(2)).toBe(false);
		const released = transcriptLayout(entries, { live: true, group: true, context }).entries.get("a1");
		expect(released?.groups.get(0)).toMatchObject({ key: "r1", calls: 5 });
	});

	it("keeps a group the reader is using as its own group when the row before it lets go", () => {
		const entries = [
			user("go"),
			assistant([tool("r1", "read"), tool("r2", "read"), tool("b1", "bash"), tool("r3", "read"), tool("r4", "read")], 0, "a1"),
			result("r1", "read"),
			result("r2", "read"),
			result("b1", "bash"),
			result("r3", "read"),
			result("r4", "read"),
		];
		// b1 held split the run into groups r1 and r3; the reader moved on into the r3 group, releasing b1.
		const kept = transcriptLayout(entries, { live: true, group: true, context, holdGroups: new Set(["r3"]) }).entries.get("a1");
		expect([...(kept?.groups.values() ?? [])].map(plan => [plan.key, plan.calls])).toEqual([
			["r1", 3],
			["r3", 2],
		]);
		// Once the reader leaves that group too, the whole run folds into one.
		const merged = transcriptLayout(entries, { live: true, group: true, context }).entries.get("a1");
		expect([...(merged?.groups.values() ?? [])].map(plan => [plan.key, plan.calls])).toEqual([["r1", 5]]);
	});

	it("splits runs at text, helper runs and the turn's latest board", () => {
		const entries = [
			user("go"),
			assistant([tool("r1", "read"), tool("t1", "todo"), tool("r2", "read"), tool("k1", "task"), tool("r3", "read"), tool("r4", "read"), tool("t2", "todo")], 0, "a1"),
			result("r1", "read"),
			result("t1", "todo", board("in_progress")),
			result("r2", "read"),
			result("k1", "task"),
			result("r3", "read"),
			result("r4", "read"),
			result("t2", "todo", board("completed")),
		];
		const layout = transcriptLayout(entries, { live: false, group: true, context });
		// The earlier board update folds in as a change; the task call and the latest board break the runs.
		expect([...(layout.entries.get("a1")?.groups.keys() ?? [])]).toEqual([0, 4]);
		expect(layout.entries.get("a1")?.groups.get(0)?.calls).toBe(3);
		expect(layout.todos.get("t1")?.role).toBe("change");
		expect(layout.todos.get("t2")?.role).toBe("board");
		expect(layout.todos.get("t2")?.update.previous?.[0]?.tasks[0]?.status).toBe("in_progress");
	});

	it("splits a live turn's runs at text, questions and helper runs while their calls still run", () => {
		const entries = [user("go"), assistant([tool("r1", "read"), tool("q1", "ask"), tool("r2", "read"), text("Now the helpers."), tool("r3", "read"), tool("k1", "task"), tool("r4", "read")], 0, "a1")];
		const layout = transcriptLayout(entries, { live: true, group: true, context }).entries.get("a1");
		expect([...(layout?.groups.entries() ?? [])].map(([index, plan]) => [index, plan.calls, plan.running])).toEqual([
			[0, 1, true],
			[2, 1, true],
			[4, 1, true],
			[6, 1, true],
		]);
		expect(layout?.hidden.size).toBe(0);
	});

	it("never starts a group above the first drawn entry", () => {
		const entries = [
			user("go"),
			assistant([tool("r1", "read")], 0, "a1"),
			result("r1", "read"),
			assistant([tool("r2", "read")], 0, "a2"),
			result("r2", "read"),
			assistant([tool("r3", "read")], 0, "a3"),
			result("r3", "read"),
		];
		// The window starts at a2: a1's step is not drawn, so the group starts at a2 and nothing in view hides under a1.
		const layout = transcriptLayout(entries, { live: false, group: true, context, from: 3 });
		expect(layout.entries.get("a1")).toBeUndefined();
		expect(layout.entries.get("a2")?.groups.get(0)?.calls).toBe(2);
		expect([...(layout.entries.get("a3")?.hidden ?? [])]).toEqual([0]);
	});

	it("marks one board per turn as the latest, live turns included", () => {
		const entries = [
			user("one"),
			assistant([tool("t1", "todo")]),
			result("t1", "todo", board("pending")),
			user("two"),
			assistant([tool("t2", "todo"), tool("t3", "todo"), tool("t4", "todo")]),
			result("t2", "todo", board("in_progress")),
			result("t3", "todo", board("completed")),
			result("t4", "todo", undefined, true),
		];
		const { todos } = transcriptLayout(entries, { live: true, group: true, context });
		expect(todos.get("t1")?.role).toBe("board");
		expect(todos.get("t2")?.role).toBe("change");
		expect(todos.get("t3")?.role).toBe("board");
		expect(todos.has("t4")).toBe(false);
	});

	it("gives elapsed time only when every timestamp is known and in order", () => {
		const entries = [user("go"), assistant([tool("r1", "read"), tool("r2", "read")], 5000, "a1"), result("r1", "read", undefined, false, 6000), result("r2", "read")];
		expect(transcriptLayout(entries, { live: false, group: true, context }).entries.get("a1")?.groups.get(0)?.elapsedMs).toBeNull();
	});

	it("sums each finished turn's file changes at its last reply", () => {
		const entries = [
			user("go"),
			assistant([tool("e1", "edit", { path: "a.ts" }), tool("w1", "write", { path: "b.ts" })], 0, "a1"),
			result("e1", "edit", { diff: "+1\n+2\n-3" }),
			result("w1", "write", {}),
			assistant([text("done")], 0, "a2"),
			user("again"),
			assistant([tool("e2", "edit", { path: "c.ts" })], 0, "a3"),
			result("e2", "edit", { diff: "+1" }),
		];
		const { summaries } = transcriptLayout(entries, { live: true, group: true, context });
		expect(summaries.get("a2")).toEqual({
			files: [
				{ path: "/repo/a.ts", action: "edited", added: 2, removed: 1 },
				{ path: "/repo/b.ts", action: "written", added: null, removed: null },
			],
			added: 2,
			removed: 1,
			partial: true,
		});
		// The live turn has no summary yet.
		expect(summaries.has("a3")).toBe(false);
		// A turn the reader has already answered keeps its summary while omp starts on the new prompt.
		const answered = [user("go"), assistant([tool("e1", "edit", { path: "a.ts" })], 0, "a1"), result("e1", "edit", { diff: "+1" }), user("again")];
		expect(transcriptLayout(answered, { live: true, group: true, context }).summaries.has("a1")).toBe(true);
	});
});

/** The reply inside an assistant entry, as the live mirror streams it. */
function streamed(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	const entry = assistant(content, timestamp);
	if (entry.type !== "message" || entry.message.role !== "assistant") throw new Error("not a reply");
	return entry.message;
}

const running = (toolCallId: string, toolName = "read") => ({ toolCallId, toolName, args: { path: "a.ts" }, startedAt: 7000 });

describe("live layout entries", () => {
	it("groups a tool omp started before its call was saved, and keeps the group's key as the call streams and saves", () => {
		const before = [user("go")];
		const unsaved = unsavedToolsMessage([running("t1")], new Set(), null);
		expect(unsaved?.content).toEqual([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" }, intent: undefined }]);
		const alone = transcriptLayout(liveLayoutEntries(before, null, unsaved, true), { live: true, group: true, context });
		expect(alone.entries.get(TAIL_ENTRY)?.groups.get(0)).toMatchObject({ key: "t1", calls: 1, running: true });

		// The call turns up in the reply streaming in: it is no longer unsaved, and leads the same group from there.
		const stream = streamed([tool("t1", "read")], 7000);
		expect(unsavedToolsMessage([running("t1")], new Set(), stream)).toBeNull();
		const streaming = transcriptLayout(liveLayoutEntries(before, stream, null, true), { live: true, group: true, context });
		expect(streaming.entries.get(STREAM_ENTRY)?.groups.get(0)).toMatchObject({ key: "t1", calls: 1 });

		// Saved, it leads the same group from its entry.
		expect(unsavedToolsMessage([running("t1")], new Set(["t1"]), null)).toBeNull();
		const saved = transcriptLayout([...before, assistant([tool("t1", "read")], 7000, "a1")], { live: true, group: true, context });
		expect(saved.entries.get("a1")?.groups.get(0)).toMatchObject({ key: "t1", calls: 1 });
	});

	it("adds an unsaved tool to the group of the call before it, which keeps its key", () => {
		const before = [user("go"), assistant([tool("r0", "grep")], 1000, "a0"), result("r0", "grep")];
		const unsaved = unsavedToolsMessage([running("t1")], new Set(["r0"]), null);
		const live = transcriptLayout(liveLayoutEntries(before, null, unsaved, true), { live: true, group: true, context });
		expect(live.entries.get("a0")?.groups.get(0)).toMatchObject({ key: "r0", calls: 2, running: true });
		expect([...(live.entries.get(TAIL_ENTRY)?.hidden ?? [])]).toEqual([0]);

		const saved = transcriptLayout([...before, assistant([tool("t1", "read")], 7000, "a1")], { live: true, group: true, context });
		expect(saved.entries.get("a0")?.groups.get(0)).toMatchObject({ key: "r0", calls: 2 });
		expect([...(saved.entries.get("a1")?.hidden ?? [])]).toEqual([0]);
	});

	it("leaves the saved entries as they are outside Normal view and while the reply holds no call", () => {
		const before = [user("go"), assistant([tool("r0", "grep")], 1000, "a0")];
		const unsaved = unsavedToolsMessage([running("t1")], new Set(["r0"]), null);
		expect(liveLayoutEntries(before, streamed([tool("t1", "read")], 1), unsaved, false)).toBe(before);
		expect(liveLayoutEntries(before, streamed([thinking("hm"), text("Looking")], 1), null, true)).toBe(before);
		expect(liveLayoutEntries(before, streamed([tool("t1", "read")], 1), null, true).map(entry => entry.id)).toEqual([...before.map(entry => entry.id), STREAM_ENTRY]);
	});
});
