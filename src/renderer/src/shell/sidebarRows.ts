/**
 * What the sidebar lists, as plain data, so the sidebar and the keyboard shortcuts agree on order. "Current chats"
 * lists every open chat in the order it was opened (status changes never reorder it); ⌘1-⌘9 open its first nine
 * rows and ⌘⇧[ / ⌘⇧] step through it. "Projects" lists every chat, open or saved, under its project.
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
	/** Chats in the project before search. */
	total: number;
	/** Expanded, or forced open by search or `removed`. */
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
 * nothing to show while searching are left out.
 */
export function sidebarGroups(input: SidebarInput): SidebarGroup[] {
	const query = input.query.trim().toLowerCase();
	const filtering = query.length > 0;
	const pins = new Set(input.pinnedSessions);
	const tabByFile = new Map(input.tabs.flatMap(tab => (tab.sessionFile ? [[tab.sessionFile, tab.id] as const] : [])));
	const listedPaths = new Set(input.projects.map(project => project.path));
	const removed = [...new Set(input.tabs.map(tab => tab.projectPath))]
		.filter(path => !listedPaths.has(path))
		.map((path): ProjectSummary => ({ path, name: folderName(path), sessionCount: 0, lastActivity: 0, exists: true }));
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
		if (query) {
			chats = chats.filter(chat =>
				chat.kind === "session" ? matchesSession(chat.session, query) : (input.openTitle(chat.tabId)?.toLowerCase().includes(query) ?? false),
			);
		}
		const nameMatch = query.length > 0 && project.name.toLowerCase().includes(query);
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

/** Archived chats across every loaded project, newest first, under the same search. */
export function archivedChats(input: SidebarInput): SidebarChat[] {
	const query = input.query.trim().toLowerCase();
	const tabByFile = new Map(input.tabs.flatMap(tab => (tab.sessionFile ? [[tab.sessionFile, tab.id] as const] : [])));
	return Object.values(input.sessionsByProject)
		.flat()
		.filter(session => session.archived && (!query || matchesSession(session, query)))
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((session): SidebarChat => ({ kind: "session", key: session.file, session, tabId: tabByFile.get(session.file) ?? null }));
}

/** A "Current chats" row: an open chat with the name of its project, which the row shows as trailing meta. */
export type CurrentChat = SidebarChat & { tabId: string; projectName: string };

function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/**
 * Every open chat in the order it was opened, matching the sidebar search when there is one. ⌘`n` opens the `n`th
 * open chat whether or not search hides its row.
 */
export function currentChats(input: Pick<SidebarInput, "projects" | "sessionsByProject" | "tabs" | "query" | "openTitle">): CurrentChat[] {
	const query = input.query.trim().toLowerCase();
	const names = new Map(input.projects.map(project => [project.path, project.name]));
	return input.tabs.flatMap((tab): CurrentChat[] => {
		const projectName = names.get(tab.projectPath) ?? folderName(tab.projectPath);
		const session = tab.sessionFile ? input.sessionsByProject[tab.projectPath]?.find(entry => entry.file === tab.sessionFile) : undefined;
		const row: CurrentChat = session
			? { kind: "session", key: `current:${tab.id}`, session, tabId: tab.id, projectName }
			: { kind: "open", key: `current:${tab.id}`, tabId: tab.id, projectName };
		if (!query) return [row];
		const live = input.openTitle(tab.id)?.toLowerCase().includes(query) ?? false;
		return live || (session && matchesSession(session, query)) || projectName.toLowerCase().includes(query) ? [row] : [];
	});
}

/** The chat `delta` steps from `current` along `order`, wrapping around; the first chat when `current` is not in it. */
export function stepChat(order: readonly string[], current: string | null, delta: number): string | null {
	if (order.length === 0) return null;
	const index = current === null ? -1 : order.indexOf(current);
	if (index === -1) return order[0] ?? null;
	return order[(((index + delta) % order.length) + order.length) % order.length] ?? null;
}

/**
 * The next chat after `current` along `order` (wrapping around) that is waiting for an answer, or null when no other
 * chat is. Starts from the top when `current` is not an open chat.
 */
export function nextWaitingChat(order: readonly string[], current: string | null, waiting: (tabId: string) => boolean): string | null {
	const start = current === null ? -1 : order.indexOf(current);
	for (let step = 1; step <= order.length; step++) {
		const id = order[(start + step) % order.length];
		if (id !== undefined && id !== current && waiting(id)) return id;
	}
	return null;
}
