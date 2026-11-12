/** `github` — gh CLI dispatch: repo views, PRs, searches, Actions run watch. */
import { Hourglass } from "@phosphor-icons/react";
import { Fragment, type ReactNode } from "react";
import { Badge, InvalidArg, Kv, KvGrid, Note, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, shortenPath, str, truncate } from "../util";

const SUCCESS_CONCLUSIONS: Record<string, string> = { success: "Succeeded", neutral: "Neutral", skipped: "Skipped" };
const FAILURE_CONCLUSIONS: Record<string, string> = {
	failure: "Failed",
	timed_out: "Timed out",
	cancelled: "Cancelled",
	action_required: "Action required",
	startup_failure: "Startup failure",
};
const RUNNING_STATUSES: Record<string, true> = { in_progress: true };
const PENDING_STATUSES: Record<string, true> = { queued: true, requested: true, waiting: true, pending: true };
const STEP_COMPLETE_STATUSES: Record<string, true> = { completed: true };

/** Own-key membership, so a GitHub state named like an Object property (`constructor`) stays unknown. */
function inTable(table: Record<string, unknown>, key: string | undefined): boolean {
	return key !== undefined && Object.hasOwn(table, key);
}

export interface GithubRunWatchStep {
	number: number;
	name: string;
	status?: string;
	conclusion?: string;
	durationSeconds?: number;
}

export interface GithubStepProgress {
	steps: GithubRunWatchStep[];
	total: number;
	completed: number;
	currentStep?: GithubRunWatchStep;
	currentPosition?: number;
	failedStep?: GithubRunWatchStep;
	allSuccessful: boolean;
	label: string;
	tone: "success" | "error" | "warning" | "muted";
}

function parseGithubRunWatchSteps(value: unknown): GithubRunWatchStep[] {
	if (!Array.isArray(value)) return [];
	const steps: GithubRunWatchStep[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate) || typeof candidate.number !== "number" || !Number.isSafeInteger(candidate.number) || candidate.number < 1 || typeof candidate.name !== "string") continue;
		const step: GithubRunWatchStep = { number: candidate.number, name: candidate.name };
		if (typeof candidate.status === "string") step.status = candidate.status;
		if (typeof candidate.conclusion === "string") step.conclusion = candidate.conclusion;
		if (typeof candidate.durationSeconds === "number" && Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds >= 0) step.durationSeconds = candidate.durationSeconds;
		steps.push(step);
	}
	return steps;
}

/** A step's tone as omp's `getStepTone`: a state GitHub adds later stays muted, never a failure. */
export function getGithubStepTone(step: GithubRunWatchStep): GithubStepProgress["tone"] {
	if (inTable(SUCCESS_CONCLUSIONS, step.conclusion)) return "success";
	if (inTable(FAILURE_CONCLUSIONS, step.conclusion)) return "error";
	if (!step.conclusion && inTable(RUNNING_STATUSES, step.status)) return "warning";
	return "muted";
}

const TONE_CLASS: Record<GithubStepProgress["tone"], string> = { success: "tv-ok-text", error: "tv-err-text", warning: "tv-warn-text", muted: "tv-muted" };

function githubStepStateLabel(step: GithubRunWatchStep): string {
	return (step.conclusion || step.status || "unknown").replaceAll("_", " ");
}

/** omp 18.19.0's step progress for one job (`getStepProgress` in pi-tui tools/github.ts); undefined without steps. */
export function getGithubStepProgress(value: unknown): GithubStepProgress | undefined {
	const steps = parseGithubRunWatchSteps(value);
	if (steps.length === 0) return undefined;
	const completed = steps.filter(step => Boolean(step.conclusion) || inTable(STEP_COMPLETE_STATUSES, step.status)).length;
	const currentIndex = steps.findIndex(step => !step.conclusion && inTable(RUNNING_STATUSES, step.status));
	const failedStep = steps.find(step => inTable(FAILURE_CONCLUSIONS, step.conclusion));
	const nextIndex = currentIndex >= 0
		? currentIndex
		: failedStep
			? -1
			: steps.findIndex(step => !step.conclusion && step.status !== "completed" && inTable(PENDING_STATUSES, step.status));
	const currentStep = nextIndex >= 0 ? steps[nextIndex] : undefined;
	const currentPosition = currentStep ? nextIndex + 1 : undefined;
	const allSuccessful = steps.every(step => inTable(SUCCESS_CONCLUSIONS, step.conclusion));
	let label: string;
	let tone: GithubStepProgress["tone"];
	if (currentStep && currentPosition !== undefined) {
		label = `${currentPosition}/${steps.length} #${currentStep.number} ${currentStep.name} · ${githubStepStateLabel(currentStep)}`;
		tone = getGithubStepTone(currentStep);
	} else if (failedStep) {
		label = `#${failedStep.number} ${failedStep.name} · ${githubStepStateLabel(failedStep)} · ${completed}/${steps.length}`;
		tone = getGithubStepTone(failedStep);
	} else {
		label = `${completed}/${steps.length} steps complete`;
		tone = allSuccessful ? "success" : "muted";
	}
	return { steps, total: steps.length, completed, currentStep, currentPosition, failedStep, allSuccessful, label, tone };
}

