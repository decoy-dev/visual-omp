/**
 * Tasks & helpers pane (DESIGN §3.7): omp's checklist (latest `todo` board, the same TodoBoard the transcript shows),
 * helpers at work (SubagentRun cards with live activity, tool calls, tokens, run time and context use, plus Stop /
 * Open conversation) and background shell jobs. This is where running work shows; Settings → Helpers holds only
 * the helper definitions, and the Helpers section links there.
 */
import { CaretRight, ChatCenteredText, GearSix, ListChecks, Square } from "@phosphor-icons/react";
import type { NativeJob, NativeSnapshot } from "@shared/contracts/native";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDisplayedEntries } from "../../chat/branch";
import { NoticeRow, StatusGlyph } from "../../chat/transcript/NoticeRow";
import type { JobStatus } from "../../chat/transcript/notices";
import { fmtDuration } from "../../collab/lib/format";
import type { PaneProps } from "../../registry/slots";
import { useNow, useSessionView } from "../../shell/hooks";
import { openSettings } from "../../state/navigation";
import { liveEntries, type SessionController, type SessionView } from "../../state/session";
import { SubagentRun } from "../../tool-render/tools/task";
import { sendSlashCommand } from "../session-tools/typed";
import { reportFailure } from "../session-tools/drive";
import { TodoBoard } from "../../tool-render/tools/todo";
import {
	Badge,
	Button,
	cn,
	EmptyState,
	Expand,
	IconButton,
	PresenceSwap,
	SectionLabel,
	Spinner,
	StatusDot,
	useMotionReduced,
} from "../../ui";
import { listRowMotion, Section, usePaneVisible } from "./common";
import { type BackgroundJob, backgroundJobs, commandSummary, foldHelpers, type Helper, helperJobSnapshots, helpersOf, helpersMayRun, latestTodo, ompRunning } from "./derive";
import { openHelper } from "./helperFocus";
import { JobWidget } from "./JobWidget";
import { helperWidgetCharts } from "./jobWidgets";
import { type HelperJobsSnapshot, watchHelperJobs } from "./helperJobs";


function HelperRow({ helper, jobs, error, session, layoutKey }: { helper: Helper; jobs: readonly BackgroundJob[]; error: string | null; session: SessionController; layoutKey: string }) {
	const { t } = useTranslation("panes");
	const reduced = useMotionReduced();
	const actions = (
		<>
			{(helper.hasTranscript || helper.messageable) && (
				<IconButton size="sm" label={t("tasks.transcript", { name: helper.name })} icon={<ChatCenteredText />} onClick={() => openHelper(session, helper)} />
			)}
			{helper.status === "running" && (
				<IconButton
					size="sm"
					variant="danger-ghost"
					label={t("tasks.stop", { name: helper.name })}
					icon={<Square weight="fill" />}
					onClick={() => session.agentCommand("kill", helper.id)}
				/>
			)}
		</>
	);
	const charts = helperWidgetCharts(helper.widget);
	return (
		<motion.li layout={reduced ? false : "position"} layoutDependency={layoutKey} {...listRowMotion}>
			<SubagentRun run={helper} actions={actions} />
			{charts && <div className="mt-2 px-3"><JobWidget widget={charts} /></div>}
			{jobs.length > 0 && <div className="mt-2 ml-4 border-l border-border pl-3"><JobList jobs={jobs} /></div>}
			{error !== null && <p role="status" className="mt-2 px-3 text-xs text-fg-muted" title={error}>{t("tasks.helper.jobsUnavailable")}</p>}
		</motion.li>
	);
}

function jobRowKey(job: BackgroundJob): string {
	return `${job.jobId}\0${job.toolCallId ?? job.startedAt ?? "unknown"}`;
}

/** Rows remeasure for order and visible-row structure, not progress text or elapsed time. */
function jobLayoutKey(job: BackgroundJob): string {
	return `${jobRowKey(job)}\0${job.state}\0${Boolean(job.intent)}\0${Boolean(job.caption)}\0${Boolean(job.widget)}\0`;
}

