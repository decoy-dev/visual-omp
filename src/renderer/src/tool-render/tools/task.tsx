/**
 * `task`: spawn subagents. `SubagentRun` is the app's helper card (status, live activity, tool count, tokens,
 * elapsed time, context use when known), shared by the transcript and the Tasks pane; `TaskRuns` lists one task
 * call's helpers from its streamed progress or final results. The expanded body keeps the batch's assignments and
 * each helper's output.
 */
import { CircleHalf } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FriendlySummary, ToolStatus } from "../../chat/friendly";
import { fmtDuration } from "../../collab/lib/format";
import { useNow } from "../../shell/hooks";
import { activityOf, type Helper, type HelperStatus, progressStatus, taskResultStatus } from "../../features/panes/derive";
import { cn, Definition, Meter, StatusBadge, StatusDot } from "../../ui";
import { AgentLink, Badge, Note, Output, ResultText, Row } from "../parts";
import type { ToolRenderer, ToolRenderHost, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, num, str, truncate } from "../util";

const MISSING_YIELD_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

/** One spawned unit of work, normalized across the batch and flat/legacy arg shapes. */
interface TaskItemView {
	id: string | null;
	description: string | null;
	assignment: string | null;
	isolated: boolean;
}

/** Reads both arg shapes: current omp (`name`, `task`) and the older one (`id`, `description`, `assignment`). */
function taskItem(record: Record<string, unknown>): TaskItemView {
	return {
		id: str(record.name) ?? str(record.id),
		description: str(record.description),
		assignment: str(record.task) ?? str(record.assignment),
		isolated: record.isolated === true,
	};
}

function taskItems(args: Record<string, unknown>): TaskItemView[] {
	if (Array.isArray(args.tasks)) return args.tasks.filter(isRecord).map(taskItem);
	const flat = taskItem(args);
	return flat.id || flat.description || flat.assignment ? [flat] : [];
}

/** "Anna.Bob" nesting → "Anna>Bob" breadcrumb (mirrors the TUI's formatTaskId). */
function taskIdLabel(id: string): string {
	return id.includes(".") ? id.split(".").join(">") : id;
}

/** "980", "12.4k", "212k", "1.3M". */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function positive(value: number | null): number | null {
	return value !== null && value > 0 ? value : null;
}

/** A helper as one `details.progress` or `details.results` record describes it; unknown numbers stay null. */
function runOf(record: Record<string, unknown>, status: HelperStatus, activity: string): Helper {
	const id = str(record.id) ?? str(record.agent) ?? "agent";
	return {
		id,
		name: taskIdLabel(id),
		status,
		activity,
		tokens: num(record.tokens),
		toolCount: num(record.toolCount),
		durationMs: positive(num(record.durationMs)),
		durationAt: null,
		contextTokens: positive(num(record.contextTokens)),
		contextWindow: positive(num(record.contextWindow)),
		model: str(record.resolvedModel),
		hasTranscript: false,
	};
}

/** The activity fields of a `details.progress` or `details.results` record. */
function recordActivity(record: Record<string, unknown>): string {
	return activityOf({
		currentToolIntent: str(record.currentToolIntent),
		lastIntent: str(record.lastIntent),
		recentTools: Array.isArray(record.recentTools) ? record.recentTools.filter(isRecord).map(tool => ({ intent: str(tool.intent) })) : undefined,
		recentOutput: Array.isArray(record.recentOutput) ? record.recentOutput.filter(line => typeof line === "string") : undefined,
		description: str(record.description),
		task: str(record.task),
	});
}

/**
 * The helpers of one task call: final results when it finished (by runtime, like the TUI), else the progress it
 * streams, else the batch it asked for while the call is still running.
 */