/** `123`, a PR/issue URL, or a branch name → `#123` or a truncated literal. */
function issueId(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (/^\d+$/.test(trimmed)) return `#${trimmed}`;
	const match = trimmed.match(/\/(?:issues|pull)\/(\d+)/);
	if (match) return `#${match[1]}`;
	return truncate(trimmed, 40);
}

function formatPr(pr: unknown): string | null {
	if (typeof pr === "string") return issueId(pr);
	if (!Array.isArray(pr)) return null;
	const parts: string[] = [];
	for (const item of pr) {
		if (typeof item !== "string") continue;
		const id = issueId(item);
		if (id) parts.push(id);
	}
	if (parts.length === 0) return null;
	if (parts.length > 3) return `${parts.slice(0, 3).join(", ")}, +${parts.length - 3} more`;
	return parts.join(", ");
}

function shortSha(sha: string): string {
	return /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

function Salient({ args }: { args: Record<string, unknown> }): ReactNode {
	const op = str(args.op) ?? "";
	const repo = str(args.repo);
	if (op.startsWith("search_")) {
		const query = str(args.query);
		return (
			<>
				{query && <span className="tv-pattern">{truncate(normalizeWs(query), 60)}</span>}
				{repo && <span className="tv-muted">{repo}</span>}
			</>
		);
	}
	if (op === "pr_checkout" || op === "pr_push") {
		const target = formatPr(args.pr) ?? str(args.branch);
		return (
			<>
				{target && <span>{target}</span>}
				{repo && <span className="tv-muted">{repo}</span>}
			</>
		);
	}
	if (op === "pr_create") {
		const title = str(args.title);
		if (title) return <span>{truncate(normalizeWs(title), 60)}</span>;
		return args.fill === true ? <span className="tv-muted">fill from commits</span> : null;
	}
	if (op === "run_watch") {
		const run = str(args.run);
		const branch = str(args.branch);
		if (run) return <span>run {truncate(run, 50)}</span>;
		return <span className="tv-muted">{branch ?? "HEAD"} workflow runs</span>;
	}
	const branch = str(args.branch);
	return (
		<>
			{repo && <span>{repo}</span>}
			{branch && <span className="tv-muted">{branch}</span>}
		</>
	);
}

function Summary(props: ToolRenderProps): ReactNode {
	const op = str(props.args.op);
	return (
		<>
			{op ? <Badge tone="accent">{op}</Badge> : <Badge tone="warn">no op</Badge>} <Salient args={props.args} />
		</>
	);
}

function argValue(value: unknown): ReactNode {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		const parts: string[] = [];
		for (const item of value) {
			if (typeof item === "string" || typeof item === "number") parts.push(String(item));
		}
		return parts.join(", ");
	}
	return <InvalidArg />;
}

function ArgsGrid({ args }: { args: Record<string, unknown> }): ReactNode {
	const rows: ReactNode[] = [];
	for (const key in args) {
		if (key === "op" || key === "body") continue;
		const value = args[key];
		if (value === undefined || value === null) continue;
		rows.push(
			<Kv k={key} key={key}>
				{argValue(value)}
			</Kv>,
		);
	}
	return rows.length > 0 ? <KvGrid>{rows}</KvGrid> : null;
}

