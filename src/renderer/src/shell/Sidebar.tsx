import type { ProjectSummary, SessionSummary } from "@shared/ipc";
import { Archive, BoxArrowUp, CaretRight, ChatCenteredDots, Columns, DotsThree, Folder, FolderMinus, FolderOpen, Gear, House, Plus, PushPin, PushPinSlash, Question, Trash, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, type MouseEvent, type ReactNode, useContext, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCommand } from "../registry/commands";
import { controllerFor, useApp } from "../state/app";
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
	IconButton,
	Kbd,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	Expand,
	ScrollArea,
	SearchInput,
	SectionLabel,
	spring,
	toast,
} from "../ui";
import { ChatStatusMark } from "./ChatStatusMark";
import { chatStatus, chatTitle, shortAgo, useNow, useSessionView } from "./hooks";

const COLLAPSED_LIMIT = 8;

/** Per-sidebar prefix for the active-row indicator's layoutId, so the highlight slides between rows. */
const IndicatorScope = createContext("sidebar");

/** Session rows slide into their new place on reorder; new rows fade and rise, removed rows fade out. */
function RowList({ sessions, now }: { sessions: SessionSummary[]; now: number }): ReactNode {
	return (
		<AnimatePresence initial={false} mode="popLayout">
			{sessions.map(session => (
				<motion.div
					key={session.file}
					layout="position"
					initial={{ opacity: 0, y: -4 }}
					animate={{ opacity: 1, y: 0 }}
					exit={{ opacity: 0 }}
					transition={spring.snappy}
				>
					<SessionRow session={session} now={now} />
				</motion.div>
			))}
		</AnimatePresence>
	);
}

function runCommand(id: string): void {
	const command = getCommand(id);
	const state = useApp.getState();
	void command?.run({ session: null, projectPath: state.activeProject });
}