export function taskRuns(args: Record<string, unknown>, details: Record<string, unknown> | null, running: boolean): Helper[] {
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	if (results.length > 0) {
		return [...results]
			.sort((a, b) => (num(a.durationMs) ?? 0) - (num(b.durationMs) ?? 0) || (num(a.index) ?? 0) - (num(b.index) ?? 0))
			.map(res => runOf(res, taskResultStatus(res), activityOf({ description: str(res.description), task: str(res.task) })));
	}
	const progress = details && Array.isArray(details.progress) ? details.progress.filter(isRecord) : [];
	if (progress.length > 0) return progress.map(p => runOf(p, progressStatus(p.status), recordActivity(p)));
	if (!running) return [];
	return taskItems(args).map((task, index) =>
		runOf({ id: task.id ?? `#${index + 1}` }, "running", activityOf({ description: task.description, task: task.assignment })),
	);
}

/** What a task row's helpers read beyond the call itself: the transcript's recorded helper states, and whether omp runs. */
export interface TaskRowContext {
	recorded: ReadonlyMap<string, HelperStatus>;
	ompRunning: boolean;
}

/**
 * Whether a task row whose helpers come from its call (`args` and the result or progress `details`) shows them the
 * same under both contexts. Only those helpers' recorded states count, so a report about another helper leaves the
 * row's memo intact.
 */
export function taskRowContextEqual(args: Record<string, unknown>, details: Record<string, unknown> | null, prev: TaskRowContext, next: TaskRowContext): boolean {
	if (prev.ompRunning !== next.ompRunning) return false;
	if (prev.recorded === next.recorded) return true;
	return taskRuns(args, details, true).every(run => prev.recorded.get(run.id) === next.recorded.get(run.id));
}

const BADGE_TONE: Record<HelperStatus, "ok" | "err" | "info" | "neutral"> = { running: "info", idle: "neutral", done: "ok", failed: "err", stopped: "neutral" };
const DOT: Record<HelperStatus, "agent" | "idle" | "ok" | "err"> = { running: "agent", idle: "idle", done: "ok", failed: "err", stopped: "idle" };

/**
 * A working helper's run time, counted on each second from omp's last report: omp measures the time only when it
 * reports progress, and a helper waiting on a long model reply reports nothing.
 */
function RunningTime({ durationMs, since }: { durationMs: number; since: number }): ReactNode {
	const now = useNow(1000);
	return <>{fmtDuration(durationMs + Math.max(0, now - since))}</>;
}

/**
 * One helper as a card: letter avatar with a status dot, name and status badge, what it is doing now (or was asked to
 * do), then the numbers omp reported (tool calls, tokens, run time, model) and a context meter when the window is
 * known. `actions` sit at the right of the name row.
 */
