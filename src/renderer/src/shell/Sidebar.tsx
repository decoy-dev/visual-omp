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
import { createContext, type MouseEvent, type ReactNode, useCallback, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getCommand } from "../registry/commands";
import { type AppState, closeChat, controllerFor, useApp } from "../state/app";
import { openHelp, openProjectSettings, openSettings, openUsage } from "../state/navigation";
import {
	Button,
	cn,
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
	Dialog,
	DialogContent,
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
	toast,
	Tooltip,
} from "../ui";
import { ChatStatusMark } from "./ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useModifierHeld, useNow, useSessionView } from "./hooks";
import { archivedChats, openChatOrder, type SidebarChat, type SidebarGroup, type SidebarInput, sidebarGroups, visibleChats } from "./sidebarRows";

const MAC = window.vomp.platform === "darwin";
/** Display prefix for ⌘/Ctrl shortcuts. */
const MOD = MAC ? "⌘" : "Ctrl+";
type SidebarState = Pick<AppState, "projects" | "sessionsByProject" | "tabs" | "prefs" | "expandedProjects" | "expandedChatLists" | "search">;

/** An open chat counts for the Active filter while it works, waits for an answer, or has omp running. */
export function isActiveChat(tabId: string): boolean {
	return chatStatus(controllerFor(tabId)?.getSnapshot() ?? null) !== "idle";
}

function sidebarInput(state: SidebarState, active: SidebarInput["active"]): SidebarInput {
	return {
		projects: state.projects,
		sessionsByProject: state.sessionsByProject,
		tabs: state.tabs,
		pinnedProjects: state.prefs?.pinnedProjects ?? [],
		pinnedSessions: state.prefs?.pinnedSessions ?? [],
		expanded: state.expandedProjects,
		showAll: state.expandedChatLists,
		query: state.search,
		active,
		openTitle: tabId => chatTitle(controllerFor(tabId)?.getSnapshot() ?? null, null),
	};
}

/** The row ⌘`n` (Ctrl+`n`) opens: the nth chat the sidebar shows under Projects, counting from 1. */
export function sidebarChatAt(n: number): SidebarChat | null {
	const state = useApp.getState();
	return visibleChats(sidebarGroups(sidebarInput(state, state.sidebarFilter === "active" ? isActiveChat : null)))[n - 1] ?? null;
}

/** Open chats in the order the sidebar lists them; ⌘⇧[ and ⌘⇧] step through these. */
export function openChatsInSidebarOrder(): string[] {
	return openChatOrder(sidebarInput(useApp.getState(), null));
}

/** Show a sidebar row's chat: the open chat, or the saved chat opened fresh. `split` puts it beside the chat on the left. */
export function openSidebarChat(chat: SidebarChat, split = false): void {
	const app = useApp.getState();
	if (chat.tabId) app.activateTab(chat.tabId, { split });
	else if (chat.kind === "session") app.openSession(chat.session, { split });
}

/** Ids of open chats that pass the Active filter; re-renders only when that set changes, never on every streamed token. */
function useActiveChatIds(): ReadonlySet<string> {
	const tabs = useApp(state => state.tabs);
	const subscribe = useCallback(
		(notify: () => void) => {
			const offs = tabs.map(tab => controllerFor(tab.id)?.subscribe(notify));
			return () => {
				for (const off of offs) off?.();
			};
		},
		[tabs],
	);
	const key = useSyncExternalStore(subscribe, () =>
		tabs
			.filter(tab => isActiveChat(tab.id))
			.map(tab => tab.id)
			.join("\n"),
	);
	return useMemo(() => new Set(key ? key.split("\n") : []), [key]);
}

/** Per-sidebar prefix for the active-row indicator's layoutId, so the highlight slides between rows. */
const IndicatorScope = createContext("sidebar");

function runCommand(id: string): void {
	const command = getCommand(id);
	const state = useApp.getState();
	void command?.run({ session: null, projectPath: state.activeProject });
}

/** Chat rows slide into their new place on reorder; new rows fade and rise, removed rows fade out. */
function RowList({ chats, now, numbers, showNumbers }: { chats: SidebarChat[]; now: number; numbers: ReadonlyMap<string, number>; showNumbers: boolean }): ReactNode {
	return (
		<AnimatePresence initial={false} mode="popLayout">
			{chats.map(chat => (
				<motion.div key={chat.key} layout="position" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring.snappy}>
					<ChatRow chat={chat} now={now} number={numbers.get(chat.key) ?? null} showNumber={showNumbers} />
				</motion.div>
			))}
		</AnimatePresence>
	);
}

interface ChatRowProps {
	chat: SidebarChat;
	now: number;
	/** ⌘1-⌘9 position, when the row has one. */
	number: number | null;
	/** ⌘/Ctrl is held: show the number in place of the time. */
	showNumber: boolean;
}

