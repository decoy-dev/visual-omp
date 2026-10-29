import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { ActiveTool, GuestSnapshot } from "../../collab/lib/client";
import {
	activityOf,
	backgroundJobs,
	chatOutputs,
	commandSummary,
	devServerUrls,
	editTotals,
	fileEdits,
	foldHelpers,
	type Helper,
	helpersAtWork,
	helpersByCall,
	helpersOf,
	helperJobSnapshots,
	isIntactBase64,
	latestTodo,
	madeCandidates,
	ompRunning,
	planChecklist,
	RECENT_HELPERS,
	runningHelpers,
	settleHelper,
	stripAssignmentPreamble,
	todoChanges,
	todoCounts,
	todoUpdates,
	transcriptHelperStates,
	workSummary,
} from "./derive";
import { pinnedHelpers } from "./pinnedHelpers";

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
	it("retains folders and saved widgets without inventing a folder for a snapshot whose start is missing", () => {
		const widget = { title: "Build", headline: { text: "40 tests" }, blocks: [{ kind: "text", text: "Compiling" }] };
		const entries = [
			call("bash", "bash", { command: "make", cwd: "packages/ui", async: true }),
			result("bash", "bash", "started", { async: { jobId: "bg_1", state: "running" } }),
			result("poll", "job", "", { jobs: [{ id: "bg_1", type: "bash", status: "running", widget }, { id: "bg_2", type: "bash", status: "running", label: "npm test" }] }),
		];
		expect(backgroundJobs(entries, true, undefined, undefined, "/project")).toMatchObject([
			{ jobId: "bg_2", command: "npm test", cwd: null },
			{ jobId: "bg_1", cwd: "/project/packages/ui", widget: { title: "Build", headline: { text: "40 tests" } } },
		]);
	});

	it("reads live wait widgets and never revives a job already settled on disk", () => {
		const entries = [call("bash", "bash", { command: "make", async: true }), result("bash", "bash", "started", { async: { jobId: "bg_1", state: "running" } })];
		const tool: ActiveTool = { toolCallId: "wait", toolName: "wait", args: {}, startedAt: 0, partialResult: { details: { jobs: [{ id: "bg_1", type: "bash", status: "running", widget: { headline: { text: "50/100" }, blocks: [] } }] } } };
		const active = new Map([["wait", tool]]);
		expect(backgroundJobs(entries, true, active)[0]?.widget?.headline?.text).toBe("50/100");
		const settled = [...entries, result("poll", "job", "", { jobs: [{ id: "bg_1", type: "bash", status: "completed", widget: { headline: { text: "100/100" } } }] })];
		expect(backgroundJobs(settled, true, active)[0]).toMatchObject({ state: "completed", widget: { headline: { text: "100/100" } } });
	});

	it("tracks an async bash job from start to delivered result, running jobs first", () => {
		const entries: SessionEntry[] = [
			call("b1", "bash", { command: "npm run dev", async: true }),
			result("b1", "bash", "started", { async: { state: "running", jobId: "j1", type: "bash" } }),
			call("b2", "bash", { command: "npm test", async: true }),
			result("b2", "bash", "started", { async: { state: "running", jobId: "j2", type: "bash" } }),
			{ ...base(), type: "custom_message", customType: "async-result", content: "done", display: true, details: { jobs: [{ jobId: "j2" }] } },
		];
		expect(backgroundJobs(entries, true)).toMatchObject([
			{ jobId: "j1", command: "npm run dev", state: "running", output: "started" },
			{ jobId: "j2", command: "npm test", state: "completed" },
		]);
	});

	it("titles a job with the intent the model gave its call", () => {
		const entries: SessionEntry[] = [
			call("b1", "bash", { command: "npm run dist:mac 2>&1 | tail -25", async: true, i: "Building the macOS installers" }),
			result("b1", "bash", "started", { async: { state: "running", jobId: "bg_1", type: "bash" } }),
			call("b2", "bash", { command: "ls", async: true }),
			result("b2", "bash", "started", { async: { state: "running", jobId: "bg_2", type: "bash" } }),
		];
		expect(backgroundJobs(entries, true).map(job => [job.jobId, job.intent])).toEqual([
			["bg_2", null],
			["bg_1", "Building the macOS installers"],
		]);
	});

	it("takes failure and output from job polls", () => {
		const entries = [
			call("b1", "bash", { command: "make", async: true }),
			result("b1", "bash", "started", { async: { state: "running", jobId: "j1", type: "bash" } }),
			call("p", "job", { poll: ["j1"] }),
			result("p", "job", "", { jobs: [{ id: "j1", status: "failed", errorText: "boom" }, { id: "other", status: "running" }] }),
		];
		expect(backgroundJobs(entries, true)).toMatchObject([{ jobId: "j1", command: "make", state: "failed", output: "boom" }]);
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
		expect(backgroundJobs([], true, active)).toMatchObject([{ jobId: "ja", command: "vite", state: "running", output: "listening" }]);
	});

	it.each(["completed", "failed", "cancelled"] as const)("takes %s from a late background frame without reviving the job", state => {
		const entries = [
			call("b1", "bash", { command: "make", async: true }),
			result("b1", "bash", "started", { async: { jobId: "bg_1", state: "running" } }),
		];
		const tool: ActiveTool = {
			toolCallId: "b1", toolName: "bash", args: { command: "make", async: true }, startedAt: 200,
			partialResult: { details: { output: "finished", async: { jobId: "bg_1", state } } },
		};
		const jobs = backgroundJobs(entries, true, new Map(), new Map([["b1", tool]]));
		expect(jobs).toMatchObject([{ jobId: "bg_1", state, output: "finished", startedAt: 0 }]);
		expect(workSummary(null, [], jobs).jobsRunning).toBe(0);
		// A terminal state is authoritative even if an older host sends it before the end event.
		expect(backgroundJobs(entries, true, new Map([["b1", tool]]))[0]?.state).toBe(state);
	});

	it("keeps a saved completion when the last late frame still said running", () => {
		const entries = [
			call("b1", "bash", { command: "make", async: true }),
			result("b1", "bash", "started", { async: { jobId: "bg_1", state: "running" } }),
			call("wait", "wait", {}),
			result("wait", "wait", "", { jobs: [{ id: "bg_1", status: "completed", resultText: "final output" }] }),
		];
		const late: ActiveTool = {
			toolCallId: "b1", toolName: "bash", args: { command: "make", async: true }, startedAt: 200,
			partialResult: { details: { output: "old output", async: { jobId: "bg_1", state: "running" } } },
		};
		expect(backgroundJobs(entries, true, new Map(), new Map([["b1", late]]))).toMatchObject([{ jobId: "bg_1", state: "completed", output: "final output" }]);
	});

	// Shapes from a saved chat: a CI watcher sent to the background, closed only by a later `wait` snapshot.
	const started = (callId: string, jobId: string, command: string) => [
		call(callId, "bash", { command, async: true }),
		result(callId, "bash", `run=1\n\nBackgrounded as job ${jobId}`, { async: { state: "running", jobId, type: "bash" }, timeoutSeconds: 1500 }),
	];
	const exit = { ...base(), type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal", recordedAt: "2026-10-01T00:20:47.661Z" } } as unknown as SessionEntry;

	it("closes a job from a wait snapshot", () => {
		const entries = [
			...started("b1", "bg_42", "gh run watch"),
			call("w1", "wait", { jobs: ["bg_42"] }),
			result("w1", "wait", "", {
				op: "wait",
				meta: { source: { type: "report", value: "background jobs snapshot" } },
				jobs: [{ id: "bg_42", type: "bash", status: "completed", label: "gh run watch", durationMs: 118131, resultText: "macos-latest success" }],
			}),
		];
		expect(backgroundJobs(entries, true)).toMatchObject([
			{ jobId: "bg_42", command: "gh run watch", state: "completed", output: "macos-latest success", durationMs: 118131 },
		]);
	});

	it("takes a delivered failure from the result's exit line", () => {
		const entries = [
			...started("b1", "bg_1", "make"),
			{
				...base(),
				type: "custom_message",
				customType: "async-result",
				content: "<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\nboom\nCommand exited with code 2\n</system-notice>",
				display: true,
				details: { jobs: [{ jobId: "bg_1", type: "bash", label: "make", durationMs: 40 }] },
			} as SessionEntry,
		];
		expect(backgroundJobs(entries, true)[0]).toMatchObject({ state: "failed", exitCode: 2, durationMs: 40 });
	});

	it("keeps a poll's outcome but takes the later delivery's output, run time and exit code", () => {
		const entries = [
			...started("b1", "bg_7", "make"),
			call("w1", "wait", { jobs: ["bg_7"] }),
			result("w1", "wait", "", { op: "wait", jobs: [{ id: "bg_7", type: "bash", status: "failed", errorText: "boom" }] }),
			{
				...base(),
				type: "custom_message",
				customType: "async-result",
				content: "<system-notice>\nBackground job bg_7 has completed. Resume your work using the result below.\nbuild log\nboom\nCommand exited with code 3\n</system-notice>",
				display: true,
				details: { jobs: [{ jobId: "bg_7", type: "bash", label: "make", durationMs: 2500 }] },
			} as SessionEntry,
		];
		expect(backgroundJobs(entries, true)[0]).toMatchObject({ state: "failed", output: "build log\nboom\nCommand exited with code 3", durationMs: 2500, exitCode: 3 });
	});

	it("stops jobs nobody reported finished once omp is gone: at a session_exit, or with no omp running now", () => {
		const entries = [...started("b1", "bg_42", "old watcher"), exit, ...started("b2", "bg_50", "new watcher")];
		expect(backgroundJobs(entries, true).map(job => [job.jobId, job.state])).toEqual([
			["bg_50", "running"],
			["bg_42", "cancelled"],
		]);
		expect(backgroundJobs(entries, false).map(job => job.state)).toEqual(["cancelled", "cancelled"]);
	});
});

