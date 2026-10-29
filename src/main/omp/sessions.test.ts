import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allSessions, findSessionFile, listProjects, resolveSessionFile, sessionSummary } from "./sessions";

const mocks = vi.hoisted(() => ({ root: "" }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ archivedSessions: [], extraProjects: [] }) }));
vi.mock("./paths", () => ({ sessionsDir: () => mocks.root }));
vi.mock("./session-pins", () => ({ loadPinnedSessionIds: async () => new Set(), migrateSessionPins: async () => {} }));

let dir: string;
let bucket: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vomp-sessions-"));
	mocks.root = join(dir, "sessions");
	bucket = join(mocks.root, "project");
	await mkdir(bucket, { recursive: true });
	await writeFile(join(bucket, "chat.jsonl"), `${JSON.stringify({ type: "session", id: "s1", cwd: "/project" })}\n`);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("allSessions", () => {
	it("lists regular project buckets once and skips symlinked buckets", async () => {
		await symlink(bucket, join(mocks.root, "alias"), "junction");
		await symlink(join(dir, "missing"), join(mocks.root, "broken"), "junction");
		const sessions = await allSessions();
		expect(sessions.map(session => session.file)).toEqual([join(bucket, "chat.jsonl")]);
	});

	it("drops cached sessions when a regular bucket becomes a symlink", async () => {
		expect(await allSessions()).toHaveLength(1);
		await rm(bucket, { recursive: true });
		const outside = join(dir, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "chat.jsonl"), `${JSON.stringify({ type: "session", id: "s2", cwd: "/other" })}\n`);
		await symlink(outside, bucket, "junction");
		expect(await allSessions()).toEqual([]);
	});

	it("folds a continuation chain for saved navigation without substituting live room identities", async () => {
		const turn = (id: string, timestamp: string) => ({ type: "message", id, timestamp, message: { role: "user", content: id } });
		const root = join(bucket, "chat.jsonl");
		const middle = join(bucket, "middle.jsonl");
		const latest = join(bucket, "latest.jsonl");
		const first = turn("first", "2026-10-28T12:00:00.000Z");
		const second = turn("second", "2026-10-29T12:00:00.000Z");
		const save = (file: string, id: string, continuationOf: string | undefined, turns: unknown[]) =>
			writeFile(file, [JSON.stringify({ type: "session", id, cwd: "/project", continuationOf, timestamp: "2026-10-28T11:00:00.000Z" }), ...turns.map(item => JSON.stringify(item)), ""].join("\n"));
		await save(root, "s1", undefined, [first]);
		await save(middle, "s2", "s1", [first]);
		await save(latest, "s3", "s2", [first, second]);
		// Idle/exit writes to the old file do not make it the conversation's newest copy.
		await appendFile(root, `${JSON.stringify({ type: "session_exit", timestamp: "2026-10-30T12:00:00.000Z" })}\n`);
		await utimes(root, new Date(), new Date("2030-01-01"));
		const sessions = await allSessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id: "s3", file: latest, previousSessionIds: expect.arrayContaining(["s1", "s2"]) });
		expect(await resolveSessionFile(root)).toBe(latest);
		expect(await findSessionFile("s1")).toBe(root);
		expect(await sessionSummary(middle)).toMatchObject({ id: "s3" });
		expect((await listProjects())[0]?.sessionCount).toBe(1);
	});

	it("keeps a deliberate fork and an original that continued writing separate", async () => {
		const save = (name: string, header: object, ids: string[]) => writeFile(join(bucket, name), [
			JSON.stringify({ type: "session", cwd: "/project", ...header }),
			...ids.map((id, index) => JSON.stringify({ type: "message", id, timestamp: `2026-10-29T12:0${index}:00.000Z`, message: { role: "user", content: id } })), "",
		].join("\n"));
		await save("chat.jsonl", { id: "s1" }, ["shared", "original-later"]);
		await save("continued.jsonl", { id: "s2", continuationOf: "s1" }, ["shared"]);
		await save("fork.jsonl", { id: "fork", parentSession: "s1" }, ["shared"]);
		expect((await allSessions()).map(session => session.id).sort()).toEqual(["fork", "s1", "s2"]);
		expect(await resolveSessionFile(join(bucket, "chat.jsonl"))).toBe(join(bucket, "chat.jsonl"));
	});

	it("ignores idle eval-state snapshots when comparing continuation activity", async () => {
		const root = join(bucket, "chat.jsonl");
		await appendFile(root, `${JSON.stringify({ type: "message", id: "turn", timestamp: "2026-10-29T12:00:00.000Z", message: { role: "user", content: "hello" } })}\n`);
		await writeFile(join(bucket, "next.jsonl"), [
			JSON.stringify({ type: "session", id: "s2", cwd: "/project", continuationOf: "s1" }),
			JSON.stringify({ type: "message", id: "turn", timestamp: "2026-10-29T12:00:00.000Z", message: { role: "user", content: "hello" } }), "",
		].join("\n"));
		await appendFile(root, `${JSON.stringify({ type: "custom_message", id: "idle", customType: "eval-state-context", timestamp: "2030-01-01T00:00:00.000Z" })}\n`);
		expect((await allSessions()).map(session => session.id)).toEqual(["s2"]);
	});
	it("resolves continuation parents by directory as well as id", async () => {
		const other = join(mocks.root, "other");
		await mkdir(other);
		const duplicate = join(other, "same-id.jsonl");
		await writeFile(duplicate, `${JSON.stringify({ type: "session", id: "s1", cwd: "/other" })}\n`);
		const latest = join(bucket, "next.jsonl");
		await writeFile(latest, `${JSON.stringify({ type: "session", id: "s2", cwd: "/project", continuationOf: "s1", timestamp: "2030-01-01T00:00:00.000Z" })}\n`);
		const sessions = await allSessions();
		expect(sessions.map(session => session.file).sort()).toEqual([latest, duplicate].sort());
		expect(sessions.find(session => session.file === latest)?.previousSessionFiles).toEqual([join(bucket, "chat.jsonl")]);
		expect(await resolveSessionFile(duplicate)).toBe(duplicate);
	});
});
