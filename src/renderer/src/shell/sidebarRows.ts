/**
 * What the sidebar lists, as plain data, so the sidebar and the keyboard shortcuts agree on order:
 * ⌘1-⌘9 open the first nine chat rows the sidebar shows (top to bottom), and ⌘⇧[ / ⌘⇧] step through
 * open chats in sidebar order.
 */
import type { ProjectSummary, SessionSummary } from "@shared/ipc";

/** Chats a collapsed list shows before "Show N more chats". */
export const COLLAPSED_LIMIT = 8;

/** An open chat (`useApp().tabs`). */
export interface OpenChatRef {
	id: string;
	projectPath: string;
	sessionFile: string | null;
}

/**
 * One chat row. `session`: a saved chat, with the open chat showing it when there is one. `open`: an open
 * chat the project's saved list does not include yet (a new chat before omp writes its file, or a file the
 * list has not picked up); these sit at the top of their project.
 */
export type SidebarChat =
	| { kind: "session"; key: string; session: SessionSummary; tabId: string | null }
	| { kind: "open"; key: string; tabId: string };

export interface SidebarGroup {
	project: ProjectSummary;
	/** Rows to show while the group is open. */
	chats: SidebarChat[];
	/** Rows behind "Show N more chats". */
	more: number;
	/** Chats in the project before search or the Active filter. */
	total: number;
	/** Expanded, or forced open by search, the Active filter or `removed`. */
	open: boolean;
	/**
	 * The project is no longer in the saved list (it was removed) but still has open chats. The group lists only
	 * those chats, always open, so they stay reachable and closable; it goes away with its last open chat.
	 */
	removed: boolean;
}

export interface SidebarInput {
	projects: readonly ProjectSummary[];
	sessionsByProject: Readonly<Record<string, readonly SessionSummary[]>>;
	tabs: readonly OpenChatRef[];
	pinnedProjects: readonly string[];
	pinnedSessions: readonly string[];
	/** Projects whose chats are showing. */
	expanded: readonly string[];
	/** Projects whose whole chat list is showing ("Show N more chats" was used). */
	showAll: readonly string[];
	query: string;
	/** The Active filter: keeps only open chats this accepts. Null shows every chat. */
	active: ((tabId: string) => boolean) | null;
	/** Live title of an open chat, for search; null while it has none. */
	openTitle(tabId: string): string | null;
}

export function sortProjects(projects: readonly ProjectSummary[], pins: readonly string[]): ProjectSummary[] {
	return [...projects].sort((a, b) => {
		const pa = pins.indexOf(a.path);
		const pb = pins.indexOf(b.path);
		if (pa !== pb) return (pa === -1 ? Infinity : pa) - (pb === -1 ? Infinity : pb);
		return b.lastActivity - a.lastActivity;
	});
}

export function matchesSession(session: SessionSummary, query: string): boolean {
	return `${session.title ?? ""} ${session.preview ?? ""}`.toLowerCase().includes(query);
}

/**
 * Project groups in sidebar order, then a group for each removed project that still has open chats. Groups with
 * nothing to show while searching or filtering are left out.
 */
export function sidebarGroups(input: SidebarInput): SidebarGroup[] {
	const query = input.query.trim().toLowerCase();
	const filtering = query.length > 0 || input.active !== null;
	const pins = new Set(input.pinnedSessions);
	const tabByFile = new Map(input.tabs.flatMap(tab => (tab.sessionFile ? [[tab.sessionFile, tab.id] as const] : [])));
	const listedPaths = new Set(input.projects.map(project => project.path));
	const removed = [...new Set(input.tabs.map(tab => tab.projectPath))]
		.filter(path => !listedPaths.has(path))
		.map((path): ProjectSummary => ({ path, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, sessionCount: 0, lastActivity: 0, exists: true }));
	const groups: SidebarGroup[] = [];
	for (const project of [...sortProjects(input.projects, input.pinnedProjects), ...removed]) {
		const isRemoved = !listedPaths.has(project.path);
		const listed = input.sessionsByProject[project.path] ?? [];
		const files = new Set(listed.map(session => session.file));
		const unlisted: SidebarChat[] = input.tabs
			.filter(tab => tab.projectPath === project.path && !(tab.sessionFile && files.has(tab.sessionFile)))
			.map(tab => ({ kind: "open", key: `open:${tab.id}`, tabId: tab.id }));
		const saved: SidebarChat[] = listed
			.filter(session => !session.archived)
			.sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id)) || b.updatedAt - a.updatedAt)
			.map(session => ({ kind: "session", key: session.file, session, tabId: tabByFile.get(session.file) ?? null }));
		let chats = [...unlisted, ...saved];
		if (isRemoved) chats = chats.filter(chat => chat.tabId !== null);
		const total = chats.length;
		const active = input.active;
		if (active) chats = chats.filter(chat => chat.tabId !== null && active(chat.tabId));
		if (query) {
			chats = chats.filter(chat =>
				chat.kind === "session" ? matchesSession(chat.session, query) : (input.openTitle(chat.tabId)?.toLowerCase().includes(query) ?? false),
			);
		}
		const nameMatch = query.length > 0 && !active && project.name.toLowerCase().includes(query);
		if (filtering && chats.length === 0 && !nameMatch) continue;
		const all = filtering || isRemoved || input.showAll.includes(project.path);
		const shown = all ? chats : chats.slice(0, COLLAPSED_LIMIT);
		groups.push({
			project,
			chats: shown,
			more: chats.length - shown.length,
			total,
			open: filtering || isRemoved || input.expanded.includes(project.path),
			removed: isRemoved,
		});
	}
	return groups;
}

/** Archived chats across every loaded project, newest first, under the same search and filter. */
export function archivedChats(input: SidebarInput): SidebarChat[] {
	const query = input.query.trim().toLowerCase();
	const tabByFile = new Map(input.tabs.flatMap(tab => (tab.sessionFile ? [[tab.sessionFile, tab.id] as const] : [])));
	const active = input.active;
	return Object.values(input.sessionsByProject)
		.flat()
		.filter(session => session.archived && (!query || matchesSession(session, query)))
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((session): SidebarChat => ({ kind: "session", key: session.file, session, tabId: tabByFile.get(session.file) ?? null }))
		.filter(chat => !active || (chat.tabId !== null && active(chat.tabId)));
}

/** Chat rows the sidebar shows under Projects, top to bottom (rows in collapsed projects are not shown). */
export function visibleChats(groups: readonly SidebarGroup[]): SidebarChat[] {
	return groups.flatMap(group => (group.open ? group.chats : []));
}

/** Open chats in sidebar order: by project (removed projects last), then by row; archived chats after, in open order. */
export function openChatOrder(input: SidebarInput): string[] {
	const everything = [...input.projects.map(project => project.path), ...input.tabs.map(tab => tab.projectPath)];
	const groups = sidebarGroups({ ...input, query: "", active: null, expanded: everything, showAll: everything });
	const order = [...groups.flatMap(group => group.chats), ...archivedChats({ ...input, query: "", active: null })].flatMap(chat =>
		chat.tabId ? [chat.tabId] : [],
	);
	const seen = new Set(order);
	for (const tab of input.tabs) if (!seen.has(tab.id)) order.push(tab.id);
	return order;
}
