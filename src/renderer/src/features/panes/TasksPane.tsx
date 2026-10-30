/**
 * Tasks & helpers pane (DESIGN §3.7): omp's checklist (latest `todo` board, the same TodoBoard the transcript shows),
 * helpers at work (SubagentRun cards with live activity, tool calls, tokens, run time and context use, plus Stop /
 * Message / transcript) and background shell jobs. This is where running work shows; Settings → Helpers holds only
 * the helper definitions, and the Helpers section links there.
 */
import { CaretRight, ChatCenteredText, ChatCircleText, FileText, GearSix, Info, ListChecks, Square } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDisplayedEntries } from "../../chat/branch";
import { NoticeRow, StatusGlyph } from "../../chat/transcript/NoticeRow";
import type { JobStatus } from "../../chat/transcript/notices";
import { fmtDuration } from "../../collab/lib/format";
import type { PaneProps } from "../../registry/slots";
import { useNow, useSessionView } from "../../shell/hooks";
import { openSettings } from "../../state/navigation";
import { liveEntries, type SessionController } from "../../state/session";
import { parseSessionHistory } from "../../state/history";
import { SubagentRun } from "../../tool-render/tools/task";
import { sendSlashCommand } from "../session-tools/typed";
import { reportFailure } from "../session-tools/drive";
import { TodoBoard } from "../../tool-render/tools/todo";
import { Markdown } from "../../transcript/Markdown";
import { TargetContextMenu } from "../../ui/TargetContextMenu";
import {
	Badge,
	Button,
	Chip,
	cn,
	Dialog,
	DialogContent,
	EmptyState,
	Expand,
	IconButton,
	Popover,
	PopoverContent,
	PopoverTrigger,
	PresenceSwap,
	SectionLabel,
	Spinner,
	StatusDot,
	toast,
} from "../../ui";
import { listRowMotion, Section, usePaneVisible } from "./common";
import { type BackgroundJob, backgroundJobs, commandSummary, foldHelpers, type Helper, helperJobSnapshots, helpersOf, latestTodo, ompRunning } from "./derive";
import { type HelperTranscriptItem, helperTranscript } from "./helperTranscript";
import { JobWidget } from "./JobWidget";
import { fetchHelperTranscript, type HelperJobsSnapshot, watchHelperJobs } from "./helperJobs";

function MessageHelper({ helper, session }: { helper: Helper; session: SessionController }) {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!text.trim()) return;
		session.agentCommand("chat", helper.id, text.trim());
		toast({ tone: "ok", message: t("tasks.messageSent", { name: helper.name }) });
		setText("");
		setOpen(false);
	};
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<IconButton size="sm" label={t("tasks.message", { name: helper.name })} icon={<ChatCenteredText />} />
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-3">
				<form onSubmit={submit} className="flex flex-col gap-2">
					<label htmlFor={`msg-${helper.id}`} className="text-sm font-medium text-fg">
						{t("tasks.messageTitle", { name: helper.name })}
					</label>
					<textarea
						id={`msg-${helper.id}`}
						autoFocus
						rows={3}
						value={text}
						onChange={event => setText(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit(event);
						}}
						placeholder={t(helper.status === "running" ? "tasks.messagePlaceholder" : "tasks.messagePlaceholderFinished")}
						className="w-full resize-none rounded-md border border-border-strong bg-panel px-2.5 py-1.5 text-md text-fg outline-none placeholder:text-fg-faint focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-ring-soft"
					/>
					<div className="flex justify-end">
						<Button size="sm" variant="primary" type="submit" disabled={!text.trim()}>
							{t("tasks.send")}
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}

