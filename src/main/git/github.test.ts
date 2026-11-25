import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ciFailures } from "./github";

const REPO_ROOT = resolve("repo");

const fake = vi.hoisted(() => ({
	requireRepo: vi.fn(),
	runGh: vi.fn(),
}));

vi.mock("./repo", () => ({
	mapLimit: async <T, U>(items: T[], _limit: number, fn: (item: T) => Promise<U>) => Promise.all(items.map(fn)),
	pushBranch: vi.fn(),
	requireRepo: (...args: unknown[]) => fake.requireRepo(...args),
	status: vi.fn(),
}));

vi.mock("./run", () => ({
	failure: (label: string, result: { stderr?: string }) => new Error(`${label}: ${result.stderr ?? ""}`),
	gh: vi.fn(),
	MissingBinaryError: class MissingBinaryError extends Error {},
	runGh: (...args: unknown[]) => fake.runGh(...args),
}));

const prViewJson = (url: string, checks: Array<{ name: string; detailsUrl: string }>) =>
	JSON.stringify({
		number: 42,
		url,
		title: "Test PR",
		state: "OPEN",
		isDraft: false,
		reviewDecision: "",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		baseRefName: "main",
		headRefName: "feat",
		statusCheckRollup: checks.map(check => ({
			__typename: "CheckRun",
			name: check.name,
			status: "COMPLETED",
			conclusion: "FAILURE",
			workflowName: "CI",
			detailsUrl: check.detailsUrl,
			startedAt: "2026-01-01T00:00:00Z",
			completedAt: "2026-01-01T00:01:00Z",
		})),
	});

describe("ciFailures host and URL validation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fake.requireRepo.mockResolvedValue({ root: REPO_ROOT });
	});

	it("fetches logs when the failing check host matches github.com", async () => {
		fake.runGh
			.mockResolvedValueOnce({
				code: 0,
				stdout: prViewJson("https://github.com/org/repo/pull/42", [
					{ name: "ci", detailsUrl: "https://github.com/org/repo/actions/runs/10/job/20" },
				]),
				stderr: "",
			})
			.mockResolvedValueOnce({ code: 0, stdout: "2026-01-01T00:00:00Z ##[error]boom\n", stderr: "" });

		const result = await ciFailures(REPO_ROOT);
		expect(fake.runGh).toHaveBeenNthCalledWith(
			2,
			["api", "repos/org/repo/actions/jobs/20/logs"],
			{ cwd: REPO_ROOT, timeoutMs: 120_000 },
		);
		expect(result.checks[0]?.logAvailable).toBe(true);
	});

	it("passes --hostname when the PR and check share the same GitHub Enterprise host", async () => {
		fake.runGh
			.mockResolvedValueOnce({
				code: 0,
				stdout: prViewJson("https://ghe.example.internal/org/repo/pull/42", [
					{ name: "ci", detailsUrl: "https://ghe.example.internal/org/repo/actions/runs/10/job/20" },
				]),
				stderr: "",
			})
			.mockResolvedValueOnce({ code: 0, stdout: "2026-01-01T00:00:00Z ##[error]boom\n", stderr: "" });

		const result = await ciFailures(REPO_ROOT);
		expect(fake.runGh).toHaveBeenNthCalledWith(
			2,
			["api", "repos/org/repo/actions/jobs/20/logs", "--hostname", "ghe.example.internal"],
			{ cwd: REPO_ROOT, timeoutMs: 120_000 },
		);
		expect(result.checks[0]?.logAvailable).toBe(true);
	});

	it("refuses to call gh api for mismatched hosts or traversal URLs", async () => {
		fake.runGh.mockResolvedValueOnce({
			code: 0,
			stdout: prViewJson("https://github.com/org/repo/pull/42", [
				{ name: "evil-host", detailsUrl: "https://attacker.example/org/repo/actions/runs/10/job/20" },
				{ name: "traversal", detailsUrl: "https://github.com/../user/actions/runs/10/job/20" },
				{ name: "encoded", detailsUrl: "https://github.com/%2e%2e/user/actions/runs/10/job/20" },
			]),
			stderr: "",
		});

		const result = await ciFailures(REPO_ROOT);
		expect(fake.runGh).toHaveBeenCalledTimes(1);
		expect(result.checks.find(check => check.name === "evil-host")).toMatchObject({
			logAvailable: false,
			error: "check URL host does not match pull request host",
		});
		expect(result.checks.find(check => check.name === "traversal")).toMatchObject({
			logAvailable: false,
			error: "not a GitHub Actions job",
		});
		expect(result.checks.find(check => check.name === "encoded")).toMatchObject({
			logAvailable: false,
			error: "not a GitHub Actions job",
		});
	});
});
