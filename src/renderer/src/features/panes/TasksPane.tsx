/**
 * Tasks & helpers pane (DESIGN §3.7): omp's checklist (latest `todo` board, the same TodoBoard the transcript shows),
 * helpers at work (SubagentRun cards with live activity, tool calls, tokens, run time and context use, plus Stop /
 * Message / transcript) and background shell jobs. This is where running work shows; Settings → Helpers holds only
 * the helper definitions, and the Helpers section links there.
 */
import { CaretRight, ChatCenteredText, ChatCircleText, FileText, GearSix, Info, ListChecks, Square } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDisplayedEntries } from "../../chat/branch";
import { NoticeRow } from "../../chat/transcript/NoticeRow";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { openSettings } from "../../state/navigation";
import { liveEntries, type SessionController } from "../../state/session";
import { parseSessionHistory } from "../../state/history";
import { SubagentRun } from "../../tool-render/tools/task";
import { TodoBoard } from "../../tool-render/tools/todo";
import { Markdown } from "../../transcript/Markdown";
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
import { listRowMotion, Section } from "./common";
import { type BackgroundJob, backgroundJobs, type Helper, helpersOf, latestTodo, ompRunning } from "./derive";
import { type HelperTranscriptItem, helperTranscript } from "./helperTranscript";

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
						placeholder={t("tasks.messagePlaceholder")}
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

function HelperRow({ helper, session, onTranscript }: { helper: Helper; session: SessionController; onTranscript(helper: Helper): void }) {
	const { t } = useTranslation("panes");
	const actions = (
		<>
			{helper.hasTranscript && (
				<IconButton size="sm" label={t("tasks.transcript", { name: helper.name })} icon={<FileText />} onClick={() => onTranscript(helper)} />
			)}
			{(helper.status === "running" || helper.status === "idle") && <MessageHelper helper={helper} session={session} />}
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
		</motion.li>
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

function TranscriptDialog({ helper, session, onClose }: { helper: Helper; session: SessionController; onClose(): void }) {
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
				const result = await client.fetchTranscript(helper.id, offset);
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
			</DialogContent>
		</Dialog>
	);
}

const JOB_DOT: Record<BackgroundJob["state"], "live" | "ok" | "err" | "idle"> = {
	running: "live",
	completed: "ok",
	failed: "err",
	cancelled: "idle",
};

function JobRow({ job }: { job: BackgroundJob }) {
	const { t } = useTranslation("panes");
	const [open, setOpen] = useState(job.state === "running");
	const tail = job.output.trimEnd().split("\n").slice(-40).join("\n");
	return (
		<motion.li layout="position" {...listRowMotion} className="overflow-hidden rounded-md border border-border bg-panel">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
			>
				<CaretRight
					className={cn("size-3.5 shrink-0 text-fg-faint transition-transform duration-(--dur) ease-(--ease-out-quart)", open && "rotate-90")}
					aria-hidden
				/>
				<StatusDot status={JOB_DOT[job.state]} label={t(`tasks.jobState.${job.state}`)} />
				<code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={job.command}>
					{job.command || job.jobId}
				</code>
				<span className="shrink-0 text-xs text-fg-faint">{t(`tasks.jobState.${job.state}`)}</span>
			</button>
			<Expand open={open}>
				<pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-inset px-3 py-2 font-mono text-xs leading-4 text-fg-muted">
					{tail || t("tasks.noOutput")}
				</pre>
			</Expand>
		</motion.li>
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
	const phases = useMemo(() => latestTodo(shown), [shown]);
	const running = ompRunning(view);
	const jobs = useMemo(() => (entries ? backgroundJobs(entries, running, activeTools) : []), [entries, running, activeTools]);
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	// Keyed on agents/progress/lifecycle, not the whole snapshot, so streaming tokens don't recompute this.
	const helpers = useMemo(
		() => helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, running),
		[agents, progress, lifecycle, running],
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
							<ul className="flex flex-col gap-2">
								<AnimatePresence initial={false}>
									{helpers.map(helper => (
										<HelperRow key={helper.id} helper={helper} session={session} onTranscript={setTranscriptOf} />
									))}
								</AnimatePresence>
							</ul>
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
							<ul className="space-y-1.5">
								<AnimatePresence initial={false}>
									{jobs.map(job => (
										<JobRow key={job.jobId} job={job} />
									))}
								</AnimatePresence>
							</ul>
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
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	const running = ompRunning(view);
	const count = useMemo(() => {
		const helpers = helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, running).filter(helper => helper.status === "running").length;
		const jobs = entries ? backgroundJobs(entries, running, activeTools).filter(job => job.state === "running").length : 0;
		return helpers + jobs;
	}, [agents, progress, lifecycle, entries, activeTools, running]);
	return count > 0 ? <Badge count={count} label={t("tasks.runningCount", { count })} /> : null;
}
