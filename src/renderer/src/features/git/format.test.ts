import type { GhPullRequest } from "@shared/contracts/git";
import { describe, expect, it } from "vitest";
import { ciState, humanizeBranch, prefillPr, worktreeLocation } from "./format";

const pr = (summary: Partial<GhPullRequest["checksSummary"]>): GhPullRequest => ({
	number: 1,
	url: "https://github.com/a/b/pull/1",
	title: "t",
	state: "open",
	draft: false,
	reviewDecision: null,
	mergeable: "mergeable",
	mergeState: "clean",
	baseBranch: "main",
	headBranch: "feat",
	checks: [],
	checksSummary: { total: 0, passing: 0, failing: 0, pending: 0, skipped: 0, cancelled: 0, ...summary },
});

describe("ciState", () => {
	it("prefers failure over running over passing", () => {
		expect(ciState(pr({ total: 3, failing: 1, pending: 1, passing: 1 }))).toBe("fail");
		expect(ciState(pr({ total: 2, pending: 1, passing: 1 }))).toBe("pending");
		expect(ciState(pr({ total: 2, passing: 1, skipped: 1 }))).toBe("pass");
		expect(ciState(pr({}))).toBe("none");
	});
});

describe("prefillPr", () => {
	it("uses a single commit's subject and body", () => {
		expect(prefillPr("feat", [{ sha: "a", subject: "Add login", body: "Why." }])).toEqual({ title: "Add login", body: "Why." });
	});

	it("titles several commits after the branch and lists their subjects", () => {
		const commits = [
			{ sha: "a", subject: "One", body: "" },
			{ sha: "b", subject: "Two", body: "x" },
		];
		expect(prefillPr("fix/checkout_total", commits)).toEqual({ title: "Checkout total", body: "- One\n- Two" });
		expect(prefillPr(null, commits).title).toBe("Two");
	});
});

describe("humanizeBranch", () => {
	it("keeps the name when nothing is left after cleanup", () => {
		expect(humanizeBranch("--")).toBe("--");
	});
});

describe("worktreeLocation", () => {
	const at = new Date(2026, 8, 30, 9, 5, 7);

	it("puts copies in a sibling <repo>-copies folder", () => {
		expect(worktreeLocation("/Users/me/site/", at)).toEqual({
			path: "/Users/me/site-copies/copy-20260930-090507",
			name: "copy-20260930-090507",
		});
	});

	it("handles Windows paths and repos at the drive root", () => {
		expect(worktreeLocation("C:\\code\\app", at).path).toBe("C:\\code\\app-copies\\copy-20260930-090507");
		expect(worktreeLocation("/app", at).path).toBe("/app-copies/copy-20260930-090507");
	});
});
