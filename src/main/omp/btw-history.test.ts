import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwTopic } from "@shared/contracts/btw";
import { btwArtifactsDir, btwHistoryDirectory, listBtwHistory, listBtwHistoryScopes, readBtwTopic, watchBtwHistory, type BtwHistoryWatcher } from "./btw-history";

let root: string;
let file: string;
let directory: string;
const watchers: BtwHistoryWatcher[] = [];
const logger = { warn: vi.fn() };
const turn = (fields: Record<string, unknown> = {}) => ({ question: "Why this approach?", answer: "Because it preserves the journal.", status: "complete", createdAt: 100, updatedAt: 150, ...fields });
const record = (id: string, fields: Record<string, unknown> = {}) => ({ ...turn(), id, leafId: null, ...fields });

async function save(id: string, fields: Record<string, unknown> = {}, destination = directory): Promise<void> {
	await mkdir(destination, { recursive: true });
	await writeFile(join(destination, `entry-${id}.json`), `${JSON.stringify(record(id, fields))}\n`);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-btw-reader-"));
	file = join(root, "session.jsonl");
	directory = join(root, "session", "btw-history");
	logger.warn.mockReset();
});
afterEach(async () => {
	for (const watcher of watchers.splice(0)) watcher.close();
	await rm(root, { recursive: true, force: true });
});

