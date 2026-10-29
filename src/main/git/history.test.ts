import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOG_FORMAT, parseLog } from "./parse";
import { diff, log } from "./repo";

vi.mock("../omp/cli", () => ({ runOmp: vi.fn() }));

let dir = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const save = (file: string, text: string, subject: string, body?: string) => {
	writeFileSync(join(dir, file), text);
	git("add", "--", file);
	git("commit", "-qm", subject, ...(body ? ["-m", body] : []));
	return git("rev-parse", "HEAD");
};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vomp-history-"));
	git("init", "-q", "--initial-branch=main");
	git("config", "user.email", "history@example.com");
	git("config", "user.name", "History Author");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("commit history", () => {
	it("returns no commits for an unborn HEAD", async () => {
		expect(await log(dir)).toEqual([]);
	});

	it("preserves separator characters and empty bodies, and counts root changes", async () => {
		const subject = "Add | fields \x1e and \x1f separators";
		const body = "First paragraph | with \x1e.\n\nSecond paragraph with \x1f.";
		const root = save("a.txt", "one\ntwo\n", subject, body);
		const latest = save("a.txt", "one\nthree\nfour\n", "Update fields");
		const commits = await log(dir);
		expect(commits).toHaveLength(2);
		expect(commits[0]).toMatchObject({ sha: latest, subject: "Update fields", body: "", files: 1, additions: 2, deletions: 1 });
		expect(commits[1]).toMatchObject({ sha: root, subject, body, author: "History Author", files: 1, additions: 2, deletions: 0 });
		expect(commits[1]?.shortSha).toBe(root.slice(0, commits[1]?.shortSha.length));
		expect(commits[1]?.authorDate).toMatch(/^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/);
		expect(await log(dir, { limit: 1, skip: 1 })).toEqual([commits[1]]);
		expect(await log(dir, { skip: 2 })).toEqual([]);
		const raw = execFileSync("git", ["log", "-z", `--format=${LOG_FORMAT}`, "--shortstat", "--root"], { cwd: dir, encoding: "utf8" });
		expect(parseLog(raw)).toEqual(commits);
	});

	it("counts empty commits and binary files without inventing line totals", async () => {
		save("binary.bin", "\0binary", "Add binary");
		git("commit", "--allow-empty", "-qm", "Empty commit");
		expect((await log(dir)).map(({ files, additions, deletions }) => ({ files, additions, deletions }))).toEqual([
			{ files: 0, additions: 0, deletions: 0 },
			{ files: 1, additions: 0, deletions: 0 },
		]);
	});

	it("uses 30 commits by default and keeps pages coherent when HEAD changes between requests", async () => {
		for (let i = 0; i < 32; i++) git("commit", "--allow-empty", "-qm", `Commit ${i}`);
		const head = git("rev-parse", "HEAD");
		const first = await log(dir, { head });
		expect(first).toHaveLength(30);
		git("commit", "--allow-empty", "-qm", "New commit between pages");
		const second = await log(dir, { head, skip: 30 });
		expect(second.map(commit => commit.subject)).toEqual(["Commit 1", "Commit 0"]);
		expect(new Set([...first, ...second].map(commit => commit.sha)).size).toBe(32);
		expect((await log(dir))[0]?.subject).toBe("New commit between pages");
	}, 30_000);

	it("rejects invalid pagination values", async () => {
		for (const options of [{ limit: 0 }, { limit: 101 }, { skip: -1 }, { limit: 1.5 }, { skip: Number.NaN }]) {
			await expect(log(dir, options)).rejects.toThrow("Invalid commit history pagination");
		}
	});

	it("validates pinned history snapshots instead of accepting revision syntax or options", async () => {
		save("a.txt", "root\n", "Root");
		for (const head of ["--all", "HEAD", "abc1234\n"]) {
			await expect(log(dir, { head })).rejects.toThrow("Invalid commit SHA");
		}
		await expect(log(dir, { head: "f".repeat(40) })).rejects.toThrow("Commit not found");
	});

	it("follows detached HEAD rather than the branch tip", async () => {
		const root = save("a.txt", "root\n", "Root");
		save("a.txt", "latest\n", "Latest");
		git("checkout", "-q", "--detach", root);
		expect((await log(dir)).map(commit => commit.sha)).toEqual([root]);
		expect((await diff(dir, { commit: root })).base).toBe("empty");
	});

	it("returns and opens SHA-256 commits, including pinned history", async () => {
		rmSync(join(dir, ".git"), { recursive: true, force: true });
		git("init", "-q", "--initial-branch=main", "--object-format=sha256");
		git("config", "user.email", "history@example.com");
		git("config", "user.name", "History Author");
		const root = save("a.txt", "root\n", "SHA-256 root");
		const latest = save("a.txt", "latest\n", "SHA-256 update");
		expect(root).toHaveLength(64);
		expect((await log(dir, { head: root })).map(commit => commit.sha)).toEqual([root]);
		expect((await log(dir))[0]?.sha).toBe(latest);
		expect((await diff(dir, { commit: root })).files[0]).toMatchObject({ kind: "added", additions: 1 });
		expect((await diff(dir, { commit: latest })).base).toBe(root);
	}, 30_000);
});

describe("historical diffs", () => {
	it("compares a root commit with the empty tree and ignores current working files", async () => {
		const sha = save("a.txt", "root line\n", "Root commit");
		writeFileSync(join(dir, "a.txt"), "uncommitted line\n");
		writeFileSync(join(dir, "untracked.txt"), "untracked\n");
		const result = await diff(dir, { commit: sha.slice(0, 7) });
		expect(result.base).toBe("empty");
		expect(result.files).toHaveLength(1);
		expect(result.files[0]).toMatchObject({ path: "a.txt", kind: "added", additions: 1, deletions: 0 });
		expect(result.files[0]?.hunks[0]?.lines).toMatchObject([{ kind: "add", text: "root line" }]);
	});

	it("rejects non-hex, option-like, short and nonexistent commit identifiers", async () => {
		save("a.txt", "root\n", "Root");
		for (const commit of ["--help", "HEAD", "abcdef", "a".repeat(65), "abc1234^", "abcdefg", "abc1234\n"]) {
			await expect(diff(dir, { commit })).rejects.toThrow("Invalid commit SHA");
		}
		await expect(diff(dir, { commit: "f".repeat(40) })).rejects.toThrow("Commit not found");
	});

	it("compares a merge with its first parent and reports matching history totals", async () => {
		save("a.txt", "root\n", "Root");
		git("switch", "-qc", "feature");
		save("feature.txt", "feature\n", "Feature");
		git("switch", "-q", "main");
		const parent = save("main.txt", "main\n", "Main");
		git("merge", "--no-ff", "-qm", "Merge feature", "feature");
		const sha = git("rev-parse", "HEAD");
		writeFileSync(join(dir, "feature.txt"), "dirty\n");
		const result = await diff(dir, { commit: sha });
		expect(result.base).toBe(parent);
		expect(result.files.map(file => file.path)).toEqual(["feature.txt"]);
		expect(result.files[0]).toMatchObject({ kind: "added", additions: 1, deletions: 0 });
		expect((await log(dir))[0]).toMatchObject({ sha, files: 1, additions: 1, deletions: 0 });
		expect((await diff(dir, { commit: sha, paths: ["main.txt"] })).files).toEqual([]);
	}, 30_000);
});
