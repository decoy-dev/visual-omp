import { DotsThree, GitDiff, SidebarSimple } from "@phosphor-icons/react";
import { Fragment, type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type CommandSpec, useCommands } from "../registry/commands";
import { ChatStatusMark } from "../shell/ChatStatusMark";
import { chatStatus, chatTitle, elapsed, useNow } from "../shell/hooks";
import { useApp } from "../state/app";
import type { SessionController, SessionView } from "../state/session";
import {
	Button,
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
import type { TranscriptMode } from "./transcript/Transcript";

const TRANSCRIPT_MODES: readonly TranscriptMode[] = ["normal", "thinking", "verbose"];

type HeaderState = "readOnly" | "readOnlyFree" | "readOnlyUnknown" | "stopped" | "reconnecting" | "waiting" | "working" | "starting" | "saved" | "ready";

/** The one state the header line describes, most urgent first. */
function headerState(view: SessionView): HeaderState {
	if (view.readOnly) return view.follow?.ownership === "free" ? "readOnlyFree" : view.follow?.ownership === "unknown" ? "readOnlyUnknown" : "readOnly";
	if (view.mode === "exited") return "stopped";
	if (view.mode === "reconnecting") return "reconnecting";
	if (view.guest?.uiRequest) return "waiting";
	if (view.working) return "working";
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

/** "Working… 14s": mounted only while omp works, so the timer starts with the turn. */
function WorkingText(): ReactNode {
	const { t } = useTranslation("chat");
	const since = useRef(Date.now());
	const now = useNow(1000);
	return (
		<>
			<span aria-hidden>{t("header.state.workingFor", { elapsed: elapsed(now - since.current) })}</span>
			<span className="sr-only">{t("header.state.working")}</span>
		</>
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
 * Chat header (DESIGN §3.4). Left: status mark, title and one line saying what the chat is doing. Right: Review
 * changes, the inspector toggle and the ⋯ session menu, which lists every command that declares `header`. The header
 * is a size container; below 36rem "Review changes" becomes an icon with a tooltip, and nothing else collapses.
 */
export function SessionHeader({ session, view, fallbackTitle }: { session: SessionController; view: SessionView; fallbackTitle: string | null }): ReactNode {
	const { t } = useTranslation(["chat", "shell"]);
	const commands = useCommands();
	const transcriptMode = useApp(state => state.prefs?.transcriptMode ?? "normal");
	const dockOpen = useApp(state => state.dockOpen);
	const ctx = { session, projectPath: session.projectPath };
	const sections = menuSections(commands.filter(command => command.when?.(ctx) ?? true));
	const title = chatTitle(view, fallbackTitle) ?? t("shell:chat.newTitle");
	const state = headerState(view);
	const reviewLabel = t("chat:header.review");

	return (
		<div className="@container/header flex min-h-(--header-h) shrink-0 items-center gap-3 border-b border-border bg-panel px-4 py-1.5">
			<StateMark state={state} view={view} />
			<div className="flex min-w-0 flex-1 flex-col">
				<PresenceSwap swapKey={title} variant="rise" className="min-w-0">
					<h1 className="truncate text-base leading-5 font-semibold text-fg" title={title}>
						{title}
					</h1>
				</PresenceSwap>
				<p role="status" className="truncate text-sm text-fg-muted">
					{state === "working" ? <WorkingText /> : t(`chat:header.state.${state}`)}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-0.5">
				{/* The wrappers own the display switch, so the buttons' own display classes cannot override it. */}
				<span className="hidden @min-[36rem]/header:contents">
					<Tooltip content={t("chat:header.reviewHint")}>
						<Button variant="ghost" size="sm" icon={<GitDiff />} onClick={() => useApp.getState().showPane("diff")}>
							{reviewLabel}
						</Button>
					</Tooltip>
				</span>
				<span className="contents @min-[36rem]/header:hidden">
					<IconButton label={reviewLabel} icon={<GitDiff />} size="md" onClick={() => useApp.getState().showPane("diff")} />
				</span>
				<IconButton
					label={t("chat:header.inspector")}
					shortcut="⌥⌘B"
					icon={<SidebarSimple mirrored />}
					size="md"
					pressed={dockOpen}
					onClick={() => useApp.getState().toggleDock()}
				/>
				<Menu>
					<MenuTrigger asChild>
						<IconButton label={t("chat:header.more")} icon={<DotsThree weight="bold" />} size="md" />
					</MenuTrigger>
					<MenuContent align="end" className="max-h-[70vh] min-w-[240px] overflow-y-auto">
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
