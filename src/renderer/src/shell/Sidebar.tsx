import {
	Archive,
	ArrowDown,
	ArrowUp,
	BoxArrowUp,
	Broom,
	CaretRight,
	ChatCenteredDots,
	CheckSquare,
	Columns,
	DotsThree,
	Folder,
	FolderMinus,
	FolderOpen,
	Gauge,
	Gear,
	House,
	NotePencil,
	Palette,
	PencilSimple,
	Plus,
	PushPin,
	PushPinSlash,
	Question,
	SortAscending,
	Smiley,
	Trash,
	X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type CSSProperties, createContext, memo, type MouseEvent, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_SIDEBAR_SORT, type SidebarSort } from "@shared/ipc";
import { shallow } from "zustand/shallow";
import type { SessionView } from "../state/session";
import { useTranslation } from "react-i18next";
import { getCommand } from "../registry/commands";
import { DialogLoadFailed, lazyView } from "../registry/lazy";
import { type AppState, closeAllChats, closeChat, closeChats, closeIdleChats, controllerFor, SIDEBAR_ID, useApp } from "../state/app";
import { openHelp, openProjectSettings, openSettings, openUsage } from "../state/navigation";
import {
	Button,
	Checkbox,
	cn,
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuTrigger,
	EmptyState,
	Expand,
	IconButton,
	Kbd,
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuGroup,
	MenuItem,
	MenuLabel,
	MenuRadioGroup,
	MenuRadioItem,
	MenuSeparator,
	MenuSub,
	MenuTrigger,
	ScrollArea,
	SearchInput,
	SectionLabel,
	spring,
	duration,
	ease,
	Mark,
	useMotionReduced,
	usePageNavSlot,
	Wordmark,
} from "../ui";
import { PROJECT_COLOR_CHOICES, ProjectColorDot } from "../features/projects/ProjectColor";
import { type ProjectColor, projectColorValue, setProjectColor, useProjectColor } from "../state/projectColors";
import { ChatStatusMark } from "./ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useModifierHeld, useNow, useSessionSelection } from "./hooks";
import { archivedChats, type CurrentChat, currentChatMoveIndex, currentChats, flatChats, type ProjectChat, type SidebarChat, type SidebarGroup, type SidebarInput, sidebarGroups } from "./sidebarRows";
import { sidebarTitles } from "./sidebarTitles";
import { TrashChatDialog } from "./trash";
import { SessionTitle, toast } from "../ui";

// Title-editing dialogs and their helpers load on demand or during idle preloading, keeping them out of the entry chunk.
// If one does not load, the failure dialog shows instead, and Close dismisses it.
const ChangeChatIconDialog = lazyView(() => import("./ChangeChatIconDialog").then(module => module.ChangeChatIconDialog), null, DialogLoadFailed);
const RenameChatDialog = lazyView(() => import("./RenameChatDialog").then(module => module.RenameChatDialog), null, DialogLoadFailed);

const MAC = window.vomp.platform === "darwin";
/** Display prefix for ⌘/Ctrl shortcuts. */
const MOD = MAC ? "⌘" : "Ctrl+";

/** Show the sidebar if it is hidden and put the caret in its chat search (a typed `/resume`). */
export function focusChatSearch(): void {
	if (!useApp.getState().sidebarOpen) useApp.getState().toggleSidebar();
	// The search field mounts with the sidebar, so look for it for up to a second.
	const until = performance.now() + 1000;
	const attempt = () => {
		const input = document.querySelector<HTMLInputElement>(`#${SIDEBAR_ID} input[data-chat-search]`);
		if (input) {
			input.focus();
			input.select();
		} else if (performance.now() < until) requestAnimationFrame(attempt);
	};
	requestAnimationFrame(attempt);
}

type SidebarState = Pick<AppState, "projects" | "sessionsByProject" | "tabs" | "prefs" | "expandedProjects" | "expandedChatLists" | "search">;

function sidebarInput(state: SidebarState, titles: ReadonlyMap<string, string | null>, labels: Pick<SidebarInput, "untitledTitle" | "newChatTitle">): SidebarInput {
	return {
		projects: state.projects,
		sessionsByProject: state.sessionsByProject,
		tabs: state.tabs,
		pinnedProjects: state.prefs?.pinnedProjects ?? [],
		sortBy: state.prefs?.sidebarSort?.by ?? DEFAULT_SIDEBAR_SORT.by,
		expanded: state.expandedProjects,
		showAll: state.expandedChatLists,
		query: state.search,
		...labels,
		openTitle: tabId => titles.get(tabId) ?? null,
	};
}

/** Show a sidebar row's chat: the open chat, or the saved chat opened fresh. `split` puts it beside the chat on the left. */
function openSidebarChat(chat: SidebarChat, split = false): void {
	const app = useApp.getState();
	if (chat.tabId) app.activateTab(chat.tabId, { split });
	else if (chat.kind === "session") app.openSession(chat.session, { split });
}

/** Per-sidebar prefix for the active-row indicator's layoutId, so the highlight slides between rows. */
const IndicatorScope = createContext("sidebar");

/** A row's menus come in two kinds with the same items: its ⋯ dropdown and its right-click menu. */
const dropdownKit = { Item: MenuItem, Separator: MenuSeparator, Sub: MenuSub, RadioGroup: MenuRadioGroup, RadioItem: MenuRadioItem };
const contextKit = {
	Item: ContextMenuItem,
	Separator: ContextMenuSeparator,
	Sub: ContextMenuSub,
	RadioGroup: ContextMenuRadioGroup,
	RadioItem: ContextMenuRadioItem,
};
type MenuKit = typeof dropdownKit | typeof contextKit;

/*
 * A row keeps its hover look while its right-click menu (`data-state` on the row) or its ⋯ menu (`data-state` on the
 * button inside) is open, though the pointer has moved into the menu: the highlight, the ⋯ button in place of the
 * time or project name.
 */
const rowMenuOpen = "data-[state=open]:bg-hover data-[state=open]:text-fg has-[[data-state=open]]:bg-hover has-[[data-state=open]]:text-fg data-[state=open]:[--mark-overlay:var(--hover)] has-[[data-state=open]]:[--mark-overlay:var(--hover)]";
const hideWhileMenuOpen = "group-data-[state=open]:hidden group-has-[[data-state=open]]:hidden";
const showWhileMenuOpen = "group-data-[state=open]:inline-flex!";

/*
 * A colored project's row: a wash of its folder color (`--row-tint`, set on the row) in place of the neutral fills,
 * 16% at rest, 24% on hover or with a menu open, 30% when its overview is showing. Text stays 7:1 or more on ink.
 */
