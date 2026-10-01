/**
 * Tasks & helpers pane (DESIGN §3.7): omp's checklist (latest `todo` board), helpers (subagents with
 * live activity, tokens, Stop / Message / transcript) and background shell jobs.
 */
import type { AgentProgress, AgentSnapshot, SubagentLifecyclePayload } from "@oh-my-pi/pi-wire";
import { CaretRight, ChatCenteredText, Check, CircleIcon, FileText, ListChecks, RadioButton, Square, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GuestSnapshot } from "../../collab/lib/client";
import type { PaneProps } from "../../registry/slots";
import { useSessionView } from "../../shell/hooks";
import { liveEntries, type SessionController } from "../../state/session";
import { parseSessionHistory } from "../../state/history";
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
	Progress,
	SectionLabel,
	Spinner,
	spring,
	StatusDot,
	toast,
} from "../../ui";
import { listRowMotion, Section } from "./common";
import { type BackgroundJob, backgroundJobs, latestTodo, type TodoPhase, type TodoStatus } from "./derive";

// ── helpers model ───────────────────────────────────────────────────────────────────────────────

type HelperStatus = "running" | "idle" | "done" | "failed" | "stopped";

interface Helper {
	id: string;
	name: string;
	status: HelperStatus;
	activity: string;
	tokens: number | null;
	hasTranscript: boolean;
}

const SNAPSHOT_STATUS: Record<AgentSnapshot["status"], HelperStatus> = {
	running: "running",
	idle: "idle",
	parked: "idle",
	aborted: "stopped",
};
const PROGRESS_STATUS: Record<AgentProgress["status"], HelperStatus> = {
	pending: "running",
	running: "running",
	completed: "done",
	failed: "failed",
	aborted: "stopped",
};
const LIFECYCLE_STATUS: Record<SubagentLifecyclePayload["status"], HelperStatus> = {
	started: "running",
	completed: "done",
	failed: "failed",
	aborted: "stopped",
};


function activityOf(progress: AgentProgress | undefined): string {
	if (!progress) return "";
	const line = progress.currentToolIntent ?? progress.lastIntent ?? progress.description ?? progress.task;
	return line.split("\n")[0]?.trim() ?? "";
}

/** Subagents from the collab `agents` list merged with their task progress, running first. */
function helpersOf(guest: Pick<GuestSnapshot, "agents" | "progress" | "lifecycle"> | null | undefined): Helper[] {
	if (!guest) return [];
	const progress = new Map<string, AgentProgress>();
	for (const payload of guest.progress.values()) progress.set(payload.progress.id, payload.progress);
	const helpers = new Map<string, Helper>();
	for (const agent of guest.agents) {
		if (agent.kind !== "sub") continue;
		const live = progress.get(agent.id);
		helpers.set(agent.id, {
			id: agent.id,
			name: agent.displayName || live?.agent || agent.id,
			// A finished task reports completed/failed in progress while the registry says idle.
			status: live && live.status !== "running" && live.status !== "pending" ? PROGRESS_STATUS[live.status] : SNAPSHOT_STATUS[agent.status],
			activity: activityOf(live),
			tokens: live?.tokens ?? null,
			hasTranscript: agent.hasSessionFile,
		});
	}
	for (const [id, live] of progress) {
		if (helpers.has(id)) continue;
		helpers.set(id, {
			id,
			name: live.agent || id,
			status: PROGRESS_STATUS[live.status],
			activity: activityOf(live),
			tokens: live.tokens,
			hasTranscript: false,
		});
	}
	for (const [id, event] of guest.lifecycle) {
		const existing = helpers.get(id);
		if (existing) {
			existing.status = LIFECYCLE_STATUS[event.status];
			if (!existing.activity && event.description) existing.activity = event.description;
			continue;
		}
		helpers.set(id, {
			id,
			name: event.agent || id,
			status: LIFECYCLE_STATUS[event.status],
			activity: event.description ?? "",
			tokens: null,
			hasTranscript: Boolean(event.sessionFile),
		});
	}
	const order: Record<HelperStatus, number> = { running: 0, idle: 1, failed: 2, stopped: 3, done: 4 };
	return [...helpers.values()].sort((a, b) => order[a.status] - order[b.status]);
}

function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

// ── sections ────────────────────────────────────────────────────────────────────────────────────

