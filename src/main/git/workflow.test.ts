import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { status } from "./repo";
import { branchCommits, createBranch, parseBranchLog, parsePrDraft, prContext, stageOnly, switchBranch } from "./workflow";

// vi.mock is hoisted above the imports: prWrite's omp call must never run in tests.
vi.mock("../omp/cli", () => ({ runOmp: vi.fn() }));

let dir = "";
const sh = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "vomp-wf-"));
	sh("init", "-q", "--initial-branch=main");
	sh("config", "user.email", "t@example.com");
	sh("config", "user.name", "T");
	writeFileSync(join(dir, "a.txt"), "a\n");
	sh("add", ".");
	sh("commit", "-qm", "first");
	sh("branch", "other");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("switchBranch", () => {
	it("refuses while tracked files have unsaved changes and leaves the branch alone", async () => {
		writeFileSync(join(dir, "a.txt"), "changed\n");
		await expect(switchBranch(dir, "other")).rejects.toThrow(/unsaved changes/);
		expect(sh("branch", "--show-current").trim()).toBe("main");
	});

	it("switches when only untracked files exist, keeping them", async () => {
		writeFileSync(join(dir, "new.txt"), "n\n");
		await switchBranch(dir, "other");
		expect(sh("branch", "--show-current").trim()).toBe("other");
		expect((await status(dir)).totals.untracked).toBe(1);
	});

	it("rejects an unknown branch", async () => {
		await expect(switchBranch(dir, "nope")).rejects.toThrow(/no branch called "nope"/);
	});
});

describe("createBranch", () => {
	it("creates and switches, carrying uncommitted edits", async () => {
		writeFileSync(join(dir, "a.txt"), "changed\n");
		await createBranch(dir, "feature/x");
		expect(sh("branch", "--show-current").trim()).toBe("feature/x");
		expect((await status(dir)).totals.unstaged).toBe(1);
	});

	it("rejects invalid names", async () => {
		await expect(createBranch(dir, "bad name..")).rejects.toThrow(/can't be used as a branch name/);
		await expect(createBranch(dir, "  ")).rejects.toThrow(/can't be used/);
	});
});

describe("stageOnly", () => {
	it("stages exactly the chosen paths, dropping anything staged before", async () => {
		writeFileSync(join(dir, "a.txt"), "changed\n");
		writeFileSync(join(dir, "b.txt"), "b\n");
		writeFileSync(join(dir, "c.txt"), "c\n");
		sh("add", "c.txt");
		await stageOnly(dir, ["b.txt"]);
		expect(sh("diff", "--cached", "--name-only").trim()).toBe("b.txt");
	});
});

describe("branch commits and PR context", () => {
	it("lists commits since the remote base, and the bases the remote offers", async () => {
		const remote = mkdtempSync(join(tmpdir(), "vomp-wf-remote-"));
		try {
			execFileSync("git", ["init", "-q", "--bare", remote]);
			sh("remote", "add", "origin", remote);
			// pickGitHubRemote needs a GitHub-looking URL; the fetch URL itself stays local.
			sh("config", "remote.origin.url", "https://github.com/acme/app.git");
			sh("config", "remote.origin.pushurl", remote);
			sh("push", "-q", remote, "main:main", "other:other");
			sh("fetch", "-q", remote, "+refs/heads/*:refs/remotes/origin/*");
			sh("switch", "-q", "-c", "feat");
			writeFileSync(join(dir, "b.txt"), "b\n");
			sh("add", ".");
			sh("commit", "-qm", "Add b", "-m", "Because b.");
			const context = await prContext(dir);
			expect(context).toMatchObject({ branch: "feat", remote: "origin", defaultBase: "main" });
			expect([...context.bases].sort()).toEqual(["main", "other"]);
			const commits = await branchCommits(dir, "main");
			expect(commits.map(commit => [commit.subject, commit.body])).toEqual([["Add b", "Because b."]]);
			expect(await branchCommits(dir, "missing")).toHaveLength(2);
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});
});

describe("parseBranchLog", () => {
	it("keeps multi-line bodies and empty bodies", () => {
		const raw = "aaa\0Fix\0line 1\nline 2\n\x1e\nbbb\0Add\0\x1e\n";
		expect(parseBranchLog(raw)).toEqual([
			{ sha: "aaa", subject: "Fix", body: "line 1\nline 2" },
			{ sha: "bbb", subject: "Add", body: "" },
		]);
	});
});

describe("parsePrDraft", () => {
	it("takes the first line as the title and the rest as the body", () => {
		expect(parsePrDraft("\nFix coupon totals\n\nThe total ignored coupons.\n")).toEqual({
			title: "Fix coupon totals",
			body: "The total ignored coupons.",
		});
	});

	it("strips labels, headings and a wrapping code fence", () => {
		expect(parsePrDraft("```markdown\n# Title: **Add login**\n\nDescription:\nAdds it.\n```")).toEqual({
			title: "Add login",
			body: "Adds it.",
		});
	});

	it("rejects an empty reply", () => {
		expect(() => parsePrDraft("  \n")).toThrow(/did not return/);
	});
});
