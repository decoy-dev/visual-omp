import { DotsThree, GitDiff, ListChecks, SidebarSimple } from "@phosphor-icons/react";
import { Fragment, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { backgroundJobs, helpersAtWork, helpersOf, latestTodo, ompRunning, workSummary } from "../features/panes/derive";
import { type CommandSpec, useCommands } from "../registry/commands";
import { ChatStatusMark } from "../shell/ChatStatusMark";
import { chatStatus, chatTitle } from "../shell/hooks";
import { currentDock, dockKey, useApp, useDockVisible } from "../state/app";
import { liveEntries, type SessionController, type SessionView } from "../state/session";
import {
	Button,
	cn,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuTrigger,
	PresenceSwap,
	StatusDot,
	Tooltip,
} from "../ui";
import { useDisplayedEntries } from "./branch";
import type { TranscriptMode } from "./transcript/Transcript";

const TRANSCRIPT_MODES: readonly TranscriptMode[] = ["normal", "thinking", "verbose"];

type HeaderState =
	| "readOnly"
	| "readOnlyFree"
	| "readOnlyUnknown"
	| "stopped"
	| "reconnecting"
	| "waiting"
	| "working"
	| "helpersWorking"
	| "starting"
	| "saved"
	| "ready";

/** The one state the header line describes, most urgent first. */
function headerState(view: SessionView): HeaderState {
	if (view.readOnly) return view.follow?.ownership === "free" ? "readOnlyFree" : view.follow?.ownership === "unknown" ? "readOnlyUnknown" : "readOnly";
	if (view.mode === "exited") return "stopped";
	if (view.mode === "reconnecting") return "reconnecting";
	if (view.guest?.uiRequest) return "waiting";
	if (view.working) return "working";
	if (helpersAtWork(view)) return "helpersWorking";
	if (view.mode === "starting") return "starting";
	if (view.mode === "history") return "saved";
	return "ready";
}

/** Status shape beside the title. States the sidebar mark has no shape for use a status glyph. */
function StateMark({ state, view }: { state: HeaderState; view: SessionView }): ReactNode {
	// Decorative: the state line beside it says the same in words.
	return (
		<span aria-hidden className="inline-flex shrink-0">
			{state === "stopped" ? (
				<StatusDot status="err" glyph />
			) : state === "reconnecting" ? (
				<StatusDot status="warn" glyph />
			) : state === "readOnly" || state === "readOnlyFree" || state === "readOnlyUnknown" ? (
				<StatusDot status="live" glyph />
			) : (
				<ChatStatusMark status={chatStatus(view)} label="" />
			)}
		</span>
	);
}

/** Commands for the ⋯ menu: those that declare `header`, sorted, split into sections by hundreds. */
function menuSections(commands: readonly CommandSpec[]): CommandSpec[][] {
	const sorted = commands.filter(command => command.header !== undefined).sort((a, b) => (a.header ?? 0) - (b.header ?? 0));
	const sections: CommandSpec[][] = [];
	let band: number | null = null;
	for (const command of sorted) {
		const next = Math.floor((command.header ?? 0) / 100);
		if (next !== band) sections.push([]);
		band = next;
		sections.at(-1)?.push(command);
	}
	return sections;
}

/**
 * "3 of 7 tasks · 2 helpers working · 1 job running", absent parts left out; opens the Tasks pane. Below 44rem of
 * header width it shrinks to an icon and one count (tasks done of total, else what is running).
 */
function WorkChip({ view, tabId }: { view: SessionView; tabId: string }): ReactNode {
	const { t } = useTranslation("panes");
	// Tasks from the branch the chat shows; jobs from every entry omp sent, since they run whatever branch is shown.
	const shown = useDisplayedEntries(view);
	const entries = liveEntries(view) ?? view.history?.entries;
	const activeTools = view.guest?.activeTools;
	const agents = view.guest?.agents;
	const progress = view.guest?.progress;
	const lifecycle = view.guest?.lifecycle;
	const ompLive = ompRunning(view);
	// Keyed on the transcript and helper maps, not the whole view, so streamed text doesn't recompute it.
	const summary = useMemo(
		() =>
			workSummary(
				latestTodo(shown),
				helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, ompLive),
				entries ? backgroundJobs(entries, ompLive, activeTools) : [],
			),
		[shown, entries, activeTools, agents, progress, lifecycle, ompLive],
	);
	// While this chat's Tasks pane is on screen, the chip reads as pressed and closes it.
	const dockVisible = useDockVisible();
	const showing = useApp(state => dockKey(state) === tabId && currentDock(state).pane === "tasks") && dockVisible;
	const parts = [
		summary.tasks ? t("work.chip.tasks", { done: summary.tasks.done, count: summary.tasks.total }) : null,
		summary.helpersWorking > 0 ? t("work.chip.helpers", { count: summary.helpersWorking }) : null,
		summary.jobsRunning > 0 ? t("work.chip.jobs", { count: summary.jobsRunning }) : null,
	].filter((part): part is string => part !== null);
	if (parts.length === 0) return null;
	const running = summary.helpersWorking + summary.jobsRunning;
	const short = summary.tasks ? `${summary.tasks.done}/${summary.tasks.total}` : String(running);
	const text = parts.join(" · ");
	return (
		<Tooltip content={showing ? t("work.chip.close") : t("work.chip.open")}>
			<button
				type="button"
				onClick={() => (showing ? useApp.getState().toggleDock(false, tabId) : useApp.getState().showPane("tasks", tabId))}
				aria-label={text}
				aria-pressed={showing}
				className={cn(
					"mr-1 inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full border border-border px-2.5 text-sm outline-none transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring",
					showing ? "bg-selected text-fg" : "bg-panel text-fg-muted",
				)}
			>
				{running > 0 ? <StatusDot status="agent" /> : <ListChecks className="size-4 shrink-0" aria-hidden />}
				<span aria-hidden className="hidden truncate tabular-nums @min-[44rem]/header:inline">
					{text}
				</span>
				<span aria-hidden className="font-mono text-xs tabular-nums @min-[44rem]/header:hidden">
					{short}
				</span>
			</button>
		</Tooltip>
	);
}