const TASK_ICON: Record<TodoStatus, ReactNode> = {
	completed: <Check className="size-3.5 text-ok" weight="bold" aria-hidden />,
	in_progress: <RadioButton className="size-3.5 text-accent" weight="fill" aria-hidden />,
	pending: <CircleIcon className="size-3.5 text-fg-faint" aria-hidden />,
	abandoned: <X className="size-3.5 text-fg-faint" aria-hidden />,
};

/** Stable keys for rows identified by their text: `text#n` for the nth repeat, so reordered tasks keep their row. */
function textKeys(texts: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return texts.map(text => {
		const n = seen.get(text) ?? 0;
		seen.set(text, n + 1);
		return `${text}#${n}`;
	});
}

function Checklist({ phases }: { phases: TodoPhase[] }) {
	const { t } = useTranslation("panes");
	const currentId = useId();
	const tasks = phases.flatMap(phase => phase.tasks);
	const done = tasks.filter(task => task.status === "completed").length;
	return (
		<Section title={t("tasks.checklist")} count={<span className="text-xs font-normal text-fg-faint">{t("tasks.doneOf", { done, total: tasks.length })}</span>}>
			<Progress value={tasks.length ? (done / tasks.length) * 100 : 0} aria-label={t("tasks.checklistProgress")} className="mb-3" />
			<ol className="space-y-3">
				{phases.map((phase, index) => {
					const keys = textKeys(phase.tasks.map(task => task.content));
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: phase order is the identity
						<li key={index}>
							{phase.name && (
								<SectionLabel as="p" className="mb-1">
									{phase.name}
								</SectionLabel>
							)}
							<ul className="space-y-0.5">
								<AnimatePresence initial={false}>
									{phase.tasks.map((task, taskIndex) => (
										<motion.li
											key={keys[taskIndex]}
											layout="position"
											{...listRowMotion}
											className={cn(
												"relative flex items-start gap-2 rounded-sm px-1 py-0.5 text-md transition-colors duration-(--dur)",
												task.status === "in_progress" && "text-fg",
												task.status === "completed" && "text-fg-muted",
												task.status === "abandoned" && "text-fg-faint line-through",
												task.status === "pending" && "text-fg",
											)}
										>
											{task.status === "in_progress" && (
												<motion.span
													aria-hidden
													layoutId={`${currentId}-current`}
													transition={spring.snappy}
													className="absolute inset-0 rounded-sm bg-accent-muted"
												/>
											)}
											<span className="relative mt-0.5 inline-flex size-3.5 shrink-0">
												<AnimatePresence initial={false} mode="popLayout">
													<motion.span
														key={task.status}
														initial={{ opacity: 0, scale: 0.6 }}
														animate={{ opacity: 1, scale: 1 }}
														exit={{ opacity: 0, scale: 0.6 }}
														transition={spring.snappy}
														className="inline-flex"
													>
														{TASK_ICON[task.status]}
													</motion.span>
												</AnimatePresence>
											</span>
											<span className="sr-only">{t(`tasks.status.${task.status}`)}</span>
											<span className="relative min-w-0 flex-1">{task.content}</span>
										</motion.li>
									))}
								</AnimatePresence>
							</ul>
						</li>
					);
				})}
			</ol>
		</Section>
	);
}

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

const HELPER_DOT: Record<HelperStatus, "agent" | "idle" | "ok" | "err"> = {
	running: "agent",
	idle: "idle",
	done: "ok",
	failed: "err",
	stopped: "idle",
};

function HelperRow({ helper, session, onTranscript }: { helper: Helper; session: SessionController; onTranscript(helper: Helper): void }) {
	const { t } = useTranslation("panes");
	return (
		<motion.li layout="position" {...listRowMotion} className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-hover">
			<span className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-inset text-xs font-semibold text-fg-muted" aria-hidden>
				{helper.name.slice(0, 1).toUpperCase()}
				<StatusDot status={HELPER_DOT[helper.status]} ringed className="absolute -bottom-0.5 -right-0.5" />
			</span>
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-1.5 text-md font-medium text-fg">
					<span className="truncate">{helper.name}</span>
					<span className="shrink-0 text-xs font-normal text-fg-faint">{t(`tasks.helperStatus.${helper.status}`)}</span>
				</p>
				{helper.activity && <p className="truncate text-sm text-fg-muted" title={helper.activity}>{helper.activity}</p>}
			</div>
			{helper.tokens !== null && (
				<span className="shrink-0 font-mono text-xs tabular-nums text-fg-faint" title={t("tasks.tokensHint")}>
					{t("tasks.tokens", { count: helper.tokens, formatted: formatTokens(helper.tokens) })}
				</span>
			)}
			<div className="flex shrink-0 items-center">
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
			</div>
		</motion.li>
	);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : ""))
		.join("");
}

