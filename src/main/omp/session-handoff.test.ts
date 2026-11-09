import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionOwnership } from "@shared/ipc";
import { SavedSessionHandoffService } from "./session-handoff";
import { RpcTerminationError } from "./rpc";

const fake = vi.hoisted(() => ({
	file: "", folder: "", resolved: "", ownership: "free" as SessionOwnership,
	hosts: [] as Array<{ sessionFile: string; phase: string }>, rpc: vi.fn(),
}));
vi.mock("./host", () => ({ listHosts: () => fake.hosts }));
vi.mock("./elsewhere", () => ({ sessionOwnership: async () => new Map([[fake.file, fake.ownership]]) }));
vi.mock("./sessions", () => ({
	resolveSessionFile: async () => fake.resolved,
	sessionSummary: async () => ({ file: fake.file, cwd: fake.folder, id: "source" }),
}));
vi.mock("./rpc", () => ({
	rpcRequests: fake.rpc,
	RpcTerminationError: class extends Error {
		constructor(message: string, private readonly terminate?: () => Promise<void>) { super(message); }
		retryTermination(): Promise<void> { return this.terminate ? this.terminate() : Promise.reject(this); }
	},
}));

const entry = { type: "compaction", id: "new-handoff", timestamp: "2026-11-09T17:02:03.456Z", method: "handoff", summary: "# Continue\n\nThe pending message is: finish the report.\n" };
let root: string, service: SavedSessionHandoffService;
const journal = (entries: unknown[] = []) => `${[ { type: "session", id: "source", cwd: fake.folder }, ...entries ].map(value => JSON.stringify(value)).join("\n")}\n`;
const start = (id = "operation") => service.handoff(id, fake.file, fake.folder, "Pending message: finish the report.");

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "vomp-handoff-"));
	fake.folder = root; fake.file = join(root, "source.jsonl"); fake.resolved = fake.file;
	fake.ownership = "free"; fake.hosts = [];
	await writeFile(fake.file, journal());
	fake.rpc.mockReset().mockImplementation(async (_folder, requests) => {
		requests[0].validate({ sessionFile: fake.file, sessionId: "source" });
		requests[1].validate({});
		await writeFile(fake.file, journal([entry]));
		requests[2].validate({ sessionFile: fake.file, sessionId: "source" });
		return [{}, {}, {}];
	});
	service = new SavedSessionHandoffService();
});
afterEach(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });

describe("saved chat handoff", () => {
	it("exports the exact new committed summary under the source artifacts directory", async () => {
		const result = await start();
		expect(result).toEqual({ file: join(root, "source", "handoff-2026-11-09T17-02-03-456Z.md") });
		expect(await readFile(result.file, "utf8")).toBe(entry.summary);
		expect(await readFile(fake.file, "utf8")).toBe(journal([entry]));
		const [folder, requests, options] = fake.rpc.mock.calls[0]!;
		expect(folder).toBe(root);
		expect(requests.map((request: { type: string }) => request.type)).toEqual(["get_state", "handoff", "get_state"]);
		expect(requests[1].params).toEqual({ customInstructions: "Pending message: finish the report." });
		expect(options).toMatchObject({ timeoutMs: 600000, waitForExit: true, signal: expect.any(AbortSignal) });
		expect(options.flags).toEqual(["--resume", fake.file, "--no-tools", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-title"]);
	});

	it.each(["elsewhere", "unknown", "unsupported"] as const)("refuses ownership %s before starting omp", async ownership => {
		fake.ownership = ownership;
		await expect(start()).rejects.toThrow("may be running");
		expect(fake.rpc).not.toHaveBeenCalled();
	});

	it("refuses a host owned by this app even when the external lease checker reports free", async () => {
		fake.hosts = [{ sessionFile: fake.file, phase: "live" }];
		await expect(start()).rejects.toThrow("may be running");
		expect(fake.rpc).not.toHaveBeenCalled();
	});

	it("does not silently follow a sibling continuation", async () => {
		fake.resolved = join(root, "sibling.jsonl");
		await expect(start()).rejects.toThrow("continued in another file");
		expect(fake.rpc).not.toHaveBeenCalled();
	});

	it("rejects changed source folder and journal identity before spawning", async () => {
		await expect(service.handoff("folder", fake.file, join(root, "different"), "")).rejects.toThrow("working folder has changed");
		await writeFile(fake.file, `${JSON.stringify({ type: "session", id: "other", cwd: root })}\n`);
		await expect(start()).rejects.toThrow("identity changed");
		expect(fake.rpc).not.toHaveBeenCalled();
	});

	it.each(["file", "id"])("validates RPC source %s before sending handoff", async field => {
		fake.rpc.mockImplementation(async (_folder, requests) => {
			requests[0].validate({ sessionFile: field === "file" ? join(root, "sibling.jsonl") : fake.file, sessionId: field === "id" ? "other" : "source" });
			throw new Error("Mutation must not run.");
		});
		await expect(start()).rejects.toThrow("opened a different chat");
		expect(await readdir(root)).toEqual(["source.jsonl"]);
	});

	it("refuses a continuation reported after mutation rather than exporting its summary", async () => {
		fake.rpc.mockImplementation(async (_folder, requests) => {
			requests[0].validate({ sessionFile: fake.file, sessionId: "source" });
			requests[2].validate({ sessionFile: join(root, "sibling.jsonl"), sessionId: "sibling" });
		});
		await expect(start()).rejects.toThrow("opened a different chat");
		expect(await readdir(root)).toEqual(["source.jsonl"]);
	});

	it.each(["missing", "old", "unrelated", "newer-unrelated"])("refuses a %s committed handoff", async kind => {
		const old = { ...entry, id: "old-handoff" };
		if (kind === "old") await writeFile(fake.file, journal([old]));
		fake.rpc.mockImplementation(async () => {
			await writeFile(fake.file, journal(kind === "missing" ? [] : kind === "old" ? [old] : kind === "unrelated" ? [{ ...entry, method: "soft" }] : [entry, { ...entry, id: "later", method: "soft" }]));
		});
		await expect(start()).rejects.toThrow("did not commit a new handoff");
		expect(await readdir(root)).toEqual(["source.jsonl"]);
	});

	it("accepts a new handoff after an older committed compaction", async () => {
		await writeFile(fake.file, journal([{ ...entry, id: "older", method: "soft" }]));
		fake.rpc.mockImplementation(async () => { await writeFile(fake.file, journal([{ ...entry, id: "older", method: "soft" }, entry])); });
		expect(await readFile((await start()).file, "utf8")).toBe(entry.summary);
	});

	it("rejects a source replaced while omp was working", async () => {
		fake.rpc.mockImplementation(async () => { await writeFile(fake.file, `${JSON.stringify({ type: "session", id: "replacement", cwd: root })}\n${JSON.stringify(entry)}\n`); });
		await expect(start()).rejects.toThrow("saved source changed");
	});

	it("rejects incomplete journal records and omp cancellation without exporting", async () => {
		await writeFile(fake.file, journal() + '{"type":"compaction"');
		await expect(start("partial")).rejects.toThrow("unfinished journal entry");
		await writeFile(fake.file, journal());
		fake.rpc.mockImplementation(async (_folder, requests) => requests[1].validate(null));
		await expect(start("cancelled")).rejects.toThrow("before committing");
	});
});

describe("handoff operation lifecycle", () => {
	it("retains cancel-before-start and same-tick cancellation without running work", async () => {
		const run = vi.fn(); service = new SavedSessionHandoffService(run);
		await service.cancel("early");
		await expect(start("early")).rejects.toMatchObject({ name: "AbortError" });
		const pending = start("same-tick");
		await service.cancel("same-tick");
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(run).not.toHaveBeenCalled();
	});

	it("reserves the operation and source while cancellation waits for process termination", async () => {
		const exit = Promise.withResolvers<void>();
		const started = Promise.withResolvers<AbortSignal>();
		service = new SavedSessionHandoffService(async (_file, _folder, _focus, signal) => {
			started.resolve(signal); await exit.promise; signal.throwIfAborted(); return { file: "unused" };
		});
		const result = start(); const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
		const signal = await started.promise;
		let cancelled = false; const cancel = service.cancel("operation").then(() => { cancelled = true; });
		expect(signal.aborted).toBe(true); expect(cancelled).toBe(false);
		await expect(start("second")).rejects.toThrow("already being created");
		exit.resolve(); await cancel; await rejection;
		expect(cancelled).toBe(true);
		await expect(start()).rejects.toMatchObject({ name: "AbortError" });
	});

	it("shutdown aborts all operations and awaits their exits before refusing new work", async () => {
		const exit = Promise.withResolvers<void>(), started = Promise.withResolvers<AbortSignal>();
		service = new SavedSessionHandoffService(async (_file, _folder, _focus, signal) => {
			started.resolve(signal); await exit.promise; signal.throwIfAborted(); return { file: "unused" };
		});
		const result = start(); const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
		const signal = await started.promise;
		let closed = false; const closing = service.close().then(() => { closed = true; });
		expect(signal.aborted).toBe(true); expect(closed).toBe(false);
		await expect(start("after-quit")).rejects.toThrow("is closing");
		exit.resolve(); await closing; await rejection; expect(closed).toBe(true);
	});

	it("retains the source after failed teardown and shares a later cancellation/close retry", async () => {
		const exit = Promise.withResolvers<{ file: string }>(), retryExit = Promise.withResolvers<void>();
		const retry = vi.fn<() => Promise<void>>();
		const failure = new RpcTerminationError("still alive", retry);
		retry.mockRejectedValueOnce(failure).mockReturnValue(retryExit.promise);
		service = new SavedSessionHandoffService(() => exit.promise);
		const result = start(); const rejection = expect(result).rejects.toThrow("still alive");
		await Promise.resolve();
		const cancelled = expect(service.cancel("operation")).rejects.toThrow("still alive");
		exit.reject(failure);
		await cancelled; await rejection;
		await expect(start("later")).rejects.toThrow("already being created");
		await expect(service.cancel("operation")).rejects.toThrow("still alive");
		const retrying = service.cancel("operation");
		await expect(start("during-retry")).rejects.toThrow("already being created");
		const closing = service.close();
		expect(retry).toHaveBeenCalledTimes(2);
		retryExit.resolve();
		await retrying; await closing;
	});

	it("keeps a failed close retryable until the retained child exit is confirmed", async () => {
		const retry = vi.fn<() => Promise<void>>();
		const failure = new RpcTerminationError("still alive", retry);
		retry.mockRejectedValueOnce(failure).mockResolvedValue(undefined);
		service = new SavedSessionHandoffService(async () => { throw failure; });
		await expect(start()).rejects.toThrow("still alive");
		await expect(service.close()).rejects.toThrow("still alive");
		await expect(start("after-failed-quit")).rejects.toThrow("already being created");
		await service.close();
		expect(retry).toHaveBeenCalledTimes(2);
	});
});