const tintedRow = [
	"bg-[color-mix(in_oklch,var(--row-tint)_16%,transparent)]",
	"hover:bg-[color-mix(in_oklch,var(--row-tint)_24%,transparent)]",
	"data-[state=open]:bg-[color-mix(in_oklch,var(--row-tint)_24%,transparent)]",
	"has-[[data-state=open]]:bg-[color-mix(in_oklch,var(--row-tint)_24%,transparent)]",
].join(" ");
const tintedRowActive = "bg-[color-mix(in_oklch,var(--row-tint)_30%,transparent)]";

function runCommand(id: string): void {
	const command = getCommand(id);
	const state = useApp.getState();
	void command?.run({ session: null, projectPath: state.activeProject });
}

/** Chat rows slide into their new place on reorder; new rows fade and rise, removed rows fade out. */
function RowList({ chats, now }: { chats: (SidebarChat | ProjectChat)[]; now: number }): ReactNode {
	const reduced = useMotionReduced();
	let layoutKey = "";
	for (const chat of chats) layoutKey += `${chat.key}\0`;
	return (
		<AnimatePresence initial={false} mode="popLayout">
			{chats.map(chat => (
				<motion.div key={chat.key} layout={reduced ? false : "position"} layoutDependency={layoutKey} initial={{ opacity: 0, y: reduced ? 0 : -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy}>
					{"projectName" in chat ? <ChatRow variant="flat" chat={chat} now={now} /> : <ChatRow chat={chat} now={now} />}
				</motion.div>
			))}
		</AnimatePresence>
	);
}

type ChatRowProps =
	| { variant?: "tree"; chat: SidebarChat; now: number }
	| { variant: "flat"; chat: ProjectChat; now: number }
	/** A Current chats row: project name as meta, ⌘1-⌘9 `number` shown while ⌘/Ctrl is held. */
	| { variant: "current"; chat: CurrentChat; now: number; number: number | null; showNumber: boolean; move(delta: number): void; canMoveUp: boolean; canMoveDown: boolean };

function sidebarSelection(view: SessionView | null) {
	return { status: chatStatus(view), title: chatTitle(view, null), host: view?.host ?? null };
}

/**
 * One chat. A Current chats row carries the raised selection pill and the ⌘ number; a Projects tree row of an open
 * chat shows only a quiet open marker, so the selection reads in one place.
 */
const ChatRow = memo(function ChatRow(props: ChatRowProps): ReactNode {
	const { chat, now } = props;
	const current = props.variant === "current";
	const flat = props.variant === "flat";
	const projectColor = useProjectColor(flat ? props.chat.projectPath : "");
	const { t } = useTranslation("shell");
	const session = chat.kind === "session" ? chat.session : null;
	const tabId = chat.tabId;
	const tab = useApp(state => (tabId ? (state.tabs.find(entry => entry.id === tabId) ?? null) : null));
	const unseen = useApp(state => (tabId ? state.unseenChats[tabId] : undefined));
	const statusId = useId();
	const primary = useApp(state => state.view === "chat" && tabId !== null && state.activeTabId === tabId);
	const secondary = useApp(state => state.view === "chat" && tabId !== null && state.splitTabId === tabId);
	const pinned = session?.pinned ?? false;
	const controller = controllerFor(tabId);
	const liveView = useSessionSelection(controller, sidebarSelection, shallow);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const titleButton = useRef<HTMLButtonElement>(null);
	const focusMovedTitle = useRef(false);
	const move = (delta: number, fromMenu = false) => {
		if (!current) return;
		focusMovedTitle.current = fromMenu;
		props.move(delta);
	};
	const onMenuCloseFocus = (event: Event) => {
		if (!focusMovedTitle.current) return;
		focusMovedTitle.current = false;
		event.preventDefault();
		titleButton.current?.focus();
	};
	const [renameSaved, setRenameSaved] = useState(false);
	const [changeIcon, setChangeIcon] = useState(false);
	const scope = useContext(IndicatorScope);
	const status = liveView.status;
	const title = liveView.title ?? session?.title ?? tab?.title ?? session?.preview ?? t(session ? "sidebar.untitled" : "chat.newTitle");
	const active = primary || secondary;
	const rename = getCommand("chat.rename");
	const renameContext = controller ? { session: controller, projectPath: controller.projectPath } : null;
	const liveRename = rename !== undefined && renameContext !== null && Boolean(liveView?.host && liveView.host.phase !== "exited") && (rename.when?.(renameContext) ?? true);
	const canRename = liveRename || session !== null;

	const open = (event?: MouseEvent) => openSidebarChat(chat, event?.metaKey || event?.ctrlKey);
	const togglePin = () => {
		if (!session) return;
		void window.vomp.invoke("sessions:pin", session.file)
			.then(() => useApp.getState().loadSessions(session.cwd))
			.catch(error => toast({ message: error instanceof Error ? error.message : String(error), tone: "err" }));
	};
	const toggleArchive = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs || !session) return;
		const ids = new Set([session.id, ...(session.previousSessionIds ?? [])]);
		const list = session.archived ? prefs.archivedSessions.filter(id => !ids.has(id)) : [...prefs.archivedSessions, session.id];
		void useApp.getState().setPrefs({ archivedSessions: list }).then(() => useApp.getState().loadSessions(session.cwd));
	};

	const items = (kit: MenuKit) => (
		<>
			<kit.Item icon={<ChatCenteredDots />} onSelect={() => open()}>
				{t("sidebar.open")}
			</kit.Item>
			{!primary && (
				<kit.Item icon={<Columns />} shortcut={`${MOD}click`} onSelect={() => openSidebarChat(chat, true)}>
					{t("sidebar.openSplit")}
				</kit.Item>
			)}
			{tabId && (
				<kit.Item icon={<X />} onSelect={() => void closeChat(tabId)}>
					{t("sidebar.close")}
				</kit.Item>
			)}
			{current && (
				<>
					<kit.Item icon={<ArrowUp />} disabled={!props.canMoveUp} shortcut={`${MAC ? "⌥" : "Alt+"}↑`} onSelect={() => move(-1, true)}>
						{t("sidebar.moveUp")}
					</kit.Item>
					<kit.Item icon={<ArrowDown />} disabled={!props.canMoveDown} shortcut={`${MAC ? "⌥" : "Alt+"}↓`} onSelect={() => move(1, true)}>
						{t("sidebar.moveDown")}
					</kit.Item>
				</>
			)}
			{canRename && (
				<kit.Item icon={<PencilSimple />} onSelect={() => {
					if (liveRename && renameContext) void rename!.run(renameContext);
					else setRenameSaved(true);
				}}>
					{t("sidebar.rename")}
				</kit.Item>
			)}
			{canRename && (
				<kit.Item icon={<Smiley />} onSelect={() => setChangeIcon(true)}>
					{t("sidebar.changeIcon")}
				</kit.Item>
			)}
			{session && (
				<>
					<kit.Item icon={pinned ? <PushPinSlash /> : <PushPin />} onSelect={togglePin}>
						{pinned ? t("sidebar.unpinChat") : t("sidebar.pinChat")}
					</kit.Item>
					<kit.Item icon={session.archived ? <BoxArrowUp /> : <Archive />} onSelect={toggleArchive}>
						{session.archived ? t("sidebar.unarchive") : t("sidebar.archive")}
					</kit.Item>
					<kit.Item icon={<FolderOpen />} onSelect={() => void window.vomp.invoke("app:showItem", session.file)}>
						{t("sidebar.reveal")}
					</kit.Item>
					<kit.Separator />
					<kit.Item icon={<Trash />} danger onSelect={() => setConfirmDelete(true)}>
						{t("sidebar.delete")}
					</kit.Item>
				</>
			)}
		</>
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							"group relative isolate flex h-8 items-center gap-2 rounded-md pr-1 text-md",
							current || flat ? "@container/row pl-row" : "pl-7",
							current && active ? "font-medium text-fg [--mark-overlay:var(--pill)]" : cn("text-fg-muted hover:bg-hover hover:text-fg hover:[--mark-overlay:var(--hover)]", rowMenuOpen),
						)}
					>
						{current && active && (
							<motion.span
								aria-hidden
								layoutId={`${scope}-current-${primary ? "active" : "split"}`}
								transition={spring.snappy}
								className="absolute inset-0 -z-10 rounded-md bg-pill shadow-(--shadow-pill)"
							/>
						)}
						<ChatStatusMark id={statusId} status={status} label={t(`sidebar.status.${status}`)} quiet={!current && tabId !== null} unseen={unseen} />
						<button
							type="button"
							ref={titleButton}
							className={cn(
								"flex-auto shrink-100 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-ring",
								// The title gives way first, down to 60% of a Current chats row; then the project name shrinks.
								current || flat ? "min-w-3/5" : "min-w-0",
								unseen && "font-semibold text-fg",
							)}
							data-row-title
							data-current-tab={current ? tabId : undefined}
							title={session?.preview ?? undefined}
							aria-current={current && active ? "true" : undefined}
							aria-describedby={unseen ? statusId : undefined}
							aria-keyshortcuts={current ? `${props.number ? `${MAC ? "Meta" : "Control"}+${props.number} ` : ""}Alt+ArrowUp Alt+ArrowDown` : undefined}
							onClick={open}
							onAuxClick={event => {
								// Middle-click closes an open chat.
								if (event.button === 1 && tabId) void closeChat(tabId);
							}}
							onKeyDown={event => {
								if (current && event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
									event.preventDefault();
									move(event.key === "ArrowUp" ? -1 : 1);
									return;
								}
								if (event.key === "Delete" && tabId) {
									event.preventDefault();
									void closeChat(tabId);
								}
							}}
						>
							<SessionTitle title={title} />
						</button>
						{!current && pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						{current || flat ? (
							current && props.showNumber && props.number ? (
								<Kbd className={cn("shrink-0 group-hover:hidden group-focus-within:hidden", hideWhileMenuOpen)}>{`${MOD}${props.number}`}</Kbd>
							) : (
								// Up to 72px of project name; hidden when fewer than about six characters would fit beside the title.
								<span
									className={cn(
										"flex max-w-18 min-w-0 items-center gap-1 font-mono text-xs text-fg-faint group-hover:hidden group-focus-within:hidden @max-[10.875rem]/row:hidden",
										hideWhileMenuOpen,
									)}
								>
									{flat && projectColor && <ProjectColorDot color={projectColor} />}
									<span className="truncate">{props.chat.projectName}</span>
								</span>
							)
						) : (
							<span className={cn("shrink-0 font-mono text-xs text-fg-faint group-hover:hidden group-focus-within:hidden", hideWhileMenuOpen)}>
								{session ? shortAgo(session.updatedAt, now) : null}
							</span>
						)}
						<Menu>
							<MenuTrigger asChild>
								<IconButton
									// `!` beats the button's own `inline-flex`; `cn` joins classes without resolving conflicts.
									className={cn("relative hidden! group-hover:inline-flex! group-focus-within:inline-flex! data-[state=open]:inline-flex!", showWhileMenuOpen)}
									label={t("sidebar.chatMenu")}
									icon={<DotsThree />}
									size="sm"
								/>
							</MenuTrigger>
							<MenuContent align="end" onCloseAutoFocus={onMenuCloseFocus}>{items(dropdownKit)}</MenuContent>
						</Menu>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent onCloseAutoFocus={onMenuCloseFocus}>{items(contextKit)}</ContextMenuContent>
			</ContextMenu>
			<TrashChatDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={title}
				target={session ? { file: session.file, cwd: session.cwd, tabId } : null}
			/>
			{renameSaved && session && <RenameChatDialog session={session} close={() => setRenameSaved(false)} />}
			{changeIcon && <ChangeChatIconDialog title={title} live={liveRename ? controller ?? null : null} session={session} close={() => setChangeIcon(false)} />}
		</>
	);
});