describe("read-only BTW history", () => {
	it.each([
		["btw-ask", ["complete"], ["The first fixture side answer is complete."]],
		["btw-follow-up", ["complete", "complete"], ["The first fixture side answer is complete.", "The follow-up fixture answer preserves the first topic."]],
		["btw-cancel", ["cancelled"], ["Partial fixture side answer."]],
	])("reads the captured upstream %s sidecars through its consumer API", async (scenario, statuses, answers) => {
		const sessions = fileURLToPath(new URL(`./tsp/fixtures/18.15.0/${scenario}.artifacts/sessions/`, import.meta.url));
		const [session] = await readdir(sessions);
		const topics = await listBtwHistory(join(sessions, `${session}.jsonl`), { logger });
		expect(topics).toHaveLength(1);
		expect(topics[0]!.turns.map(value => value.status)).toEqual(statuses);
		expect(topics[0]!.turns.map(value => value.answer)).toEqual(answers);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("derives omp artifacts from the exact session filename without requiring it to exist", async () => {
		expect(btwArtifactsDir(file)).toBe(join(root, "session"));
		expect(btwArtifactsDir(join(root, "session.data"))).toBeNull();
		expect(btwHistoryDirectory(file)).toBe(directory);
		expect(await listBtwHistory(file, { logger })).toEqual([]);
		expect(await readBtwTopic(file, "missing", { logger })).toBeNull();
		expect(await listBtwHistory("session.data", { logger })).toEqual([]);
		expect(await readdir(root)).toEqual([]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("projects initial and follow-up turns, raw title sidecars and stable newest-first ordering", async () => {
		await save("z", { createdAt: 200, status: "cancelled" });
		await save("a", {
			createdAt: 200,
			leafId: "leaf-1",
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			followUps: [turn({ question: "What failed?", answer: "Partial answer", status: "error", error: "Request failed", createdAt: 220, updatedAt: 230 })],
		});
		await save("old", { createdAt: 20, status: "interrupted" });
		await writeFile(join(directory, "entry-a.title"), "A stored heading\n");
		await writeFile(join(directory, "unrelated.json"), "{}");
		await writeFile(join(directory, "entry-a.json.tmp"), "partial checkpoint");
		const topics = await listBtwHistory(file, { logger });
		expect(topics.map(topic => topic.id)).toEqual(["a", "z", "old"]);
		expect(topics[0]).toEqual({
			id: "a", title: "A stored heading\n", live: false,
			turns: [turn(), turn({ question: "What failed?", answer: "Partial answer", status: "error", error: "Request failed", createdAt: 220, updatedAt: 230 })].map((value, index) => index === 0 ? { ...value, createdAt: 200 } : value),
		});
		expect(topics[1]!.title).toBe("Why this approach?");
		expect(await readBtwTopic(file, "a", { logger })).toEqual(topics[0]);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("keeps running records unchanged unless the caller requests recovery, preserving matching live topics", async () => {
		await save("active", { status: "running", followUps: [turn({ status: "running" })] });
		expect((await listBtwHistory(file))[0]!.turns.map(value => value.status)).toEqual(["running", "running"]);
		expect((await listBtwHistory(file, { recoverRunning: true }))[0]!.turns.map(value => value.status)).toEqual(["interrupted", "interrupted"]);
		const live = (await listBtwHistory(file, { recoverRunning: true, liveTopicIds: new Set(["active"]) }))[0]!;
		expect(live.live).toBe(true);
		expect(live.turns.map(value => value.status)).toEqual(["running", "running"]);
		expect(JSON.parse(await readFile(join(directory, "entry-active.json"), "utf8")).status).toBe("running");
	});

	it("isolates focused scopes and discovers all focused directories without merging identities", async () => {
		await save("shared");
		const helper = join(directory, "sessions", "helper_1");
		await save("shared", { answer: "Helper answer" }, helper);
		await save("other", { answer: "Sibling answer" }, join(directory, "sessions", "helper-2"));
		await writeFile(join(directory, "sessions", "not-a-directory"), "ignored");
		expect(await listBtwHistoryScopes(file)).toEqual(["helper-2", "helper_1"]);
		expect((await listBtwHistory(file)).map(topic => topic.id)).toEqual(["shared"]);
		expect(await readBtwTopic(file, "shared", { scope: "helper_1" })).toMatchObject({ scope: "helper_1", turns: [{ answer: "Helper answer" }] });
		expect((await listBtwHistory(file, { includeScopes: true })).map(topic => [topic.id, topic.scope])).toEqual([["other", "helper-2"], ["shared", undefined], ["shared", "helper_1"]]);
		const otherFile = join(root, "child.jsonl");
		expect(await listBtwHistory(otherFile, { artifactsDir: join(root, "session"), scope: "helper_1" })).toEqual(await listBtwHistory(file, { scope: "helper_1" }));
		const unsafeScope = "../external/session";
		const hashed = createHash("sha256").update(unsafeScope).digest("hex");
		expect(btwHistoryDirectory(file, { scope: unsafeScope })).toBe(join(directory, "sessions", hashed));
		await save("hashed", {}, join(directory, "sessions", hashed));
		expect((await listBtwHistory(file, { scope: unsafeScope }))[0]!.scope).toBe(unsafeScope);
		expect(await readBtwTopic(file, "../external")).toBeNull();
	});

	it("skips invalid JSON, strict-schema violations, mismatched ids and non-files with a log per skipped entry", async () => {
		await save("valid");
		await writeFile(join(directory, "entry-json.json"), "{");
		await save("wrong-id", { id: "somewhere-else" });
		await save("extra", { title: "Forbidden JSON title" });
		await save("timestamp", { updatedAt: 8640000000000001 });
		await save("negative", { createdAt: -1 });
		await save("missing", { updatedAt: undefined });
		await save("status", { status: "pending" });
		await save("follow", { followUps: [turn({ unexpected: true })] });
		await save("image", { images: [{ type: "image", data: 3, mimeType: "image/png" }] });
		await writeFile(join(directory, "entry-.json"), "{}");
		await mkdir(join(directory, "entry-folder.json"));
		const topics = await listBtwHistory(file, { logger });
		expect(topics.map(topic => topic.id)).toEqual(["valid"]);
		expect(logger.warn).toHaveBeenCalledTimes(11);
		for (const [message, details] of logger.warn.mock.calls) {
			expect(message).toBe("Ignoring malformed BTW history record");
			expect(details).toMatchObject({ path: expect.stringContaining(directory), error: expect.any(String) });
		}
	});

	it("logs unreadable title sidecars while preserving the valid topic under its question", async () => {
		await save("valid");
		await mkdir(join(directory, "entry-valid.title"));
		expect(await readBtwTopic(file, "valid", { logger })).toMatchObject({ title: "Why this approach?" });
		expect(logger.warn).toHaveBeenCalledWith("Ignoring unreadable BTW history title", { path: join(directory, "entry-valid.title"), error: "Expected a regular file" });
	});

	it("logs an unreadable history directory instead of throwing", async () => {
		await mkdir(join(root, "session"));
		await writeFile(directory, "not a directory");
		expect(await listBtwHistory(file, { logger })).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith("Ignoring unreadable BTW history directory", { path: directory, error: "Expected a directory" });
	});

	it("reads and watches existing history without changing file bytes, mtimes or directory entries", async () => {
		await save("saved");
		await writeFile(join(directory, "entry-saved.title"), "Saved title");
		await writeFile(file, "session journal remains untouched\n");
		const paths = [file, join(directory, "entry-saved.json"), join(directory, "entry-saved.title")];
		const before = await Promise.all(paths.map(async path => ({ bytes: await readFile(path), mtime: (await stat(path)).mtimeMs })));
		const names = await readdir(directory);
		const callback = vi.fn();
		const watcher = watchBtwHistory(file, callback, { logger });
		watchers.push(watcher);
		await watcher.refresh();
		await watcher.refresh();
		watcher.close();
		expect(callback).toHaveBeenCalledTimes(1);
		expect(await Promise.all(paths.map(async path => ({ bytes: await readFile(path), mtime: (await stat(path)).mtimeMs })))).toEqual(before);
		expect(await readdir(directory)).toEqual(names);
	});
});

describe("BTW history watcher lifecycle", () => {
	it("observes a missing directory, streamed checkpoints, titles, atomic replacement and deletion", async () => {
		let latest: BtwTopic[] = [];
		const callback = vi.fn((topics: BtwTopic[]) => { latest = topics; });
		const watcher = watchBtwHistory(file, callback, { logger });
		watchers.push(watcher);
		await watcher.refresh();
		expect(latest).toEqual([]);
		expect(await readdir(root)).toEqual([]);
		await save("stream", { status: "running", answer: "First chunk" });
		await vi.waitFor(() => expect(latest[0]?.turns[0]?.answer).toBe("First chunk"), { timeout: 4000 });
		await writeFile(join(directory, "entry-stream.json"), JSON.stringify(record("stream", { status: "running", answer: "Second chunk" })));
		await vi.waitFor(() => expect(latest[0]?.turns[0]?.answer).toBe("Second chunk"), { timeout: 4000 });
		await writeFile(join(directory, "entry-stream.title"), "Streamed title");
		await vi.waitFor(() => expect(latest[0]?.title).toBe("Streamed title"), { timeout: 4000 });
		await writeFile(join(directory, "replacement.tmp"), JSON.stringify(record("stream", { answer: "Finished" })));
		await rename(join(directory, "replacement.tmp"), join(directory, "entry-stream.json"));
		await vi.waitFor(() => expect(latest[0]?.turns[0]?.status).toBe("complete"), { timeout: 4000 });
		await rm(join(directory, "entry-stream.json"));
		await vi.waitFor(() => expect(latest).toEqual([]), { timeout: 4000 });
		watcher.close();
		const calls = callback.mock.calls.length;
		await save("after-close");
		await watcher.refresh();
		expect(callback).toHaveBeenCalledTimes(calls);
	});

	it("discovers newly created focused histories and keeps watching after directory recreation", async () => {
		let latest: BtwTopic[] = [];
		const watcher = watchBtwHistory(file, topics => { latest = topics; }, { includeScopes: true, logger });
		watchers.push(watcher);
		await watcher.refresh();
		const scoped = join(directory, "sessions", "helper");
		await save("focused", { answer: "Initial" }, scoped);
		await vi.waitFor(() => expect(latest[0]?.scope).toBe("helper"), { timeout: 4000 });
		await rm(directory, { recursive: true });
		await vi.waitFor(() => expect(latest).toEqual([]), { timeout: 4000 });
		await save("returned", { answer: "Recreated" }, scoped);
		await vi.waitFor(() => expect(latest[0]?.id).toBe("returned"), { timeout: 4000 });
		await save("returned", { answer: "Edited after recreation" }, scoped);
		await vi.waitFor(() => expect(latest[0]?.turns[0]?.answer).toBe("Edited after recreation"), { timeout: 4000 });
	});

	it("suppresses initial asynchronous delivery and directory creation after immediate disposal", async () => {
		const callback = vi.fn();
		const watcher = watchBtwHistory(file, callback, { includeScopes: true, logger });
		watcher.close();
		await watcher.refresh();
		expect(callback).not.toHaveBeenCalled();
		expect(await readdir(root)).toEqual([]);
	});
});
