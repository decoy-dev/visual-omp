/** Pure parsers for GitHub CLI output: auth status text, `pr view` JSON, Actions job logs. */
import { z } from "zod";
import type {
	GhAccount,
	GhAuthStatus,
	GhCheck,
	GhChecksSummary,
	GhFailedCheck,
	GhFailedStep,
	GhPullRequest,
} from "@shared/contracts/git";

// ───────────────────────────────────────── gh auth status

const ACCOUNT_RE = /^\s*(\S+)\s+(Logged in to|Failed to log in to)\s+(\S+)\s+(?:account|as)\s+(\S+)\s+\(([^)]+)\)/;
const TOKEN_RE = /^\s*(\S+)\s+Failed to log in to\s+(\S+)\s+using token\s+\(([^)]+)\)/;
const DETAIL_RE = /^\s*-\s+(.*)$/;

/** Parse `gh auth status --hostname github.com` output (stdout or stderr; format stable since gh 2.40). */
export function parseGhAuthStatus(text: string): Omit<GhAuthStatus, "installed"> {
	const accounts: GhAccount[] = [];
	let account: GhAccount | null = null;
	for (const line of text.split("\n")) {
		const match = ACCOUNT_RE.exec(line);
		const tokenOnly = match ? null : TOKEN_RE.exec(line);
		if (match || tokenOnly) {
			const ok = match?.[2] === "Logged in to";
			account = {
				login: match?.[4] ?? null,
				active: false,
				ok,
				source: match?.[5] ?? tokenOnly?.[3] ?? null,
				protocol: null,
				scopes: [],
				error: null,
			};
			accounts.push(account);
			continue;
		}
		const detail = account ? DETAIL_RE.exec(line)?.[1] : undefined;
		if (!account || detail === undefined) continue;
		if (detail.startsWith("Active account: ")) account.active = detail.endsWith("true");
		else if (detail.startsWith("Git operations protocol: ")) account.protocol = detail.slice(25).trim();
		else if (detail.startsWith("Token scopes: ")) {
			account.scopes = [...detail.slice(14).matchAll(/'([^']+)'/g)].map(scope => scope[1] ?? "");
		} else if (!account.ok && !detail.startsWith("Token: ")) {
			account.error = account.error ? `${account.error} ${detail}` : detail;
		}
	}
	const active = accounts.find(entry => entry.active) ?? accounts[0] ?? null;
	const loggedIn = active?.ok ?? false;
	let problem: string | null = null;
	if (!active) problem = "Not signed in to GitHub. Run `gh auth login`.";
	else if (!loggedIn) problem = active.error ?? "The GitHub token is invalid. Run `gh auth login` again.";
	return { loggedIn, host: "github.com", account: loggedIn ? active?.login ?? null : null, accounts, problem };
}

// ───────────────────────────────────────── gh pr view --json

const CheckRunSchema = z.object({
	__typename: z.literal("CheckRun"),
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullish(),
	detailsUrl: z.string().nullish(),
	workflowName: z.string().nullish(),
	startedAt: z.string().nullish(),
	completedAt: z.string().nullish(),
});

const StatusContextSchema = z.object({
	__typename: z.literal("StatusContext"),
	context: z.string(),
	state: z.string(),
	targetUrl: z.string().nullish(),
	startedAt: z.string().nullish(),
});

const RollupItemSchema = z.discriminatedUnion("__typename", [CheckRunSchema, StatusContextSchema]);

/** Fields requested from `gh pr view --json`. */
export const PR_VIEW_FIELDS =
	"number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,baseRefName,headRefName,statusCheckRollup";

export const PrViewSchema = z.object({
	number: z.number(),
	url: z.string(),
	title: z.string(),
	state: z.string(),
	isDraft: z.boolean(),
	reviewDecision: z.string().nullish(),
	mergeable: z.string(),
	mergeStateStatus: z.string(),
	baseRefName: z.string(),
	headRefName: z.string(),
	statusCheckRollup: z.array(z.unknown()).nullish(),
});

const epoch = (value: string | null | undefined): number | null => {
	if (!value || value.startsWith("0001-")) return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
};

