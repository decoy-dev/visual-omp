import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allSessions } from "./sessions";

const mocks = vi.hoisted(() => ({ root: "" }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ archivedSessions: [], extraProjects: [] }) }));
vi.mock("./paths", () => ({ sessionsDir: () => mocks.root }));

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
});