/**
 * A Current chats row while chats are being selected: a checkbox named by the chat's title, described by its status,
 * with the whole row as its label. It has no menus, drag, open or close gestures.
 */
const SelectChatRow = memo(function SelectChatRow({ chat, checked, onCheckedChange }: { chat: CurrentChat; checked: boolean; onCheckedChange(checked: boolean): void }): ReactNode {
	const { t } = useTranslation("shell");
	const session = chat.kind === "session" ? chat.session : null;
	const tabTitle = useApp(state => state.tabs.find(entry => entry.id === chat.tabId)?.title ?? null);
	const unseen = useApp(state => state.unseenChats[chat.tabId]);
	const liveView = useSessionSelection(controllerFor(chat.tabId), sidebarSelection, shallow);
	const active = useApp(state => state.view === "chat" && (state.activeTabId === chat.tabId || state.splitTabId === chat.tabId));
	const inputId = useId();
	const statusId = useId();
	const title = liveView.title ?? session?.title ?? tabTitle ?? session?.preview ?? t(session ? "sidebar.untitled" : "chat.newTitle");
	return (
		<div
			className={cn(
				"relative isolate flex h-8 items-center gap-2 rounded-md pr-1 pl-row text-md has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring",
				active ? "font-medium text-fg [--mark-overlay:var(--pill)]" : "text-fg-muted hover:bg-hover hover:text-fg hover:[--mark-overlay:var(--hover)]",
			)}
		>
			{/* The open chat keeps its pill: selection is shown by the checkboxes, not by the row. */}
			{active && <span aria-hidden className="absolute inset-0 -z-10 rounded-md bg-pill shadow-(--shadow-pill)" />}
			<Checkbox id={inputId} checked={checked} onCheckedChange={onCheckedChange} aria-label={title} aria-describedby={statusId} data-select-chat={chat.tabId} />
			{/* The label's overlay makes the whole row toggle the checkbox. */}
			<label htmlFor={inputId} className="flex min-w-0 flex-1 cursor-default items-center gap-2 after:absolute after:inset-0 after:rounded-md">
				<ChatStatusMark id={statusId} status={liveView.status} label={t(`sidebar.status.${liveView.status}`)} unseen={unseen} />
				<SessionTitle title={title} />
			</label>
		</div>
	);
});