/**
 * Chat header (DESIGN §3.4). Left: status mark, title and one line saying what the chat is doing. Right: Review
 * changes, the inspector toggle and the ⋯ session menu, which lists every command that declares `header`. The header
 * is a size container; below 36rem "Review changes" becomes an icon with a tooltip, and below 44rem the work chip
 * shrinks to one count.
 */
export function SessionHeader({ session, view, fallbackTitle }: { session: SessionController; view: SessionView; fallbackTitle: string | null }): ReactNode {
	const { t } = useTranslation(["chat", "shell"]);
	const commands = useCommands();
	const transcriptMode = useApp(state => state.prefs?.transcriptMode ?? "normal");
	// Each half of a split has a header; its toggle reads as pressed only for its own chat's panel.
	const dockVisible = useDockVisible();
	const ownDockVisible = useApp(state => dockKey(state) === session.tabId) && dockVisible;
	const ctx = { session, projectPath: session.projectPath };
	const sections = menuSections(commands.filter(command => command.when?.(ctx) ?? true));
	const title = chatTitle(view, fallbackTitle) ?? t("shell:chat.newTitle");
	const state = headerState(view);
	const reviewLabel = t("chat:header.review");

	return (
		<div className="@container/header flex min-h-(--header-h) shrink-0 items-center gap-3 border-b border-border bg-panel px-4 py-2">
			<StateMark state={state} view={view} />
			<div className="flex min-w-0 flex-1 flex-col">
				<PresenceSwap swapKey={title} variant="rise" className="min-w-0">
					<h1 className="truncate text-base leading-5 font-semibold text-fg" title={title}>
						{title}
					</h1>
				</PresenceSwap>
				<p role="status" className="truncate text-sm text-fg-muted">
					{t(`chat:header.state.${state}`)}
				</p>
			</div>
			<div className="flex min-w-0 shrink-0 items-center gap-0.5">
				<WorkChip view={view} tabId={session.tabId} />
				{/* The wrappers own the display switch, so the buttons' own display classes cannot override it. */}
				<span className="hidden @min-[36rem]/header:contents">
					<Tooltip content={t("chat:header.reviewHint")}>
						<Button variant="ghost" size="sm" icon={<GitDiff />} onClick={() => useApp.getState().showPane("diff", session.tabId)}>
							{reviewLabel}
						</Button>
					</Tooltip>
				</span>
				<span className="contents @min-[36rem]/header:hidden">
					<IconButton label={reviewLabel} icon={<GitDiff />} size="md" onClick={() => useApp.getState().showPane("diff", session.tabId)} />
				</span>
				<IconButton
					label={t("chat:header.inspector")}
					shortcut="⌥⌘B"
					icon={<SidebarSimple mirrored />}
					size="md"
					pressed={ownDockVisible}
					onClick={() => useApp.getState().toggleDock(undefined, session.tabId)}
				/>
				<Menu>
					<MenuTrigger asChild>
						<IconButton label={t("chat:header.more")} icon={<DotsThree weight="bold" />} size="md" />
					</MenuTrigger>
					<MenuContent align="end" className="max-h-[70vh] min-w-60 overflow-y-auto">
						{sections.map((section, index) => (
							<Fragment key={section[0]?.id}>
								{index > 0 && <MenuSeparator />}
								{section.map(command => {
									const Icon = command.icon;
									return (
										<MenuItem key={command.id} icon={Icon ? <Icon /> : undefined} shortcut={command.shortcut} danger={command.danger} onSelect={() => void command.run(ctx)}>
											{t(command.title)}
										</MenuItem>
									);
								})}
							</Fragment>
						))}
						{sections.length > 0 && <MenuSeparator />}
						<MenuLabel>{t("chat:header.view")}</MenuLabel>
						<MenuRadioGroup
							value={transcriptMode}
							onValueChange={value => {
								const mode = TRANSCRIPT_MODES.find(entry => entry === value);
								if (mode) void useApp.getState().setPrefs({ transcriptMode: mode });
							}}
						>
							{TRANSCRIPT_MODES.map(mode => (
								<MenuRadioItem key={mode} value={mode} shortcut={mode === "normal" ? "⌘O" : undefined}>
									{t(`chat:header.views.${mode}`)}
								</MenuRadioItem>
							))}
						</MenuRadioGroup>
					</MenuContent>
				</Menu>
			</div>
		</div>
	);
}
