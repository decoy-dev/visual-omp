import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendedPrompt, newestPrompt, type PromptScan, promptTime } from "./session-prompts";

const header = JSON.stringify({ type: "session", id: "s", cwd: "/p", timestamp: "2026-11-18T10:00:00.000Z" });
const user = (at: string, text = "hi", extra = "") =>
	`{"type":"message","id":"u","parentId":null,"timestamp":"${at}","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(text)}}]${extra}}}`;
const assistant = (at: string, text: string) =>
	`{"type":"message","id":"a","parentId":"u","timestamp":"${at}","message":{"role":"assistant","content":[{"type":"text","text":${JSON.stringify(text)}}]}}`;
const result = (text: string) => `{"type":"custom_message","customType":"async-result","content":${JSON.stringify(text)}}`;
const ms = (at: string) => Date.parse(at);

let dir: string;
let file: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vomp-prompts-"));
	file = join(dir, "chat.jsonl");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const write = (lines: string[], tail = "") => writeFile(file, `${lines.join("\n")}\n${tail}`);
const first = async () => {
	const info = await stat(file);
	return newestPrompt(file, info.size, info.ino);
};
const next = async (previous: PromptScan) => {
	const info = await stat(file);
	return appendedPrompt(file, info.size, info.ino, previous);
};
const size = async () => (await stat(file)).size;

describe("promptTime", () => {
	it("reads the time of a message you sent and nothing else", () => {
		expect(promptTime(Buffer.from(user("2026-11-18T10:05:00.000Z")))).toBe(ms("2026-11-18T10:05:00.000Z"));
		expect(promptTime(Buffer.from(assistant("2026-11-18T10:06:00.000Z", "done")))).toBeNull();
		expect(promptTime(Buffer.from(result("Helper finished")))).toBeNull();
		expect(promptTime(Buffer.from(header))).toBeNull();
		// Quoted inside text, the keys are escaped and match nothing.
		expect(promptTime(Buffer.from(assistant("2026-11-18T10:06:00.000Z", '{"type":"message","message":{"role":"user"')))).toBeNull();
	});

	it("skips user messages omp wrote itself", () => {
		expect(promptTime(Buffer.from(user("2026-11-18T10:05:00.000Z", "summary", ',"attribution":"agent"')))).toBeNull();
		expect(promptTime(Buffer.from(user("2026-11-18T10:05:00.000Z", "recorded", ',"synthetic":true')))).toBeNull();
		expect(promptTime(Buffer.from(user("2026-11-18T10:05:00.000Z", "typed", ',"attribution":"user"')))).toBe(ms("2026-11-18T10:05:00.000Z"));
	});
});

describe("newestPrompt", () => {
	it("finds your last message behind omp's long replies, across read chunks", async () => {
		const long = "x".repeat(200 * 1024);
		await write([header, user("2026-11-18T10:01:00.000Z"), user("2026-11-18T10:02:00.000Z"), assistant("2026-11-18T10:03:00.000Z", long), result(long), assistant("2026-11-18T10:09:00.000Z", "done")]);
		expect(await first()).toMatchObject({ at: ms("2026-11-18T10:02:00.000Z"), end: await size() });
	});

	it("reads back as far as it takes, past several megabytes of omp's work", async () => {
		const work = Array.from({ length: 12 }, (_, index) => assistant("2026-11-18T10:03:00.000Z", String(index).repeat(1024 * 1024)));
		await write([header, user("2026-11-18T10:01:00.000Z"), ...work]);
		expect((await first()).at).toBe(ms("2026-11-18T10:01:00.000Z"));
	});

	it("leaves a line omp is still writing for the next read", async () => {
		await write([header, user("2026-11-18T10:01:00.000Z")], user("2026-11-18T10:05:00.000Z").slice(0, 60));
		expect(await first()).toMatchObject({ at: ms("2026-11-18T10:01:00.000Z"), end: header.length + 1 + user("2026-11-18T10:01:00.000Z").length + 1 });
	});

	it("finds a message whose own line spans several chunks, and reports none for a chat without one", async () => {
		await write([header, user("2026-11-18T10:01:00.000Z", "y".repeat(300 * 1024)), assistant("2026-11-18T10:02:00.000Z", "ok")]);
		expect((await first()).at).toBe(ms("2026-11-18T10:01:00.000Z"));
		await write([header, assistant("2026-11-18T10:02:00.000Z", "ok")]);
		expect(await first()).toMatchObject({ at: null, end: await size() });
	});

	it.each([',"attribution":"agent"', ',"synthetic":true'])("skips a long message omp marked as its own after its text (%s)", async marker => {
		await write([header, user("2026-11-18T10:01:00.000Z"), user("2026-11-18T10:04:00.000Z", "z".repeat(300 * 1024), marker), assistant("2026-11-18T10:05:00.000Z", "ok")]);
		expect((await first()).at).toBe(ms("2026-11-18T10:01:00.000Z"));
	});
});