function jobVisual(job: Record<string, unknown>): { icon: ReactNode; cls: string; label: string } {
	const conclusion = str(job.conclusion);
	const status = str(job.status);
	if (conclusion && inTable(SUCCESS_CONCLUSIONS, conclusion)) return { icon: "✓", cls: "tv-ok-text", label: SUCCESS_CONCLUSIONS[conclusion] };
	if (conclusion && inTable(FAILURE_CONCLUSIONS, conclusion)) return { icon: "✕", cls: "tv-err-text", label: FAILURE_CONCLUSIONS[conclusion] };
	if (status && inTable(RUNNING_STATUSES, status)) return { icon: "●", cls: "tv-warn-text", label: "Running" };
	if (status && inTable(PENDING_STATUSES, status)) return { icon: <Hourglass size={14} aria-hidden="true" />, cls: "tv-muted", label: "Pending" };
	return { icon: "○", cls: "tv-faint", label: "Unknown status" };
}

function RunBlock({ run }: { run: Record<string, unknown> }): ReactNode {
	const label = str(run.workflowName) ?? str(run.displayTitle) ?? "GitHub Actions";
	const meta: string[] = [];
	const branch = str(run.branch);
	const sha = str(run.headSha);
	if (branch) meta.push(branch);
	else if (sha) meta.push(shortSha(sha));
	const id = num(run.id);
	if (id !== null) meta.push(`#${id}`);
	const conclusion = str(run.conclusion);
	const status = str(run.status);
	const tone =
		conclusion && inTable(SUCCESS_CONCLUSIONS, conclusion)
			? ("ok" as const)
			: conclusion && inTable(FAILURE_CONCLUSIONS, conclusion)
				? ("err" as const)
				: status && inTable(RUNNING_STATUSES, status)
					? ("warn" as const)
					: undefined;
	const jobs = Array.isArray(run.jobs) ? run.jobs : [];
	return (
		<div className="tv-list">
			<Row>
				<span>{label}</span> <span className="tv-muted">{meta.join("  ")}</span>{" "}
				{(conclusion || status) && <Badge tone={tone}>{conclusion ?? status}</Badge>}
			</Row>
			{jobs.length === 0 && (
				<Row>
					<span className="tv-faint">waiting for workflow jobs…</span>
				</Row>
			)}
			{jobs.map((job, index) => {
				if (!isRecord(job)) return null;
				const visual = jobVisual(job);
				const duration = num(job.durationSeconds);
				const progress = getGithubStepProgress(job.steps);
				return (
					<Fragment key={num(job.id) ?? index}>
						<Row>
							<span className={`tv-job-state ${visual.cls}`} role="img" aria-label={visual.label}>{visual.icon}</span> <span>{str(job.name) ?? "job"}</span>
							{duration !== null && <span className="tv-faint"> {duration}s</span>}
						</Row>
						{progress && <details className="tv-gh-steps">
							<summary className={`tv-gh-step-progress ${TONE_CLASS[progress.tone]}`}>{progress.label}</summary>
							<div className="tv-gh-step-list">
								{progress.steps.map(step => {
									const toneClass = TONE_CLASS[getGithubStepTone(step)];
									return <div className="tv-gh-step" key={step.number}>
										<span className="tv-faint">#{step.number}</span> <span className={toneClass}>{step.name}</span>{" "}
										<span className={toneClass}>{githubStepStateLabel(step)}</span>
										{step.durationSeconds !== undefined && <span className="tv-faint"> {step.durationSeconds}s</span>}
									</div>;
								})}
							</div>
						</details>}
					</Fragment>
				);
			})}
		</div>
	);
}