interface ProjectGroupProps {
	group: SidebarGroup;
	now: number;
	/** Search is on: every matching row shows and empty text stays hidden. */
	filtering: boolean;
	layoutKey: string;
}

function ProjectGroup({ group, now, filtering, layoutKey }: ProjectGroupProps): ReactNode {
	const { t } = useTranslation("shell");
	const { project } = group;
	const active = useApp(state => state.activeProject === project.path && state.view === "project");
	const pinned = useApp(state => state.prefs?.pinnedProjects.includes(project.path) ?? false);
	const color = useProjectColor(project.path);
	const reduced = useMotionReduced();

	const togglePin = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs) return;
		const list = pinned ? prefs.pinnedProjects.filter(path => path !== project.path) : [project.path, ...prefs.pinnedProjects];
		void useApp.getState().setPrefs({ pinnedProjects: list });
	};

	const items = (kit: MenuKit) => (
		<>
			<kit.Item icon={<Plus />} onSelect={() => void useApp.getState().newChat(project.path)}>
				{t("sidebar.newChatHere")}
			</kit.Item>
			<kit.Item icon={<House />} onSelect={() => useApp.getState().openProject(project.path)}>
				{t("sidebar.projectOverview")}
			</kit.Item>
			<kit.Item icon={<Gear />} onSelect={() => openProjectSettings(project.path)}>
				{t("sidebar.projectSettings")}
			</kit.Item>
			<kit.Item icon={<FolderOpen />} onSelect={() => void window.vomp.invoke("app:showItem", project.path)}>
				{t("sidebar.reveal")}
			</kit.Item>
			{!group.removed && (
				<>
					<kit.Sub icon={<Palette />} label={t("projects:color.label")}>
						<kit.RadioGroup
							value={color ?? "none"}
							onValueChange={value => void setProjectColor(project.path, value === "none" ? null : (value as ProjectColor))}
						>
							{PROJECT_COLOR_CHOICES.map(choice => (
								<kit.RadioItem key={choice ?? "none"} value={choice ?? "none"}>
									<span className="flex items-center gap-2">
										<ProjectColorDot color={choice} />
										{t(choice ? `projects:color.${choice}` : "projects:color.none")}
									</span>
								</kit.RadioItem>
							))}
						</kit.RadioGroup>
					</kit.Sub>
					<kit.Item icon={pinned ? <PushPinSlash /> : <PushPin />} onSelect={togglePin}>
						{pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject")}
					</kit.Item>
					<kit.Separator />
					<kit.Item icon={<X />} onSelect={() => void window.vomp.invoke("project:remove", project.path).then(() => useApp.getState().refreshProjects())}>
						{t("sidebar.removeProject")}
					</kit.Item>
				</>
			)}
		</>
	);

	return (
		<motion.div role="group" aria-label={project.name} layout={reduced ? false : "position"} layoutDependency={layoutKey} transition={spring.gentle}>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						style={color ? ({ "--row-tint": projectColorValue(color) } as CSSProperties) : undefined}
						className={cn(
							"group flex h-9 items-center gap-1 rounded-md pr-1 pl-1 text-md",
							color ? (active ? tintedRowActive : tintedRow) : active ? "bg-selected" : cn("hover:bg-hover", rowMenuOpen),
						)}
					>
						<IconButton
							label={group.open ? t("sidebar.collapse", { name: project.name }) : t("sidebar.expand", { name: project.name })}
							icon={<CaretRight className={cn("transition-transform duration-(--dur) ease-(--ease-out-quart)", group.open && "rotate-90")} />}
							size="sm"
							aria-expanded={group.open}
							disabled={filtering || group.removed}
							onClick={() => useApp.getState().toggleProjectExpanded(project.path)}
						/>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-ring"
							aria-current={active ? "page" : undefined}
							onClick={() => useApp.getState().openProject(project.path)}
							title={group.removed ? t("sidebar.removedProject", { path: project.path }) : project.exists ? project.path : t("sidebar.missingFolder")}
						>
							{project.exists ? (
								<Folder
									weight={color ? "fill" : "regular"}
									className="size-4 shrink-0 text-fg-muted"
									style={color ? { color: projectColorValue(color) } : undefined}
								/>
							) : (
								<FolderMinus className="size-4 shrink-0 text-warn" />
							)}
							<span className="truncate">{project.name}</span>
						</button>
						{pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						<Menu>
							<MenuTrigger asChild>
								<IconButton
									className={cn("hidden! group-hover:inline-flex! group-focus-within:inline-flex! data-[state=open]:inline-flex!", showWhileMenuOpen)}
									label={t("sidebar.projectMenu")}
									icon={<DotsThree />}
									size="sm"
								/>
							</MenuTrigger>
							<MenuContent align="end">{items(dropdownKit)}</MenuContent>
						</Menu>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>{items(contextKit)}</ContextMenuContent>
			</ContextMenu>
			<Expand open={group.open} className="relative flex flex-col gap-px pb-1">
				<RowList chats={group.chats} now={now} />
				{!filtering && group.total === 0 && <p className="py-1 pr-2 pl-7 text-sm text-fg-faint">{t("sidebar.noChats")}</p>}
				{group.more > 0 && (
					<button
						type="button"
						className="h-7 rounded-md pl-7 text-left text-sm text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
						onClick={() => useApp.getState().showMoreChats(project.path)}
					>
						{t("sidebar.moreChats", { count: group.more })}
					</button>
				)}
			</Expand>
		</motion.div>
	);
}

/** "+" on the Projects header: open a folder, make a new one, or clone from GitHub. */
function AddProjectMenu(): ReactNode {
	const { t } = useTranslation("shell");
	const items = ["project.open", "project.newFolder", "project.clone"].flatMap(id => getCommand(id) ?? []);
	if (items.length === 0) return null;
	return (
		<Menu>
			<MenuTrigger asChild>
				<IconButton label={t("projects:sidebar.add")} icon={<Plus />} size="sm" />
			</MenuTrigger>
			<MenuContent align="end">
				{items.map(command => {
					const Icon = command.icon;
					return (
						<MenuItem key={command.id} icon={Icon ? <Icon /> : undefined} shortcut={command.shortcut} onSelect={() => runCommand(command.id)}>
							{t(command.title)}
						</MenuItem>
					);
				})}
			</MenuContent>
		</Menu>
	);
}

/** Sorting applies only to Projects; Current chats keeps its manually adjustable tab order. */
function SidebarSortMenu({ sort }: { sort: SidebarSort }): ReactNode {
	const { t } = useTranslation("shell");
	const labelId = useId();
	const viewLabelId = useId();
	const update = (patch: Partial<SidebarSort>) => {
		const current = useApp.getState().prefs?.sidebarSort ?? DEFAULT_SIDEBAR_SORT;
		void useApp.getState().setPrefs({ sidebarSort: { ...current, ...patch } });
	};
	return (
		<Menu>
			<MenuTrigger asChild>
				<IconButton label={t("sidebar.sort.label")} icon={<SortAscending />} size="sm" />
			</MenuTrigger>
			<MenuContent align="end">
				<MenuLabel id={labelId}>{t("sidebar.sort.by")}</MenuLabel>
				<MenuRadioGroup aria-labelledby={labelId} value={sort.by} onValueChange={by => update({ by: by as SidebarSort["by"] })}>
					<MenuRadioItem value="recent">{t("sidebar.sort.recent")}</MenuRadioItem>
					<MenuRadioItem value="name">{t("sidebar.sort.name")}</MenuRadioItem>
					<MenuRadioItem value="created">{t("sidebar.sort.created")}</MenuRadioItem>
				</MenuRadioGroup>
				<MenuSeparator />
				<MenuLabel id={viewLabelId}>{t("sidebar.sort.view")}</MenuLabel>
				<MenuGroup aria-labelledby={viewLabelId}>
					<MenuCheckboxItem
						indicator="switch"
						checked={sort.groupByProject}
						onCheckedChange={checked => update({ groupByProject: checked === true })}
						onSelect={event => event.preventDefault()}
					>
						{t("sidebar.sort.groupByProject")}
					</MenuCheckboxItem>
				</MenuGroup>
			</MenuContent>
		</Menu>
	);
}

/** Usage & limits, Settings and Help. The one whose page is showing is highlighted. */
function BottomNav(): ReactNode {
	const { t } = useTranslation("shell");
	const pageId = useApp(state => (state.view === "page" ? (state.page?.id ?? null) : null));
	const items = [
		{ id: "usage", icon: Gauge, label: t("sidebar.usage"), open: () => openUsage() },
		{ id: "settings", icon: Gear, label: t("sidebar.settings"), open: () => openSettings() },
		{ id: "help", icon: Question, label: t("sidebar.help"), open: openHelp },
	];
	return (
		<div className="flex flex-col gap-px border-t border-border p-2">
			{items.map(({ id, icon: Icon, label, open }) => {
				const current = pageId === id;
				return (
					<button
						key={id}
						type="button"
						aria-current={current ? "page" : undefined}
						className={cn(
							"flex h-9 items-center gap-2 rounded-md px-row text-md font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring",
							current ? "bg-pill text-fg shadow-(--shadow-pill)" : "text-fg-muted hover:bg-hover hover:text-fg",
						)}
						onClick={() => {
							if (!current) open();
						}}
					>
						<Icon className="size-4" />
						{label}
					</button>
				);
			})}
		</div>
	);
}

/** The sidebar's 40px top: the lockup and version in the window drag region, clear of the macOS traffic lights. */
function SidebarHeader(): ReactNode {
	const { t } = useTranslation("shell");
	const [version, setVersion] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void window.vomp.invoke("app:info").then(info => {
			if (live) setVersion(info.version);
		});
		return () => {
			live = false;
		};
	}, []);
	return (
		<div className={cn("drag-region flex h-10 shrink-0 items-center pr-3", MAC ? "pl-traffic" : "pl-4")}>
			{/* A narrow sidebar or large text drops the version first, then the word, keeping the mark. */}
			<div className="@container flex min-w-0 flex-1 items-center gap-2">
				<Wordmark withMark size="sm" className="shrink-0 @max-[6.75rem]:hidden" />
				<span className="hidden @max-[6.75rem]:inline-flex">
					<Mark size={18} />
					<span className="sr-only">visual-omp</span>
				</span>
				{version && (
					<span className="font-mono text-xs text-fg-faint transition-colors duration-(--dur-slow) ease-(--ease-out-quart) @max-[10rem]:hidden">
						{t("sidebar.version", { version })}
					</span>
				)}
			</div>
		</div>
	);
}

