import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { ActiveTool } from "../../collab/lib/client";
import { backgroundJobs, chatOutputs, devServerUrls, isIntactBase64, latestTodo } from "./derive";

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

describe("chatOutputs", () => {
	const context = { cwd: "/proj", home: "/Users/me" };
	const PNG = "iVBORw0KGgo=";
	const BLOB = "b".repeat(64);

	/** A tool call and its result at `time` (ms); `blocks` are extra content blocks such as images. */
	function tool(id: string, name: string, args: Record<string, unknown>, time: number, options: { details?: unknown; blocks?: unknown[]; isError?: boolean } = {}): SessionEntry[] {
		const content = [{ type: "text", text: "" }, ...(options.blocks ?? [])] as Extract<SessionEntry, { type: "message" }>["message"]["content"];
		return [
			call(id, name, args),
			{
				...base(),
				type: "message",
				message: { role: "toolResult", toolCallId: id, toolName: name, content, details: options.details, isError: options.isError ?? false, timestamp: time },
			} as SessionEntry,
		];
	}
	const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });
	const summary = (entries: SessionEntry[]) => chatOutputs(entries, context).map(({ key, kind, tool: name, time }) => `${kind} ${name} ${key} @${time}`);

	it("lists read images by their file, keeping only the newest read of a path, newest first", () => {
		const entries = [
			...tool("r1", "read", { path: "/tmp/poster.png" }, 1, { details: { meta: { source: { type: "path", value: "/tmp/poster.png" } } }, blocks: [image(PNG)] }),
			...tool("r2", "read", { path: "shots/b.png:img" }, 2, { blocks: [image(`blob:sha256:${BLOB}`)] }),
			...tool("r3", "read", { path: "/tmp/poster.png" }, 3, { details: { meta: { source: { type: "path", value: "/tmp/poster.png" } } }, blocks: [image(PNG)] }),
			...tool("r4", "read", { path: "notes.md" }, 4, { details: { resolvedPath: "/proj/notes.md" } }),
		];
		expect(summary(entries)).toEqual(["image read /tmp/poster.png @3", "image read /proj/shots/b.png @2"]);
		expect(chatOutputs(entries, context)[1].inline).toEqual({ kind: "blob", hash: BLOB });
	});

	it("keeps images without a path as separate items and merges frames only by image paths", () => {
		const entries = [
			...tool("b1", "browser", { action: "run" }, 1, { blocks: [image(PNG), image(PNG)] }),
			...tool("v1", "read", { path: "/tmp/clip.mp4:12" }, 2, { blocks: [image(PNG)] }),
			...tool("v2", "read", { path: "/tmp/clip.mp4:40" }, 3, { blocks: [image(PNG)] }),
		];
		expect(summary(entries)).toEqual(["image read v2#0 @3", "image read v1#0 @2", "image browser b1#1 @1", "image browser b1#0 @1"]);
		expect(chatOutputs(entries, context)[0].path).toBe("/tmp/clip.mp4");
	});

	it("pairs generated images with their saved paths, through a device write too", () => {
		const inner = { imagePaths: ["/var/T/omp-image-1.webp"], images: [{ data: `blob:sha256:${BLOB}`, mimeType: "image/webp" }] };
		const entries = tool("g1", "write", { path: "xd://generate_image", content: "{}" }, 5, {
			details: { xdev: { tool: "generate_image", mode: "execute", args: { subject: "cat" }, inner } },
		});
		const [output] = chatOutputs(entries, context);
		expect(output).toEqual({ key: "/var/T/omp-image-1.webp", kind: "image", path: "/var/T/omp-image-1.webp", tool: "generate_image", time: 5, inline: { kind: "blob", hash: BLOB } });
	});

	it("lists files from write, edit and applied ast_edit, resolving relative and home paths", () => {
		const entries = [
			...tool("w1", "write", { path: "~/site/logo.svg" }, 1),
			...tool("w2", "write", { path: "src/a.ts" }, 2, { details: { resolvedPath: "/proj/src/a.ts" } }),
			...tool("e1", "edit", { input: "[src/a.ts#AB12]\n" }, 3, { details: { path: "src/a.ts" } }),
			...tool("e2", "edit", { input: "" }, 4, {
				details: { perFileResults: [{ path: "/proj/b.ts" }, { path: "/proj/broken.ts", isError: true }] },
			}),
			...tool("w3", "write", { path: "/proj/failed.ts" }, 5, { isError: true }),
			...tool("x1", "ast_edit", { paths: ["lib"] }, 6, { details: { applied: true, cwd: "/other", fileReplacements: [{ path: "lib/c.ts", count: 2 }] } }),
		];
		expect(summary(entries)).toEqual([
			"file ast_edit /other/lib/c.ts @6",
			"file edit /proj/b.ts @4",
			"file edit /proj/src/a.ts @3",
			"image write /Users/me/site/logo.svg @1",
		]);
	});

	it("counts a staged ast_edit preview only once resolve applies it", () => {
		const preview = (id: string, time: number, file: string) =>
			tool(id, "ast_edit", { paths: ["."] }, time, { details: { applied: false, fileReplacements: [{ path: file, count: 1 }] } });
		const entries = [
			...preview("x1", 1, "kept.ts"),
			...tool("r1", "resolve", { action: "apply" }, 2),
			...preview("x2", 3, "dropped.ts"),
			...tool("r2", "resolve", { action: "discard" }, 4),
			...preview("x3", 5, "pending.ts"),
		];
		expect(summary(entries)).toEqual(["file ast_edit /proj/kept.ts @2"]);
	});
});

describe("isIntactBase64", () => {
	it("rejects data the live stream cut short", () => {
		expect(isIntactBase64("iVBORw0KGgo=")).toBe(true);
		expect(isIntactBase64("iVBORw0KGgo\n…[120 chars elided for collab session]")).toBe(false);
		expect(isIntactBase64("blob:sha256:abc")).toBe(false);
	});
});