interface TranscriptMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	/** Tool intents/names the helper used in this step. */
	tools: string[];
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
	const messages = useMemo((): TranscriptMessage[] => {
		if (!state || !("text" in state)) return [];
		return parseSessionHistory(state.text).entries.flatMap((entry): TranscriptMessage[] => {
			if (entry.type !== "message") return [];
			const message = entry.message;
			if (message.role === "user") return [{ id: entry.id, role: "user", text: textOf(message.content), tools: [] }];
			if (message.role !== "assistant") return [];
			const text = message.content.map(block => (block.type === "text" ? block.text : "")).join("");
			const tools = message.content.flatMap(block => (block.type === "toolCall" ? [block.intent ?? block.name] : []));
			return [{ id: entry.id, role: "assistant", text, tools }];
		});
	}, [state]);
	return (
		<Dialog open onOpenChange={open => !open && onClose()}>
			<DialogContent size="xl" title={t("tasks.transcriptTitle", { name: helper.name })} className="h-[min(640px,calc(100vh-64px))]">
				{!state ? (
					<div className="flex items-center gap-2 py-6 text-sm text-fg-muted" role="status">
						<Spinner /> {t("tasks.transcriptLoading")}
					</div>
				) : "error" in state ? (
					<p className="py-6 text-sm text-err">{state.error}</p>
				) : messages.length === 0 ? (
					<p className="py-6 text-sm text-fg-muted">{t("tasks.transcriptEmpty")}</p>
				) : (
					<div className="space-y-4 pb-4">
						{messages.map(message =>
							message.role === "user" ? (
								<div key={message.id} className="rounded-md bg-inset px-4 py-3">
									<SectionLabel as="p">{t("tasks.assignment")}</SectionLabel>
									<div className="mt-1 whitespace-pre-wrap text-md text-fg">{message.text}</div>
								</div>
							) : (
								<div key={message.id}>
									{message.text && <Markdown text={message.text} />}
									{message.tools && message.tools.length > 0 && (
										<div className="mt-1 flex flex-wrap gap-1">
											{message.tools.map((tool, index) => (
												// biome-ignore lint/suspicious/noArrayIndexKey: display only
												<Chip key={index} tone="neutral">
													{tool}
												</Chip>
											))}
										</div>
									)}
								</div>
							),
						)}
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
		<motion.li layout="position" {...listRowMotion} className="rounded-md border border-border bg-panel">
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
				<pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-inset px-3 py-2 font-mono text-[11px] leading-4 text-fg-muted">
					{tail || t("tasks.noOutput")}
				</pre>
			</Expand>
		</motion.li>
	);
}

// ── pane ────────────────────────────────────────────────────────────────────────────────────────

export function TasksPane({ session }: PaneProps) {
	const { t } = useTranslation("panes");
	const view = useSessionView(session);
	const [transcriptOf, setTranscriptOf] = useState<Helper | null>(null);
	const entries = liveEntries(view) ?? view?.history?.entries;
	const activeTools = view?.guest?.activeTools;
	const phases = useMemo(() => (entries ? latestTodo(entries) : null), [entries]);
	const jobs = useMemo(() => (entries ? backgroundJobs(entries, activeTools) : []), [entries, activeTools]);
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	// Keyed on agents/progress/lifecycle, not the whole snapshot, so streaming tokens don't recompute this.
	const helpers = useMemo(() => helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null), [agents, progress, lifecycle]);

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
					<Expand open={hasChecklist}>{phases && <Checklist phases={phases} />}</Expand>
					<Expand open={helpers.length > 0}>
						<Section title={t("tasks.helpers")} count={runningHelpers > 0 && <Badge count={runningHelpers} label={t("tasks.runningCount", { count: runningHelpers })} />}>
							<ul className="-mx-1.5 space-y-0.5">
								<AnimatePresence initial={false}>
									{helpers.map(helper => (
										<HelperRow key={helper.id} helper={helper} session={session} onTranscript={setTranscriptOf} />
									))}
								</AnimatePresence>
							</ul>
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
	const count = useMemo(() => {
		const helpers = helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null).filter(helper => helper.status === "running").length;
		const jobs = entries ? backgroundJobs(entries, activeTools).filter(job => job.state === "running").length : 0;
		return helpers + jobs;
	}, [agents, progress, lifecycle, entries, activeTools]);
	return count > 0 ? <Badge count={count} label={t("tasks.runningCount", { count })} /> : null;
}
