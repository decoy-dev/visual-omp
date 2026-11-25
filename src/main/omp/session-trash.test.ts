import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allSessions } from "./sessions";
import { trashSessionConversation } from "./session-trash";
const fake = vi.hoisted(() => ({ root: "", trash: vi.fn(), owners: new Map<string, string>(), hosts: [] as Array<{hostId:string; sessionFile:string; phase:string}>, stop: vi.fn() }));
vi.mock("electron", () => ({ shell: { trashItem: fake.trash } }));
vi.mock("../env", () => ({ userEnv: async () => ({}) }));
vi.mock("../ipc", () => ({ broadcast: vi.fn() }));
vi.mock("../prefs", () => ({ getPrefs: () => ({ archivedSessions: [], extraProjects: [] }) }));
vi.mock("./paths", () => ({ sessionsDir: () => fake.root }));
vi.mock("./session-pins", () => ({ loadPinnedSessionIds: async () => new Set(), migrateSessionPins: async () => {} }));
vi.mock("./host", () => ({ listHosts: () => fake.hosts, stopHost: fake.stop }));
vi.mock("./elsewhere", () => ({ sessionOwnership: async (files: string[]) => new Map(files.map(file => [file, fake.owners.get(file) ?? "free"])) }));
let dir: string;
let oldFile: string;
let latestFile: string;
let trash: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vomp-trash-chain-"));
	fake.root = join(dir, "sessions");
	const bucket = join(fake.root, "project");
	trash = join(dir, "system-trash");
	await mkdir(bucket, { recursive: true }); await mkdir(trash);
	oldFile = join(bucket, "old.jsonl"); latestFile = join(bucket, "latest.jsonl");
	for (const [file, id, continuationOf, timestamp] of [[oldFile, "old", undefined, "2026-10-28T12:00:00.000Z"], [latestFile, "latest", "old", "2026-10-29T12:00:00.000Z"]]) {
		await writeFile(file!, `${JSON.stringify({ type: "session", id, continuationOf, timestamp, cwd: "/project" })}\n`);
		await mkdir(file!.slice(0, -6));
		await writeFile(join(file!.slice(0, -6), "plan.txt"), id!);
	}
	fake.trash.mockReset().mockImplementation((path: string) => rename(path, join(trash, basename(path))));
	fake.owners.clear(); fake.hosts = []; fake.stop.mockReset();
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe("trashSessionConversation", () => {
	it("moves every linked transcript and artifact folder to recoverable Trash and removes the folded chat", async () => {
		expect(await allSessions()).toHaveLength(1);
		await trashSessionConversation(oldFile);
		expect(fake.trash.mock.calls.map(([path]) => path).sort()).toEqual([oldFile, latestFile, oldFile.slice(0, -6), latestFile.slice(0, -6)].sort());
		expect(await allSessions()).toEqual([]);
		expect(await readFile(join(trash, "old", "plan.txt"), "utf8")).toBe("old");
		// The system's Put Back restores each original path, after which the index folds it again.
		for (const [path] of fake.trash.mock.calls) await rename(join(trash, basename(path)), path);
		expect((await allSessions()).map(session => session.id)).toEqual(["latest"]);
	});
	it("reports a partial failure's remaining paths while still trashing other chain files", async () => {
		fake.trash.mockImplementation((path: string) => path === oldFile ? Promise.reject(new Error("Access denied")) : rename(path, join(trash, basename(path))));
		await expect(trashSessionConversation(latestFile)).rejects.toThrow(`${oldFile}: Access denied`);
		expect((await allSessions()).map(session => session.id)).toEqual(["old"]);
		expect(await readFile(join(trash, "latest.jsonl"), "utf8")).toContain('"id":"latest"');
	});
	it.each(["elsewhere", "unknown"])("refuses the complete chain before any trash call when a predecessor is %s", async owner => {
		fake.owners.set(oldFile, owner);
		await expect(trashSessionConversation(latestFile)).rejects.toThrow(oldFile);
		expect(fake.trash).not.toHaveBeenCalled();
		expect(await readFile(latestFile, "utf8")).toContain('"id":"latest"');
	});
	it("stops every app host in the set before checking their released ownership", async () => {
		fake.hosts = [{ hostId: "older-host", sessionFile: oldFile, phase: "live" }];
		fake.owners.set(oldFile, "elsewhere");
		fake.stop.mockImplementation(async () => { fake.owners.set(oldFile, "free"); });
		await trashSessionConversation(latestFile);
		expect(fake.stop).toHaveBeenCalledWith("older-host");
		expect(await allSessions()).toEqual([]);
	});
	it("never includes a duplicate id from a different project bucket in the trash set", async () => {
		const other = join(fake.root, "other");
		await mkdir(other);
		const duplicate = join(other, "duplicate.jsonl");
		await writeFile(duplicate, `${JSON.stringify({ type: "session", id: "old", cwd: "/other" })}\n`);
		await trashSessionConversation(latestFile);
		expect((await allSessions()).map(session => session.file)).toEqual([duplicate]);
	});

	it("refuses files outside sessionsDir, traversal paths, and symlinks escaping sessionsDir", async () => {
		const outside = join(dir, "outside.jsonl");
		await writeFile(outside, '{"type":"session","id":"out","cwd":"/project"}\n');
		await expect(trashSessionConversation(outside)).rejects.toThrow("not an omp session file");
		await expect(trashSessionConversation(join(fake.root, "..", "outside.jsonl"))).rejects.toThrow("not an omp session file");

		const linkFile = join(fake.root, "project", "linked.jsonl");
		const outsideDir = join(dir, "outside-dir");
		await mkdir(outsideDir);
		const linkDir = join(fake.root, "linked-project");
		let createdSymlinks = false;
		try {
			await symlink(outside, linkFile);
			await symlink(outsideDir, linkDir);
			createdSymlinks = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
		}
		if (createdSymlinks) {
			await expect(trashSessionConversation(linkFile)).rejects.toThrow("not an omp session file");
			await writeFile(join(outsideDir, "escaped.jsonl"), '{"type":"session","id":"esc","cwd":"/project"}\n');
			await expect(trashSessionConversation(join(linkDir, "escaped.jsonl"))).rejects.toThrow("not an omp session file");
		}
		expect(fake.trash).not.toHaveBeenCalled();
	});

	it("allows trashing a live host sessionFile even outside sessionsDir after stopping the host", async () => {
		const customFile = join(dir, "custom-host-session.jsonl");
		await writeFile(customFile, '{"type":"session","id":"custom","cwd":"/project"}\n');
		fake.hosts = [{ hostId: "custom-host", sessionFile: customFile, phase: "live" }];
		await trashSessionConversation(customFile);
		expect(fake.stop).toHaveBeenCalledWith("custom-host");
		expect(fake.trash).toHaveBeenCalledWith(customFile);
	});
});
