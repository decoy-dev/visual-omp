import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	countLines,
	isBinary,
	parseCloneProgress,
	parseCommitOutput,
	parseGitHubUrl,
	parseNumstat,
	parseRefs,
	parseRemotes,
	parseStatusV2,
	parseUnifiedDiff,
	parseWorktrees,
	pickGitHubRemote,
	repoNameFromUrl,
	syntheticAddedDiff,
	unquotePath,
} from "./parse";

/** Output captured from throwaway repos under /tmp (see fixture names for the scenario). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseStatusV2", () => {
	// Mid-merge repo: diverged from origin/main (ahead 1, behind 1), conflict, staged rename with an
	// unstaged edit, staged new file, unstaged delete/modify/binary change, untracked files.
	const status = parseStatusV2(fixture("status-merge.z"));
	const byPath = new Map(status.entries.map(entry => [entry.path, entry]));

	it("reads branch, upstream and ahead/behind", () => {
		expect(status).toMatchObject({
			head: "00ab25afc72e5a8d03d95347cc8c3e280c474a05",
			branch: "main",
			detached: false,
			upstream: "origin/main",
			ahead: 1,
			behind: 1,
		});
	});

	it("classifies every entry kind", () => {
		expect(byPath.get("conflict.txt")).toMatchObject({ kind: "conflicted", conflict: "both-modified" });
		expect(byPath.get("renamed.txt")).toMatchObject({
			kind: "renamed",
			origPath: "rename-me.txt",
			index: "renamed",
			worktree: "modified",
		});
		expect(byPath.get("staged-new.txt")).toMatchObject({ kind: "added", index: "added", worktree: null });
		expect(byPath.get("delete.txt")).toMatchObject({ kind: "deleted", index: null, worktree: "deleted" });
		expect(byPath.get("modify.txt")).toMatchObject({ kind: "modified", worktree: "modified" });
		expect(byPath.get("untracked file.txt")).toMatchObject({ kind: "untracked", index: null, worktree: null });
		expect(byPath.get("sub/deep.txt")?.kind).toBe("untracked");
		expect(status.entries).toHaveLength(8);
	});

	it("keeps the rename source out of the entry list", () => {
		expect(byPath.has("rename-me.txt")).toBe(false);
	});

	it("handles an unborn branch", () => {
		const unborn = parseStatusV2(fixture("status-unborn.z"));
		expect(unborn).toMatchObject({ head: null, branch: "main", detached: false, upstream: null, ahead: 0 });
		expect(unborn.entries.map(entry => [entry.path, entry.kind])).toEqual([
			["a.txt", "added"],
			["b.txt", "untracked"],
		]);
	});

	it("handles a detached HEAD", () => {
		const detached = parseStatusV2(fixture("status-detached.z"));
		expect(detached).toMatchObject({ branch: null, detached: true, head: "4205b4942113e4c6d081cb470f91016fd431bad5" });
	});

	it("keeps spaces, tabs and non-ASCII in -z paths, and flags type changes", () => {
		const paths = parseStatusV2(fixture("status-paths.z"));
		expect(paths.entries.map(entry => entry.path)).toEqual([
			"link-me",
			"moved space.txt",
			"nonl.txt",
			"run.sh",
			"tab\tname.txt",
			"ünï.txt",
		]);
		expect(paths.entries[0]).toMatchObject({ kind: "typechange", worktree: "typechange" });
		expect(paths.entries[1]).toMatchObject({ origPath: "with space.txt", kind: "renamed" });
	});
});

describe("parseNumstat", () => {
	it("reads counts, binaries and renames", () => {
		const entries = parseNumstat(fixture("numstat-merge.z"));
		expect(entries).toEqual([
			{ path: "conflict.txt", origPath: null, additions: 4, deletions: 0, binary: false },
			{ path: "delete.txt", origPath: null, additions: 0, deletions: 2, binary: false },
			{ path: "image.bin", origPath: null, additions: null, deletions: null, binary: true },
			{ path: "modify.txt", origPath: null, additions: 1, deletions: 0, binary: false },
			{ path: "renamed.txt", origPath: "rename-me.txt", additions: 1, deletions: 0, binary: false },
			{ path: "staged-new.txt", origPath: null, additions: 1, deletions: 0, binary: false },
		]);
	});

	it("keeps rename records aligned when paths contain spaces and tabs", () => {
		const entries = parseNumstat(fixture("numstat-paths.z"));
		expect(entries.map(entry => entry.path)).toEqual([
			"link-me",
			"moved space.txt",
			"nonl.txt",
			"run.sh",
			"tab\tname.txt",
			"ünï.txt",
		]);
		expect(entries[1]).toMatchObject({ origPath: "with space.txt", additions: 1, deletions: 0 });
	});
});

describe("parseUnifiedDiff", () => {
	it("splits files and parses hunks with line numbers", () => {
		const files = parseUnifiedDiff(fixture("diff-merge.txt"));
		expect(files.map(file => [file.path, file.kind])).toEqual([
			["conflict.txt", "modified"],
			["delete.txt", "deleted"],
			["image.bin", "modified"],
			["modify.txt", "modified"],
			["renamed.txt", "renamed"],
			["staged-new.txt", "added"],
		]);
		const conflict = files[0];
		expect(conflict).toMatchObject({ additions: 4, deletions: 0 });
		expect(conflict?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 7 });
		expect(conflict?.hunks[0]?.lines[1]).toEqual({
			kind: "add",
			text: "<<<<<<< HEAD",
			oldLine: null,
			newLine: 2,
			noNewline: false,
		});
		expect(conflict?.hunks[0]?.lines.at(-1)).toMatchObject({ kind: "context", text: "line3", oldLine: 3, newLine: 7 });
	});

	it("reports binaries, deletions and renames", () => {
		const files = parseUnifiedDiff(fixture("diff-merge.txt"));
		const binary = files.find(file => file.path === "image.bin");
		expect(binary).toMatchObject({ binary: true, hunks: [] });
		expect(files.find(file => file.path === "delete.txt")).toMatchObject({ oldMode: "100644", newMode: null, deletions: 2 });
		const renamed = files.find(file => file.path === "renamed.txt");
		expect(renamed).toMatchObject({ origPath: "rename-me.txt", additions: 1 });
		expect(renamed?.hunks[0]).toMatchObject({ section: "e", oldStart: 6, newStart: 6 });
		expect(renamed?.patch.startsWith("diff --git a/rename-me.txt b/renamed.txt\nsimilarity index 88%\n")).toBe(true);
	});

	it("decodes spaced, quoted and non-ASCII paths, mode changes and type changes", () => {
		const files = parseUnifiedDiff(fixture("diff-paths.txt"));
		expect(files.map(file => [file.path, file.kind])).toEqual([
			["link-me", "typechange"],
			["moved space.txt", "renamed"],
			["nonl.txt", "modified"],
			["run.sh", "modified"],
			["tab\tname.txt", "modified"],
			["ünï.txt", "modified"],
		]);
		expect(files[0]).toMatchObject({ oldMode: "100644", newMode: "120000", additions: 1, deletions: 1 });
		expect(files[0]?.hunks).toHaveLength(2);
		expect(files[1]?.origPath).toBe("with space.txt");
		expect(files[3]).toMatchObject({ oldMode: "100644", newMode: "100755", hunks: [] });
	});

	it("marks lines followed by '\\ No newline at end of file'", () => {
		const nonl = parseUnifiedDiff(fixture("diff-paths.txt")).find(file => file.path === "nonl.txt");
		expect(nonl?.hunks[0]?.lines.map(line => [line.kind, line.text, line.noNewline])).toEqual([
			["del", "no newline", true],
			["add", "no newline", false],
			["add", "still none", true],
		]);
	});

	it("parses CRLF git output without retaining carriage returns in paths or hunk content", () => {
		const diff = [
			"diff --git a/file.txt b/file.txt",
			"index 1234567..89abcde 100644",
			"--- a/file.txt",
			"+++ b/file.txt",
			"@@ -1 +1 @@",
			"-before",
			"+after",
			"",
		].join("\r\n");
		expect(parseUnifiedDiff(diff)).toMatchObject([
			{
				path: "file.txt",
				kind: "modified",
				additions: 1,
				deletions: 1,
				hunks: [{ header: "@@ -1 +1 @@", lines: [{ text: "before" }, { text: "after" }] }],
				patch: expect.not.stringContaining("\r"),
			},
		]);
	});
});

describe("untracked files", () => {
	it("synthesizes the same diff git prints for a new file", () => {
		const synthetic = syntheticAddedDiff("untracked file.txt", "100644", "new\nfile\n");
		expect(synthetic.patch).toBe(
			"diff --git a/untracked file.txt b/untracked file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/untracked file.txt\n@@ -0,0 +1,2 @@\n+new\n+file\n",
		);
		expect(synthetic).toMatchObject({ kind: "added", untracked: true, additions: 2, deletions: 0 });
		expect(synthetic.hunks[0]?.lines.map(line => line.newLine)).toEqual([1, 2]);
	});

	it("handles missing trailing newline, empty and binary files", () => {
		const noEol = syntheticAddedDiff("a", "100644", "x");
		expect(noEol.patch).toContain("@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n");
		expect(noEol.hunks[0]?.lines[0]?.noNewline).toBe(true);
		expect(syntheticAddedDiff("e", "100644", "")).toMatchObject({ additions: 0, hunks: [] });
		expect(syntheticAddedDiff("b", "100644", null)).toMatchObject({ binary: true, hunks: [] });
	});

	it("counts lines and detects binary content like git", () => {
		expect(countLines("")).toBe(0);
		expect(countLines("a\nb\n")).toBe(2);
		expect(countLines("a\nb")).toBe(2);
		expect(isBinary(Buffer.from("\x89PNG\0\0\x01"))).toBe(true);
		expect(isBinary(Buffer.from("plain text"))).toBe(false);
	});
});

describe("unquotePath", () => {
	it("decodes git's C-style quoting including octal UTF-8", () => {
		expect(unquotePath('"tab\\tname.txt"')).toBe("tab\tname.txt");
		expect(unquotePath('"\\303\\274n\\303\\257.txt"')).toBe("ünï.txt");
		expect(unquotePath("plain.txt")).toBe("plain.txt");
	});
});

describe("parseWorktrees", () => {
	it("reads branches, detached and locked worktrees and marks main/current", () => {
		const list = parseWorktrees(fixture("worktrees.z"), "/tmp/vomp-fx/wt-feature");
		expect(list).toEqual([
			expect.objectContaining({ path: "/private/tmp/vomp-fx/other", branch: "main", isMain: true, isCurrent: false }),
			expect.objectContaining({
				path: "/private/tmp/vomp-fx/wt-detached",
				branch: null,
				detached: true,
				locked: true,
				lockReason: "testing lock",
				isMain: false,
			}),
			expect.objectContaining({ path: "/private/tmp/vomp-fx/wt-feature", branch: "feature/x", isCurrent: true }),
		]);
	});
});

describe("parseRefs", () => {
	it("reads ahead/behind, gone upstreams and skips remote HEAD", () => {
		const { local, remote } = parseRefs(fixture("refs.z"));
		expect(local.map(branch => branch.name)).toEqual(["gone-up", "main"]);
		expect(local[0]).toMatchObject({ upstream: "origin/deleted-branch", upstreamGone: true, ahead: 0, current: false });
		expect(local[1]).toMatchObject({
			upstream: "origin/main",
			ahead: 1,
			behind: 1,
			current: true,
			subject: "ours",
			worktreePath: "/private/tmp/vomp-fx/repo",
			date: 1790789825000,
		});
		expect(remote.map(branch => [branch.name, branch.remote])).toEqual([["origin/main", "origin"]]);
	});
});

describe("remotes and GitHub URLs", () => {
	it("parses `git remote -v`", () => {
		const remotes = parseRemotes(
			"fork\tgit@github.com:me/omp.git (fetch)\nfork\tgit@github.com:me/omp.git (push)\norigin\thttps://github.com/can1357/oh-my-pi.git (fetch)\norigin\thttps://github.com/can1357/oh-my-pi.git (push)\n",
		);
		expect(remotes).toEqual([
			{ name: "fork", url: "git@github.com:me/omp.git" },
			{ name: "origin", url: "https://github.com/can1357/oh-my-pi.git" },
		]);
		expect(pickGitHubRemote(remotes)).toMatchObject({ remote: "origin", owner: "can1357", repo: "oh-my-pi" });
	});

	it("recognizes every GitHub URL form", () => {
		const expected = { host: "github.com", owner: "o", repo: "r", webUrl: "https://github.com/o/r" };
		for (const url of [
			"https://github.com/o/r",
			"https://github.com/o/r.git",
			"https://user@github.com/o/r.git/",
			"git@github.com:o/r.git",
			"ssh://git@github.com/o/r.git",
			"ssh://git@ssh.github.com:443/o/r.git",
		]) {
			expect(parseGitHubUrl(url), url).toEqual(expected);
		}
		expect(parseGitHubUrl("https://gitlab.com/o/r.git")).toBeNull();
		expect(parseGitHubUrl("/srv/git/r.git")).toBeNull();
		expect(parseGitHubUrl("git@github.example.com:team/app.git")).toMatchObject({ host: "github.example.com" });
	});

	it("derives the clone folder name", () => {
		expect(repoNameFromUrl("https://github.com/o/my-repo.git")).toBe("my-repo");
		expect(repoNameFromUrl("git@github.com:o/my-repo.git")).toBe("my-repo");
		expect(repoNameFromUrl("https://github.com/o/my-repo/")).toBe("my-repo");
	});
});

describe("parseCloneProgress", () => {
	it("maps each phase of real clone output to a monotonic overall percentage", () => {
		const lines = fixture("clone-progress.txt").split(/[\r\n]/);
		const parsed = lines.map(line => parseCloneProgress(line)).filter(entry => entry !== null);
		expect(parsed.map(entry => entry.phase).filter((phase, i, all) => all[i - 1] !== phase)).toEqual([
			"enumerating",
			"counting",
			"compressing",
			"receiving",
			"resolving",
		]);
		const receiving = parsed.find(entry => entry.message === "Receiving objects:  50% (5/10)");
		expect(receiving).toMatchObject({ phase: "receiving", percent: 50, overall: 45 });
		expect(parsed.at(-1)).toMatchObject({ phase: "resolving", percent: 100, overall: 95 });
		expect(parseCloneProgress("Cloning into 'clone-out'...")).toBeNull();
	});
});

describe("parseCommitOutput", () => {
	it("extracts the dry-run message, warnings and fallback flag", () => {
		const parsed = parseCommitOutput(fixture("omp-commit-dry-run.out"), "");
		expect(parsed.commits).toEqual([
			{ message: "docs: updated documentation for a.txt and 1 other\n\n- Updated a.txt\n- Updated n.txt", changes: null },
		]);
		expect(parsed.warnings).toEqual(["Commit generated using fallback due to agent failure"]);
		expect(parsed.usedFallback).toBe(true);
		expect(parsed.noChanges).toBe(false);
	});

	it("reads a real commit run", () => {
		const parsed = parseCommitOutput(fixture("omp-commit.out"), "");
		expect(parsed).toMatchObject({ commits: [], usedFallback: true, noChanges: false });
	});

	it("detects a clean tree", () => {
		expect(parseCommitOutput("● Resolving model...\n", "No changes to commit.\n").noChanges).toBe(true);
	});

	it("reads split plans (format from omp's runSplitCommit dry-run branch)", () => {
		const stdout =
			"● Starting commit agent...\n\nSplit commit plan (dry run):\nCommit 1:\nfeat(api): add endpoint\n\n- Added route\nChanges: src/api.ts (all), src/types.ts (hunks 1, 2)\nCommit 2:\ndocs: note endpoint\nChanges: README.md (lines 3-9)\n";
		expect(parseCommitOutput(stdout, "").commits).toEqual([
			{ message: "feat(api): add endpoint\n\n- Added route", changes: "src/api.ts (all), src/types.ts (hunks 1, 2)" },
			{ message: "docs: note endpoint", changes: "README.md (lines 3-9)" },
		]);
	});
	it("parses CRLF output from omp commit", () => {
		const stdout = [
			"● Starting commit agent...",
			"",
			"Split commit plan (dry run):",
			"Commit 1:",
			"feat(api): add endpoint",
			"",
			"- Added route",
			"Changes: src/api.ts",
			"",
		].join("\r\n");
		expect(parseCommitOutput(stdout, "No changes to commit.\r\n")).toEqual({
			commits: [{ message: "feat(api): add endpoint\n\n- Added route", changes: "src/api.ts" }],
			warnings: [],
			usedFallback: false,
			noChanges: true,
		});
	});
});