/**
 * Running helpers, then the latest finished ones and any older failed one (`foldHelpers`); the rest wait behind "Show
 * earlier helpers", the same way the background jobs fold.
 */
function HelperList({ helpers, session }: { helpers: readonly Helper[]; session: SessionController }) {
	const { t } = useTranslation("panes");
	const [all, setAll] = useState(false);
	const readers = useHelperJobs(helpers, session);
	const jobs = useMemo(() => new Map([...readers].map(([id, snapshot]) => [id, snapshot.jobs])), [readers]);
	const ordered = helpers.toSorted((a, b) => (jobs.get(b.id)?.filter(job => job.state === "running").length ?? 0) - (jobs.get(a.id)?.filter(job => job.state === "running").length ?? 0));
	const { shown, earlier } = foldHelpers(ordered, all, jobs);
	let layoutKey = "";
	for (const helper of shown) {
		const error = readers.get(helper.id)?.error ?? null;
		layoutKey += `${helper.id}\0${helper.status}\0${Boolean(helper.widget)}\0${error !== null}\0`;
		for (const job of jobs.get(helper.id) ?? []) layoutKey += jobLayoutKey(job);
	}
	return (
		<>
			<ul className="flex flex-col gap-2">
				<AnimatePresence initial={false}>
					{shown.map(helper => (
						<HelperRow key={helper.id} helper={helper} jobs={jobs.get(helper.id) ?? []} error={readers.get(helper.id)?.error ?? null} session={session} layoutKey={layoutKey} />
					))}
				</AnimatePresence>
			</ul>
			{earlier > 0 && (
				<div className="mt-2">
					<button
						type="button"
						aria-expanded={all}
						onClick={() => setAll(!all)}
						className="inline-flex h-7 items-center rounded-md px-1 text-sm text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
					>
						{all ? t("tasks.helper.fewer") : t("tasks.helper.earlier", { count: earlier })}
					</button>
				</div>
			)}
		</>
	);
}


/** Read omp-owned helper files for background jobs, including helpers whose finished rows are folded. */
function useHelperJobs(helpers: readonly Helper[], session: SessionController): ReadonlyMap<string, HelperJobsSnapshot> {
	const [readers, setReaders] = useState<ReadonlyMap<string, HelperJobsSnapshot>>(new Map());
	const visible = usePaneVisible("tasks");
	const view = useSessionView(session);
	const client = session.guestClient();
	const live = helpersMayRun(view);
	// Progress reports change often; the roster, transcript availability and whether a helper is still running are
	// what change the readers. Running helpers ("0") sort first so their reads queue ahead of finished ones ("1").
	const keys = helpers.filter(helper => helper.hasTranscript).map(helper => `${helper.status === "running" ? "0" : "1"}${helper.id}`).sort().join("\0");
	const readerStops = useRef(new Map<string, () => void>());
	const readerClient = useRef(client);
	useEffect(() => {
		const active = readerStops.current;
		const stopAll = () => { for (const stop of active.values()) stop(); active.clear(); };
		if (readerClient.current !== client) {
			stopAll();
			readerClient.current = client;
		}
		if (!visible || !client || !keys || !live) {
			stopAll();
			return;
		}
		// Only changed helpers restart, so a helper finishing does not read every other transcript again.
		const wanted = new Set(keys.split("\0"));
		for (const [key, stop] of active) if (!wanted.has(key)) { stop(); active.delete(key); }
		for (const key of wanted) {
			if (active.has(key)) continue;
			const id = key.slice(1);
			active.set(key, watchHelperJobs(client, id, session.projectPath, key[0] === "0", snapshot => {
				setReaders(previous => new Map(previous).set(id, snapshot));
			}));
		}
	}, [visible, client, keys, live, session]);
	useEffect(() => () => { for (const stop of readerStops.current.values()) stop(); readerStops.current.clear(); }, []);
	return live ? readers : new Map([...readers].map(([id, snapshot]) => [id, { ...snapshot, jobs: snapshot.jobs.map(job => job.state === "running" ? { ...job, state: "cancelled" as const } : job) }]));
}

