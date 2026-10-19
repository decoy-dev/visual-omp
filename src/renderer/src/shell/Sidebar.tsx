import {
	Archive,
	BoxArrowUp,
	CaretRight,
	ChatCenteredDots,
	Columns,
	DotsThree,
	Folder,
	FolderMinus,
	FolderOpen,
	Gauge,
	Gear,
	House,
	NotePencil,
	PencilSimple,
	Plus,
	PushPin,
	PushPinSlash,
	Question,
	Trash,
	X,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCommand } from "../registry/commands";
import { type AppState, closeChat, controllerFor, SIDEBAR_ID, useApp } from "../state/app";
import { openHelp, openProjectSettings, openSettings, openUsage } from "../state/navigation";
import {
	Button,
	cn,
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
	EmptyState,
	Expand,
	IconButton,
	Kbd,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
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
import { ChatStatusMark } from "./ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useModifierHeld, useNow, useSessionView } from "./hooks";
import { archivedChats, type CurrentChat, currentChats, type SidebarChat, type SidebarGroup, type SidebarInput, sidebarGroups } from "./sidebarRows";
import { TrashChatDialog } from "./trash";

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

function sidebarInput(state: SidebarState): SidebarInput {
	return {
		projects: state.projects,
		sessionsByProject: state.sessionsByProject,
		tabs: state.tabs,
		pinnedProjects: state.prefs?.pinnedProjects ?? [],
		pinnedSessions: state.prefs?.pinnedSessions ?? [],
		expanded: state.expandedProjects,
		showAll: state.expandedChatLists,
		query: state.search,
		openTitle: tabId => chatTitle(controllerFor(tabId)?.getSnapshot() ?? null, null),
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

function runCommand(id: string): void {
	const command = getCommand(id);
	const state = useApp.getState();
	void command?.run({ session: null, projectPath: state.activeProject });
}

/** Chat rows slide into their new place on reorder; new rows fade and rise, removed rows fade out. */
function RowList({ chats, now }: { chats: SidebarChat[]; now: number }): ReactNode {
	return (
		<AnimatePresence initial={false} mode="popLayout">
			{chats.map(chat => (
				<motion.div key={chat.key} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy}>
					<ChatRow chat={chat} now={now} />
				</motion.div>
			))}
		</AnimatePresence>
	);
}

type ChatRowProps =
	| { variant?: "tree"; chat: SidebarChat; now: number }
	/** A Current chats row: project name as meta, ⌘1-⌘9 `number` shown while ⌘/Ctrl is held. */
	| { variant: "current"; chat: CurrentChat; now: number; number: number | null; showNumber: boolean };

/**
 * One chat. A Current chats row carries the raised selection pill and the ⌘ number; a Projects tree row of an open
 * chat shows only a quiet open marker, so the selection reads in one place.
 */
function ChatRow(props: ChatRowProps): ReactNode {
	const { chat, now } = props;
	const current = props.variant === "current";
	const { t } = useTranslation("shell");
	const session = chat.kind === "session" ? chat.session : null;
	const tabId = chat.tabId;
	const tab = useApp(state => (tabId ? (state.tabs.find(entry => entry.id === tabId) ?? null) : null));
	const primary = useApp(state => state.view === "chat" && tabId !== null && state.activeTabId === tabId);
	const secondary = useApp(state => state.view === "chat" && tabId !== null && state.splitTabId === tabId);
	const pinned = useApp(state => (session ? (state.prefs?.pinnedSessions.includes(session.id) ?? false) : false));
	const controller = controllerFor(tabId);
	const liveView = useSessionView(controller);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const scope = useContext(IndicatorScope);
	const status = chatStatus(liveView);
	const title = chatTitle(liveView, session?.title ?? tab?.title ?? null) ?? session?.preview ?? t(session ? "sidebar.untitled" : "chat.newTitle");
	const active = primary || secondary;
	const rename = getCommand("chat.rename");
	const renameContext = controller ? { session: controller, projectPath: controller.projectPath } : null;
	const canRename = rename !== undefined && renameContext !== null && (rename.when?.(renameContext) ?? true);

	const open = (event?: MouseEvent) => openSidebarChat(chat, event?.metaKey || event?.ctrlKey);
	const togglePin = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs || !session) return;
		const list = pinned ? prefs.pinnedSessions.filter(id => id !== session.id) : [...prefs.pinnedSessions, session.id];
		void useApp.getState().setPrefs({ pinnedSessions: list });
	};
	const toggleArchive = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs || !session) return;
		const list = session.archived ? prefs.archivedSessions.filter(id => id !== session.id) : [...prefs.archivedSessions, session.id];
		void useApp.getState().setPrefs({ archivedSessions: list }).then(() => useApp.getState().loadSessions(session.cwd));
	};

	const items = (Item: typeof MenuItem | typeof ContextMenuItem, Separator: typeof MenuSeparator | typeof ContextMenuSeparator) => (
		<>
			<Item icon={<ChatCenteredDots />} onSelect={() => open()}>
				{t("sidebar.open")}
			</Item>
			{!primary && (
				<Item icon={<Columns />} shortcut={`${MOD}click`} onSelect={() => openSidebarChat(chat, true)}>
					{t("sidebar.openSplit")}
				</Item>
			)}
			{tabId && (
				<Item icon={<X />} onSelect={() => void closeChat(tabId)}>
					{t("sidebar.close")}
				</Item>
			)}
			{canRename && renameContext && (
				<Item icon={<PencilSimple />} onSelect={() => void rename.run(renameContext)}>
					{t("sidebar.rename")}
				</Item>
			)}
			{session && (
				<>
					<Item icon={pinned ? <PushPinSlash /> : <PushPin />} onSelect={togglePin}>
						{pinned ? t("sidebar.unpinChat") : t("sidebar.pinChat")}
					</Item>
					<Item icon={session.archived ? <BoxArrowUp /> : <Archive />} onSelect={toggleArchive}>
						{session.archived ? t("sidebar.unarchive") : t("sidebar.archive")}
					</Item>
					<Item icon={<FolderOpen />} onSelect={() => void window.vomp.invoke("app:showItem", session.file)}>
						{t("sidebar.reveal")}
					</Item>
					<Separator />
					<Item icon={<Trash />} danger onSelect={() => setConfirmDelete(true)}>
						{t("sidebar.delete")}
					</Item>
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
							current ? "@container/row pl-row" : "pl-7",
							current && active ? "font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
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
						<ChatStatusMark status={status} label={t(`sidebar.status.${status}`)} quiet={!current && tabId !== null} />
						<button
							type="button"
							className={cn(
								"flex-auto shrink-100 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-ring",
								// The title gives way first, down to 60% of a Current chats row; then the project name shrinks.
								current ? "min-w-3/5" : "min-w-0",
							)}
							data-row-title
							title={session?.preview ?? undefined}
							aria-current={current && active ? "true" : undefined}
							aria-keyshortcuts={current && props.number ? `${MAC ? "Meta" : "Control"}+${props.number}` : undefined}
							onClick={open}
							onAuxClick={event => {
								// Middle-click closes an open chat.
								if (event.button === 1 && tabId) void closeChat(tabId);
							}}
							onKeyDown={event => {
								if (event.key === "Delete" && tabId) {
									event.preventDefault();
									void closeChat(tabId);
								}
							}}
						>
							{title}
						</button>
						{!current && pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						{current ? (
							props.showNumber && props.number ? (
								<Kbd className="shrink-0 group-hover:hidden group-focus-within:hidden">{`${MOD}${props.number}`}</Kbd>
							) : (
								// Up to 72px of project name; hidden when fewer than about six characters would fit beside the title.
								<span className="max-w-18 min-w-0 truncate font-mono text-xs text-fg-faint group-hover:hidden group-focus-within:hidden @max-[10.875rem]/row:hidden">
									{props.chat.projectName}
								</span>
							)
						) : (
							<span className="shrink-0 font-mono text-xs text-fg-faint group-hover:hidden group-focus-within:hidden">{session ? shortAgo(session.updatedAt, now) : null}</span>
						)}
						<Menu>
							<MenuTrigger asChild>
								<IconButton
									// `!` beats the button's own `inline-flex`; `cn` joins classes without resolving conflicts.
									className="relative hidden! group-hover:inline-flex! group-focus-within:inline-flex! data-[state=open]:inline-flex!"
									label={t("sidebar.chatMenu")}
									icon={<DotsThree />}
									size="sm"
								/>
							</MenuTrigger>
							<MenuContent align="end">{items(MenuItem, MenuSeparator)}</MenuContent>
						</Menu>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>{items(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
			</ContextMenu>
			<TrashChatDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title={title}
				target={session ? { file: session.file, cwd: session.cwd, tabId } : null}
			/>
		</>
	);
}

interface ProjectGroupProps {
	group: SidebarGroup;
	now: number;
	/** Search is on: every matching row shows and empty text stays hidden. */
	filtering: boolean;
}

function ProjectGroup({ group, now, filtering }: ProjectGroupProps): ReactNode {
	const { t } = useTranslation("shell");
	const { project } = group;
	const active = useApp(state => state.activeProject === project.path && state.view === "home");
	const pinned = useApp(state => state.prefs?.pinnedProjects.includes(project.path) ?? false);

	const togglePin = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs) return;
		const list = pinned ? prefs.pinnedProjects.filter(path => path !== project.path) : [project.path, ...prefs.pinnedProjects];
		void useApp.getState().setPrefs({ pinnedProjects: list });
	};

	const items = (Item: typeof MenuItem | typeof ContextMenuItem, Separator: typeof MenuSeparator | typeof ContextMenuSeparator) => (
		<>
			<Item icon={<Plus />} onSelect={() => void useApp.getState().newChat(project.path)}>
				{t("sidebar.newChatHere")}
			</Item>
			<Item icon={<House />} onSelect={() => useApp.getState().openProject(project.path)}>
				{t("sidebar.projectOverview")}
			</Item>
			<Item icon={<Gear />} onSelect={() => openProjectSettings(project.path)}>
				{t("sidebar.projectSettings")}
			</Item>
			<Item icon={<FolderOpen />} onSelect={() => void window.vomp.invoke("app:showItem", project.path)}>
				{t("sidebar.reveal")}
			</Item>
			{!group.removed && (
				<>
					<Item icon={pinned ? <PushPinSlash /> : <PushPin />} onSelect={togglePin}>
						{pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject")}
					</Item>
					<Separator />
					<Item icon={<X />} onSelect={() => void window.vomp.invoke("project:remove", project.path).then(() => useApp.getState().refreshProjects())}>
						{t("sidebar.removeProject")}
					</Item>
				</>
			)}
		</>
	);

	return (
		<motion.div role="group" aria-label={project.name} layout="position" transition={spring.gentle}>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div className={cn("group flex h-9 items-center gap-1 rounded-md pr-1 pl-1 text-md", active ? "bg-selected" : "hover:bg-hover")}>
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
							{project.exists ? <Folder className="size-4 shrink-0 text-fg-muted" /> : <FolderMinus className="size-4 shrink-0 text-warn" />}
							<span className="truncate">{project.name}</span>
						</button>
						{pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						<Menu>
							<MenuTrigger asChild>
								<IconButton
									className="hidden! group-hover:inline-flex! group-focus-within:inline-flex! data-[state=open]:inline-flex!"
									label={t("sidebar.projectMenu")}
									icon={<DotsThree />}
									size="sm"
								/>
							</MenuTrigger>
							<MenuContent align="end">{items(MenuItem, MenuSeparator)}</MenuContent>
						</Menu>
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent>{items(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
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
				{version && <span className="font-mono text-xs text-fg-faint @max-[10rem]:hidden">{t("sidebar.version", { version })}</span>}
			</div>
		</div>
	);
}

/** Every open chat in the order it was opened, above Projects; hidden when no chat is open or search hides them all. */
function CurrentChats({ chats, now }: { chats: CurrentChat[]; now: number }): ReactNode {
	const { t } = useTranslation("shell");
	const tabs = useApp(state => state.tabs);
	const showNumbers = useModifierHeld();
	if (chats.length === 0) return null;
	return (
		<section aria-label={t("sidebar.current")} className="mb-stack flex flex-col gap-px">
			<SectionLabel as="h2" className="flex h-7 items-center px-row">
				{t("sidebar.current")}
			</SectionLabel>
			<AnimatePresence initial={false} mode="popLayout">
				{chats.map(chat => {
					const index = tabs.findIndex(tab => tab.id === chat.tabId);
					return (
						<motion.div key={chat.key} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy}>
							<ChatRow variant="current" chat={chat} now={now} number={index >= 0 && index < 9 ? index + 1 : null} showNumber={showNumbers} />
						</motion.div>
					);
				})}
			</AnimatePresence>
		</section>
	);
}

/**
 * The 40px header, then New chat, Search chats, Current chats and Projects with their chats, then Usage & limits,
 * Settings and Help. An open page puts its Back link at the top through the page nav slot (`usePageNavSlot`); a page
 * with a section nav (Settings, mode "nav") fills the space with its sections in place of the chat lists, which
 * crossfade with it.
 */
export function Sidebar({ width }: { width: number }): ReactNode {
	const { t } = useTranslation("shell");
	const scope = useId();
	const projects = useApp(state => state.projects);
	const sessionsByProject = useApp(state => state.sessionsByProject);
	const tabs = useApp(state => state.tabs);
	const prefs = useApp(state => state.prefs);
	const expandedProjects = useApp(state => state.expandedProjects);
	const expandedChatLists = useApp(state => state.expandedChatLists);
	const search = useApp(state => state.search);
	const setSlot = usePageNavSlot(state => state.setSlot);
	const slotMode = usePageNavSlot(state => state.mode);
	const takeover = slotMode === "nav";
	const fade = useMotionReduced() ? { duration: 0 } : { duration: duration.base, ease: ease.outQuart };
	const [showArchived, setShowArchived] = useState(false);
	const now = useNow();
	const query = search.trim().toLowerCase();
	const filtering = query.length > 0;

	// Current chats look up their saved chat (title, menu) in their project's list, and search looks through every
	// project, so load the chat lists not loaded yet.
	useEffect(() => {
		const state = useApp.getState();
		const paths = [...tabs.map(tab => tab.projectPath), ...(filtering ? state.projects.map(project => project.path) : [])];
		for (const path of new Set(paths)) if (!state.sessionsByProject[path]) void state.loadSessions(path);
	}, [filtering, tabs]);

	const { groups, archived, current } = useMemo(() => {
		const input = sidebarInput({ projects, sessionsByProject, tabs, prefs, expandedProjects, expandedChatLists, search });
		return { groups: sidebarGroups(input), archived: archivedChats(input), current: currentChats(input) };
	}, [projects, sessionsByProject, tabs, prefs, expandedProjects, expandedChatLists, search]);

	return (
		<IndicatorScope.Provider value={scope}>
			<nav id={SIDEBAR_ID} aria-label={t("sidebar.label")} data-tour="sidebar" style={{ width }} className="flex h-full shrink-0 flex-col">
				<SidebarHeader />
				<div className="relative flex min-h-0 flex-1 flex-col">
					{/* Always mounted so a page can portal into it: its Back row ("back"), or Back and its sections ("nav"). */}
					<motion.div
						ref={setSlot}
						data-page-nav
						initial={false}
						animate={{ opacity: slotMode ? 1 : 0 }}
						transition={fade}
						className={cn("flex-col", takeover ? "flex min-h-0 flex-1" : slotMode ? "flex shrink-0" : "hidden")}
					/>
					{/*
					 * Under a takeover the lists lie under the sections and fade out, then leave the accessibility tree; they stay
					 * mounted so Back finds them where they were scrolled. Below a Back row they slide down with it.
					 */}
					<motion.div
						layout="position"
						initial={false}
						animate={takeover ? { opacity: 0, transitionEnd: { visibility: "hidden" } } : { opacity: 1, visibility: "visible" }}
						transition={{ ...fade, layout: fade }}
						inert={takeover}
						className={cn("flex min-h-0 flex-col", takeover ? "pointer-events-none absolute inset-0" : "flex-1")}
					>
						<div className="flex flex-col gap-1 px-3 pb-2">
							<button
								type="button"
								aria-keyshortcuts={MAC ? "Meta+N" : "Control+N"}
								className="flex h-9 items-center gap-2 rounded-md px-row text-md font-semibold text-accent outline-none hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring"
								onClick={() => {
									const { activeProject, newChat } = useApp.getState();
									if (activeProject) void newChat(activeProject);
									else runCommand("chat.startIn");
								}}
							>
								<NotePencil className="size-4" />
								<span className="flex-1 text-left">{t("sidebar.newChat")}</span>
								<span className="font-mono text-xs font-normal text-fg-faint">{`${MOD}N`}</span>
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
							) : groups.length === 0 ? (
								<p className="px-row text-sm text-fg-faint">{t("sidebar.noResults", { q: search.trim() })}</p>
							) : (
								groups.map(group => <ProjectGroup key={group.project.path} group={group} now={now} filtering={filtering} />)
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