const CONCLUSIONS: Record<string, GhCheck["conclusion"]> = {
	SUCCESS: "success",
	FAILURE: "failure",
	STARTUP_FAILURE: "failure",
	ERROR: "failure",
	CANCELLED: "cancelled",
	SKIPPED: "skipped",
	NEUTRAL: "neutral",
	TIMED_OUT: "timed_out",
	ACTION_REQUIRED: "action_required",
	STALE: "stale",
};

function bucketOf(status: GhCheck["status"], conclusion: GhCheck["conclusion"]): GhCheck["bucket"] {
	if (status !== "completed") return "pending";
	switch (conclusion) {
		case "success":
		case "neutral":
			return "pass";
		case "skipped":
			return "skipping";
		case "cancelled":
			return "cancel";
		default:
			return "fail";
	}
}

/**
 * Normalize `statusCheckRollup` into checks. Re-runs report the same check more than once; like
 * `gh pr checks`, only the most recent run per workflow+name is kept. Unknown item types are skipped.
 */
export function normalizeChecks(rollup: unknown[]): GhCheck[] {
	const latest = new Map<string, GhCheck>();
	for (const raw of rollup) {
		const parsed = RollupItemSchema.safeParse(raw);
		if (!parsed.success) continue;
		const item = parsed.data;
		let check: GhCheck;
		if (item.__typename === "CheckRun") {
			const status: GhCheck["status"] =
				item.status === "COMPLETED" ? "completed" : item.status === "IN_PROGRESS" ? "in_progress" : "queued";
			const conclusion = status === "completed" ? (CONCLUSIONS[item.conclusion ?? ""] ?? null) : null;
			check = {
				name: item.name,
				workflow: item.workflowName || null,
				status,
				conclusion,
				bucket: bucketOf(status, conclusion),
				url: item.detailsUrl || null,
				startedAt: epoch(item.startedAt),
				completedAt: epoch(item.completedAt),
			};
		} else {
			const pending = item.state === "PENDING" || item.state === "EXPECTED";
			const status: GhCheck["status"] = pending ? "in_progress" : "completed";
			const conclusion = pending ? null : (CONCLUSIONS[item.state] ?? "failure");
			check = {
				name: item.context,
				workflow: null,
				status,
				conclusion,
				bucket: bucketOf(status, conclusion),
				url: item.targetUrl || null,
				startedAt: epoch(item.startedAt),
				completedAt: null,
			};
		}
		const key = `${check.workflow ?? ""}\0${check.name}`;
		const previous = latest.get(key);
		if (!previous || (check.startedAt ?? 0) >= (previous.startedAt ?? 0)) latest.set(key, check);
	}
	return [...latest.values()];
}

export function summarizeChecks(checks: GhCheck[]): GhChecksSummary {
	const summary: GhChecksSummary = { total: checks.length, passing: 0, failing: 0, pending: 0, skipped: 0, cancelled: 0 };
	for (const check of checks) {
		if (check.bucket === "pass") summary.passing++;
		else if (check.bucket === "fail") summary.failing++;
		else if (check.bucket === "pending") summary.pending++;
		else if (check.bucket === "skipping") summary.skipped++;
		else summary.cancelled++;
	}
	return summary;
}

export function toPullRequest(view: z.infer<typeof PrViewSchema>): GhPullRequest {
	const checks = normalizeChecks(view.statusCheckRollup ?? []);
	const state = view.state.toLowerCase();
	const review = (view.reviewDecision ?? "").toLowerCase();
	const mergeable = view.mergeable.toLowerCase();
	return {
		number: view.number,
		url: view.url,
		title: view.title,
		state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
		draft: view.isDraft,
		reviewDecision:
			review === "approved" || review === "changes_requested" || review === "review_required" ? review : null,
		mergeable: mergeable === "mergeable" || mergeable === "conflicting" ? mergeable : "unknown",
		mergeState: view.mergeStateStatus.toLowerCase(),
		baseBranch: view.baseRefName,
		headBranch: view.headRefName,
		checks,
		checksSummary: summarizeChecks(checks),
	};
}

