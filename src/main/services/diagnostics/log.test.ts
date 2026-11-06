import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsLog, exceptionDetails, formatDiagnostic, RendererRecovery, type DiagnosticEvent } from "./log";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
async function fixture(cap = 1024) {
	const folder = await mkdtemp(join(tmpdir(), "vomp-diagnostics-"));
	folders.push(folder);
	return { folder, log: new DiagnosticsLog(join(folder, "diagnostics.log"), cap) };
}
const event = { event: "renderer-visibility", windowId: 1, state: "hidden" } as const;
const time = new Date("2026-11-05T12:00:00.000Z");

describe("diagnostics log", () => {
	it("formats ISO time and schema-projected event data on one plain-text line", () => {
		expect(formatDiagnostic(event, time)).toBe('2026-11-05T12:00:00.000Z renderer-visibility {"windowId":1,"state":"hidden"}\n');
	});
	it("drops unrecognized fields and nested chat contents rather than serializing arbitrary objects", () => {
		const input = { ...event, prompt: "secret prompt", token: "sk-private", text: "chat text", contents: "file contents" };
		expect(formatDiagnostic(input, time)).toBe(formatDiagnostic(event, time));
		const memory = { event: "memory", trigger: "interval", hosts: 2, processes: [{ pid: 1, type: "Browser", workingSetKiB: 123, chat: "private" }], environment: { TOKEN: "secret" } };
		expect(formatDiagnostic(memory as DiagnosticEvent, time)).toBe('2026-11-05T12:00:00.000Z memory {"trigger":"interval","hosts":2,"processes":[{"pid":1,"type":"Browser","workingSetKiB":123}]}\n');
	});
	it.each(["closed", "attached", "attach-retrying", "ignored"] as const)("projects only room counts and state for %s", state => {
		const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const input = { event: "collab-room", chatId, state, attempts: 40, roomId: "private-room", link: "secret-key" };
		expect(formatDiagnostic(input as DiagnosticEvent, time)).toBe(`2026-11-05T12:00:00.000Z collab-room ${JSON.stringify({ chatId, state, attempts: 40 })}\n`);
	});
	it("projects resync bytes without retaining guest or room data", () => {
		const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const input = { event: "collab-resync", chatId, behindBytes: 1234, guest: "private", roomId: "private-room" };
		expect(formatDiagnostic(input as DiagnosticEvent, time)).toBe(`2026-11-05T12:00:00.000Z collab-resync ${JSON.stringify({ chatId, behindBytes: 1234 })}\n`);
	});
	it("writes one privacy-projected completion line and drops malformed completion data", async () => {
		const { log } = await fixture(2048);
		const completion = {
			event: "chat-completion", chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			edgeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", cause: "agent_end", phase: "live",
			isTerminal: true, willContinue: false, awaitingAsyncWork: false, isStreaming: false,
			sinceStreamingMs: 12, runningHelpers: 0, finished: "emitted", notificationRequested: true, suppressedReason: null,
		} as const;
		log.write({ ...completion, text: "private chat", token: "secret", prompt: { messages: ["private"] } } as DiagnosticEvent);
		log.write({ ...completion, sinceStreamingMs: -1, text: "private invalid" } as DiagnosticEvent);
		await log.flush();
		const lines = (await readFile(log.file, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^\S+ chat-completion /);
		const fields = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")));
		const { event: _event, ...expected } = completion;
		expect(fields).toEqual(expected);
	});
	it.each([
		{ ...event, state: "hidden\nprivate prompt" }, { ...event, event: "unknown" },
		{ event: "host-start", chatId: "a private filename", transport: "tsp" },
		{ event: "child-gone", type: "GPU", reason: "chat text", exitCode: 1, serviceName: "" },
		{ event: "main-exception", kind: "uncaughtException", errorType: "private token", fingerprint: "0123456789abcdef" },
		{ event: "collab-room", chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "unknown", attempts: 1 },
		{ event: "collab-room", chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "closed", attempts: -1 },
		{ event: "collab-room", chatId: "private filename", state: "closed", attempts: 0 },
		{ event: "collab-resync", chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", behindBytes: -1 },
		{ event: "collab-resync", chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", behindBytes: 0.5 },
		{ event: "collab-resync", chatId: "private filename", behindBytes: 0 },
	])("rejects untrusted values outside the event boundary: %j", input => {
		expect(formatDiagnostic(input as DiagnosticEvent, time)).toBeNull();
	});
	it("records every supported event shape", () => {
		const chatId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const events: DiagnosticEvent[] = [
			{ event: "app-start", version: "0.7.7", platform: "win32", arch: "x64", electron: "44.5.1", transport: "tsp", classic: false },
			{ event: "omp-version", version: "18.16.0" }, { event: "crash-reporter", started: true },
			{ event: "window-unresponsive", windowId: 1 }, { event: "window-responsive", windowId: 1, durationMs: 12000 },
			{ event: "renderer-gone", windowId: 1, reason: "oom", exitCode: -1, reload: true },
			{ event: "child-gone", type: "GPU", reason: "crashed", exitCode: 1, serviceName: "gpu" },
			{ event: "host-start", chatId, transport: "tsp" },
			{ event: "host-exit", chatId, transport: "tsp", exitCode: 1, signal: null, uptimeMs: 1234 }, event,
			{ event: "collab-room", chatId, state: "attached", attempts: 1 },
			{ event: "collab-resync", chatId, behindBytes: 1234 },
			{ event: "main-exception", kind: "uncaughtException", ...exceptionDetails(new TypeError("secret")) },
			{ event: "memory", trigger: "unresponsive", hosts: 2, processes: [{ pid: 1, type: "Browser", workingSetKiB: 123 }] },
			{ event: "report-send", outcome: "failed", status: 429 },
		];
		for (const item of events) expect(formatDiagnostic(item, time)).toContain(`${item.event} {`);
	});
	it("caps both files, rotates once, and retains whole UTF-8 lines in order", async () => {
		const { folder, log } = await fixture(220);
		for (let i = 0; i < 8; i++) log.write({ ...event, windowId: i });
		await log.flush();
		expect((await readdir(folder)).sort()).toEqual(["diagnostics.log", "diagnostics.log.1"]);
		for (const file of [log.file, `${log.file}.1`]) {
			expect((await stat(file)).size).toBeLessThanOrEqual(220);
			const lines = (await readFile(file, "utf8")).trim().split("\n");
			for (const line of lines) expect(() => JSON.parse(line.slice(line.indexOf("{")))).not.toThrow();
		}
		expect(await readFile(log.file, "utf8")).toContain('"windowId":7');
		expect(await readFile(`${log.file}.1`, "utf8")).not.toContain('"windowId":0');
		const excerpt = await log.recent(4);
		expect(excerpt).toContain('"windowId":4');
		expect(excerpt).toContain('"windowId":7');
	});
	it("bounds pre-existing oversized files and a burst queue", async () => {
		const { log } = await fixture(1024);
		await writeFile(log.file, "x".repeat(4096));
		await writeFile(`${log.file}.1`, "x".repeat(4096));
		for (let i = 0; i < 2000; i++) log.write({ ...event, windowId: i });
		await log.flush();
		expect((await stat(log.file)).size).toBeLessThanOrEqual(1024);
		expect((await stat(`${log.file}.1`)).size).toBeLessThanOrEqual(1024);
		expect(await readFile(log.file, "utf8")).not.toContain('"windowId":1999');
	});
	it("survives write failures without rejected flushes and accepts subsequent writes", async () => {
		const { folder } = await fixture();
		const file = join(folder, "blocked");
		await writeFile(file, "a regular file");
		const log = new DiagnosticsLog(join(file, "diagnostics.log"));
		log.write(event);
		await expect(log.flush()).resolves.toBeUndefined();
		await rm(file);
		log.write(event);
		await log.flush();
		expect(await readFile(log.file, "utf8")).toContain("renderer-visibility");
	});
	it("returns a bounded revalidated excerpt, excluding corrupted lines and extra private fields", async () => {
		const { log } = await fixture();
		log.write(event);
		await log.flush();
		await writeFile(log.file, '2026-11-05T12:00:00.000Z renderer-visibility {"windowId":1,"state":"hidden","prompt":"PRIVATE"}\nmalformed PRIVATE\n2026-11-05T12:00:01.000Z renderer-visibility {"windowId":2,"state":"visible"}\n');
		expect(await log.recent(1)).toContain('"windowId":2');
		expect(await log.recent(2)).not.toContain("PRIVATE");
		expect(await log.recent(200, 1)).toBe("");
		expect(await log.recent(0)).toBe("");
	});
	it("hashes exception identity without logging message, stack, path or arbitrary thrown values", () => {
		const error = new TypeError("private-token /Users/person/chat.txt");
		const details = exceptionDetails(error);
		expect(details.errorType).toBe("TypeError");
		expect(details.fingerprint).toMatch(/^[a-f0-9]{16}$/);
		expect(details).toEqual(exceptionDetails(error));
		expect(JSON.stringify(details)).not.toContain("private");
		expect(exceptionDetails({ secret: "token" }).errorType).toBe("NonError");
	});
});

describe("renderer recovery", () => {
	it("reloads the first abnormal death and suppresses a second within a minute", () => {
		const recovery = new RendererRecovery();
		expect(recovery.shouldReload("crashed", 0)).toBe(true);
		expect(recovery.shouldReload("oom", 59_999)).toBe(false);
		expect(recovery.shouldReload("crashed", 119_998)).toBe(false);
		expect(recovery.shouldReload("crashed", 179_998)).toBe(true);
	});
	it("does not reload or spend the recovery boundary on clean exits", () => {
		const recovery = new RendererRecovery();
		expect(recovery.shouldReload("clean-exit", 0)).toBe(false);
		expect(recovery.shouldReload("crashed", 1)).toBe(true);
	});
});