function HelperRow({ helper, jobs, error, session, onTranscript }: { helper: Helper; jobs: readonly BackgroundJob[]; error: string | null; session: SessionController; onTranscript(helper: Helper): void }) {
	const { t } = useTranslation("panes");
	const actions = (
		<>
			{helper.hasTranscript && (
				<IconButton size="sm" label={t("tasks.transcript", { name: helper.name })} icon={<FileText />} onClick={() => onTranscript(helper)} />
			)}
			{helper.messageable && <MessageHelper helper={helper} session={session} />}
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
	return (
		<motion.li layout="position" {...listRowMotion}>
			<SubagentRun run={helper} actions={actions} />
			{helper.widget && <div className="mt-2 px-3"><JobWidget widget={helper.widget} /></div>}
			{jobs.length > 0 && <div className="mt-2 ml-4 border-l border-border pl-3"><JobList jobs={jobs} /></div>}
			{error !== null && <p role="status" className="mt-2 px-3 text-xs text-fg-muted" title={error}>{t("tasks.helper.jobsUnavailable")}</p>}
		</motion.li>
	);
}

/**
 * Running helpers, then the latest finished ones and any older failed one (`foldHelpers`); the rest wait behind "Show
 * earlier helpers", the same way the background jobs fold.
 */
function HelperList({ helpers, session, onTranscript }: { helpers: readonly Helper[]; session: SessionController; onTranscript(helper: Helper): void }) {
	const { t } = useTranslation("panes");
	const [all, setAll] = useState(false);
	const readers = useHelperJobs(helpers, session);
	const jobs = useMemo(() => new Map([...readers].map(([id, snapshot]) => [id, snapshot.jobs])), [readers]);
	const ordered = helpers.toSorted((a, b) => (jobs.get(b.id)?.filter(job => job.state === "running").length ?? 0) - (jobs.get(a.id)?.filter(job => job.state === "running").length ?? 0));
	const { shown, earlier } = foldHelpers(ordered, all, jobs);
	return (
		<>
			<ul className="flex flex-col gap-2">
				<AnimatePresence initial={false}>
					{shown.map(helper => (
						<HelperRow key={helper.id} helper={helper} jobs={jobs.get(helper.id) ?? []} error={readers.get(helper.id)?.error ?? null} session={session} onTranscript={onTranscript} />
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

function TranscriptItem({ item }: { item: HelperTranscriptItem }) {
	const { t } = useTranslation("panes");
	switch (item.kind) {
		case "assignment":
		case "prompt":
			return (
				<div className="rounded-md bg-inset px-4 py-3">
					<SectionLabel as="p">{item.kind === "assignment" ? t("tasks.assignment") : t("tasks.transcriptMessage")}</SectionLabel>
					<div className="mt-1 whitespace-pre-wrap text-md text-fg">{item.text}</div>
				</div>
			);
		case "message":
			// Same card as the chat's IRC notices (chat/transcript/NoticeRow.tsx), plus why it arrived.
			return (
				<div className="rounded-lg border border-border bg-panel px-card py-3">
					<p className="flex min-w-0 items-center gap-2">
						<ChatCircleText className="size-4 shrink-0 text-fg-faint" aria-hidden />
						<span className="min-w-0 truncate text-md font-medium text-fg">
							{item.from ? t("tasks.transcriptMessageFrom", { name: item.from }) : t("tasks.transcriptMessage")}
						</span>
						{item.interrupted && <span className="shrink-0 text-sm text-fg-faint">{t("tasks.transcriptInterrupted")}</span>}
					</p>
					<div className="selectable mt-1.5 pl-6">
						<Markdown text={item.text} />
					</div>
				</div>
			);
		case "notice":
			return (
				<p className="flex min-w-0 items-center gap-2 text-sm text-fg-faint" title={item.text}>
					<Info className="size-4 shrink-0" aria-hidden />
					<span className="min-w-0 truncate">{item.text}</span>
				</p>
			);
		case "custom":
			return <NoticeRow entry={item.entry} mode="normal" />;
		case "reply":
			return (
				<div>
					{item.text && <Markdown text={item.text} />}
					{item.tools.length > 0 && (
						<div className="mt-1 flex flex-wrap gap-1">
							{item.tools.map((tool, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: display only
								<Chip key={index} tone="neutral">
									{tool}
								</Chip>
							))}
						</div>
					)}
				</div>
			);
	}
}

/** A helper's conversation, read from omp through the collab stream (Tasks pane, the chat's pinned helpers). */
export function TranscriptDialog({ helper, session, onClose }: { helper: Helper; session: SessionController; onClose(): void }) {
	const { t } = useTranslation("panes");
	const [state, setState] = useState<{ text: string } | { error: string } | null>(null);
	useEffect(() => {
		const client = session.guestClient();
		if (!client) {
			setState({ error: t("tasks.transcriptOffline") });
			return;
		}
		let cancelled = false;
		void (async () => {
			let offset = 0;
			let text = "";
			while (!cancelled) {
				const result = await fetchHelperTranscript(client, helper.id, offset, () => cancelled);
				if (cancelled) return;
				if (!result) {
					setState({ error: t("tasks.transcriptTimeout") });
					return;
				}
				if (result.kind === "error") {
					setState({ error: result.message });
					return;
				}
				text += result.text;
				setState({ text });
				if (result.newSize <= offset || !result.text) return;
				offset = result.newSize;
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [helper.id, session, t]);
	const items = useMemo(() => (state && "text" in state ? helperTranscript(parseSessionHistory(state.text).entries) : []), [state]);
	return (
		<Dialog open onOpenChange={open => !open && onClose()}>
			<DialogContent size="xl" title={t("tasks.transcriptTitle", { name: helper.name })} className="h-[min(640px,calc(100vh-64px))]">
				<TargetContextMenu projectPath={session.projectPath} tabId={session.tabId}>
				{!state ? (
					<div className="flex items-center gap-2 py-6 text-sm text-fg-muted" role="status">
						<Spinner /> {t("tasks.transcriptLoading")}
					</div>
				) : "error" in state ? (
					<p className="py-6 text-sm text-err">{state.error}</p>
				) : items.length === 0 ? (
					<p className="py-6 text-sm text-fg-muted">{t("tasks.transcriptEmpty")}</p>
				) : (
					<div className="space-y-4 pb-4">
						{items.map(item => (
							<TranscriptItem key={item.id} item={item} />
						))}
					</div>
				)}
				</TargetContextMenu>
			</DialogContent>
		</Dialog>
	);
}

/** Read the same omp-owned helper files as the conversation dialog, including helpers whose finished rows are folded. */
function useHelperJobs(helpers: readonly Helper[], session: SessionController): ReadonlyMap<string, HelperJobsSnapshot> {
	const [readers, setReaders] = useState<ReadonlyMap<string, HelperJobsSnapshot>>(new Map());
	const visible = usePaneVisible("tasks");
	const view = useSessionView(session);
	const client = session.guestClient();
	const live = ompRunning(view);
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
function JobRow({ job, session }: { job: BackgroundJob; session?: SessionController }) {
	const { t } = useTranslation("panes");
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
		<motion.li layout="position" {...listRowMotion} className="border-b border-border last:border-b-0">
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
	return (
		<>
			{session && running.length > 0 && <div className="mb-1 flex justify-end"><StopJobs session={session} id="all" /></div>}
			<ul className="overflow-hidden rounded-lg border border-border bg-panel">
				<AnimatePresence initial={false}>
					{shown.map(job => (
						<JobRow key={job.jobId} job={job} session={session} />
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

export function TasksPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const [transcriptOf, setTranscriptOf] = useState<Helper | null>(null);
	// The checklist follows the branch the chat shows (after a rewind, not the abandoned one); jobs are processes that
	// keep running whatever branch is shown, so they read every entry omp sent.
	const shown = useDisplayedEntries(view);
	const entries = liveEntries(view) ?? view?.history?.entries;
	const activeTools = view?.guest?.activeTools;
	const backgroundTools = view?.guest?.backgroundTools;
	const phases = useMemo(() => latestTodo(shown), [shown]);
	const running = ompRunning(view);
	const jobs = useMemo(() => (entries ? backgroundJobs(entries, running, activeTools, backgroundTools, view?.guest?.header?.cwd ?? session?.projectPath ?? null) : []), [entries, running, activeTools, backgroundTools, view?.guest?.header?.cwd, session?.projectPath]);
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	const snapshots = useMemo(() => helperJobSnapshots(entries ?? [], activeTools, backgroundTools), [entries, activeTools, backgroundTools]);
	// Keyed on agents/progress/lifecycle, not the whole snapshot, so streaming tokens don't recompute this.
	const helpers = useMemo(
		() => helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, running).map(helper => {
			const snapshot = snapshots.get(helper.id);
			if (!snapshot) return helper;
			const stage = [...(progress?.values() ?? [])].find(payload => payload.progress.id === helper.id)?.progress.stage;
			return { ...helper, activity: stage ? helper.activity : snapshot.stage || helper.activity, completionPercent: helper.completionPercent ?? snapshot.completionPercent, widget: snapshot.widget };
		}),
		[agents, progress, lifecycle, running, snapshots],
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
							<HelperList helpers={helpers} session={session} onTranscript={setTranscriptOf} />
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
					{transcriptOf && <TranscriptDialog helper={transcriptOf} session={session} onClose={() => setTranscriptOf(null)} />}
				</div>
			) : (
				<EmptyState icon={<ListChecks />} title={t("tasks.emptyTitle")} body={t("tasks.empty")} />
			)}
		</PresenceSwap>
	);
}

/** Tab badge: how many helpers and background jobs are running. */
export function TasksBadge({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const entries = view?.guest?.entries;
	const activeTools = view?.guest?.activeTools;
	const backgroundTools = view?.guest?.backgroundTools;
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	const running = ompRunning(view);
	const count = useMemo(() => {
		const helpers = helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, running).filter(helper => helper.status === "running").length;
		const jobs = entries ? backgroundJobs(entries, running, activeTools, backgroundTools).filter(job => job.state === "running").length : 0;
		return helpers + jobs;
	}, [agents, progress, lifecycle, entries, activeTools, backgroundTools, running]);
	return count > 0 ? <Badge count={count} label={t("tasks.runningCount", { count })} /> : null;
}