/** Job controls use the composer's Send now path, so omp can dispatch `/jobs kill` during a model turn. */
function StopJobs({ session, id }: { session: SessionController; id: string }) {
	const { t } = useTranslation("panes");
	const [pending, setPending] = useState(false);
	return <Button size="sm" variant="ghost" disabled={pending} aria-label={id === "all" ? t("tasks.job.stopAll") : t("tasks.job.stop", { id })} onClick={() => {
		setPending(true);
		void sendSlashCommand(session, `/jobs kill ${id}`, { now: true }).catch(reportFailure).finally(() => setPending(false));
	}}>{pending ? <Spinner /> : <Square weight="fill" className="size-3" aria-hidden />}{id === "all" ? t("tasks.job.stopAll") : t("tasks.job.stopAction")}</Button>;
}

/** How a settled job reads, with the chat's own job marks (NoticeRow's `StatusGlyph`). */
const SETTLED_STATUS: Record<Exclude<BackgroundJob["state"], "running">, JobStatus> = { completed: "ok", failed: "failed", cancelled: "stopped" };

/** Settled jobs shown before "Show earlier jobs"; omp's `/jobs` lists the five most recent as well. */
const RECENT_JOBS = 5;

/** How long a running job has run, ticking each second; mounted only while the job runs, so settled rows hold no timer. */
function RunningFor({ since }: { since: number }) {
	const now = useNow(1000);
	return <>{fmtDuration(Math.max(0, now - since))}</>;
}

/**
 * One background job, as omp's `/jobs` lists it (status, run time, the command dimmed underneath) but titled by what
 * the model said the command is for. Opens to the full command and the latest output.
 */
function JobRow({ job, session, layoutKey }: { job: BackgroundJob; session?: SessionController; layoutKey: string }) {
	const { t } = useTranslation("panes");
	const reduced = useMotionReduced();
	const [open, setOpen] = useState(false);
	const summary = useMemo(() => commandSummary(job.command) || job.jobId, [job.command, job.jobId]);
	const tail = useMemo(() => job.output.trimEnd().split("\n").slice(-40).join("\n"), [job.output]);
	const settledMeta = [
		job.state === "failed" && job.exitCode !== null ? t("tasks.job.exit", { code: job.exitCode }) : null,
		job.state === "cancelled" ? t("tasks.jobState.cancelled") : null,
		job.state !== "running" && job.durationMs !== null ? fmtDuration(job.durationMs) : null,
	].filter((part): part is string => part !== null);
	const live = job.state === "running" && job.startedAt !== null;
	return (
		<motion.li layout={reduced ? false : "position"} layoutDependency={`${layoutKey}\0${open}`} {...listRowMotion} className="border-b border-border last:border-b-0">
			<div className="flex items-start">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2 text-left outline-none hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
					{job.state === "running" ? (
						<StatusDot status="live" label={t("tasks.jobState.running")} />
					) : (
						<StatusGlyph status={SETTLED_STATUS[job.state]} />
					)}
				</span>
				<span className="flex min-w-0 flex-1 flex-col gap-0.5">
					{job.intent ? (
						<>
							<span className="line-clamp-2 break-words text-sm text-fg" title={job.intent}>{job.intent}</span>
							<code className="truncate font-mono text-xs text-fg-faint">{summary}</code>
						</>
					) : (
						<code className="truncate font-mono text-xs leading-5 text-fg">{summary}</code>
					)}
					{job.cwd && <span className="line-clamp-2 break-all font-mono text-xs text-fg-muted" title={job.cwd}>{job.cwd}</span>}
					{job.caption && <span className="line-clamp-2 break-words text-xs text-fg-muted" title={job.caption}>{job.caption}</span>}
					{job.widget && <JobWidget widget={job.widget} headlineOnly />}
				</span>
				{(live || settledMeta.length > 0) && (
					<span className={cn("mt-0.5 shrink-0 text-xs tabular-nums", job.state === "failed" ? "text-err" : "text-fg-faint")}>
						{live && job.startedAt !== null ? <RunningFor since={job.startedAt} /> : settledMeta.join(" · ")}
					</span>
				)}
				<CaretRight
					className={cn(
						"mt-1 size-3.5 shrink-0 text-fg-faint transition-[rotate] duration-(--dur) ease-(--ease-out)",
						open && "rotate-90",
					)}
					aria-hidden
				/>
			</button>
			{session && job.state === "running" && <div className="shrink-0 py-1 pr-1"><StopJobs session={session} id={job.jobId} /></div>}
			</div>
			<Expand open={open}>
				<div className="flex flex-col gap-2 border-t border-border bg-inset px-3 py-2.5">
					{job.widget && <JobWidget widget={job.widget} />}
					<SectionLabel as="p">{t("tasks.job.command")}</SectionLabel>
					<pre className="selectable m-0 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-4 text-fg">{job.command}</pre>
					<SectionLabel as="p">{t("tasks.job.output")}</SectionLabel>
					<pre className="selectable m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-4 text-fg-muted">
						{tail || t("tasks.noOutput")}
					</pre>
					<p className="font-mono text-xs text-fg-faint">{t("tasks.job.id", { id: job.jobId })}</p>
				</div>
			</Expand>
		</motion.li>
	);
}

