import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { ActiveTool } from "../../collab/lib/client";
import { backgroundJobs, devServerUrls, latestTodo } from "./derive";

let seq = 0;
const base = () => ({ id: `e${++seq}`, parentId: null, timestamp: "2026-01-01T00:00:00Z" });

function call(id: string, name: string, args: Record<string, unknown>): SessionEntry {
	return {
		...base(),
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args }],
			model: "m",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
			stopReason: "toolUse",
			timestamp: 0,
		},
	};
}

function result(toolCallId: string, toolName: string, text: string, details?: unknown, isError = false): SessionEntry {
	return {
		...base(),
		type: "message",
		message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError, timestamp: 0 },
	};
}

describe("latestTodo", () => {
	it("uses the newest successful board and skips failed updates", () => {
		const entries = [
			call("t1", "todo", { op: "init" }),
			result("t1", "todo", "", { phases: [{ name: "Old", tasks: [{ content: "a", status: "pending" }] }] }),
			call("t2", "todo", { op: "done" }),
			result("t2", "todo", "", { phases: [{ name: "New", tasks: [{ content: "a", status: "completed" }, { content: "b", status: "weird" }] }] }),
			call("t3", "todo", { op: "bad" }),
			result("t3", "todo", "error", { phases: [] }, true),
		];
		expect(latestTodo(entries)).toEqual([
			{
				name: "New",
				tasks: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "pending" },
				],
			},
		]);
	});

	it("recognizes todo calls made through a device write", () => {
		const entries = [
			call("t1", "write", { path: "xd://todo", content: "{}" }),
			result("t1", "write", "", { xdev: { mode: "execute", tool: "todo", args: {}, inner: { phases: [{ name: "P", tasks: [] }] } } }),
		];
		expect(latestTodo(entries)).toEqual([{ name: "P", tasks: [] }]);
	});

	it("is null when omp never made a checklist", () => {
		expect(latestTodo([call("b", "bash", { command: "ls" }), result("b", "bash", "x")])).toBeNull();
	});
});

describe("backgroundJobs", () => {
	it("tracks an async bash job from start to delivered result, newest first", () => {
		const entries: SessionEntry[] = [
			call("b1", "bash", { command: "npm run dev", async: true }),
			result("b1", "bash", "started", { async: { state: "running", jobId: "j1", type: "bash" } }),
			call("b2", "bash", { command: "npm test", async: true }),
			result("b2", "bash", "started", { async: { state: "running", jobId: "j2", type: "bash" } }),
			{ ...base(), type: "custom_message", customType: "async-result", content: "done", display: true, details: { jobs: [{ jobId: "j2" }] } },
		];
		expect(backgroundJobs(entries)).toEqual([
			{ jobId: "j2", command: "npm test", state: "completed", output: "started" },
			{ jobId: "j1", command: "npm run dev", state: "running", output: "started" },
		]);
	});

	it("takes failure and output from job polls", () => {
		const entries = [
			call("b1", "bash", { command: "make", async: true }),
			result("b1", "bash", "started", { async: { state: "running", jobId: "j1", type: "bash" } }),
			call("p", "job", { poll: ["j1"] }),
			result("p", "job", "", { jobs: [{ id: "j1", status: "failed", errorText: "boom" }, { id: "other", status: "running" }] }),
		];
		expect(backgroundJobs(entries)).toEqual([{ jobId: "j1", command: "make", state: "failed", output: "boom" }]);
	});

	it("shows streaming output of a job started in the background, not foreground commands", () => {
		const tool = (args: Record<string, unknown>, jobId: string): ActiveTool => ({
			toolCallId: jobId,
			toolName: "bash",
			args,
			startedAt: 0,
			partialResult: { details: { output: "listening", async: { state: "running", jobId } } },
		});
		const active = new Map([
			["a", tool({ command: "vite", async: true }, "ja")],
			["b", tool({ command: "npm test" }, "jb")],
		]);
		expect(backgroundJobs([], active)).toEqual([{ jobId: "ja", command: "vite", state: "running", output: "listening" }]);
	});
});

describe("devServerUrls", () => {
	it("finds local URLs in command output, newest first, normalized and deduplicated", () => {
		const entries = [
			call("b1", "bash", { command: "vite" }),
			result("b1", "bash", "  ➜  Local:   \u001b[36mhttp://localhost:5173/\u001b[39m\n  ➜  Network: http://192.168.1.2:5173/"),
			call("b2", "bash", { command: "serve" }),
			result("b2", "bash", "Listening on http://0.0.0.0:8080. Also http://localhost:5173"),
		];
		expect(devServerUrls(entries)).toEqual(["http://localhost:8080", "http://localhost:5173"]);
	});
});