export function SubagentRun({ run, actions, className }: { run: Helper; actions?: ReactNode; className?: string }): ReactNode {
	const { t } = useTranslation("panes");
	const working = run.status === "running";
	const context = run.contextTokens !== null && run.contextWindow !== null ? Math.min(1, run.contextTokens / run.contextWindow) : null;
	return (
		<div className={cn("flex items-start gap-3 rounded-lg border border-border bg-panel px-card py-3", className)}>
			<span className="relative mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-semibold text-fg-muted" aria-hidden>
				{run.name.slice(0, 1).toUpperCase()}
				<StatusDot status={DOT[run.status]} ringed className="absolute -right-0.5 -bottom-0.5" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 items-center gap-2">
					<p className="min-w-0 truncate text-md font-medium text-fg" title={run.name}>
						{run.name}
					</p>
					<StatusBadge tone={BADGE_TONE[run.status]} className="shrink-0">
						{t(`tasks.helperStatus.${run.status}`)}
					</StatusBadge>
					{actions && <div className="ml-auto flex shrink-0 items-center">{actions}</div>}
				</div>
				{run.activity && (
					<p className={cn("flex min-w-0 items-start gap-2 text-sm", working ? "text-fg" : "text-fg-muted")} title={run.activity}>
						{working && <CircleHalf weight="fill" className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />}
						<span className="line-clamp-2 min-w-0">{run.activity}</span>
					</p>
				)}
				<p className="flex flex-wrap items-center gap-x-2 font-mono text-xs tabular-nums text-fg-faint">
					{[
						run.toolCount !== null && run.toolCount > 0 && <span key="tools">{t("work.helper.tools", { count: run.toolCount })}</span>,
						run.tokens !== null && run.tokens > 0 && (
							<Definition key="tokens" content={t("tasks.tokensHint")}>
								{t("tasks.tokens", { count: run.tokens, formatted: formatTokens(run.tokens) })}
							</Definition>
						),
						run.durationMs !== null && (
							<span key="time">
								{working && run.durationAt !== null ? <RunningTime durationMs={run.durationMs} since={run.durationAt} /> : fmtDuration(run.durationMs)}
							</span>
						),
						run.model && (
							<span key="model" className="truncate">
								{run.model}
							</span>
						),
					]
						.filter(Boolean)
						// Each separator travels with the stat after it, so a wrapped line never ends on "·".
						.map((item, index) =>
							index === 0 ? (
								item
							) : (
								<span key={`stat${index}`} className="flex min-w-0 max-w-full items-center gap-x-2">
									<span aria-hidden>·</span>
									{item}
								</span>
							),
						)}
				</p>
				{context !== null && run.contextTokens !== null && run.contextWindow !== null && (
					<div className="mt-1 flex items-center gap-2 text-xs text-fg-faint">
						<span className="shrink-0">{t("work.helper.context")}</span>
						<Meter
							fraction={context}
							label={t("work.helper.contextLabel", { name: run.name })}
							valueText={t("work.helper.contextValue", { used: formatTokens(run.contextTokens), total: formatTokens(run.contextWindow) })}
							className="max-w-32 flex-1"
						/>
						<span className="shrink-0 font-mono tabular-nums">{Math.round(context * 100)}%</span>
					</div>
				)}
			</div>
		</div>
	);
}

/** Helper states in the order a mixed batch names them, and the `task.one` / `task.many` key of each. */
const HELPER_STATUSES: readonly HelperStatus[] = ["running", "idle", "done", "failed", "stopped"];
const SUMMARY_KEY: Record<HelperStatus, string> = { running: "running", idle: "idle", done: "ok", failed: "error", stopped: "stopped" };

/**
 * The task call's one-liner from its helpers' state. Homogeneous batches use a short phrase; mixed batches name each
 * reported state with its count. Only an all-finished batch gets the success mark; a batch with waiting or stopped
 * helpers (and none working or failed) gets the neutral mark, labelled "Waiting" when any helper still waits.
 */
export function helperRunsSummary(runs: readonly Helper[], describeState: (status: HelperStatus, count: number) => string): FriendlySummary | null {
	if (runs.length === 0) return null;
	const counts: Record<HelperStatus, number> = { running: 0, idle: 0, done: 0, failed: 0, stopped: 0 };
	for (const run of runs) counts[run.status]++;
	const present = HELPER_STATUSES.filter(status => counts[status] > 0);
	const status: ToolStatus = counts.running > 0 ? "running" : counts.failed > 0 ? "error" : counts.done === runs.length ? "ok" : "neutral";
	const outcome = status === "neutral" ? { status, statusLabel: counts.idle > 0 ? "task.mark.idle" : "task.mark.stopped" } : { status };
	const only = present.length === 1 ? present[0] : undefined;
	if (only && runs.length === 1) return { key: `task.one.${SUMMARY_KEY[only]}`, values: { agent: runs[0]?.name ?? "" }, ...outcome };
	if (only) return { key: `task.many.${SUMMARY_KEY[only]}`, values: { count: runs.length }, ...outcome };
	const summary = present.map(state => describeState(state, counts[state])).join(" · ");
	return { key: "task.many.states", values: { count: runs.length, summary }, ...outcome };
}

/** The helpers one task call runs, as cards; shown under the call in the transcript while they run and after. */
export function TaskRuns({ runs }: { runs: readonly Helper[] }): ReactNode {
	if (runs.length === 0) return null;
	return (
		<div className="flex flex-col gap-2">
			{runs.map(run => (
				<SubagentRun key={run.id} run={run} />
			))}
		</div>
	);
}