describe("appendedPrompt", () => {
	it("moves only for a message you sent, reading what omp appended", async () => {
		await write([header, user("2026-11-18T10:01:00.000Z")]);
		const opened = await first();
		await appendFile(file, `${assistant("2026-11-18T10:02:00.000Z", "reply")}\n${result("helper done")}\n`);
		const replied = await next(opened);
		expect(replied).toMatchObject({ at: opened.at, end: await size() });
		await appendFile(file, `${user("2026-11-18T10:07:00.000Z")}\n${assistant("2026-11-18T10:08:00.000Z", "again")}\n`);
		expect(await next(replied)).toMatchObject({ at: ms("2026-11-18T10:07:00.000Z"), end: await size() });
	});

	it("waits for a line omp has not finished writing", async () => {
		await write([header, user("2026-11-18T10:01:00.000Z")]);
		const opened = await first();
		const typed = user("2026-11-18T10:05:00.000Z");
		await appendFile(file, typed.slice(0, 40));
		const partial = await next(opened);
		expect(partial).toEqual(opened);
		await appendFile(file, `${typed.slice(40)}\n`);
		expect(await next(partial)).toMatchObject({ at: ms("2026-11-18T10:05:00.000Z"), end: await size() });
	});

	it("reads a rewritten file again: shorter, the same size, or longer", async () => {
		const asked = user("2026-11-18T10:01:00.000Z");
		await write([header, asked, assistant("2026-11-18T10:02:00.000Z", "a".repeat(4096))]);
		const opened = await first();
		// Shorter, with no message you sent: the earlier time stays.
		await write([header, assistant("2026-11-18T10:03:00.000Z", "short")]);
		expect(await next(opened)).toMatchObject({ at: opened.at, end: await size() });
		// The same size in place, with a newer message where the reply was.
		await write([header, asked, assistant("2026-11-18T10:02:00.000Z", "a".repeat(4096))]);
		const same = await first();
		const newer = user("2026-11-18T10:09:00.000Z", "b".repeat(assistant("2026-11-18T10:02:00.000Z", "a".repeat(4096)).length - user("2026-11-18T10:09:00.000Z", "").length));
		await write([header, asked, newer]);
		expect(await size()).toBe(same.end);
		expect((await next(same)).at).toBe(ms("2026-11-18T10:09:00.000Z"));
		// Longer, with different bytes before the old end.
		await write([header, asked, assistant("2026-11-18T10:02:00.000Z", "a".repeat(4096))]);
		const longer = await first();
		await write([header, user("2026-11-18T10:11:00.000Z", "c".repeat(5000)), assistant("2026-11-18T10:12:00.000Z", "d")]);
		expect((await next(longer)).at).toBe(ms("2026-11-18T10:11:00.000Z"));
		// Only a message's time changed, ahead of the same trailing reply: same inode, size and last bytes.
		const reply = assistant("2026-11-18T10:12:00.000Z", "e".repeat(200));
		await write([header, user("2026-11-18T10:13:00.000Z"), reply]);
		const stamped = await first();
		await write([header, user("2026-11-18T10:14:00.000Z"), reply]);
		expect((await next(stamped)).at).toBe(ms("2026-11-18T10:14:00.000Z"));
	});
});