/** Running jobs, then the five most recent settled ones; the rest wait behind "Show earlier jobs". */
function JobList({ jobs, session }: { jobs: readonly BackgroundJob[]; session?: SessionController }) {
	const { t } = useTranslation("panes");
	const [all, setAll] = useState(false);
	const running = jobs.filter(job => job.state === "running");
	const settled = jobs.filter(job => job.state !== "running");
	const hidden = all ? 0 : Math.max(0, settled.length - RECENT_JOBS);
	const shown = [...running, ...settled.slice(0, settled.length - hidden)];
	let layoutKey = "";
	for (const job of shown) layoutKey += jobLayoutKey(job);
	return (
		<>
			{session && running.length > 0 && <div className="mb-1 flex justify-end"><StopJobs session={session} id="all" /></div>}
			<ul className="overflow-hidden rounded-lg border border-border bg-panel">
				<AnimatePresence initial={false}>
					{shown.map(job => (
						<JobRow key={jobRowKey(job)} job={job} session={session} layoutKey={layoutKey} />
					))}
				</AnimatePresence>
			</ul>
			{(hidden > 0 || (all && settled.length > RECENT_JOBS)) && (
				<button
					type="button"
					onClick={() => setAll(!all)}
					className="mt-2 inline-flex h-7 items-center rounded-md px-1 text-sm text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				>
					{all ? t("tasks.job.fewer") : t("tasks.job.earlier", { count: hidden })}
				</button>
			)}
		</>
	);
}

// ── pane ────────────────────────────────────────────────────────────────────────────────────────

const NO_NATIVE_JOBS: readonly NativeJob[] = [];

/** One initial read, then extension events only. Late reads and old sessions cannot replace current captions. */
function useNativeJobs(view: SessionView | null): readonly NativeJob[] {
	const hostId = view?.mode === "live" && view.host?.phase === "live" ? view.host.hostId : undefined;
	const generation = view?.host?.generation;
	const sessionId = view?.guest?.header?.id;
	const scope = `${hostId ?? ""}:${generation ?? ""}:${sessionId ?? ""}`;
	const [snapshot, setSnapshot] = useState<{ scope: string; jobs: readonly NativeJob[] } | null>(null);
	useEffect(() => {
		if (!hostId) return;
		let active = true;
		let revision = 0;
		const publish = (native: NativeSnapshot) => {
			if (!active || native.asyncJobsGeneration !== generation || (sessionId && native.location && native.location.sessionId !== sessionId)) return false;
			setSnapshot({ scope, jobs: native.shutdown ? NO_NATIVE_JOBS : native.asyncJobs ?? NO_NATIVE_JOBS });
			return true;
		};
		const off = window.vomp.on("native:changed", event => {
			if (event.hostId !== hostId) return;
			if (publish(event.snapshot)) revision++;
		});
		void window.vomp.invoke("native:snapshot", hostId).then(native => {
			if (revision === 0) publish(native);
		}).catch(() => undefined);
		return () => { active = false; off(); };
	}, [hostId, generation, sessionId, scope]);
	return hostId && snapshot?.scope === scope ? snapshot.jobs : NO_NATIVE_JOBS;
}