/** `{owner, repo, jobId}` from an Actions check URL (`…/actions/runs/<run>/job/<job>`). */
export function parseActionsJobUrl(url: string): { host: string; owner: string; repo: string; jobId: string } | null {
	const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/actions\/runs\/\d+\/job\/(\d+)/.exec(url);
	return match?.[1] && match[2] && match[3] && match[4]
		? { host: match[1], owner: match[2], repo: match[3], jobId: match[4] }
		: null;
}

// ───────────────────────────────────────── Actions job logs

const TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
/** Terminal color/cursor escape sequences some actions print into their logs. */
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const MAX_LINE_CHARS = 400;

interface LogStep {
	name: string;
	/** Output lines (the step's "Run …" header group excluded). */
	lines: string[];
	errors: string[];
	/** Index into `lines` just past the last `##[error]`. */
	errorEnd: number;
}

/**
 * Pull the failing steps out of a raw Actions job log (`GET /repos/{o}/{r}/actions/jobs/{id}/logs`).
 * Steps start at `##[group]Run …`; a step failed when it printed `##[error]`. Each excerpt is the
 * last `maxLines` output lines up to the final error, which is where test runners and compilers
 * print their summary. Without any `##[error]`, the log tail is returned as one pseudo-step.
 */
export function summarizeJobLog(log: string, maxLines: number): GhFailedStep[] {
	const steps: LogStep[] = [];
	let step: LogStep = { name: "Set up job", lines: [], errors: [], errorEnd: 0 };
	steps.push(step);
	let inHeader = false;
	for (const rawLine of log.replace(/^\uFEFF/, "").split(/\r?\n/)) {
		const line = rawLine.replace(TIMESTAMP_RE, "").replace(ANSI_RE, "");
		if (line.startsWith("##[group]Run ")) {
			step = { name: line.slice(9), lines: [], errors: [], errorEnd: 0 };
			steps.push(step);
			inHeader = true;
			continue;
		}
		if (line.startsWith("##[endgroup]")) {
			inHeader = false;
			continue;
		}
		if (inHeader || line.startsWith("##[end-action") || line.startsWith("##[debug]")) continue;
		if (line.startsWith("##[error]")) {
			const message = line.slice(9);
			step.errors.push(message);
			step.lines.push(`Error: ${message}`);
			step.errorEnd = step.lines.length;
			continue;
		}
		const text = line.replace(/^##\[(?:group|warning|notice)\]/, "");
		step.lines.push(text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text);
	}
	const failed = steps.filter(entry => entry.errors.length > 0);
	if (failed.length > 0) {
		return failed.map(entry => ({
			step: entry.name,
			excerpt: entry.lines.slice(0, entry.errorEnd).slice(-maxLines).join("\n").trim(),
			errors: entry.errors,
		}));
	}
	const tail = steps.flatMap(entry => entry.lines).slice(-maxLines);
	return tail.length > 0 ? [{ step: "Log tail", excerpt: tail.join("\n").trim(), errors: [] }] : [];
}

/** Markdown report of failing checks, suitable as the body of a "Fix CI" prompt. */
export function formatCiFailures(pr: { number: number; url: string }, checks: GhFailedCheck[]): string {
	if (checks.length === 0) return `No failing checks on PR #${pr.number} (${pr.url}).`;
	const parts = [`CI is failing on PR #${pr.number} (${pr.url}).`];
	for (const check of checks) {
		const title = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
		parts.push(`## ${title}${check.conclusion ? ` — ${check.conclusion}` : ""}`);
		if (check.url) parts.push(check.url);
		if (!check.logAvailable) {
			parts.push(`(Log unavailable: ${check.error ?? "not a GitHub Actions job"}.)`);
			continue;
		}
		for (const step of check.steps) {
			parts.push(`### Step: ${step.step}`);
			if (step.errors.length > 0) parts.push(step.errors.map(error => `- ${error}`).join("\n"));
			if (step.excerpt) parts.push(`\`\`\`text\n${step.excerpt.replaceAll("```", "` ` `")}\n\`\`\``);
		}
	}
	return parts.join("\n\n");
}