/** The header card's fill clip: all of it, or none of it (a zero-width strip at its left edge). */
const CARD_FULL = "inset(0% 0% 0% 0%)";
const CARD_EMPTY = "inset(0% 100% 0% 0%)";

interface HeaderCardProps {
	/** A page holds the Back slot. */
	filled: boolean;
	/** The card keeps its height and white text: while filled, and while the fill sweeps out after the page closes. */
	open: boolean;
	/** The fill finished leaving, so the card can close up. */
	onEmptied(): void;
}

/**
 * The header, then the Back slot a page portals its Back row into. While a page is open the two share one light teal
 * card that runs to the window's top and the sidebar's sides, with 12px bottom corners like the main sheet's. The
 * fill reaches 12px under the sheet at the top, so the notch beside the sheet's rounded top-left corner is teal too
 * (the sheet paints over the rest; see Shell). `data-page-card` makes the text and mark white, darkens the hover
 * background and uses an ink focus ring (tokens.css). The fill sweeps in from the left when a page opens. When the
 * page closes, the card keeps its height and white text while the fill sweeps back out, then closes up. Under reduced
 * motion the fill crossfades.
 */
function HeaderCard({ filled, open, onEmptied }: HeaderCardProps): ReactNode {
	const setBackSlot = usePageNavSlot(state => state.setBackSlot);
	const reduced = useMotionReduced();
	const [slot, setSlot] = useState<HTMLDivElement | null>(null);
	const slotRef = useCallback(
		(element: HTMLDivElement | null) => {
			setSlot(element);
			setBackSlot(element);
		},
		[setBackSlot],
	);
	// The Back slot's height while a page fills it, which the card keeps after the page takes its Back row away.
	const [height, setHeight] = useState(0);
	useEffect(() => {
		if (!slot || !filled) return;
		const observer = new ResizeObserver(() => setHeight(slot.offsetHeight));
		observer.observe(slot);
		return () => observer.disconnect();
	}, [slot, filled]);
	const fill = filled
		? { opacity: 1, clipPath: CARD_FULL }
		: reduced
			? { opacity: 0, clipPath: CARD_FULL }
			: { opacity: 1, clipPath: CARD_EMPTY };
	const fillTransition = reduced
		? { opacity: { duration: duration.base, ease: ease.outQuart }, clipPath: { duration: 0 } }
		: filled
			? { duration: duration.xl, ease: ease.outExpo }
			: { duration: duration.slow, ease: ease.outQuart };
	return (
		<div data-page-card={open ? "filled" : undefined} className="relative isolate shrink-0">
			<motion.div
				aria-hidden
				initial={false}
				animate={fill}
				transition={fillTransition}
				onAnimationComplete={() => {
					if (usePageNavSlot.getState().mode === null) onEmptied();
				}}
				className="pointer-events-none absolute bottom-2 left-0 right-[calc(-1*var(--radius-lg))] top-0 -z-1"
			>
				<div className="absolute inset-y-0 left-0 right-(--radius-lg) rounded-b-lg bg-page-card" />
				<div className="absolute right-0 top-0 size-(--radius-lg) bg-page-card" />
			</motion.div>
			<SidebarHeader />
			{/* Always mounted so a page can portal its Back row into it; no height while the card is closed. */}
			<motion.div
				ref={slotRef}
				initial={false}
				animate={{ opacity: filled ? 1 : 0 }}
				transition={reduced ? { duration: 0 } : { duration: duration.base, ease: ease.outQuart }}
				style={open && !filled ? { minHeight: height } : undefined}
				className={open ? "pb-2" : "hidden"}
			/>
		</div>
	);
}