function SessionRow({ session, now }: { session: SessionSummary; now: number }): ReactNode {
	const { t } = useTranslation("shell");
	const tab = useApp(state => state.tabs.find(entry => entry.sessionFile === session.file) ?? null);
	const activeTabId = useApp(state => state.activeTabId);
	const splitTabId = useApp(state => state.splitTabId);
	const view = useApp(state => state.view);
	const pinned = useApp(state => state.prefs?.pinnedSessions.includes(session.id) ?? false);
	const liveView = useSessionView(controllerFor(tab?.id));
	const [confirmDelete, setConfirmDelete] = useState(false);
	const status = chatStatus(liveView);
	const title = chatTitle(liveView, session.title) ?? session.preview ?? t("sidebar.untitled");
	const primary = view === "chat" && tab !== null && tab.id === activeTabId;
	const secondary = view === "chat" && tab !== null && tab.id === splitTabId;
	const active = primary || secondary;
	const scope = useContext(IndicatorScope);

	const open = (event?: MouseEvent) => useApp.getState().openSession(session, { split: event?.metaKey || event?.ctrlKey });
	const togglePin = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs) return;
		const list = pinned ? prefs.pinnedSessions.filter(id => id !== session.id) : [...prefs.pinnedSessions, session.id];
		void useApp.getState().setPrefs({ pinnedSessions: list });
	};
	const toggleArchive = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs) return;
		const list = session.archived ? prefs.archivedSessions.filter(id => id !== session.id) : [...prefs.archivedSessions, session.id];
		void useApp.getState().setPrefs({ archivedSessions: list }).then(() => useApp.getState().loadSessions(session.cwd));
	};
	const remove = async () => {
		setConfirmDelete(false);
		if (tab) await useApp.getState().closeTab(tab.id);
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
			<Item icon={<Columns />} shortcut="⌘click" onSelect={() => useApp.getState().openSession(session, { split: true })}>
				{t("sidebar.openSplit")}
			</Item>
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
	);

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							"group relative isolate flex h-8 items-center gap-2 rounded-md pr-1 pl-7 text-md",
							active ? "font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
						)}
					>
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
							title={session.preview ?? undefined}
							onClick={open}
						>
							{title}
						</button>
						{pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						<span className="shrink-0 font-mono text-xs text-fg-faint group-hover:hidden group-focus-within:hidden">
							{shortAgo(session.updatedAt, now)}
						</span>
						<Menu>
							<MenuTrigger asChild>
								<IconButton
									className="relative hidden group-hover:inline-flex group-focus-within:inline-flex data-[state=open]:inline-flex"
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

function ProjectGroup({ project, sessions, now, forceOpen }: { project: ProjectSummary; sessions: SessionSummary[]; now: number; forceOpen: boolean }): ReactNode {
	const { t } = useTranslation("shell");
	const expanded = useApp(state => state.expandedProjects.includes(project.path)) || forceOpen;
	const active = useApp(state => state.activeProject === project.path && state.view === "home");
	const pinned = useApp(state => state.prefs?.pinnedProjects.includes(project.path) ?? false);
	const pinnedSessions = useApp(state => state.prefs?.pinnedSessions);
	const [showAll, setShowAll] = useState(false);
	const ordered = useMemo(() => {
		const pins = new Set(pinnedSessions ?? []);
		return [...sessions].sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updatedAt - a.updatedAt);
	}, [sessions, pinnedSessions]);
	const visible = showAll || forceOpen ? ordered : ordered.slice(0, COLLAPSED_LIMIT);

	const togglePin = () => {
		const prefs = useApp.getState().prefs;
		if (!prefs) return;
		const list = pinned ? prefs.pinnedProjects.filter(path => path !== project.path) : [project.path, ...prefs.pinnedProjects];
		void useApp.getState().setPrefs({ pinnedProjects: list });
	};

	const items = (Item: typeof MenuItem | typeof ContextMenuItem, Separator: typeof MenuSeparator | typeof ContextMenuSeparator) => (
		<>
			<Item icon={<Plus />} onSelect={() => useApp.getState().newChat(project.path)}>
				{t("sidebar.newChatHere")}
			</Item>
			<Item icon={<House />} onSelect={() => useApp.getState().openProject(project.path)}>
				{t("sidebar.projectHome")}
			</Item>
			<Item icon={<FolderOpen />} onSelect={() => void window.vomp.invoke("app:showItem", project.path)}>
				{t("sidebar.reveal")}
			</Item>
			<Item icon={pinned ? <PushPinSlash /> : <PushPin />} onSelect={togglePin}>
				{pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject")}
			</Item>
			{getCommand("project.settings") && (
				<Item icon={<Gear />} onSelect={() => useApp.getState().openSheet("project-settings", { projectPath: project.path })}>
					{t("sidebar.settings")}
				</Item>
			)}
			<Separator />
			<Item icon={<X />} onSelect={() => void window.vomp.invoke("project:remove", project.path).then(() => useApp.getState().refreshProjects())}>
				{t("sidebar.removeProject")}
			</Item>
		</>
	);

	return (
		<motion.div role="group" aria-label={project.name} layout="position" transition={spring.gentle}>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div className={cn("group flex h-9 items-center gap-1 rounded-md pr-1 pl-1 text-md", active ? "bg-selected" : "hover:bg-hover")}>
						<IconButton
							label={expanded ? t("sidebar.collapse", { name: project.name }) : t("sidebar.expand", { name: project.name })}
							icon={<CaretRight className={cn("transition-transform duration-(--dur) ease-(--ease-out-quart)", expanded && "rotate-90")} />}
							size="sm"
							aria-expanded={expanded}
							onClick={() => useApp.getState().toggleProjectExpanded(project.path)}
						/>
						<button
							type="button"
							className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left font-semibold text-fg outline-none focus-visible:outline-2 focus-visible:outline-ring"
							onClick={() => useApp.getState().openProject(project.path)}
							title={project.exists ? project.path : t("sidebar.missingFolder")}
						>
							{project.exists ? <Folder className="size-4 shrink-0 text-fg-muted" /> : <FolderMinus className="size-4 shrink-0 text-warn" />}
							<span className="truncate">{project.name}</span>
						</button>
						{pinned && <PushPin className="size-3 shrink-0 text-fg-faint" aria-hidden />}
						<Menu>
							<MenuTrigger asChild>
								<IconButton
									className="hidden group-hover:inline-flex group-focus-within:inline-flex data-[state=open]:inline-flex"
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
			<Expand open={expanded} className="relative flex flex-col gap-px pb-1">
				<RowList sessions={visible} now={now} />
				{!forceOpen && ordered.length === 0 && <p className="py-1 pr-2 pl-7 text-sm text-fg-faint">{t("sidebar.noChats")}</p>}
				{!showAll && !forceOpen && ordered.length > COLLAPSED_LIMIT && (
					<button
						type="button"
						className="h-7 rounded-md pl-7 text-left text-sm text-fg-muted hover:bg-hover hover:text-fg"
						onClick={() => setShowAll(true)}
					>
						{t("sidebar.moreChats", { count: ordered.length - COLLAPSED_LIMIT })}
					</button>
				)}
			</Expand>
		</motion.div>
	);
}

function matches(session: SessionSummary, query: string): boolean {
	return `${session.title ?? ""} ${session.preview ?? ""}`.toLowerCase().includes(query);
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

/** Projects → chats (DESIGN §3.2). */
export function Sidebar({ width }: { width: number }): ReactNode {
	const { t } = useTranslation("shell");
	const scope = useId();
	const projects = useApp(state => state.projects);
	const sessionsByProject = useApp(state => state.sessionsByProject);
	const search = useApp(state => state.search);
	const pinnedProjects = useApp(state => state.prefs?.pinnedProjects);
	const [showArchived, setShowArchived] = useState(false);
	const now = useNow();
	const query = search.trim().toLowerCase();

	// Searching looks through every project, so load the ones not expanded yet.
	useEffect(() => {
		if (!query) return;
		const state = useApp.getState();
		for (const project of state.projects) if (!state.sessionsByProject[project.path]) void state.loadSessions(project.path);
	}, [query]);

	const ordered = useMemo(() => {
		const pins = pinnedProjects ?? [];
		return [...projects].sort((a, b) => {
			const pa = pins.indexOf(a.path);
			const pb = pins.indexOf(b.path);
			if (pa !== pb) return (pa === -1 ? Infinity : pa) - (pb === -1 ? Infinity : pb);
			return b.lastActivity - a.lastActivity;
		});
	}, [projects, pinnedProjects]);

	const groups = ordered
		.map(project => {
			const sessions = (sessionsByProject[project.path] ?? []).filter(session => !session.archived);
			return { project, sessions: query ? sessions.filter(session => matches(session, query)) : sessions };
		})
		.filter(group => !query || group.sessions.length > 0 || group.project.name.toLowerCase().includes(query));
	const archived = Object.values(sessionsByProject)
		.flat()
		.filter(session => session.archived && (!query || matches(session, query)));

	return (
		<IndicatorScope.Provider value={scope}>
		<nav aria-label={t("sidebar.label")} data-tour="sidebar" style={{ width }} className="flex shrink-0 flex-col border-r border-border bg-panel">
			<div className="flex flex-col gap-1 px-3 pt-3 pb-2">
				<SearchInput
					value={search}
					onValueChange={value => useApp.getState().setSearch(value)}
					placeholder={t("sidebar.search")}
					hint={<Kbd>⌘K</Kbd>}
				/>
				<button
					type="button"
					aria-haspopup="dialog"
					className="flex h-9 items-center gap-2 rounded-md px-2 text-md font-semibold text-accent hover:bg-accent-muted focus-visible:outline-2 focus-visible:outline-ring"
					onClick={() => runCommand("chat.startIn")}
				>
					<Plus className="size-4" />
					{t("sidebar.newChat")}
				</button>
			</div>
			<div className="mx-3 h-px bg-border" />
			<div className="flex items-center justify-between gap-2 pt-3 pr-3 pl-4">
				<SectionLabel as="h2">{t("sidebar.projects")}</SectionLabel>
				<AddProjectMenu />
			</div>
			<ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 py-2">
				{projects.length === 0 ? (
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
					<p className="px-2 text-sm text-fg-faint">{t("sidebar.noResults", { q: search })}</p>
				) : (
					groups.map(group => (
						<ProjectGroup key={group.project.path} project={group.project} sessions={group.sessions} now={now} forceOpen={query.length > 0} />
					))
				)}
				{archived.length > 0 && (
					<div className="mt-2">
						<button
							type="button"
							aria-expanded={showArchived}
							className="flex h-8 w-full items-center gap-1 rounded-md px-2 text-sm text-fg-muted hover:bg-hover"
							onClick={() => setShowArchived(open => !open)}
						>
							<CaretRight className={cn("size-3.5 transition-transform duration-(--dur) ease-(--ease-out-quart)", showArchived && "rotate-90")} />
							{t("sidebar.archived")} · {archived.length}
						</button>
						<Expand open={showArchived} className="relative flex flex-col gap-px">
							<RowList sessions={archived} now={now} />
						</Expand>
					</div>
				)}
			</ScrollArea>
			<div className="flex flex-col gap-px border-t border-border p-2">
				<button
					type="button"
					className="flex h-9 items-center gap-2 rounded-md px-2 text-md font-medium text-fg-muted hover:bg-hover hover:text-fg"
					onClick={() => useApp.getState().goHome()}
				>
					<House className="size-4" />
					{t("sidebar.home")}
				</button>
				<button
					type="button"
					className="flex h-9 items-center gap-2 rounded-md px-2 text-md font-medium text-fg-muted hover:bg-hover hover:text-fg"
					onClick={() => runCommand("app.settings")}
				>
					<Gear className="size-4" />
					{t("sidebar.settings")}
				</button>
				<button
					type="button"
					className="flex h-9 items-center gap-2 rounded-md px-2 text-md font-medium text-fg-muted hover:bg-hover hover:text-fg"
					onClick={() => runCommand("app.help")}
				>
					<Question className="size-4" />
					{t("sidebar.help")}
				</button>
			</div>
		</nav>
		</IndicatorScope.Provider>
	);
}
