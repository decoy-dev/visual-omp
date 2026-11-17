import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatCompactionStore, type ChatCompactionStore } from "../services/chat-compaction";
import { afterOverlayReady, ChatCompactionOverlay, OVERLAY_RELOAD_MS, resumeSessionId } from "./chat-compaction-overlay";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "vomp-compaction-"));
	dirs.push(dir);
	return dir;
}

async function overlay(saved: Record<string, number> = {}) {
	const file = join(await scratch(), "chat-compaction.json");
	await writeFile(file, JSON.stringify(saved));
	const store = createChatCompactionStore(file);
	const writes: (number | null)[] = [];
	const applied: (number | null)[] = [];
	const controller = new ChatCompactionOverlay(store, async tokens => { writes.push(tokens); }, tokens => applied.push(tokens));
	return { file, store, controller, writes, applied };
}

describe("per-chat compaction points", () => {
	it("starts a resumed chat with its saved point and keeps it across a restart of the same session", async () => {
		const { controller, writes } = await overlay({ "session-a": 400_000 });
		expect(await controller.initial("session-a")).toBe(400_000);
		// omp reports the same session once it connects, and again after a restart.
		await controller.identify("session-a");
		expect(writes).toEqual([]);
		expect(controller.tokens).toBe(400_000);
	});

	it("removes the previous session's point when the chat moves to another session", async () => {
		const { controller, writes, applied } = await overlay({ "session-a": 400_000, "session-c": 600_000 });
		await controller.initial("session-a");
		await controller.identify("session-b");
		await controller.identify("session-c");
		expect(writes).toEqual([null, 600_000]);
		expect(applied).toEqual([null, 600_000]);
	});

	it("refuses a Save made for a session the chat has left, and keeps it off the next session", async () => {
		const { controller, store, writes } = await overlay();
		await controller.initial("session-a");
		const save = controller.set("session-a", 400_000);
		controller.identify("session-b");
		await expect(save).rejects.toThrow("The chat changed");
		await controller.ready();
		expect(controller.tokens).toBeNull();
		expect(writes.at(-1) ?? null).toBeNull();
		expect(await store.get("session-b")).toBeNull();
		expect(() => controller.set("session-a", 600_000)).toThrow("The chat changed");
	});

	it("applies rapid Save and Reset in order and persists the last one", async () => {
		const { controller, file, writes } = await overlay();
		await controller.initial("session-a");
		await Promise.all([controller.set("session-a", 400_000), controller.set("session-a", null), controller.set("session-a", 600_000)]);
		expect(writes).toEqual([400_000, null, 600_000]);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "session-a": 600_000 });
		await controller.set("session-a", null);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
		expect(await createChatCompactionStore(file).get("session-a")).toBeNull();
	});

	it("holds a prompt until omp has had time to reload the overlay", async () => {
		const { controller } = await overlay();
		await controller.initial("session-a");
		const started = Date.now();
		await controller.set("session-a", 400_000);
		await controller.ready();
		expect(Date.now() - started).toBeGreaterThanOrEqual(OVERLAY_RELOAD_MS - 20);
	});

	it("ignores stored entries that are not whole token counts", async () => {
		const file = join(await scratch(), "chat-compaction.json");
		await writeFile(file, JSON.stringify({ good: 400_000, fraction: 1.5, negative: -1, text: "400k" }));
		const store = createChatCompactionStore(file);
		expect(await Promise.all(["good", "fraction", "negative", "text"].map(id => store.get(id)))).toEqual([400_000, null, null, null]);
	});

	it("reads the session id after omp's title record", async () => {
		const file = join(await scratch(), "session.jsonl");
		await writeFile(file, [JSON.stringify({ type: "title", v: 1, title: "Saved chat", pad: " ".repeat(200) }), JSON.stringify({ type: "session", version: 3, id: "session-a", cwd: "/project" }), JSON.stringify({ type: "message" })].join("\n"));
		expect(await resumeSessionId(file)).toBe("session-a");
		expect(await resumeSessionId(join(await scratch(), "missing.jsonl"))).toBeNull();
	});

	it("applies only the newest session when the chat moves again while a saved point is read", async () => {
		const reads = new Map<string, PromiseWithResolvers<number | null>>();
		const store: ChatCompactionStore = {
			get: sessionId => { const read = Promise.withResolvers<number | null>(); reads.set(sessionId, read); return read.promise; },
			set: async () => {},
		};
		const writes: (number | null)[] = [];
		const controller = new ChatCompactionOverlay(store, async tokens => { writes.push(tokens); });
		const first = controller.identify("session-b");
		await vi.waitFor(() => expect(reads.has("session-b")).toBe(true));
		const second = controller.identify("session-c");
		reads.get("session-b")!.resolve(400_000);
		await first;
		await vi.waitFor(() => expect(reads.has("session-c")).toBe(true));
		reads.get("session-c")!.resolve(600_000);
		await second;
		expect(writes).toEqual([600_000]);
	});

	it("makes a prompt wait for overlay changes queued while it was already waiting", async () => {
		const { controller } = await overlay();
		await controller.initial("session-a");
		await controller.set("session-a", 400_000);
		const waiting = controller.ready();
		// Queued after the prompt started waiting: the prompt must not go out on the earlier point.
		await Promise.resolve();
		const later = controller.set("session-a", 600_000);
		await waiting;
		expect(controller.tokens).toBe(600_000);
		await later;
	});

	it("holds prompts after a failed overlay write until a rewrite succeeds", async () => {
		const file = join(await scratch(), "chat-compaction.json");
		await writeFile(file, JSON.stringify({ "session-a": 400_000 }));
		let failing = 2;
		const writes: (number | null)[] = [];
		const controller = new ChatCompactionOverlay(createChatCompactionStore(file), async tokens => {
			if (failing-- > 0) throw new Error("disk full");
			writes.push(tokens);
		});
		await controller.initial("session-a");
		// Leaving session-a must remove its point; while that write fails, prompts may not go out.
		await expect(controller.identify("session-b")).rejects.toThrow("disk full");
		await expect(controller.ready()).rejects.toThrow("disk full");
		await controller.ready();
		expect(writes).toEqual([null]);
		expect(controller.tokens).toBeNull();
	});

	it("keeps a point that failed to save out of memory and out of later saves", async () => {
		const dir = await scratch();
		const file = join(dir, "chat-compaction.json");
		await writeFile(file, JSON.stringify({ "session-a": 400_000 }));
		const store = createChatCompactionStore(file);
		expect(await store.get("session-a")).toBe(400_000);
		// The atomic write's temporary file cannot be created while a folder holds its name.
		await mkdir(`${file}.${process.pid}.tmp`);
		await expect(store.set("session-a", 600_000)).rejects.toThrow();
		expect(await store.get("session-a")).toBe(400_000);
		await rm(`${file}.${process.pid}.tmp`, { recursive: true });
		await store.set("session-b", 100_000);
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ "session-a": 400_000, "session-b": 100_000 });
	});

	it("reports an unreadable store without overwriting it, and runs the chat on omp's settings", async () => {
		const file = join(await scratch(), "chat-compaction.json");
		await writeFile(file, "{ not json");
		const store = createChatCompactionStore(file);
		await expect(store.set("session-a", 400_000)).rejects.toThrow();
		expect(await readFile(file, "utf8")).toBe("{ not json");
		const errors: unknown[] = [];
		const controller = new ChatCompactionOverlay(store, async () => {}, () => {}, error => errors.push(error));
		expect(await controller.initial("session-a")).toBeNull();
		await controller.ready();
		expect(errors).toHaveLength(1);
	});

	it("refuses a prompt whose chat changed while it waited for the overlay", async () => {
		let scope = "1:session-a";
		const gate = Promise.withResolvers<void>();
		const run = vi.fn(async () => "sent");
		const sending = afterOverlayReady({ ready: () => gate.promise }, () => scope, run);
		scope = "2:session-b";
		gate.resolve();
		await expect(sending).rejects.toThrow("The chat changed before its message could be sent.");
		expect(run).not.toHaveBeenCalled();
		scope = "2:session-b";
		await expect(afterOverlayReady({ ready: async () => {} }, () => scope, run)).resolves.toBe("sent");
	});
});