/** Unseen open chats appear first; manual moves change tab order within the source group. */
function CurrentChats({ chats, now }: { chats: CurrentChat[]; now: number }): ReactNode {
	const { t } = useTranslation("shell");
	const tabs = useApp(state => state.tabs);
	const unseenChats = useApp(state => state.unseenChats);
	const reduced = useMotionReduced();
	const { ordered, unseenCount } = useMemo(() => {
		const unseen: CurrentChat[] = [];
		const seen: CurrentChat[] = [];
		for (const chat of chats) (unseenChats[chat.tabId] ? unseen : seen).push(chat);
		return { ordered: [...unseen, ...seen], unseenCount: unseen.length };
	}, [chats, unseenChats]);
	const showNumbers = useModifierHeld();
	const [dragId, setDragId] = useState<string | null>(null);
	const [dropIndex, setDropIndex] = useState<number | null>(null);
	const [announcement, setAnnouncement] = useState({ text: "", sequence: 0 });
	const sectionRef = useRef<HTMLElement>(null);
	const menuTrigger = useRef<HTMLButtonElement>(null);
	const [selecting, setSelecting] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
	/** Where focus goes when selection ends: the menu trigger after Done or Escape; nowhere after a close, whose dialog places it. */
	const refocusMenu = useRef(false);
	const displayed = ordered.map(chat => chat.tabId);
	// Selection is keyed by tab id: closed chats leave it, new chats start unchecked, and chats hidden by search stay selected.
	const selectedIds = tabs.flatMap(tab => selected.has(tab.id) ? [tab.id] : []);
	const hiddenSelected = selectedIds.filter(id => !displayed.includes(id)).length;
	const filtering = chats.length < tabs.length;
	const visibleSelected = displayed.filter(id => selected.has(id)).length;
	const announce = (text: string) => setAnnouncement(previous => ({ text, sequence: previous.sequence + 1 }));
	const endSelection = (refocus: boolean) => {
		refocusMenu.current = refocus;
		setSelecting(false);
		setSelected(new Set());
		announce(t("sidebar.selectionOff"));
	};
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			if (selecting) sectionRef.current?.querySelector<HTMLInputElement>("input[data-select-chat]")?.focus();
			else if (refocusMenu.current) menuTrigger.current?.focus();
			refocusMenu.current = false;
		});
		return () => cancelAnimationFrame(frame);
	}, [selecting]);
	useEffect(() => {
		if (selecting && tabs.length === 0) endSelection(false);
	});
	const toggle = (ids: readonly string[], checked: boolean) =>
		setSelected(previous => {
			const next = new Set(previous);
			for (const id of ids) {
				if (checked) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	const closeSelected = async () => {
		if ((await closeChats(selectedIds, "selected")) !== null) endSelection(false);
	};
	const layoutKey = `${displayed.join("\0")}\0${unseenCount}`;
	const moveTo = (tabId: string, position: number) => {
		const state = useApp.getState();
		const from = state.tabs.findIndex(tab => tab.id === tabId);
		const to = currentChatMoveIndex(state.tabs.map(tab => tab.id), displayed, state.unseenChats, tabId, position);
		if (to < 0) return;
		state.moveTab(tabId, to);
		const group = displayed.filter(id => Boolean(state.unseenChats[id]) === Boolean(state.unseenChats[tabId]));
		const groupStart = displayed.indexOf(group[0]!);
		const actual = Math.max(groupStart, Math.min(groupStart + group.length - 1, position));
		const chat = ordered.find(chat => chat.tabId === tabId);
		const session = chat?.kind === "session" ? chat.session : null;
		// The same title the row shows, so the announcement names the chat the person sees.
		const title =
			chatTitle(controllerFor(tabId)?.getSnapshot() ?? null, session?.title ?? state.tabs.find(tab => tab.id === tabId)?.title ?? null) ??
			session?.preview ??
			t(session ? "sidebar.untitled" : "chat.newTitle");
		announce(from === to ? t("sidebar.groupBoundary") : t("sidebar.moved", { title, position: actual + 1, count: ordered.length }));
	};
	// While selecting, a search with no matching chats keeps Done, Close and the hidden-selection note.
	if (chats.length === 0 && !selecting) return null;
	return (
		<section
			ref={sectionRef}
			aria-label={t("sidebar.current")}
			data-chat-selection={selecting || undefined}
			className="mb-stack flex flex-col gap-px"
			onKeyDown={event => {
				if (!selecting || event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				endSelection(true);
			}}
		>
			<div className="flex h-7 items-center gap-1 pl-row">
				<SectionLabel as="h2" className="min-w-0 flex-1">{t("sidebar.current")}</SectionLabel>
				{selecting ? (
					<Button size="sm" variant="ghost" onClick={() => endSelection(true)}>{t("sidebar.selectDone")}</Button>
				) : (
					<Menu>
						<MenuTrigger asChild>
							<IconButton ref={menuTrigger} size="sm" icon={<DotsThree />} label={t("sidebar.currentMenu")} />
						</MenuTrigger>
						<MenuContent align="end">
							<MenuItem icon={<CheckSquare />} onSelect={() => { setSelecting(true); announce(t("sidebar.selectionOn")); }}>{t("sidebar.selectChats")}</MenuItem>
							<MenuItem icon={<Broom />} onSelect={() => void closeIdleChats()}>{t("sidebar.closeIdle")}</MenuItem>
							<MenuItem icon={<X />} onSelect={() => void closeAllChats()}>{t("sidebar.closeAll")}</MenuItem>
						</MenuContent>
					</Menu>
				)}
			</div>
			{selecting && (
				<div className="flex flex-col gap-1 pr-1 pb-1 pl-row">
					<Checkbox
						label={<span className="text-sm">{t(filtering ? "sidebar.selectAllVisible" : "sidebar.selectAll")}</span>}
						checked={visibleSelected > 0 && visibleSelected === displayed.length}
						indeterminate={visibleSelected > 0 && visibleSelected < displayed.length}
						disabled={displayed.length === 0}
						onCheckedChange={checked => toggle(displayed, checked)}
					/>
					<div className="flex items-center gap-2">
						<span className="min-w-0 flex-1 text-sm text-fg-muted" aria-live="polite">{t("sidebar.selectedCount", { count: selectedIds.length, total: tabs.length })}</span>
						<Button size="sm" variant="secondary" disabled={selectedIds.length === 0} aria-label={t("sidebar.closeSelectedLabel")} onClick={() => void closeSelected()}>
							{t("sidebar.closeSelected")}
						</Button>
					</div>
					{hiddenSelected > 0 && <p className="text-sm text-fg-muted">{t("sidebar.selectedHidden", { count: hiddenSelected })}</p>}
				</div>
			)}
			<div role="status" aria-live="polite" aria-atomic="true" className="sr-only"><span key={announcement.sequence}>{announcement.text}</span></div>
			<AnimatePresence initial={false} mode="popLayout">
				{ordered.map((chat, position) => {
					const index = tabs.findIndex(tab => tab.id === chat.tabId);
					return (
						<motion.div
							key={chat.key}
							layout={reduced ? false : "position"}
							layoutDependency={layoutKey}
							initial={{ opacity: 0, y: reduced ? 0 : -4 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0 }}
							transition={spring.snappy}
						>
							{unseenCount > 0 && position === unseenCount && <div aria-hidden className="mx-row my-1 h-px bg-border" />}
							{selecting ? (
								<SelectChatRow chat={chat} checked={selected.has(chat.tabId)} onCheckedChange={checked => toggle([chat.tabId], checked)} />
							) : (
							<div
								draggable
								onDragStart={event => {
									setDragId(chat.tabId);
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData("application/x-vomp-chat", chat.tabId);
								}}
								onDragEnd={() => { setDragId(null); setDropIndex(null); }}
								onDragOver={event => {
									if (!dragId) return;
									event.preventDefault();
									event.stopPropagation();
									event.dataTransfer.dropEffect = "move";
									const box = event.currentTarget.getBoundingClientRect();
									const group = ordered.map((entry, index) => Boolean(unseenChats[entry.tabId]) === Boolean(unseenChats[dragId]) ? index : -1).filter(index => index >= 0);
									const target = event.clientY > box.top + box.height / 2 ? position + 1 : position;
									setDropIndex(Math.max(group[0]!, Math.min(group.at(-1)! + 1, target)));
								}}
								onDrop={event => {
									if (!dragId || dropIndex === null) return;
									event.preventDefault();
									event.stopPropagation();
									const from = displayed.indexOf(dragId);
									moveTo(dragId, from < dropIndex ? dropIndex - 1 : dropIndex);
									sectionRef.current?.querySelector<HTMLButtonElement>(`button[data-current-tab="${CSS.escape(dragId)}"]`)?.focus();
									setDragId(null);
									setDropIndex(null);
								}}
								className={cn(
									"relative",
									dragId === chat.tabId && "opacity-50",
									dragId && dropIndex === position && "before:absolute before:-top-px before:inset-x-row before:h-0.5 before:bg-accent",
									dragId && dropIndex === position + 1 && position === ordered.length - 1 && "after:absolute after:-bottom-px after:inset-x-row after:h-0.5 after:bg-accent",
								)}
							>
								<ChatRow variant="current" chat={chat} now={now} number={index >= 0 && index < 9 ? index + 1 : null} showNumber={showNumbers}
									move={delta => moveTo(chat.tabId, position + delta)}
									canMoveUp={position > 0 && Boolean(unseenChats[ordered[position - 1]!.tabId]) === Boolean(unseenChats[chat.tabId])}
									canMoveDown={position < ordered.length - 1 && Boolean(unseenChats[ordered[position + 1]!.tabId]) === Boolean(unseenChats[chat.tabId])}
								/>
							</div>
							)}
						</motion.div>
					);
				})}
			</AnimatePresence>
		</section>
	);
}

/**
 * The header card, then New chat, Search chats, Current chats and Projects with their chats, then Usage & limits,
 * Settings and Help. An open page puts its Back link in the header card, which fills with teal (`HeaderCard`); a page
 * with a section nav (Settings, mode "nav") also fills the space under it with its sections through the nav slot
 * (`usePageNavSlot`), in place of the chat lists, which crossfade with it.
 */
export function Sidebar({ width }: { width: number }): ReactNode {
	const { t } = useTranslation("shell");
	const scope = useId();
	const projects = useApp(state => state.projects);
	const sessionsByProject = useApp(state => state.sessionsByProject);
	const tabs = useApp(state => state.tabs);
	const labels = useMemo(() => ({ untitledTitle: t("sidebar.untitled"), newChatTitle: t("chat.newTitle") }), [t]);
	const titleSource = useMemo(() => sidebarTitles(tabs, sessionsByProject, controllerFor, labels), [tabs, sessionsByProject, labels]);
	const titles = useSyncExternalStore(titleSource.subscribe, titleSource.getSnapshot);
	const prefs = useApp(state => state.prefs);
	const sort = prefs?.sidebarSort ?? DEFAULT_SIDEBAR_SORT;
	const expandedProjects = useApp(state => state.expandedProjects);
	const expandedChatLists = useApp(state => state.expandedChatLists);
	const search = useApp(state => state.search);
	const setNavSlot = usePageNavSlot(state => state.setNavSlot);
	const slotMode = usePageNavSlot(state => state.mode);
	const takeover = slotMode === "nav";
	// The header card stays open while its fill sweeps out after a page closes; the lists below then slide up.
	const [cardOpen, setCardOpen] = useState(slotMode !== null);
	if (slotMode !== null && !cardOpen) setCardOpen(true);
	const reduced = useMotionReduced();
	const fade = reduced ? { duration: 0 } : { duration: duration.base, ease: ease.outQuart };
	const [showArchived, setShowArchived] = useState(false);
	const now = useNow();
	const query = search.trim().toLowerCase();
	const filtering = query.length > 0;

	// Flat lists, created ordering and search need every saved list, including collapsed projects.
	useEffect(() => {
		const state = useApp.getState();
		const allProjects = filtering || !sort.groupByProject || sort.by === "created";
		const paths = [...tabs.map(tab => tab.projectPath), ...(allProjects ? projects.map(project => project.path) : [])];
		for (const path of new Set(paths)) if (!state.sessionsByProject[path]) void state.loadSessions(path);
	}, [filtering, tabs, projects, sort.groupByProject, sort.by]);

	const { groups, flat, archived, current } = useMemo(() => {
		const input = sidebarInput({ projects, sessionsByProject, tabs, prefs, expandedProjects, expandedChatLists, search }, titles, labels);
		return { groups: sidebarGroups(input), flat: sort.groupByProject ? [] : flatChats(input), archived: archivedChats(input), current: currentChats(input) };
	}, [projects, sessionsByProject, tabs, prefs, expandedProjects, expandedChatLists, search, sort.groupByProject, titles, labels]);
	const projectLayoutKey = useMemo(() => {
		let key = `${filtering}\0`;
		for (const group of groups) {
			key += `${group.project.path}\0${group.open}\0${group.more > 0}\0${group.total === 0}\0`;
			for (const chat of group.chats) key += `${chat.key}\0`;
		}
		return key;
	}, [groups, filtering]);

	return (
		<IndicatorScope.Provider value={scope}>
			<nav id={SIDEBAR_ID} aria-label={t("sidebar.label")} data-tour="sidebar" style={{ width }} className="flex h-full shrink-0 flex-col">
				<HeaderCard filled={slotMode !== null} open={cardOpen} onEmptied={() => setCardOpen(false)} />
				<div className="relative flex min-h-0 flex-1 flex-col">
					{/* Always mounted so a page with sections (Settings) can portal its rail into it. */}
					<motion.div
						ref={setNavSlot}
						data-page-nav
						initial={false}
						animate={{ opacity: takeover ? 1 : 0 }}
						transition={fade}
						className={cn("flex-col", takeover ? "flex min-h-0 flex-1" : "hidden")}
					/>
					{/*
					 * Under a takeover the lists lie under the sections and fade out, then leave the accessibility tree; they stay
					 * mounted so Back finds them where they were scrolled. Under a page's Back row they slide down as the card grows.
					 */}
					<motion.div
						layout={reduced ? false : "position"}
						layoutDependency={`${cardOpen}\0${takeover}`}
						initial={false}
						animate={takeover ? { opacity: 0, transitionEnd: { visibility: "hidden" } } : { opacity: 1, visibility: "visible" }}
						transition={{ ...fade, layout: fade }}
						inert={takeover}
						className={cn("flex min-h-0 flex-col", takeover ? "pointer-events-none absolute inset-0" : "flex-1")}
					>
						<div className="flex flex-col gap-1 px-3 pb-2">
							<button
								type="button"
								data-new-chat
								className="flex h-9 items-center gap-2 rounded-md px-row text-md font-semibold text-accent outline-none hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring"
								onClick={() => void useApp.getState().newChat()}
							>
								<NotePencil className="size-4" />
								<span className="flex-1 text-left">{t("sidebar.newChat")}</span>
							</button>
							<SearchInput
								value={search}
								onValueChange={value => useApp.getState().setSearch(value)}
								placeholder={t("sidebar.search")}
								aria-label={t("sidebar.search")}
								data-chat-search
							/>
						</div>
						<div className="mx-3 h-px bg-border" />
						<ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 py-2">
							<CurrentChats chats={current} now={now} />
							<div className="flex h-7 items-center gap-1 pl-row">
								<SectionLabel as="h2" className="flex-1">
									{t("sidebar.projects")}
								</SectionLabel>
								<SidebarSortMenu sort={sort} />
								<AddProjectMenu />
							</div>
							{projects.length === 0 && groups.length === 0 ? (
								<EmptyState
									icon={<Folder />}
									title={t("sidebar.noProjects")}
									actions={
										<Button variant="primary" size="sm" icon={<Plus />} onClick={() => runCommand("project.new")}>
											{t("sidebar.newProject")}
										</Button>
									}
								/>
							) : (sort.groupByProject ? groups.length === 0 : flat.length === 0) ? (
								<p className="px-row text-sm text-fg-faint">{filtering ? t("sidebar.noResults", { q: search.trim() }) : t("sidebar.noFlatChats")}</p>
							) : !sort.groupByProject ? (
								<RowList chats={flat} now={now} />
							) : (
								groups.map(group => <ProjectGroup key={group.project.path} group={group} now={now} filtering={filtering} layoutKey={projectLayoutKey} />)
							)}
							{archived.length > 0 && (
								<div className="mt-2">
									<button
										type="button"
										aria-expanded={showArchived}
										className="flex h-8 w-full items-center gap-1 rounded-md px-row text-sm text-fg-muted outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
										onClick={() => setShowArchived(open => !open)}
									>
										<CaretRight className={cn("size-3.5 transition-transform duration-(--dur) ease-(--ease-out-quart)", showArchived && "rotate-90")} />
										{t("sidebar.archived")} · {archived.length}
									</button>
									<Expand open={showArchived} className="relative flex flex-col gap-px">
										<RowList chats={archived} now={now} />
									</Expand>
								</div>
							)}
						</ScrollArea>
					</motion.div>
				</div>
				<BottomNav />
			</nav>
		</IndicatorScope.Provider>
	);
}