function Summary({ args }: ToolRenderProps): ReactNode {
	const agent = str(args.agent);
	const resume = str(args.resume);
	const tasks = taskItems(args);
	const first = tasks.length > 0 ? tasks[0] : null;
	const label = first ? (first.description ?? first.id) : null;
	return (
		<>
			{agent && <Badge tone="accent">{agent}</Badge>}
			{!agent && resume && <Badge>resume {resume}</Badge>}
			{label && <span className="tv-muted">{truncate(normalizeWs(label), 72)}</span>}
			{tasks.length > 1 && <Badge>{tasks.length} tasks</Badge>}
		</>
	);
}

/** One helper's final output: the link to its conversation, the output preview, and error or abort notes. */
function AgentOutput({ res, host }: { res: Record<string, unknown>; host?: ToolRenderHost }): ReactNode {
	const id = str(res.id) ?? "agent";
	// The runtime prepends a one-line warning when a subagent never called
	// yield; lift it out of the output preview like the TUI does.
	let output = str(res.output) ?? "";
	let warning: string | null = null;
	const nl = output.indexOf("\n");
	const firstLine = (nl === -1 ? output : output.slice(0, nl)).trim();
	if (firstLine.startsWith(MISSING_YIELD_PREFIX)) {
		warning = firstLine;
		output = nl === -1 ? "" : output.slice(nl + 1).replace(/^\s*\n+/, "");
	}
	const status = taskResultStatus(res);
	const error = str(res.error);
	const aborted = res.aborted === true;
	const abortReason = str(res.abortReason);
	const patchPath = str(res.patchPath);
	const branchName = str(res.branchName);
	return (
		<>
			<Row
				k={
					<AgentLink id={id} host={host}>
						{taskIdLabel(id)}
					</AgentLink>
				}
			>
				{res.truncated === true && <Badge tone="warn">truncated</Badge>}
			</Row>
			{warning && <Note tone="warn">{warning}</Note>}
			{aborted && abortReason && <Note tone="err">{abortReason}</Note>}
			{output.trim() !== "" && <Output text={output} maxLines={6} error={status === "failed" && num(res.exitCode) !== 0} />}
			{error && !aborted && error !== abortReason && <Note tone={num(res.exitCode) === 0 ? "warn" : "err"}>{error}</Note>}
			{patchPath && <div className="tv-faint">patch: {patchPath}</div>}
			{!patchPath && branchName && <div className="tv-faint">branch: {branchName}</div>}
		</>
	);
}

function Body({ args, result, host }: ToolRenderProps): ReactNode {
	const resume = str(args.resume);
	const context = str(args.context);
	const tasks = taskItems(args);
	const details = detailsRecord(result);
	const results = details && Array.isArray(details.results) ? details.results.filter(isRecord) : [];
	return (
		<>
			{resume && <Badge>resume {resume}</Badge>}
			{context && <Output text={context} maxLines={4} title="context" />}
			{tasks.length > 0 && (
				<div className="tv-list">
					{tasks.map((t, i) => (
						<div key={t.id ?? i}>
							<Row
								k={
									t.id ? (
										<AgentLink id={t.id} host={host}>
											{taskIdLabel(t.id)}
										</AgentLink>
									) : (
										<Badge tone="accent">{`#${i + 1}`}</Badge>
									)
								}
							>
								{t.isolated && <Badge>isolated</Badge>}{" "}
								{t.description && <span>{truncate(normalizeWs(t.description), 120)}</span>}
							</Row>
							{t.assignment && <Output text={t.assignment} maxLines={6} title="assignment" />}
						</div>
					))}
				</div>
			)}
			{results.length > 0 ? (
				<div className="tv-list">
					{results.map((res, i) => (
						<AgentOutput key={str(res.id) ?? i} res={res} host={host} />
					))}
				</div>
			) : (
				!details?.progress && <ResultText result={result} maxLines={12} />
			)}
		</>
	);
}

export const taskRenderer: ToolRenderer = { Summary, Body };