function WatchView({ watch }: { watch: Record<string, unknown> }): ReactNode {
	const repo = str(watch.repo) ?? "";
	const watching = str(watch.state) === "watching";
	const run = isRecord(watch.run) ? watch.run : null;
	const runId = run ? num(run.id) : null;
	let header: string;
	if (str(watch.mode) === "run" && runId !== null) {
		header = `${watching ? "watching " : ""}run #${runId} on ${repo}`;
	} else {
		const sha = str(watch.headSha);
		const target = sha ? shortSha(sha) : "this commit";
		header = watching ? `watching ${target} on ${repo}` : `workflow runs for ${target} on ${repo}`;
	}
	const note = str(watch.note);
	const runs: Record<string, unknown>[] = [];
	if (run) runs.push(run);
	else if (Array.isArray(watch.runs)) {
		for (const item of watch.runs) {
			if (isRecord(item)) runs.push(item);
		}
	}
	const failedLogs = Array.isArray(watch.failedLogs) ? watch.failedLogs : [];
	return (
		<>
			<div className="tv-muted">{header}</div>
			{note && <div className="tv-faint">{note}</div>}
			{runs.length === 0 && <div className="tv-faint">waiting for workflow runs…</div>}
			{runs.map((item, index) => (
				<RunBlock run={item} key={num(item.id) ?? index} />
			))}
			{failedLogs.map((entry, index) => {
				if (!isRecord(entry)) return null;
				const jobName = str(entry.jobName) ?? "job";
				const workflow = str(entry.workflowName);
				const failedRunId = num(entry.runId);
				const context = workflow ?? "run";
				const title = `${jobName} · ${context}${failedRunId !== null ? ` #${failedRunId}` : ""}`;
				const tail = str(entry.tail);
				if (!tail || entry.available === false) {
					return (
						<Note tone="warn" key={index}>
							{title}: log tail unavailable
						</Note>
					);
				}
				return <Output text={tail} maxLines={12} error title={title} key={index} />;
			})}
		</>
	);
}

function CheckoutRows({ checkouts }: { checkouts: readonly unknown[] }): ReactNode {
	return (
		<div className="tv-list">
			{checkouts.map((entry, index) => {
				if (!isRecord(entry)) return null;
				const prNumber = num(entry.prNumber);
				const worktree = str(entry.worktreePath);
				return (
					<Row k={prNumber !== null ? `#${prNumber}` : "PR"} key={prNumber ?? index}>
						<span>{str(entry.branch) ?? ""}</span>
						{worktree && <span className="tv-muted"> {shortenPath(worktree)}</span>}
						{entry.reused === true && <Badge>reused</Badge>}
					</Row>
				);
			})}
		</div>
	);
}

const DETAIL_KEYS = [
	"repo",
	"branch",
	"worktreePath",
	"remote",
	"remoteBranch",
	"headSha",
	"runId",
	"status",
	"conclusion",
];

function DetailsGrid({ details }: { details: Record<string, unknown> }): ReactNode {
	const rows: ReactNode[] = [];
	for (const key of DETAIL_KEYS) {
		const value = details[key];
		if (typeof value === "number") {
			rows.push(
				<Kv k={key} key={key}>
					{String(value)}
				</Kv>,
			);
		} else if (typeof value === "string" && value) {
			const text = key === "worktreePath" ? shortenPath(value) : key === "headSha" ? shortSha(value) : value;
			rows.push(
				<Kv k={key} key={key}>
					{text}
				</Kv>,
			);
		}
	}
	if (Array.isArray(details.runIds)) {
		const ids: string[] = [];
		for (const id of details.runIds) {
			if (typeof id === "number") ids.push(`#${id}`);
		}
		if (ids.length > 0) {
			rows.push(
				<Kv k="runs" key="runs">
					{ids.join(", ")}
				</Kv>,
			);
		}
	}
	if (Array.isArray(details.failedJobs)) {
		const jobs: string[] = [];
		for (const job of details.failedJobs) {
			if (typeof job === "string") jobs.push(job);
		}
		if (jobs.length > 0) {
			rows.push(
				<Kv k="failedJobs" key="failedJobs">
					<span className="tv-err-text">{jobs.join(", ")}</span>
				</Kv>,
			);
		}
	}
	return rows.length > 0 ? <KvGrid>{rows}</KvGrid> : null;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const watch = details && isRecord(details.watch) ? details.watch : null;
	const checkouts = details && Array.isArray(details.checkouts) ? details.checkouts : null;
	const bodyText = str(args.body);
	return (
		<>
			<ArgsGrid args={args} />
			{bodyText && <Output text={bodyText} maxLines={8} title="body" />}
			{watch && <WatchView watch={watch} />}
			{checkouts && checkouts.length > 0 && <CheckoutRows checkouts={checkouts} />}
			{details && !watch && <DetailsGrid details={details} />}
			<ResultText result={result} maxLines={12} lang="markdown" />
		</>
	);
}

export const githubRenderer: ToolRenderer = { Summary, Body };
