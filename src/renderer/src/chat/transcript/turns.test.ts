import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { transcriptLayout } from "./turns";

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

	it("leaves live turns, single calls and other views alone", () => {
		const entries = [user("go"), assistant([tool("r1", "read"), tool("r2", "read")], 0, "a1"), result("r1", "read"), result("r2", "read")];
		expect(transcriptLayout(entries, { live: true, group: true, context }).entries.size).toBe(0);
		expect(transcriptLayout(entries, { live: false, group: false, context }).entries.size).toBe(0);
		const single = [user("go"), assistant([tool("r1", "read"), text("ok"), tool("r2", "read")], 0, "a1"), result("r1", "read"), result("r2", "read")];
		expect(transcriptLayout(single, { live: false, group: true, context }).entries.size).toBe(0);
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
	});
});
