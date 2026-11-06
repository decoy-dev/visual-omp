import { appendFile, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { helperSessionFile } from "./helper-file";
import { sessionsDir } from "./paths";
import { loadSavedToolOutput, SAVED_TOOL_OUTPUT_LIMITS } from "./session-tool-output";

const mocks = vi.hoisted(() => ({
	root: "",
	env: { PI_CODING_AGENT_DIR: "/mock/inferred-agent" },
	afterOpen: undefined as (() => Promise<void>) | undefined,
	afterRead: undefined as (() => Promise<void>) | undefined,
	readSizes: [] as number[],
	openedFiles: [] as string[],
	activeHandles: 0,
	maxActiveHandles: 0,
}));
vi.mock("../env", () => ({ userEnv: async () => mocks.env }));
vi.mock("./paths", () => ({ sessionsDir: vi.fn(() => mocks.root) }));
vi.mock("node:fs/promises", async importOriginal => {
	const actual = await importOriginal<typeof FsPromises>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			mocks.openedFiles.push(String(args[0]));
			mocks.activeHandles++;
			mocks.maxActiveHandles = Math.max(mocks.maxActiveHandles, mocks.activeHandles);
			const close = handle.close.bind(handle);
			handle.close = async () => {
				try { await close(); } finally { mocks.activeHandles--; }
			};
			const read = handle.read.bind(handle);
			handle.read = (async (...readArgs: unknown[]) => {
				if (typeof readArgs[2] === "number") mocks.readSizes.push(readArgs[2]);
				const result = await Reflect.apply(read, handle, readArgs);
				await mocks.afterRead?.();
				return result;
			}) as typeof handle.read;
			await mocks.afterOpen?.();
			return handle;
		},
	};
});

let dir: string;
let bucket: string;
let file: string;
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const header = (id = "saved-chat") => ({ type: "session", version: 3, id, cwd: join(tmpdir(), "project") });
const result = (toolCallId = "wanted", content: unknown = [{ type: "text", text: "complete output" }], extra = {}) => ({
	type: "message", id: `entry-${toolCallId}`, message: { role: "toolResult", toolName: "bash", toolCallId, content, ...extra },
});
const save = (entries: unknown[], destination = file) => writeFile(destination, entries.map(line).join(""));

beforeEach(async () => {
	dir = await realpath(await mkdtemp(join(tmpdir(), "vomp-saved-output-")));
	mocks.root = join(dir, "sessions");
	bucket = join(mocks.root, "project");
	await mkdir(bucket, { recursive: true });
	file = join(bucket, "chat.jsonl");
	mocks.afterOpen = undefined;
	mocks.afterRead = undefined;
	mocks.readSizes = [];
	mocks.openedFiles = [];
	mocks.activeHandles = 0;
	mocks.maxActiveHandles = 0;
	vi.mocked(sessionsDir).mockClear();
});
afterEach(async () => {
	mocks.afterOpen = undefined;
	mocks.afterRead = undefined;
	await rm(dir, { recursive: true, force: true });
});

