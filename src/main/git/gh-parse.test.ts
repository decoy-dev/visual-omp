import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	formatCiFailures,
	normalizeChecks,
	parseActionsJobUrl,
	parseGhAuthStatus,
	PrViewSchema,
	summarizeJobLog,
	toPullRequest,
} from "./gh-parse";

/** Real gh 2.62 output (account names anonymized; PR/log from a public repository). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseGhAuthStatus", () => {
	it("picks the active account among several", () => {
		const status = parseGhAuthStatus(fixture("gh-auth-ok.txt"));
		expect(status).toMatchObject({ loggedIn: true, account: "octo-main", problem: null });
		expect(status.accounts).toEqual([
			{
				login: "octo-main",
				active: true,
				ok: true,
				source: "keyring",
				protocol: "https",
				scopes: ["delete_repo", "gist", "read:org", "repo", "workflow"],
				error: null,
			},
			expect.objectContaining({ login: "octo-alt", active: false, ok: true }),
		]);
	});

	it("parses CRLF auth status details", () => {
		const status = parseGhAuthStatus(fixture("gh-auth-ok.txt").replace(/\n/g, "\r\n"));
		expect(status).toMatchObject({ loggedIn: true, account: "octo-main", problem: null });
		expect(status.accounts[0]).toMatchObject({
			login: "octo-main",
			active: true,
			protocol: "https",
			scopes: ["delete_repo", "gist", "read:org", "repo", "workflow"],
		});
	});

	it("reports being logged out", () => {
		const status = parseGhAuthStatus(fixture("gh-auth-none.txt"));
		expect(status).toMatchObject({ loggedIn: false, account: null, accounts: [] });
		expect(status.problem).toContain("gh auth login");
	});

	it("explains an invalid token", () => {
		const status = parseGhAuthStatus(fixture("gh-auth-bad-token.txt"));
		expect(status.loggedIn).toBe(false);
		expect(status.accounts).toEqual([
			expect.objectContaining({ login: null, ok: false, active: true, source: "GH_TOKEN" }),
		]);
		expect(status.problem).toBe("The token in GH_TOKEN is invalid.");
	});
});

describe("pull request status", () => {
	const pr = toPullRequest(PrViewSchema.parse(JSON.parse(fixture("gh-pr-view.json"))));

	it("maps state, review and mergeability", () => {
		expect(pr).toMatchObject({
			number: 13877,
			state: "open",
			draft: false,
			reviewDecision: null,
			mergeable: "conflicting",
			mergeState: "dirty",
			baseBranch: "main",
			headBranch: "feat/goal-tool-default",
		});
	});

	it("normalizes checks and counts buckets", () => {
		const failing = pr.checks.filter(check => check.bucket === "fail").map(check => check.name);
		expect(failing).toEqual([
			"Test coding-agent native/unit (TS) 2/3",
			"Test TS workspace fast",
			"Test coding-agent UI/TUI (TS)",
		]);
		expect(pr.checks.find(check => check.name === "Test TS workspace fast")).toEqual({
			name: "Test TS workspace fast",
			workflow: "CI",
			status: "completed",
			conclusion: "failure",
			bucket: "fail",
			url: "https://github.com/can1357/oh-my-pi/actions/runs/36729556785/job/109935474731",
			startedAt: Date.parse("2026-09-30T14:30:33Z"),
			completedAt: Date.parse("2026-09-30T14:32:43Z"),
		});
		const { total, failing: failCount, pending } = pr.checksSummary;
		expect({ failCount, pending }).toEqual({ failCount: 3, pending: 0 });
		expect(total).toBe(pr.checksSummary.passing + pr.checksSummary.skipped + failCount);
	});

	it("keeps only the latest run of a re-run check and maps commit statuses", () => {
		const checks = normalizeChecks([
			{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", workflowName: "CI", startedAt: "2026-01-01T00:00:00Z" },
			{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "", workflowName: "CI", startedAt: "2026-01-02T00:00:00Z" },
			{ __typename: "StatusContext", context: "renovate/stability-days", state: "SUCCESS", targetUrl: "https://docs.renovatebot.com/", startedAt: "2026-09-30T10:01:12Z" },
			{ __typename: "StatusContext", context: "ci/external", state: "PENDING", targetUrl: null },
			{ __typename: "SomethingNew" },
		]);
		expect(checks.map(check => [check.name, check.status, check.conclusion, check.bucket])).toEqual([
			["test", "in_progress", null, "pending"],
			["renovate/stability-days", "completed", "success", "pass"],
			["ci/external", "in_progress", null, "pending"],
		]);
	});

	it("extracts the Actions job id from a check URL", () => {
		expect(parseActionsJobUrl("https://github.com/can1357/oh-my-pi/actions/runs/36729556785/job/109935475243")).toEqual({
			host: "github.com",
			owner: "can1357",
			repo: "oh-my-pi",
			jobId: "109935475243",
		});
		expect(parseActionsJobUrl("https://docs.renovatebot.com/")).toBeNull();
	});
});

describe("summarizeJobLog", () => {
	const steps = summarizeJobLog(fixture("gh-job-log.txt"), 80);

	it("finds the failing step and its error annotation", () => {
		expect(steps).toHaveLength(1);
		expect(steps[0]?.step).toBe("Run bun run ci:test:coding-agent:native");
		expect(steps[0]?.errors).toEqual(["Process completed with exit code 1."]);
	});

	it("keeps the tail of the step output up to the error, without timestamps or cleanup noise", () => {
		const excerpt = steps[0]?.excerpt ?? "";
		const lines = excerpt.split("\n");
		expect(lines.length).toBeLessThanOrEqual(80);
		expect(lines.at(-1)).toBe("Error: Process completed with exit code 1.");
		expect(excerpt).toContain("TypeError: session.getEnabledToolNames is not a function.");
		expect(excerpt).toContain(" 1 failed");
		expect(excerpt).not.toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d/);
		expect(excerpt).not.toContain("Post job cleanup");
		expect(excerpt).not.toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24");
	});

	it("falls back to the log tail when no step reported an error", () => {
		const tail = summarizeJobLog("2026-01-01T00:00:00.0000000Z ##[group]Run make\n2026-01-01T00:00:00.1Z make\n##[endgroup]\nboom\n", 10);
		expect(tail).toEqual([{ step: "Log tail", excerpt: "boom", errors: [] }]);
	});

	it("formats a Fix CI report", () => {
		const text = formatCiFailures({ number: 7, url: "https://github.com/o/r/pull/7" }, [
			{ name: "test", workflow: "CI", url: "https://x/job/1", conclusion: "failure", logAvailable: true, steps, error: null },
			{ name: "lint", workflow: null, url: null, conclusion: "failure", logAvailable: false, steps: [], error: "not a GitHub Actions job" },
		]);
		expect(text).toContain("CI is failing on PR #7 (https://github.com/o/r/pull/7).");
		expect(text).toContain("## CI / test — failure");
		expect(text).toContain("### Step: Run bun run ci:test:coding-agent:native\n\n- Process completed with exit code 1.");
		expect(text).toContain("```text\n");
		expect(text).toContain("(Log unavailable: not a GitHub Actions job.)");
	});
});