describe("commandSummary", () => {
	it("skips shell setup to the first step that does something", () => {
		expect(commandSummary('set -e\nMD5=$(md5 -q wp/elementor_data.json)\ncurl -s https://example.com/api')).toBe("curl -s https://example.com/api");
		expect(commandSummary('set -e && git add -A && git commit -q -m "How it works"')).toBe("git add -A");
		expect(commandSummary("cd sites/main && export NODE_ENV=production && npm run build")).toBe("npm run build");
		// A CI watcher from a saved chat: a pause, a lookup assignment and a status echo come before the real step.
		expect(
			commandSummary('sleep 10; id=$(gh run list --workflow Release --limit 1 --json databaseId -q \'.[0].databaseId\'); echo "run=$id"; gh run watch "$id" --exit-status'),
		).toBe('gh run watch "$id" --exit-status');
	});

	it("splits only at top-level separators, never inside quotes, substitutions or here-documents", () => {
		expect(commandSummary('echo "starting; please wait"; npm run build')).toBe("npm run build");
		expect(commandSummary("ID=$(gh run list --limit 1 \\\n  --json databaseId -q '.[0].databaseId'); gh run watch \"$ID\"")).toBe('gh run watch "$ID"');
		expect(commandSummary("RUN=$(\n  gh run list --limit 1\n)\ngh run view \"$RUN\" --log-failed | tail -40")).toBe('gh run view "$RUN" --log-failed | tail -40');
		expect(commandSummary("cat > /tmp/inspect.sh <<'EOF'\ncd sites/main; echo \"it's here\"\nEOF\nbash /tmp/inspect.sh")).toBe("cat > /tmp/inspect.sh <<'EOF'");
		// The body ends only at a line that is exactly the marker: not a near match, not a space-indented copy.
		expect(commandSummary("echo ready <<'END.TXT'\nENDxTXT\n  END.TXT\nrm -rf body\nEND.TXT\nbash a.sh")).toBe("bash a.sh");
		expect(commandSummary("echo ready <<-END\n\tnot yet\n\tEND\nbash b.sh")).toBe("bash b.sh");
		expect(commandSummary("set -e # stop on the first error\nnpm test 2>&1 | tail -5")).toBe("npm test 2>&1 | tail -5");
	});

	it("falls back to the first line when the quoting does not balance, keeps setup-only commands, and shortens long steps", () => {
		expect(commandSummary("case $x in a) npm test ;; esac")).toBe("case $x in a) npm test ;; esac");
		expect(commandSummary("set -e")).toBe("set -e");
		expect(commandSummary(`curl ${"x".repeat(200)}`)).toHaveLength(120);
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
		expect(output).toEqual({
			key: "/var/T/omp-image-1.webp",
			kind: "image",
			path: "/var/T/omp-image-1.webp",
			tool: "generate_image",
			action: "generated",
			produced: true,
			relation: "created",
			time: 5,
			inline: { kind: "blob", hash: BLOB },
		});
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

	const relations = (entries: SessionEntry[], made = {}) => chatOutputs(entries, context, made).map(({ key, relation }) => `${relation} ${key}`);

	it("claims a file is new only when omp reports it: a patch-mode create or a generated image, even when omp edits or views it later", () => {
		const inner = { imagePaths: ["/var/T/omp-image-2.webp"], images: [{ data: `blob:sha256:${BLOB}`, mimeType: "image/webp" }] };
		const entries = [
			...tool("e1", "edit", { input: "" }, 1, { details: { perFileResults: [{ path: "/proj/added.ts", op: "create" }, { path: "/proj/old.ts", op: "update" }] } }),
			...tool("e2", "edit", { input: "" }, 2, { details: { path: "/proj/added.ts" } }),
			...tool("g1", "write", { path: "xd://generate_image", content: "{}" }, 3, {
				details: { xdev: { tool: "generate_image", mode: "execute", args: { subject: "cat" }, inner } },
			}),
			...tool("r1", "read", { path: "/var/T/omp-image-2.webp" }, 4, { blocks: [image(PNG)] }),
		];
		expect(relations(entries)).toEqual(["created /var/T/omp-image-2.webp", "created /proj/added.ts", "changed /proj/old.ts"]);
		expect(chatOutputs(entries, context)[2].action).toBe("edited");
	});

	it("calls a write over a file the chat never opened written, since it may be new or replaced, and keeps that through later edits", () => {
		const entries = [
			...tool("w1", "write", { path: "existing-unread.ts" }, 1),
			...tool("e1", "edit", { input: "" }, 2, { details: { path: "existing-unread.ts" } }),
			...tool("r1", "read", { path: "missing.ts" }, 3, { isError: true }),
			...tool("w2", "write", { path: "missing.ts" }, 4),
		];
		expect(relations(entries)).toEqual(["written /proj/missing.ts", "written /proj/existing-unread.ts"]);
	});

	it("calls a file changed once the chat shows it existed: an edit, or a write or command after reading or viewing it", () => {
		const entries = [
			...tool("e1", "edit", { input: "" }, 1, { details: { path: "kept.ts" } }),
			...tool("r1", "read", { path: "old.ts" }, 2),
			...tool("w1", "write", { path: "old.ts" }, 3),
			...tool("r2", "read", { path: "/tmp/poster.png" }, 4, { blocks: [image(PNG)] }),
			...tool("w2", "write", { path: "/tmp/poster.png" }, 5),
			...tool("r3", "read", { path: "/proj/config.json" }, 6),
			...tool("b1", "bash", { command: "npm run fmt" }, 7),
			...tool("r4", "read", { path: "/tmp/shot.png" }, 8, { blocks: [image(PNG)] }),
		];
		const made = { b1: [{ path: "/proj/config.json", mtime: 7, size: 1 }] };
		expect(relations(entries, made)).toEqual([
			"viewed /tmp/shot.png",
			"changed /proj/config.json",
			"changed /tmp/poster.png",
			"changed /proj/old.ts",
			"changed /proj/kept.ts",
		]);
	});

	it("calls a file a command left modified written when the chat hadn't seen it, since the scan can't tell new from replaced", () => {
		const entries = tool("b1", "bash", { command: "make" }, 10);
		const made = { b1: [{ path: "/out/report.pdf", mtime: 9, size: 1 }] };
		expect(relations(entries, made)).toEqual(["written /out/report.pdf"]);
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

	it("lists PDFs omp read as viewed, without the page images the read rendered", () => {
		const entries = tool("p1", "read", { path: "docs/flyer.pdf:2" }, 7, { details: { resolvedPath: "/proj/docs/flyer.pdf" }, blocks: [image(PNG)] });
		expect(chatOutputs(entries, context)).toEqual([
			{ key: "/proj/docs/flyer.pdf", kind: "pdf", path: "/proj/docs/flyer.pdf", tool: "read", action: "viewed", produced: false, relation: "viewed", time: 7, inline: null },
		]);
	});

	it("places files a command made at that call, so the newest use wins and a file viewed after it was made stays made", () => {
		const entries = [
			...tool("b1", "bash", { command: "make" }, 10),
			...tool("r1", "read", { path: "/out/previews/1.png" }, 20, { blocks: [image(PNG)] }),
			...tool("r2", "read", { path: "/tmp/scratch.png" }, 25, { blocks: [image(PNG)] }),
			...tool("b2", "bash", { command: "make" }, 30, { isError: true }),
		];
		const made = {
			b1: [
				{ path: "/out/previews/1.png", mtime: 9, size: 1 },
				{ path: "/out/flyer.pdf", mtime: 8, size: 1 },
			],
			b2: [{ path: "/out/notes.txt", mtime: 29, size: 1 }],
		};
		const outputs = chatOutputs(entries, context, made);
		expect(outputs.map(({ kind, action, produced, key, time }) => `${kind} ${action}${produced ? " (made)" : ""} ${key} @${time}`)).toEqual([
			"file made (made) /out/notes.txt @30",
			"image viewed /tmp/scratch.png @25",
			"image viewed (made) /out/previews/1.png @20",
			"pdf made (made) /out/flyer.pdf @10",
		]);
	});
});

describe("madeCandidates", () => {
	const context = { cwd: "/proj", home: "/Users/me" };

	function callAt(id: string, name: string, args: Record<string, unknown>, time: number): SessionEntry {
		const entry = call(id, name, args);
		if (entry.type === "message") entry.message.timestamp = time;
		return entry;
	}
	function resultAt(id: string, name: string, text: string, time: number, details?: unknown): SessionEntry {
		const entry = result(id, name, text, details);
		if (entry.type === "message") entry.message.timestamp = time;
		return entry;
	}
	/** omp's bookkeeping entry, written to saved sessions only. */
	const started = (toolCallId: string, at: string) =>
		({ ...base(), type: "custom", customType: "tool_execution_start", data: { toolCallId, startedAt: at } }) as unknown as SessionEntry;

	it("finds the folder a shell variable names and the paths printed by the command", () => {
		const command = [
			'OUTDIR="/Users/me/Out" && mkdir -p "$OUTDIR/previews" && python3 - "$OUTDIR" <<\'PY\'',
			"import sys, fitz",
			"PY",
			"ls ~/Out/*.pdf",
		].join("\n");
		const entries = [callAt("b1", "bash", { command }, 1000), resultAt("b1", "bash", "wrote /Users/me/Out/flyer.pdf, done.\n", 5000)];
		expect(madeCandidates(entries, context)).toEqual([
			{ id: "b1", paths: ["/Users/me/Out", "/Users/me/Out/previews", "/Users/me/Out/flyer.pdf"], start: 1000, end: 5000 },
		]);
	});

	it("keeps Windows separators in drive and UNC paths, quoted or printed", () => {
		const command = String.raw`python render.py --out "C:\Users\me\Out" && dir C:/Users/me/Out/*.pdf`;
		const output = [String.raw`Saved C:\Users\me\Out\flyer.pdf.`, String.raw`Shared to \\nas\team\flyers\flyer.pdf`, String.raw`['C:\\Users\\me\\Out\\a.png']`].join("\n");
		const entries = [callAt("w1", "bash", { command }, 1000), resultAt("w1", "bash", output, 2000)];
		expect(madeCandidates(entries, context)[0].paths).toEqual([
			String.raw`C:\Users\me\Out`,
			"C:/Users/me/Out",
			String.raw`C:\Users\me\Out\flyer.pdf`,
			String.raw`\\nas\team\flyers\flyer.pdf`,
			String.raw`C:\Users\me\Out\a.png`,
		]);
	});

	it("reads paths from code, resolves relative ones against the call's folder, and ignores apostrophes in prose", () => {
		const code = "fig.savefig('/tmp/chart.png')\nopen(\"report/summary.pdf\", \"wb\")\nprint('It is saved to /tmp/out.pdf, isn' + 't it')";
		const entries = [callAt("e1", "eval", { language: "py", code, cwd: "/work" }, 100), resultAt("e1", "eval", "", 200)];
		// The `cwd` argument names a folder too, so it is checked like any other path.
		expect(madeCandidates(entries, context)[0].paths).toEqual(["/tmp/chart.png", "/work/report/summary.pdf", "/tmp/out.pdf", "/work"]);
	});

	it("starts the window at omp's recorded start, else at the call, else at the result", () => {
		const entries = [
			callAt("a", "bash", { command: "touch /tmp/a.png" }, 1000),
			started("a", "1970-01-01T00:00:02.000Z"),
			resultAt("a", "bash", "", 3000),
			callAt("b", "bash", { command: "touch /tmp/b.png" }, 4000),
			resultAt("b", "bash", "", 6000),
			call("c", "bash", { command: "touch /tmp/c.png" }),
			resultAt("c", "bash", "", 9000),
		];
		expect(madeCandidates(entries, context).map(({ id, start, end }) => `${id} ${start}-${end}`)).toEqual(["a 2000-3000", "b 4000-6000", "c 9000-9000"]);
	});

	it("extends a background job's window to the delivery of its result, and skips calls that name nothing", () => {
		const delivered = { ...base(), timestamp: "1970-01-01T00:00:50.000Z", type: "custom_message", customType: "async-result", content: "", details: { jobId: "j1" }, display: false } as SessionEntry;
		const entries = [
			callAt("j", "bash", { command: "render.sh > /tmp/r.pdf", async: true }, 1000),
			resultAt("j", "bash", "started", 2000, { async: { jobId: "j1", state: "running" } }),
			callAt("n", "bash", { command: "echo hi" }, 3000),
			resultAt("n", "bash", "hi", 4000),
			callAt("r", "read", { path: "/tmp/r.pdf" }, 5000),
			resultAt("r", "read", "", 6000),
			delivered,
		];
		expect(madeCandidates(entries, context)).toEqual([{ id: "j", paths: ["/tmp/r.pdf"], start: 1000, end: 50_000 }]);
	});
});

describe("isIntactBase64", () => {
	it("rejects data the live stream cut short", () => {
		expect(isIntactBase64("iVBORw0KGgo=")).toBe(true);
		expect(isIntactBase64("iVBORw0KGgo\n…[120 chars elided for collab session]")).toBe(false);
		expect(isIntactBase64("blob:sha256:abc")).toBe(false);
	});
});

describe("todo updates", () => {
	const phases = (...tasks: [string, string][]) => ({ phases: [{ name: "P", tasks: tasks.map(([content, status]) => ({ content, status })) }] });

	it("pairs each successful board with the one it replaced, counting a repeated result once", () => {
		const entries = [
			call("t1", "todo", { op: "init" }),
			result("t1", "todo", "", phases(["a", "pending"])),
			result("t1", "todo", "", phases(["a", "pending"])),
			call("t2", "todo", { op: "bad" }),
			result("t2", "todo", "error", phases(), true),
			call("t3", "todo", { op: "done" }),
			result("t3", "todo", "", phases(["a", "completed"])),
		];
		const updates = todoUpdates(entries);
		expect(updates.map(update => update.callId)).toEqual(["t1", "t3"]);
		expect(updates[0]?.previous).toBeNull();
		expect(updates[1]?.previous).toEqual([{ name: "P", tasks: [{ content: "a", status: "pending" }] }]);
	});

	it("describes what an update changed, status moves first", () => {
		const before = [{ name: "P", tasks: [{ content: "a", status: "in_progress" as const }, { content: "b", status: "pending" as const }, { content: "gone", status: "pending" as const }] }];
		const after = [{ name: "P", tasks: [{ content: "new", status: "pending" as const }, { content: "a", status: "completed" as const }, { content: "b", status: "in_progress" as const }] }];
		expect(todoChanges(before, after)).toEqual([
			{ kind: "completed", task: "a" },
			{ kind: "started", task: "b" },
			{ kind: "added", task: "new" },
			{ kind: "removed", task: "gone" },
		]);
	});

	it("counts abandoned tasks apart from the total", () => {
		const board = [{ name: "P", tasks: [{ content: "a", status: "completed" as const }, { content: "b", status: "abandoned" as const }, { content: "c", status: "pending" as const }] }];
		expect(todoCounts(board)).toEqual({ done: 1, total: 2, abandoned: 1 });
	});
});

describe("fileEdits and editTotals", () => {
	const context = { cwd: "/proj", home: "/Users/me" };

	it("counts lines from omp's diffs and skips failed calls, failed files and unapplied previews", () => {
		const entries = [
			call("e1", "edit", { path: "a.ts" }),
			result("e1", "edit", "", { diff: "--- a\n+++ b\n+one\n+two\n-three\n context" }),
			result("e1", "edit", "", { diff: "+one" }),
			call("e2", "edit", {}),
			result("e2", "edit", "", {
				perFileResults: [
					{ path: "/proj/a.ts", diff: "+x" },
					{ path: "/proj/bad.ts", diff: "+x", isError: true },
					{ path: "new.ts", op: "create", diff: "+1\n+2" },
				],
			}),
			call("e3", "edit", { path: "c.ts" }),
			result("e3", "edit", "boom", { diff: "+1" }, true),
			call("s1", "ast_edit", {}),
			result("s1", "ast_edit", "", { applied: false, fileReplacements: [{ path: "staged.ts" }] }),
			call("x1", "reject", { action: "discard" }),
			result("x1", "reject", "", {}),
			call("w1", "write", { path: "/proj/a.ts" }),
			result("w1", "write", "", {}),
		];
		const edits = fileEdits(entries, context);
		expect([...edits.keys()]).toEqual(["e1", "e2", "w1"]);
		expect(edits.get("e1")).toEqual([{ path: "/proj/a.ts", action: "edited", added: 2, removed: 1 }]);
		expect(edits.get("e2")).toEqual([
			{ path: "/proj/a.ts", action: "edited", added: 1, removed: 0 },
			{ path: "/proj/new.ts", action: "created", added: 2, removed: 0 },
		]);

		expect(editTotals(edits, ["e1", "e2"])).toEqual({
			files: [
				{ path: "/proj/a.ts", action: "edited", added: 3, removed: 1 },
				{ path: "/proj/new.ts", action: "created", added: 2, removed: 0 },
			],
			added: 5,
			removed: 1,
			partial: false,
		});
		// Repeated assistant call ids can appear around transcript replay; the diff for that call counts once.
		expect(editTotals(edits, ["e1", "e1", "e2"])).toEqual({
			files: [
				{ path: "/proj/a.ts", action: "edited", added: 3, removed: 1 },
				{ path: "/proj/new.ts", action: "created", added: 2, removed: 0 },
			],
			added: 5,
			removed: 1,
			partial: false,
		});
		// A write has no diff, so the file's totals become unknown and leave the sums.
		expect(editTotals(edits, ["e1", "w1"])).toEqual({ files: [{ path: "/proj/a.ts", action: "edited", added: null, removed: null }], added: 0, removed: 0, partial: true });
	});

	it("credits an applied ast_edit preview to the resolve call", () => {
		const entries = [
			call("s1", "ast_edit", {}),
			result("s1", "ast_edit", "", { applied: false, fileReplacements: [{ path: "x.ts" }] }),
			call("r1", "resolve", { action: "apply" }),
			result("r1", "resolve", "", { action: "apply", sourceToolName: "ast_edit" }),
		];
		expect([...fileEdits(entries, context)]).toEqual([["r1", [{ path: "/proj/x.ts", action: "edited", added: null, removed: null }]]]);
	});
});

describe("planChecklist", () => {
	it("reads checkbox steps outside code fences", () => {
		const plan = ["# Plan", "- [x] Inventory", "1. [ ] Rewrite", "  - [X] nested", "```", "- [ ] not a step", "```", "- plain"].join("\n");
		expect(planChecklist(plan)).toEqual([
			{ text: "Inventory", checked: true, depth: 0 },
			{ text: "Rewrite", checked: false, depth: 0 },
			{ text: "nested", checked: true, depth: 1 },
		]);
	});

	it("is null for prose plans", () => {
		expect(planChecklist("# Plan\n\n1. Do it\n- then this")).toBeNull();
	});
});

describe("helpersOf and workSummary", () => {
	const progress = {
		index: 0,
		id: "Atlas",
		agent: "task",
		status: "running" as const,
		task: "Scan\nthe store",
		currentToolIntent: "Reading limits",
		recentTools: [],
		recentOutput: [],
		toolCount: 6,
		requests: 3,
		tokens: 12_400,
		contextTokens: 40_000,
		contextWindow: 0,
		cost: 0,
		durationMs: 61_000,
		resolvedModel: "opus",
	};

	it("keeps the progress fields omp reports, with the time the report arrived, and drops unknown denominators", () => {
		const guest = {
			agents: [{ id: "Atlas", displayName: "Atlas", kind: "sub" as const, status: "running" as const, hasSessionFile: true, createdAt: 0, lastActivity: 0 }],
			progress: new Map([["Atlas", { index: 0, agent: "task", task: "", progress, receivedAt: 5_000 }]]),
			lifecycle: new Map([["Bolt", { id: "Bolt", agent: "explore", status: "completed" as const, index: 1, description: "Look around" }]]),
		};
		const helpers = helpersOf(guest, true);
		expect(helpers).toEqual([
			{
				id: "Atlas",
				name: "Atlas",
				status: "running",
				activity: "Reading limits",
				completionPercent: null,
				tokens: 12_400,
				toolCount: 6,
				durationMs: 61_000,
				durationAt: 5_000,
				contextTokens: 40_000,
				contextWindow: null,
				model: "opus",
				hasTranscript: true,
				messageable: true,
			},
			{
				id: "Bolt",
				name: "explore",
				status: "done",
				activity: "Look around",
				completionPercent: null,
				tokens: null,
				toolCount: null,
				durationMs: null,
				durationAt: null,
				contextTokens: null,
				contextWindow: null,
				model: null,
				hasTranscript: false,
				messageable: false,
			},
		]);
		const jobs = [{ jobId: "j", command: "x", intent: null, state: "running" as const, output: "", startedAt: null, durationMs: null, exitCode: null }];
		expect(workSummary(latestTodo([]), helpers, jobs)).toEqual({ tasks: null, helpersWorking: 1, jobsRunning: 1 });
		// A stale mirror after omp is gone: nothing works any more, finished helpers keep their outcome.
		expect(helpersOf(guest, false).map(helper => `${helper.id}:${helper.status}`)).toEqual(["Atlas:stopped", "Bolt:done"]);
	});

	it("groups live helpers under the task call that started them, in the call's order", () => {
		const byCall = helpersByCall(
			{
				agents: [],
				progress: new Map([
					["B", { index: 1, agent: "task", task: "", parentToolCallId: "k1", progress: { ...progress, id: "B", index: 1, status: "completed" as const }, receivedAt: 0 }],
					["A", { index: 0, agent: "task", task: "", parentToolCallId: "k1", progress: { ...progress, id: "A" }, receivedAt: 0 }],
					["X", { index: 0, agent: "task", task: "", progress: { ...progress, id: "X" }, receivedAt: 0 }],
				]),
				lifecycle: new Map([["C", { id: "C", agent: "explore", status: "started" as const, index: 0, parentToolCallId: "k2" }]]),
			},
			true,
		);
		expect([...byCall.keys()]).toEqual(["k1", "k2"]);
		expect(byCall.get("k1")?.map(helper => `${helper.id}:${helper.status}`)).toEqual(["A:running", "B:done"]);
		expect(byCall.get("k2")?.map(helper => helper.status)).toEqual(["running"]);
	});

	type AgentStatus = "running" | "idle" | "parked" | "aborted";
	const agent = (id: string, status: AgentStatus, lastActivity: number) => ({ id, displayName: id, kind: "sub" as const, status, hasSessionFile: true, createdAt: 0, lastActivity });
	const report = (id: string, status: "running" | "completed" | "failed", receivedAt: number) => [id, { index: 0, agent: "task", task: "", progress: { ...progress, id, status }, receivedAt }] as const;
	const states = (helpers: readonly { id: string; status: string; messageable: boolean }[]) => helpers.map(helper => `${helper.id}:${helper.status}${helper.messageable ? ":msg" : ""}`);
	const pinnedIds = (helpers: readonly Helper[]) => [...pinnedHelpers(helpers).ids];

	it("shows a helper omp keeps for a follow-up (idle or parked) as done, and it still takes a message", () => {
		const guest = {
			agents: [agent("Idle", "idle", 30), agent("Parked", "parked", 20), agent("Kept", "idle", 10), agent("Gone", "aborted", 5)],
			progress: new Map([report("Kept", "failed", 10)]),
			lifecycle: new Map(),
		};
		// A failed helper omp kept takes a message too; an aborted one omp let go of does not.
		expect(states(helpersOf(guest, true))).toEqual(["Idle:done:msg", "Parked:done:msg", "Kept:failed:msg", "Gone:stopped"]);
		expect(workSummary(null, helpersOf(guest, true), []).helpersWorking).toBe(0);
		expect(pinnedIds(helpersOf(guest, true))).toEqual([]);
	});

	it("lists running helpers first in omp's order, then finished ones newest first", () => {
		const guest = {
			agents: [agent("Old", "parked", 100), agent("Run1", "running", 50), agent("New", "idle", 300), agent("Run2", "running", 10)],
			// The latest progress report counts over omp's last activity time, which parking moves on.
			progress: new Map([report("Old", "completed", 400), report("Mid", "failed", 200)]),
			// Without a time, a helper only the lifecycle reported is the oldest.
			lifecycle: new Map([["Life", { id: "Life", agent: "task", status: "completed" as const, index: 0 }]]),
		};
		expect(states(helpersOf(guest, true))).toEqual(["Run1:running:msg", "Run2:running:msg", "Old:done:msg", "New:done:msg", "Mid:failed", "Life:done"]);
	});

	it("stops working helpers once omp is gone, and keeps done ones done without a message", () => {
		const guest = { agents: [agent("Run", "running", 1), agent("Parked", "parked", 2)], progress: new Map(), lifecycle: new Map() };
		expect(states(helpersOf(guest, false))).toEqual(["Parked:done", "Run:stopped"]);
	});

	it("shows a parked helper as running again once a message starts a new turn", () => {
		const before = {
			agents: [agent("Atlas", "parked", 1)],
			progress: new Map([report("Atlas", "completed", 1)]),
			lifecycle: new Map([["Atlas", { id: "Atlas", agent: "task", status: "completed" as const, index: 0 }]]),
		};
		expect(states(helpersOf(before, true))).toEqual(["Atlas:done:msg"]);
		// omp reports the follow-up turn as started before its progress, and the registry says running.
		const woken = { ...before, lifecycle: new Map([["Atlas", { id: "Atlas", agent: "task", status: "started" as const, index: 0 }]]) };
		expect(states(helpersOf(woken, true))).toEqual(["Atlas:running:msg"]);
		const running = { agents: [agent("Atlas", "running", 2)], progress: new Map([report("Atlas", "running", 2)]), lifecycle: woken.lifecycle };
		expect(states(helpersOf(running, true))).toEqual(["Atlas:running:msg"]);
		expect(pinnedIds(helpersOf(running, true))).toEqual(["Atlas"]);
	});

	describe("runningHelpers", () => {
		type Sources = Parameters<typeof helpersOf>[0] & object;
		/** A chat's view on a running omp (or an exited one) with these helper sources. */
		const view = (guest: Sources, live = true) => ({ guest: guest as GuestSnapshot, mode: live ? ("live" as const) : ("exited" as const), readOnly: false, follow: null });
		const cases: Sources[] = [
			{ agents: [agent("Run1", "running", 1), agent("Run2", "running", 2)], progress: new Map(), lifecycle: new Map() },
			{ agents: [agent("Idle", "idle", 3), agent("Parked", "parked", 2), agent("Gone", "aborted", 1)], progress: new Map([report("Idle", "failed", 3)]), lifecycle: new Map() },
			// The registry still says running after the task reported it finished.
			{ agents: [agent("Atlas", "running", 1)], progress: new Map([report("Atlas", "completed", 1)]), lifecycle: new Map() },
			// Known from progress or lifecycle alone; a lifecycle start wakes a parked helper.
			{ agents: [agent("Atlas", "parked", 1)], progress: new Map([report("Solo", "running", 1)]), lifecycle: new Map([["Atlas", { id: "Atlas", agent: "task", status: "started" as const, index: 0 }]]) },
			{ agents: [], progress: new Map(), lifecycle: new Map([["Bolt", { id: "Bolt", agent: "task", status: "completed" as const, index: 0 }]]) },
		];

		it("counts the running helpers helpersOf lists, and none once omp is gone", () => {
			expect(cases.map(guest => runningHelpers(view(guest)))).toEqual(cases.map(guest => helpersOf(guest, true).filter(helper => helper.status === "running").length));
			expect(cases.map(guest => runningHelpers(view(guest)))).toEqual([2, 0, 0, 2, 0]);
			expect(cases.map(guest => runningHelpers(view(guest, false)))).toEqual([0, 0, 0, 0, 0]);
			expect(runningHelpers(null)).toBe(0);
		});

		it("reuses the count while the helper lists stay the same, and counts again when omp replaces one", () => {
			const agents = [agent("Run", "running", 1)];
			const guest = { agents, progress: new Map(), lifecycle: new Map() };
			expect(runningHelpers(view(guest))).toBe(1);
			// Changed in place, the same lists: the cached count stands, so nothing was walked again.
			agents.push(agent("Late", "running", 2));
			expect(runningHelpers(view({ ...guest }))).toBe(1);
			// The collab client publishes a new list or map with each helper update; replacing any one of them counts again.
			expect(runningHelpers(view({ ...guest, agents: [...agents] }))).toBe(2);
			const reported = { agents: [agent("Run", "running", 1)], progress: new Map(), lifecycle: new Map() };
			expect(runningHelpers(view(reported))).toBe(1);
			expect(runningHelpers(view({ ...reported, progress: new Map([report("Run", "completed", 3)]) }))).toBe(0);
			const parked = { agents: [agent("Run", "parked", 1)], progress: new Map(), lifecycle: new Map() };
			expect(runningHelpers(view(parked))).toBe(0);
			const woken = new Map([["Run", { id: "Run", agent: "task", status: "started" as const, index: 0 }]]);
			expect(runningHelpers(view({ ...parked, lifecycle: woken }))).toBe(1);
			expect(helpersAtWork(view(parked))).toBe(false);
			expect(helpersAtWork(view(reported))).toBe(true);
		});
	});
});

describe("foldHelpers", () => {
	const make = (id: string, status: "running" | "done" | "failed" | "stopped") => ({
		id,
		name: id,
		status,
		activity: "",
		tokens: null,
		toolCount: null,
		durationMs: null,
		durationAt: null,
		contextTokens: null,
		contextWindow: null,
		model: null,
		hasTranscript: false,
		messageable: status !== "stopped",
	});
	// helpersOf order: running, then finished newest first.
	const running = [make("R1", "running"), make("R2", "running")];
	const done = ["D1", "D2", "D3"].map(id => make(id, "done"));
	const parked = Array.from({ length: 10 }, (_, index) => make(`P${index + 1}`, "done"));
	const failed = make("F", "failed");
	const ids = (helpers: readonly { id: string }[]) => helpers.map(helper => helper.id);

	it("lists running helpers, the latest finished ones, then any older failed one, and counts the rest", () => {
		expect(RECENT_HELPERS).toBe(3);
		const helpers = [...running, ...done, ...parked, failed];
		const folded = foldHelpers(helpers, false);
		expect(ids(folded.shown)).toEqual(["R1", "R2", "D1", "D2", "D3", "F"]);
		expect(folded.earlier).toBe(10);
		const expanded = foldHelpers(helpers, true);
		expect(expanded.shown).toBe(helpers);
		expect(expanded.earlier).toBe(10);
	});

	it("retains an older helper's running child job across expand and collapse without losing the toggle count", () => {
		const helpers = [...done, ...parked.slice(0, 3)];
		const jobs = new Map([["P2", [{ jobId: "child", command: "make", intent: null, state: "running" as const, output: "", startedAt: null, durationMs: null, exitCode: null }]]]);
		const collapsed = foldHelpers(helpers, false, jobs);
		expect(ids(collapsed.shown)).toEqual(["D1", "D2", "D3", "P2"]);
		expect(collapsed.earlier).toBe(2);
		const expanded = foldHelpers(helpers, true, jobs);
		expect(expanded.shown).toBe(helpers);
		expect(expanded.earlier).toBe(2);
		expect(foldHelpers(helpers, false, jobs)).toEqual(collapsed);
	});

	it("counts a recent failed helper among the latest and never folds a running one", () => {
		const folded = foldHelpers([...running, failed, ...done, ...parked.slice(0, 2)], false);
		expect(ids(folded.shown)).toEqual(["R1", "R2", "F", "D1", "D2"]);
		expect(folded.earlier).toBe(3);
		expect(foldHelpers([...running, ...done], false)).toEqual({ shown: [...running, ...done], earlier: 0 });
	});
});

describe("transcriptHelperStates and settleHelper", () => {
	// Shapes from a saved chat: a background spawn returns with pending progress; a wait snapshot and omp's
	// async-result delivery later report the end.
	const spawn = (callId: string, id: string) => [
		call(callId, "task", { tasks: [{ name: id, agent: "astra", task: "Review." }] }),
		result(callId, "task", `Started ${id}`, {
			results: [],
			totalDurationMs: 0,
			progress: [{ index: 0, id, agent: "astra", status: "pending", task: "Complete assignment thoroughly:\n\nReview.", recentTools: [], recentOutput: [] }],
			async: { state: "running", jobId: id, type: "task" },
		}),
	];
	const delivered = (jobId: string, id: string, status: string) =>
		({
			...base(),
			type: "custom_message",
			customType: "async-result",
			display: true,
			content: `<system-notice>\nBackground job ${jobId} has completed. Resume your work using the result below.\n<task-result id="${id}" agent="astra" status="${status}" duration="21.1s">\n<meta lines="4" size="53B" />\n<output>\n{ "verdict": "APPROVED" }\n</output>\n</task-result>\n</system-notice>`,
			details: { meta: { source: { type: "report", value: "background job delivery" } }, jobs: [{ jobId, type: "task", label: id, durationMs: 6 }] },
		}) as SessionEntry;
	const exit = { ...base(), type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal" } } as unknown as SessionEntry;
	const pendingRun = {
		id: "AdvisorContext",
		name: "AdvisorContext",
		status: "running" as const,
		activity: "",
		tokens: null,
		toolCount: null,
		durationMs: null,
		durationAt: null,
		contextTokens: null,
		contextWindow: null,
		model: null,
		hasTranscript: false,
		messageable: false,
	};

	it("follows wait snapshots and async-result deliveries, latest last", () => {
		const states = transcriptHelperStates([
			...spawn("k1", "AdvisorContext"),
			...spawn("k2", "Reviewer"),
			call("w", "wait", {}),
			result("w", "wait", "", { op: "wait", jobs: [{ id: "Reviewer", type: "task", status: "completed", label: "Reviewer", agentUrlId: "Reviewer" }] }),
			delivered("AdvisorContext", "AdvisorContext", "failed (exit 1)"),
			...spawn("k3", "Later"),
		]);
		expect(Object.fromEntries(states)).toEqual({ AdvisorContext: "failed", Reviewer: "done", Later: "running" });
	});

	it("reads a messaged helper's second run by its label", () => {
		const states = transcriptHelperStates([...spawn("k1", "AdvisorWave1Features"), delivered("AdvisorWave1Features-2", "AdvisorWave1Features", "completed")]);
		expect(states.get("AdvisorWave1Features")).toBe("done");
	});

	it("stops helpers still working at a session_exit", () => {
		const states = transcriptHelperStates([...spawn("k1", "Old"), exit, ...spawn("k2", "New")]);
		expect(Object.fromEntries(states)).toEqual({ Old: "stopped", New: "running" });
	});

	it("applies the recorded state, then stops what still works without omp", () => {
		expect(settleHelper(pendingRun, new Map([["AdvisorContext", "done"]]), false).status).toBe("done");
		expect(settleHelper(pendingRun, new Map(), true)).toBe(pendingRun);
		expect(settleHelper(pendingRun, null, false).status).toBe("stopped");
		expect(settleHelper({ ...pendingRun, status: "done", messageable: true }, null, false)).toMatchObject({ status: "done", messageable: false });
		expect(settleHelper({ ...pendingRun, messageable: true }, null, false)).toMatchObject({ status: "stopped", messageable: false });
		expect(settleHelper({ ...pendingRun, status: "failed" }, null, false).status).toBe("failed");
	});
});

describe("ompRunning", () => {
	const following = (ownership: "elsewhere" | "free" | "unknown") => ({ mode: "history" as const, readOnly: true, follow: { readable: true, error: null, ownership } });

	it("counts this tab's omp and another process following the file, never a plain saved chat or an exited omp", () => {
		expect(["starting", "live", "reconnecting"].map(mode => ompRunning({ mode: mode as "live", readOnly: false, follow: null }))).toEqual([true, true, true]);
		expect(ompRunning({ mode: "history", readOnly: false, follow: null })).toBe(false);
		expect(ompRunning({ mode: "exited", readOnly: false, follow: null })).toBe(false);
		expect(ompRunning(null)).toBe(false);
	});

	it("stops counting a read-only follower once the other process lets go of the file", () => {
		expect(ompRunning(following("elsewhere"))).toBe(true);
		expect(ompRunning(following("unknown"))).toBe(true);
		expect(ompRunning({ mode: "history", readOnly: true, follow: null })).toBe(true);
		// Elsewhere → free: the tab stays read-only until Continue here, but nothing runs the chat's work any more.
		expect(ompRunning(following("free"))).toBe(false);
	});
});

describe("activityOf", () => {
	// The `task` omp reports for a pending helper: its assignment wrapped in subagent-user-prompt.md.
	const task = "Complete assignment thoroughly:\n\n# Target\nProve the HOMEBREW_NO_ASK fix with a throwaway cask.\n\n# Change\n1. Build it";

	it("shows the assignment without omp's preamble or a heading before the helper does anything", () => {
		expect(activityOf({ task, recentTools: [], recentOutput: [] })).toBe("Prove the HOMEBREW_NO_ASK fix with a throwaway cask.");
		expect(activityOf({ task: "Complete assignment thoroughly:\n\n# Only a heading" })).toBe("Only a heading");
		expect(activityOf({ task: "Complete assignment thoroughly:\n\n" })).toBe("");
		expect(stripAssignmentPreamble(task)).toBe("# Target\nProve the HOMEBREW_NO_ASK fix with a throwaway cask.\n\n# Change\n1. Build it");
	});

	it("prefers omp's generated label to the assignment", () => {
		expect(activityOf({ task, description: "Prove the Homebrew fix" })).toBe("Prove the Homebrew fix");
	});

	it("prefers the helper's latest activity once it has some", () => {
		expect(activityOf({ stage: "Checking installer output\nMore", currentToolIntent: "Reading cask" })).toBe("Checking installer output");
		expect(activityOf({ stage: " \n ", currentToolIntent: "Reading cask" })).toBe("Reading cask");
		const base = { task, description: "Prove the Homebrew fix" };
		expect(activityOf({ ...base, recentOutput: ["Checking the tap formula next.", "Earlier line"] })).toBe("Checking the tap formula next.");
		expect(activityOf({ ...base, recentTools: [{ intent: null }, { intent: "Reading cask" }], recentOutput: ["text"] })).toBe("Reading cask");
		expect(activityOf({ ...base, lastIntent: "Running brew audit", recentTools: [{ intent: "Reading cask" }] })).toBe("Running brew audit");
		expect(activityOf({ ...base, lastIntent: "Running brew audit", currentToolIntent: "Writing test cask\nmore" })).toBe("Writing test cask");
	});
});

describe("helperJobSnapshots", () => {
	it("uses the agent handle for collided task job ids and accepts live widget updates", () => {
		const entries = [result("wait", "wait", "", { jobs: [{ id: "Atlas-2", agentUrlId: "Atlas", type: "task", stage: "Reviewing", completionPercent: 70, widget: { title: "Review", blocks: [] } }] })];
		expect(helperJobSnapshots(entries).get("Atlas")).toMatchObject({ stage: "Reviewing", completionPercent: 70, widget: { title: "Review" } });
		const tools = new Map<string, ActiveTool>([["w", { toolCallId: "w", toolName: "wait", args: {}, startedAt: 0, partialResult: { details: { jobs: [{ id: "Atlas-2", agentUrlId: "Atlas", type: "task", stage: "Finishing", completionPercent: 90, widget: { title: "Finishing", blocks: [] } }] } } }]]);
		expect(helperJobSnapshots(entries, tools).get("Atlas")).toMatchObject({ stage: "Finishing", completionPercent: 90, widget: { title: "Finishing" } });
	});
});