describe("loadSavedToolOutput", () => {
	it("keeps the inferred legacy project/file root and uses the login environment", async () => {
		await save([header(), result()]);
		const reports = vi.fn(() => [] as string[]);
		expect((await loadSavedToolOutput(file, "wanted", false, reports)).status).toBe("ready");
		expect(sessionsDir).toHaveBeenCalledWith(mocks.env);
		expect(reports).not.toHaveBeenCalled();
		const flat = join(mocks.root, "flat.jsonl");
		await save([header(), result()], flat);
		expect(await loadSavedToolOutput(flat, "wanted")).toEqual({ status: "unavailable" });
	});

	it("reads an XDG session solely from a current report when the inferred root is missing", async () => {
		mocks.root = join(dir, "config", "omp", "sessions");
		const hosted = join(dir, "data", "omp", "sessions", "project", "hosted.jsonl");
		await mkdir(dirname(hosted), { recursive: true });
		await save([header(), result()], hosted);
		expect(await loadSavedToolOutput(hosted, "wanted")).toEqual({ status: "unavailable" });
		expect(await loadSavedToolOutput(hosted, "wanted", false, () => [hosted])).toEqual({
			status: "ready", content: [{ type: "text", text: "complete output" }],
		});
		expect(mocks.openedFiles).toEqual([hosted]);
	});

	it.each(["report", "request"] as const)("canonicalizes an ancestor alias on the reported %s side", async aliasSide => {
		const data = join(dir, "data");
		const alias = join(dir, "data-alias");
		const hosted = join(data, "omp", "sessions", "project", "hosted.jsonl");
		await mkdir(dirname(hosted), { recursive: true });
		await save([header(), result()], hosted);
		await symlink(data, alias, "junction");
		const aliased = join(alias, "omp", "sessions", "project", "hosted.jsonl");
		expect(await loadSavedToolOutput(aliasSide === "request" ? aliased : hosted, "wanted", false,
			() => [aliasSide === "report" ? aliased : hosted])).toEqual({
			status: "ready", content: [{ type: "text", text: "complete output" }],
		});
	});

	it("grants only direct files in a reported flat directory, never its parent or nested artifacts", async () => {
		const hosted = join(dir, "custom", "hosted.jsonl");
		const sibling = join(dirname(hosted), "sibling.jsonl");
		const outside = join(dir, "outside.jsonl");
		const unrelated = join(dir, "unrelated", "chat.jsonl");
		const artifact = join(dirname(hosted), "hosted", "artifact.jsonl");
		for (const destination of [hosted, sibling, outside, unrelated, artifact]) {
			await mkdir(dirname(destination), { recursive: true });
			await save([header(), result()], destination);
		}
		const reports = () => [hosted];
		expect((await loadSavedToolOutput(sibling, "wanted", false, reports)).status).toBe("ready");
		for (const rejected of [outside, unrelated, artifact]) {
			expect(await loadSavedToolOutput(rejected, "wanted", false, reports)).toEqual({ status: "unavailable" });
		}
	});

	it("keeps a project directory authorized when another current host still reports it", async () => {
		const first = join(dir, "custom", "first.jsonl");
		const second = join(dir, "custom", "second.jsonl");
		await mkdir(dirname(first), { recursive: true });
		await save([header("first"), result()], first);
		await save([header("second"), result()], second);
		let reported = [first, second];
		mocks.afterRead = async () => {
			reported = [second];
			mocks.afterRead = undefined;
		};
		expect(await loadSavedToolOutput(second, "wanted", false, () => reported)).toEqual({
			status: "ready", content: [{ type: "text", text: "complete output" }],
		});
	});

	it.each(["open", "scan", "header"] as const)("rejects removed or repointed report authority during the %s read phase", async phase => {
		const hosted = join(dir, "custom", "hosted.jsonl");
		const moved = join(dir, "moved", "hosted.jsonl");
		for (const destination of [hosted, moved]) {
			await mkdir(dirname(destination), { recursive: true });
			await save([header(), result()], destination);
		}
		for (const replacement of [[], [moved]]) {
			let reported = [hosted];
			let reads = 0;
			if (phase === "open") mocks.afterOpen = async () => { reported = replacement; };
			else mocks.afterRead = async () => {
				if (++reads === (phase === "scan" ? 1 : 2)) reported = replacement;
			};
			expect(await loadSavedToolOutput(hosted, "wanted", false, () => reported)).toEqual({ status: "unavailable" });
			mocks.afterOpen = undefined;
			mocks.afterRead = undefined;
		}
	});

	it("revalidates the reported directory alias after reading a canonical requested file", async () => {
		const data = join(dir, "data");
		const replacement = join(dir, "replacement-data");
		const alias = join(dir, "data-alias");
		const hosted = join(data, "project", "hosted.jsonl");
		for (const root of [data, replacement]) {
			await mkdir(join(root, "project"), { recursive: true });
			await save([header(), result()], join(root, "project", "hosted.jsonl"));
		}
		await symlink(data, alias, "junction");
		mocks.afterRead = async () => {
			mocks.afterRead = undefined;
			await rm(alias);
			await symlink(replacement, alias, "junction");
		};
		expect(await loadSavedToolOutput(hosted, "wanted", false, () => [join(alias, "project", "hosted.jsonl")])).toEqual({ status: "unavailable" });
	});

	it("rejects a linked reported project directory even when the requested file is canonical", async () => {
		const hosted = join(dir, "custom", "hosted.jsonl");
		const alias = join(dir, "linked-custom");
		await mkdir(dirname(hosted), { recursive: true });
		await save([header(), result()], hosted);
		await symlink(dirname(hosted), alias, "junction");
		expect(await loadSavedToolOutput(hosted, "wanted", false, () => [join(alias, "hosted.jsonl")])).toEqual({ status: "unavailable" });
	});

	it.each(["file", "bucket"] as const)("rejects a directly symlinked reported project %s", async kind => {
		const hosted = join(dir, "custom", "hosted.jsonl");
		await mkdir(dirname(hosted), { recursive: true });
		await save([header(), result()], hosted);
		let requested: string;
		if (kind === "file") {
			requested = join(dirname(hosted), "linked.jsonl");
			await symlink(hosted, requested, "file");
		} else {
			const linked = join(dir, "linked-custom");
			await symlink(dirname(hosted), linked, "junction");
			requested = join(linked, "hosted.jsonl");
		}
		expect(await loadSavedToolOutput(requested, "wanted", false, () => [hosted])).toEqual({ status: "unavailable" });
	});

	it("reads current reports on every request without retaining a previous directory grant", async () => {
		const hosted = join(dir, "custom", "hosted.jsonl");
		const moved = join(dir, "moved", "hosted.jsonl");
		for (const destination of [hosted, moved]) {
			await mkdir(dirname(destination), { recursive: true });
			await save([header(), result()], destination);
		}
		let reported = [hosted];
		const reports = () => reported;
		expect((await loadSavedToolOutput(hosted, "wanted", false, reports)).status).toBe("ready");
		reported = [];
		expect(await loadSavedToolOutput(hosted, "wanted", false, reports)).toEqual({ status: "unavailable" });
		reported = [moved];
		expect(await loadSavedToolOutput(hosted, "wanted", false, reports)).toEqual({ status: "unavailable" });
		expect((await loadSavedToolOutput(moved, "wanted", false, reports)).status).toBe("ready");
	});

	it("groups by exact provider identity without lending authority to another provider or no provider", async () => {
		const hosted = join(dir, "custom", "hosted.jsonl");
		await mkdir(dirname(hosted), { recursive: true });
		await save([header(), result("first"), result("second")], hosted);
		const reports = () => [hosted];
		const otherReports = () => [hosted];
		expect((await Promise.all([
			loadSavedToolOutput(hosted, "first", false, reports),
			loadSavedToolOutput(hosted, "first", false, () => []),
			loadSavedToolOutput(hosted, "first"),
			loadSavedToolOutput(hosted, "second", false, reports),
			loadSavedToolOutput(hosted, "first", false, otherReports),
		])).map(output => output.status)).toEqual(["ready", "unavailable", "unavailable", "ready", "ready"]);
		expect(mocks.openedFiles).toEqual([hosted, hosted]);
		expect(mocks.readSizes).toHaveLength(4);
	});

	it.each([2, 16])("coalesces %i pending same-file call ids into one bounded scan", async count => {
		const ids = Array.from({ length: count }, (_, index) => `call-${index}`);
		await save([header(), ...ids.map(id => result(id, [{ type: "text", text: id }]))]);
		expect(await Promise.all(ids.map(id => loadSavedToolOutput(file, id)))).toEqual(
			ids.map(id => ({ status: "ready", content: [{ type: "text", text: id }] })),
		);
		expect(mocks.openedFiles).toEqual([file]);
		// One chunk scan plus one shared session-header recheck, not one of each per call.
		expect(mocks.readSizes).toHaveLength(2);
		expect(Math.max(...mocks.readSizes)).toBeLessThanOrEqual(64 * 1024);
	});

	it("limits each same-file batch to sixteen calls", async () => {
		const ids = Array.from({ length: 33 }, (_, index) => `call-${index}`);
		await save([header(), ...ids.map(id => result(id))]);
		expect((await Promise.all(ids.map(id => loadSavedToolOutput(file, id)))).map(output => output.status)).toEqual(ids.map(() => "ready"));
		expect(mocks.openedFiles).toEqual([file, file, file]);
		expect(mocks.readSizes).toHaveLength(6);
		expect(mocks.maxActiveHandles).toBe(1);
	});

	it("serializes scans globally and gathers nonadjacent queued calls for the same exact file", async () => {
		const other = join(bucket, "other.jsonl");
		await save([header(), result("first"), result("third")]);
		await save([header("other"), result("second")], other);
		const opened = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		mocks.afterOpen = async () => { opened.resolve(); await release.promise; };
		const outputs = Promise.all([
			loadSavedToolOutput(file, "first"),
			loadSavedToolOutput(other, "second"),
			loadSavedToolOutput(file, "third"),
		]);
		await opened.promise;
		try {
			expect(mocks.openedFiles).toEqual([file]);
			expect(mocks.activeHandles).toBe(1);
		} finally {
			mocks.afterOpen = undefined;
			release.resolve();
		}
		expect((await outputs).map(output => output.status)).toEqual(["ready", "ready", "ready"]);
		expect(mocks.openedFiles).toEqual([file, other]);
		expect(mocks.readSizes).toHaveLength(4);
		expect(mocks.maxActiveHandles).toBe(1);
	});

	it("returns unavailable when the bounded pending queue is saturated and accepts later requests", async () => {
		await save([header(), result()]);
		const opened = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		mocks.afterOpen = async () => { opened.resolve(); await release.promise; };
		const active = loadSavedToolOutput(file, "wanted");
		await opened.promise;
		const queued = Array.from({ length: 128 }, () => loadSavedToolOutput(file, "wanted"));
		try {
			expect(await loadSavedToolOutput(file, "wanted", true)).toEqual({ status: "unavailable" });
			expect(mocks.openedFiles).toEqual([file]);
		} finally {
			mocks.afterOpen = undefined;
			release.resolve();
		}
		expect((await Promise.all([active, ...queued])).every(output => output.status === "ready")).toBe(true);
		expect(mocks.openedFiles).toHaveLength(9); // One active scan and eight bounded queued batches.
		expect(mocks.maxActiveHandles).toBe(1);
		expect((await loadSavedToolOutput(file, "wanted")).status).toBe("ready");
	});

	it("keeps automatic and manual limits independent within one shared scan", async () => {
		const content = [{ type: "text", text: "x".repeat(SAVED_TOOL_OUTPUT_LIMITS.autoBytes) }];
		const oversized = [{ type: "text", text: "x".repeat(SAVED_TOOL_OUTPUT_LIMITS.manualBytes) }];
		await save([header(), result("wanted", content), result("oversized", oversized), result("small")]);
		expect(await Promise.all([
			loadSavedToolOutput(file, "wanted"),
			loadSavedToolOutput(file, "wanted", false),
			loadSavedToolOutput(file, "wanted", true),
			loadSavedToolOutput(file, "oversized", true),
			loadSavedToolOutput(file, "small"),
		])).toEqual([
			{ status: "too-large" },
			{ status: "too-large" },
			{ status: "ready", content },
			{ status: "too-large" },
			{ status: "ready", content: [{ type: "text", text: "complete output" }] },
		]);
		expect(mocks.openedFiles).toEqual([file]);
	});

	it("keeps completed calls when a later record is malformed but rejects unresolved calls", async () => {
		await writeFile(file, line(header()) + line(result("first")) + "{broken}\n" + line(result("later")));
		expect(await Promise.all([
			loadSavedToolOutput(file, "first"),
			loadSavedToolOutput(file, "later"),
		])).toEqual([
			{ status: "ready", content: [{ type: "text", text: "complete output" }] },
			{ status: "unavailable" },
		]);
		expect(mocks.openedFiles).toEqual([file]);
	});

	it.each(["replace", "truncate", "header"] as const)("rejects the entire ready batch after a mid-scan %s change", async change => {
		await save([header(), result("first"), result("second")]);
		mocks.afterRead = async () => {
			mocks.afterRead = undefined;
			if (change === "replace") await rename(file, `${file}.old`);
			if (change === "truncate") await save([header()]);
			else await save([header("other-chat"), result("first"), result("second")]);
		};
		expect(await Promise.all([
			loadSavedToolOutput(file, "first"),
			loadSavedToolOutput(file, "second"),
		])).toEqual([{ status: "unavailable" }, { status: "unavailable" }]);
		expect(mocks.openedFiles).toEqual([file]);
	});

	it("returns an exact saved bash result with roughly 50 KiB intact and no details or trace", async () => {
		const text = "saved bash output\n".repeat(3000);
		const content = [{ type: "text", text }];
		await save([
			{ type: "title", title: "Saved chat" }, header(),
			result("other", [{ type: "text", text: "wrong call" }]),
			result("wanted", [{ type: "text", text: "wrong tool" }], { toolName: "read" }),
			result("wanted", [{ type: "text", text: "wrong role" }], { role: "assistant" }),
			result("wanted", content, { isError: false, details: { trace: "private trace".repeat(100_000) } }),
		]);
		expect(text.length).toBeGreaterThan(50_000);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "ready", content });
	});

	it("projects only display fields even when a block contains extra trace data", async () => {
		await save([header(), result("wanted", [{ type: "text", text: "output", data: "bytes", mimeType: "text/plain", trace: "private", details: { secret: true } }])]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "ready", content: [{ type: "text", text: "output", data: "bytes", mimeType: "text/plain" }] });
	});

	it("keeps calls in other sessions and continuation files out of the lookup", async () => {
		await save([header(), result("other")]);
		await save([header("continued"), result()], join(bucket, "continued.jsonl"));
		await save([header("unrelated"), result()], join(bucket, "unrelated.jsonl"));
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it("returns unavailable for missing files, unknown calls, and unfinished result records", async () => {
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
		await save([header(), result("other")]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
		await appendFile(file, JSON.stringify(result())); // No final newline: the writer has not published a complete record.
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
		await appendFile(file, "\n");
		expect((await loadSavedToolOutput(file, "wanted")).status).toBe("ready");
	});

	it("does not need to parse an incomplete tail after a complete matching result", async () => {
		await save([header(), result()]);
		await appendFile(file, '{"type":"message","message":');
		expect((await loadSavedToolOutput(file, "wanted")).status).toBe("ready");
	});

	it.each([
		[], [result()], [{ type: "session", id: "", cwd: tmpdir() }, result()],
		[{ type: "session", id: "saved", cwd: "relative" }, result()],
		[header(), header("different"), result()],
		[{ type: "artifact", id: "saved" }, header(), result()],
	].map(entries => [entries] as const))("rejects missing, invalid, or conflicting session headers (%j)", async entries => {
		await save(entries);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it("rejects malformed complete JSONL and results that are not bash toolResult messages", async () => {
		await writeFile(file, line(header()) + "{broken}\n" + line(result()));
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
		await save([header(), result("wanted", [], { role: "user" }), result("wanted", [], { toolName: "python" })]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it.each([null, "text", [null], ["primitive collab marker"], [{ text: "missing type" }], [{ type: "text", text: 3 }]].map(content => [content] as const))("rejects invalid saved content safely (%j)", async content => {
		await save([header(), result("wanted", content)]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it("uses a larger bound only for explicit manual requests", async () => {
		const content = [{ type: "text", text: "x".repeat(SAVED_TOOL_OUTPUT_LIMITS.autoBytes) }];
		await save([header(), result("wanted", content)]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "too-large" });
		expect(await loadSavedToolOutput(file, "wanted", false)).toEqual({ status: "too-large" });
		expect(await loadSavedToolOutput(file, "wanted", true)).toEqual({ status: "ready", content });
		await save([header(), result("wanted", [{ type: "text", text: "x".repeat(SAVED_TOOL_OUTPUT_LIMITS.manualBytes) }])]);
		expect(await loadSavedToolOutput(file, "wanted", true)).toEqual({ status: "too-large" });
	});

	it("counts serialized UTF-8 content, including escaping, at the exact response boundary", async () => {
		const overhead = Buffer.byteLength(JSON.stringify([{ type: "text", text: "" }]));
		const content = [{ type: "text", text: "x".repeat(SAVED_TOOL_OUTPUT_LIMITS.autoBytes - overhead) }];
		await save([header(), result("wanted", content)]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "ready", content });
		content[0]!.text += "x";
		await save([header(), result("wanted", content)]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "too-large" });
		await save([header(), result("wanted", [{ type: "text", text: "\n界".repeat(60_000) }])]);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "too-large" });
	});

	it("bounds individual JSONL lines even when they never finish", async () => {
		await writeFile(file, line(header()) + " ".repeat(SAVED_TOOL_OUTPUT_LIMITS.lineBytes + 1));
		expect(await Promise.all([
			loadSavedToolOutput(file, "wanted", true),
			loadSavedToolOutput(file, "other"),
		])).toEqual([{ status: "too-large" }, { status: "too-large" }]);
		expect(mocks.openedFiles).toEqual([file]);
	});

	it("bounds the scan without reading into another session or past its byte window", async () => {
		// Use full JSONL records rather than millions of empty lines, so this checks the byte boundary.
		const padding = { type: "custom_message", content: "" };
		const rowBytes = 64 * 1024;
		const paddingRow = line({ ...padding, content: "x".repeat(rowBytes - Buffer.byteLength(line(padding))) });
		const paddingText = paddingRow.repeat(SAVED_TOOL_OUTPUT_LIMITS.scanBytes / rowBytes);
		await save([header()]);
		await appendFile(file, paddingText);
		await appendFile(file, line(result()));
		expect(await Promise.all([
			loadSavedToolOutput(file, "wanted", true),
			loadSavedToolOutput(file, "other"),
		])).toEqual([{ status: "too-large" }, { status: "too-large" }]);
		expect(mocks.openedFiles).toEqual([file]);
		expect(mocks.readSizes.reduce((total, bytes) => total + bytes, 0)).toBe(SAVED_TOOL_OUTPUT_LIMITS.scanBytes);
		expect(Math.max(...mocks.readSizes)).toBeLessThanOrEqual(64 * 1024);
		mocks.readSizes = [];
		await save([header(), result()]);
		await appendFile(file, paddingText);
		expect((await loadSavedToolOutput(file, "wanted")).status).toBe("ready");
		expect(mocks.readSizes.reduce((total, bytes) => total + bytes, 0)).toBeLessThan(128 * 1024);
	});

	it.each([
		[null, "wanted"], [23, "wanted"], ["relative.jsonl", "wanted"], ["/session\0.jsonl", "wanted"],
		["/session.txt", "wanted"], ["/session.jsonl", null], ["/session.jsonl", ""],
		["/session.jsonl", "x".repeat(4097)], ["/session.jsonl", "wanted", "true"],
		["/session.jsonl", "wanted", false, null], ["/session.jsonl", "wanted", false, []],
		["/session.jsonl", "wanted", false, "/reported.jsonl"], ["/session.jsonl", "wanted", false, {}],
	].map(args => [args] as const))("validates runtime IPC arguments (%j)", async args => {
		expect(await Reflect.apply(loadSavedToolOutput, undefined, args)).toEqual({ status: "unavailable" });
	});

	it.each([null, false, 0, [], {}, "/reported.jsonl"].map(provider => [provider] as const))("rejects a nonfunction main-only provider even for a valid session (%j)", async provider => {
		await save([header(), result()]);
		expect(await Reflect.apply(loadSavedToolOutput, undefined, [file, "wanted", false, provider])).toEqual({ status: "unavailable" });
		expect(mocks.openedFiles).toEqual([]);
	});

	it("refuses regular non-session files and unregistered helper or artifact paths", async () => {
		const outside = join(dir, "outside.jsonl");
		const artifact = join(bucket, "chat", "artifact.jsonl");
		await mkdir(dirname(artifact), { recursive: true });
		await save([header(), result()], outside);
		await save([header(), result()], artifact);
		expect(await loadSavedToolOutput(outside, "wanted")).toEqual({ status: "unavailable" });
		expect(await loadSavedToolOutput(artifact, "wanted")).toEqual({ status: "unavailable" });
		await mkdir(file);
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it.each(["root", "file"] as const)("accepts a configured session %s through an ancestor path alias", async aliasSide => {
		await save([header(), result()]);
		const alias = join(dir, "sessions-alias");
		await symlink(mocks.root, alias, "junction");
		let requestedFile = file;
		if (aliasSide === "root") mocks.root = alias;
		else requestedFile = join(alias, "project", "chat.jsonl");
		expect(await loadSavedToolOutput(requestedFile, "wanted")).toEqual({
			status: "ready", content: [{ type: "text", text: "complete output" }],
		});
	});

	it("rejects a configured root alias that changes while its session file is opened", async () => {
		await save([header(), result()]);
		const alias = join(dir, "sessions-alias");
		const replacementRoot = join(dir, "replacement-sessions");
		await mkdir(join(replacementRoot, "project"), { recursive: true });
		await save([header("replacement"), result()], join(replacementRoot, "project", "chat.jsonl"));
		await symlink(mocks.root, alias, "junction");
		mocks.root = alias;
		mocks.afterOpen = async () => {
			await rm(alias);
			await symlink(replacementRoot, alias, "junction");
		};
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it.each(["file", "bucket"] as const)("still rejects a symlinked project %s targeting another indexed session", async kind => {
		const otherBucket = join(mocks.root, "other-project");
		await mkdir(otherBucket);
		await save([header("other"), result()], join(otherBucket, "chat.jsonl"));
		if (kind === "file") await symlink(join(otherBucket, "chat.jsonl"), file, "file");
		else {
			await rm(bucket, { recursive: true });
			await symlink(otherBucket, bucket, "junction");
		}
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it.each(["file", "bucket"] as const)("rejects symlinked project %s paths", async kind => {
		const outside = join(dir, "outside");
		await mkdir(outside);
		await save([header(), result()], join(outside, "chat.jsonl"));
		if (kind === "file") await symlink(join(outside, "chat.jsonl"), file, "file");
		else { await rm(bucket, { recursive: true }); await symlink(outside, bucket, "junction"); }
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it("rejects a project file replaced between opening and validation", async () => {
		await save([header(), result()]);
		mocks.afterOpen = async () => {
			await rename(file, `${file}.old`);
			await save([header("replacement"), result()]);
		};
		expect(await loadSavedToolOutput(file, "wanted")).toEqual({ status: "unavailable" });
	});

	it("reads a registered nested helper file through the same content-only API", async () => {
		const helper = join(bucket, "chat", "Atlas", "Atlas.Child.jsonl");
		await mkdir(dirname(helper), { recursive: true });
		await save([header("helper"), result()], helper);
		const registered = await helperSessionFile(file, "Atlas.Child");
		expect(registered).toBe(helper);
		const reports = vi.fn(() => [] as string[]);
		expect(await loadSavedToolOutput(registered!, "wanted", false, reports)).toEqual({ status: "ready", content: [{ type: "text", text: "complete output" }] });
		expect(reports).not.toHaveBeenCalled();
		expect(sessionsDir).not.toHaveBeenCalled();
	});

	it.each(["canonical", "alias"] as const)("never derives a wider directory grant from a registered %s helper report", async aliasSide => {
		const helper = join(bucket, "chat", "Atlas", "Atlas.Child.jsonl");
		const sibling = join(dirname(helper), "unregistered.jsonl");
		await mkdir(dirname(helper), { recursive: true });
		await save([header("helper"), result()], helper);
		await save([header("unregistered"), result()], sibling);
		const registered = await helperSessionFile(file, "Atlas.Child");
		expect(registered).toBe(helper);
		let reported = helper;
		if (aliasSide === "alias") {
			const alias = join(dir, "sessions-alias");
			await symlink(mocks.root, alias, "junction");
			reported = join(alias, "project", "chat", "Atlas", "Atlas.Child.jsonl");
		}
		const reports = () => [reported];
		expect((await loadSavedToolOutput(registered!, "wanted", false, reports)).status).toBe("ready");
		expect(await loadSavedToolOutput(sibling, "wanted", false, reports)).toEqual({ status: "unavailable" });
	});

	it.each(["file", "directory", "root"] as const)("reuses registered helper validation when its %s becomes a symlink", async kind => {
		const root = join(bucket, "chat");
		const helper = join(root, "Atlas", "Atlas.Child.jsonl");
		const outside = join(dir, "outside");
		await mkdir(dirname(helper), { recursive: true });
		await mkdir(join(outside, "Atlas"), { recursive: true });
		await save([header("helper"), result()], helper);
		await save([header("private"), result()], join(outside, "Atlas.Child.jsonl"));
		await save([header("private"), result()], join(outside, "Atlas", "Atlas.Child.jsonl"));
		const registered = await helperSessionFile(file, "Atlas.Child");
		expect(registered).toBe(helper);
		if (kind === "file") { await rm(helper); await symlink(join(outside, "Atlas.Child.jsonl"), helper, "file"); }
		else if (kind === "directory") { await rename(dirname(helper), join(root, "old")); await symlink(outside, dirname(helper), "junction"); }
		else { await rename(root, `${root}-old`); await symlink(outside, root, "junction"); }
		expect(await loadSavedToolOutput(registered!, "wanted")).toEqual({ status: "unavailable" });
	});

	it("rejects a registered helper replaced between opening and validation", async () => {
		const helper = join(bucket, "chat", "Atlas.jsonl");
		await mkdir(dirname(helper), { recursive: true });
		await save([header("helper"), result()], helper);
		const registered = await helperSessionFile(file, "Atlas");
		mocks.afterOpen = async () => {
			await rename(helper, `${helper}.old`);
			await save([header("replacement"), result()], helper);
		};
		expect(await loadSavedToolOutput(registered!, "wanted")).toEqual({ status: "unavailable" });
	});
});