export function TasksPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	// The checklist follows the branch the chat shows (after a rewind, not the abandoned one); jobs are processes that
	// keep running whatever branch is shown, so they read every entry omp sent.
	const shown = useDisplayedEntries(view);
	const entries = liveEntries(view) ?? view?.history?.entries;
	const activeTools = view?.guest?.activeTools;
	const backgroundTools = view?.guest?.backgroundTools;
	const phases = useMemo(() => latestTodo(shown), [shown]);
	const running = ompRunning(view);
	const helpersLive = helpersMayRun(view);
	const nativeJobs = useNativeJobs(view);
	const processStartedAt = view?.host?.processStartedAt;
	const jobs = useMemo(() => backgroundJobs(entries ?? [], running, activeTools, backgroundTools, view?.guest?.header?.cwd ?? session?.projectPath ?? null, nativeJobs, processStartedAt), [entries, running, activeTools, backgroundTools, view?.guest?.header?.cwd, session?.projectPath, nativeJobs, processStartedAt]);
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	const snapshots = useMemo(() => helperJobSnapshots(entries ?? [], activeTools, backgroundTools), [entries, activeTools, backgroundTools]);
	// Keyed on agents/progress/lifecycle, not the whole snapshot, so streaming tokens don't recompute this.
	const helpers = useMemo(
		() => helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, helpersLive).map(helper => {
			const snapshot = snapshots.get(helper.id);
			if (!snapshot) return helper;
			const stage = [...(progress?.values() ?? [])].find(payload => payload.progress.id === helper.id)?.progress.stage;
			return { ...helper, activity: stage ? helper.activity : snapshot.stage || helper.activity, completionPercent: helper.completionPercent ?? snapshot.completionPercent, widget: snapshot.widget };
		}),
		[agents, progress, lifecycle, helpersLive, snapshots],
	);

	const hasChecklist = phases !== null && phases.length > 0;
	const hasContent = hasChecklist || helpers.length > 0 || jobs.length > 0;
	const runningHelpers = helpers.filter(helper => helper.status === "running").length;
	const runningJobs = jobs.filter(job => job.state === "running").length;
	// Presence owners stay mounted while their last row leaves: each section collapses through Expand, and the whole
	// list fades out before the empty state fades in (PresenceSwap keeps the last rendered list while it exits).
	return (
		<PresenceSwap swapKey={session && hasContent ? "list" : "empty"} className="flex min-h-0 flex-1 flex-col">
			{session && hasContent ? (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<Expand open={hasChecklist}>
						{phases && (
							<section className="border-b border-border px-3 py-3" aria-label={t("tasks.checklist")}>
								<TodoBoard phases={phases} />
							</section>
						)}
					</Expand>
					<Expand open={helpers.length > 0}>
						<Section title={t("tasks.helpers")} count={runningHelpers > 0 && <Badge count={runningHelpers} label={t("tasks.runningCount", { count: runningHelpers })} />}>
							<HelperList helpers={helpers} session={session} />
							<button
								type="button"
								onClick={() => openSettings("helpers", { projectPath: projectPath ?? session.projectPath })}
								className="mt-2 inline-flex h-7 items-center gap-1.5 rounded-md px-1 text-sm text-fg-muted hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
							>
								<GearSix aria-hidden className="size-4" />
								{t("tasks.manageHelpers")}
							</button>
						</Section>
					</Expand>
					<Expand open={jobs.length > 0}>
						<Section
							title={t("tasks.background")}
							count={runningJobs > 0 && <Badge count={runningJobs} label={t("tasks.runningCount", { count: runningJobs })} />}
						>
							<JobList jobs={jobs} session={view?.mode === "live" && !view.readOnly ? session : undefined} />
						</Section>
					</Expand>
				</div>
			) : (
				<EmptyState icon={<ListChecks />} title={t("tasks.emptyTitle")} body={t("tasks.empty")} />
			)}
		</PresenceSwap>
	);
}

