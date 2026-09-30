import type {
	GhAuthStatus,
	GhCiFailures,
	GhFailedCheck,
	GhPrCreateOptions,
	GhPrCreateResult,
	GhPullRequest,
} from "@shared/contracts/git";
import {
	formatCiFailures,
	parseActionsJobUrl,
	parseGhAuthStatus,
	PR_VIEW_FIELDS,
	PrViewSchema,
	summarizeJobLog,
	toPullRequest,
} from "./gh-parse";
import { mapLimit, pushBranch, requireRepo, status } from "./repo";
import { failure, gh, MissingBinaryError, runGh } from "./run";

const DEFAULT_LOG_LINES = 80;
const LOG_FETCH_CONCURRENCY = 4;

export async function authStatus(): Promise<GhAuthStatus> {
	try {
		const result = await runGh(["auth", "status", "--hostname", "github.com"]);
		return { installed: true, ...parseGhAuthStatus(`${result.stdout}\n${result.stderr}`) };
	} catch (error) {
		if (!(error instanceof MissingBinaryError)) throw error;
		return {
			installed: false,
			loggedIn: false,
			host: "github.com",
			account: null,
			accounts: [],
			problem: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com.",
		};
	}
}

export async function prStatus(cwd: string): Promise<GhPullRequest | null> {
	const { root } = await requireRepo(cwd);
	const result = await runGh(["pr", "view", "--json", PR_VIEW_FIELDS], { cwd: root });
	if (result.code !== 0) {
		if (/no (?:open )?pull requests? found/i.test(result.stderr)) return null;
		throw failure("gh pr view", result);
	}
	return toPullRequest(PrViewSchema.parse(JSON.parse(result.stdout)));
}

/** Push the branch when it has no upstream or unpushed commits, then open the PR. */
export async function createPr(cwd: string, options: GhPrCreateOptions): Promise<GhPrCreateResult> {
	const { root } = await requireRepo(cwd);
	const current = await status(root);
	if (!current.branch) throw new Error("Cannot open a pull request from a detached HEAD. Create a branch first.");
	const pushed = !current.upstream || current.ahead > 0;
	if (pushed) await pushBranch(root);
	const args = ["pr", "create", "--title", options.title, "--body", options.body];
	if (options.draft) args.push("--draft");
	if (options.base) args.push("--base", options.base);
	const out = await gh(args, { cwd: root, timeoutMs: 120_000 });
	const url = out.trim().split("\n").reverse().find(line => /^https?:\/\/\S+\/pull\/\d+/.test(line.trim()))?.trim();
	if (!url) throw new Error(`gh pr create did not print a pull request URL:\n${out.trim()}`);
	return { url, number: Number(/\/pull\/(\d+)/.exec(url)?.[1]), pushed };
}

/** Failing checks of the current branch's PR with log excerpts from GitHub Actions. */
export async function ciFailures(cwd: string, maxLines = DEFAULT_LOG_LINES): Promise<GhCiFailures> {
	const { root } = await requireRepo(cwd);
	const pr = await prStatus(root);
	if (!pr) throw new Error("The current branch has no pull request.");
	const failing = pr.checks.filter(check => check.bucket === "fail");
	const checks = await mapLimit(failing, LOG_FETCH_CONCURRENCY, async (check): Promise<GhFailedCheck> => {
		const base = { name: check.name, workflow: check.workflow, url: check.url, conclusion: check.conclusion };
		const job = check.url ? parseActionsJobUrl(check.url) : null;
		if (!job) return { ...base, logAvailable: false, steps: [], error: "not a GitHub Actions job" };
		const args = ["api", `repos/${job.owner}/${job.repo}/actions/jobs/${job.jobId}/logs`];
		if (job.host !== "github.com") args.push("--hostname", job.host);
		const result = await runGh(args, { cwd: root, timeoutMs: 120_000 });
		if (result.code !== 0) {
			return { ...base, logAvailable: false, steps: [], error: result.stderr.trim() || "log download failed" };
		}
		return { ...base, logAvailable: true, steps: summarizeJobLog(result.stdout, maxLines), error: null };
	});
	return { pr: pr.number, url: pr.url, checks, text: formatCiFailures(pr, checks) };
}