function ChatRow({ chat, now, number, showNumber }: ChatRowProps): ReactNode {
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
	const remove = async () => {
		setConfirmDelete(false);
		if (!session) return;
		if (tabId) await useApp.getState().closeTab(tabId);
		try {
			await window.vomp.invoke("sessions:trash", session.file);
			await useApp.getState().loadSessions(session.cwd);
		} catch (error) {
			toast({ tone: "err", message: error instanceof Error ? error.message : String(error) });
		}
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
					<div className={cn("group relative isolate flex h-8 items-center gap-2 rounded-md pr-1 pl-7 text-md", active ? "font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}>
						{active && (
							<motion.span
								aria-hidden
								layoutId={`${scope}-${primary ? "active" : "split"}`}
								transition={spring.snappy}
								className="absolute inset-0 -z-10 rounded-md bg-selected"
							/>
						)}
						<ChatStatusMark status={status} label={t(`sidebar.status.${status}`)} />
						<button
							type="button"
							className="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:outline-2 focus-visible:after:outline-ring"
							title={session?.preview ?? undefined}
							aria-current={active ? "true" : undefined}
							aria-keyshortcuts={number ? `${MAC ? "Meta" : "Control"}+${number}` : undefined}
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
						{pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						<span className="shrink-0 font-mono text-xs text-fg-faint group-hover:hidden group-focus-within:hidden">
							{showNumber && number ? <Kbd>{`${MOD}${number}`}</Kbd> : session ? shortAgo(session.updatedAt, now) : null}
						</span>
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
			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent
					size="sm"
					destructive
					title={t("deleteChat.title", { title })}
					description={t("deleteChat.body", { title })}
					footer={
						<>
							<Button variant="secondary" onClick={() => setConfirmDelete(false)}>
								{t("deleteChat.cancel")}
							</Button>
							<Button variant="danger" onClick={() => void remove()}>
								{t("deleteChat.confirm")}
							</Button>
						</>
					}
				/>
			</Dialog>
		</>
	);
}

interface ProjectGroupProps {
	group: SidebarGroup;
	now: number;
	numbers: ReadonlyMap<string, number>;
	showNumbers: boolean;
	/** Search or the Active filter is on: every matching row shows and empty text stays hidden. */
	filtering: boolean;
}

function ProjectGroup({ group, now, numbers, showNumbers, filtering }: ProjectGroupProps): ReactNode {
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
				<RowList chats={group.chats} now={now} numbers={numbers} showNumbers={showNumbers} />
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
							"flex h-9 items-center gap-2 rounded-md px-2 text-md font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring",
							current ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
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

/** New chat, Search chats, Projects with their chats, then Usage & limits, Settings and Help. */
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
	const activeOnly = useApp(state => state.sidebarFilter === "active");
	const activeIds = useActiveChatIds();
	const [showArchived, setShowArchived] = useState(false);
	const showNumbers = useModifierHeld();
	const now = useNow();
	const query = search.trim().toLowerCase();
	const filtering = query.length > 0 || activeOnly;

	// Search looks through every project and the Active filter through every project with an open chat,
	// so load the chat lists not loaded yet.
	useEffect(() => {
		if (!filtering) return;
		const state = useApp.getState();
		const paths = query ? state.projects.map(project => project.path) : state.tabs.map(tab => tab.projectPath);
		for (const path of new Set(paths)) if (!state.sessionsByProject[path]) void state.loadSessions(path);
	}, [filtering, query, tabs]);

	const { groups, archived } = useMemo(() => {
		const input = sidebarInput(
			{ projects, sessionsByProject, tabs, prefs, expandedProjects, expandedChatLists, search },
			activeOnly ? tabId => activeIds.has(tabId) : null,
		);
		return { groups: sidebarGroups(input), archived: archivedChats(input) };
	}, [projects, sessionsByProject, tabs, prefs, expandedProjects, expandedChatLists, search, activeOnly, activeIds]);
	const numbers = useMemo(() => new Map(visibleChats(groups).slice(0, 9).map((chat, index) => [chat.key, index + 1])), [groups]);

	return (
		<IndicatorScope.Provider value={scope}>
			<nav aria-label={t("sidebar.label")} data-tour="sidebar" style={{ width }} className="flex shrink-0 flex-col border-r border-border bg-panel">
				<div className="flex flex-col gap-1 px-3 pt-3 pb-2">
					<button
						type="button"
						aria-keyshortcuts={MAC ? "Meta+N" : "Control+N"}
						className="flex h-9 items-center gap-2 rounded-md px-2 text-md font-semibold text-accent outline-none hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring"
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
					/>
				</div>
				<div className="mx-3 h-px bg-border" />
				<div className="flex items-center gap-1 pt-3 pr-3 pl-4">
					<SectionLabel as="h2" className="flex-1">
						{t("sidebar.projects")}
					</SectionLabel>
					<Tooltip content={t("sidebar.activeHint")}>
						<button
							type="button"
							aria-pressed={activeOnly}
							className={cn(
								"flex h-6 items-center gap-1 rounded-full px-2 text-xs font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring",
								activeOnly ? "bg-accent-muted text-accent" : "text-fg-muted hover:bg-hover hover:text-fg",
							)}
							onClick={() => useApp.getState().setSidebarFilter(activeOnly ? "all" : "active")}
						>
							{t("sidebar.active")}
							{activeIds.size > 0 && <span className="font-mono">{activeIds.size}</span>}
						</button>
					</Tooltip>
					<AddProjectMenu />
				</div>
				<ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 py-2">
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
						<p className="px-2 text-sm text-fg-faint">{query ? t("sidebar.noResults", { q: search.trim() }) : t("sidebar.noActive")}</p>
					) : (
						groups.map(group => (
							<ProjectGroup key={group.project.path} group={group} now={now} numbers={numbers} showNumbers={showNumbers} filtering={filtering} />
						))
					)}
					{archived.length > 0 && (
						<div className="mt-2">
							<button
								type="button"
								aria-expanded={showArchived}
								className="flex h-8 w-full items-center gap-1 rounded-md px-2 text-sm text-fg-muted outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-ring"
								onClick={() => setShowArchived(open => !open)}
							>
								<CaretRight className={cn("size-3.5 transition-transform duration-(--dur) ease-(--ease-out-quart)", showArchived && "rotate-90")} />
								{t("sidebar.archived")} · {archived.length}
							</button>
							<Expand open={showArchived} className="relative flex flex-col gap-px">
								<RowList chats={archived} now={now} numbers={numbers} showNumbers={false} />
							</Expand>
						</div>
					)}
				</ScrollArea>
				<BottomNav />
			</nav>
		</IndicatorScope.Provider>
	);
}
