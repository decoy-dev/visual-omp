/**
 * Sidebar rows in stable open order, which also defines numbered shortcuts and chat cycling. Current chats
 * visually groups unseen results first without changing those numbers. Projects lists every chat, open or
 * saved, either under its project or in one sorted list.
 */
import type { ProjectSummary, SessionSummary, SidebarSort } from "@shared/ipc";

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
 * list has not included). Unknown dates follow saved chats in created order and lead them in recent order.
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
	sortBy?: SidebarSort["by"];
	/** Projects whose chats are showing. */
	expanded: readonly string[];
	/** Projects whose whole chat list is showing ("Show N more chats" was used). */
	showAll: readonly string[];
	query: string;
	untitledTitle: string;
	newChatTitle: string;
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

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compareChats(a: SidebarChat, b: SidebarChat, input: SidebarInput): number {
	const savedA = a.kind === "session" ? a.session : null;
	const savedB = b.kind === "session" ? b.session : null;
	const pins = Number(savedB?.pinned ?? false) - Number(savedA?.pinned ?? false);
	if (pins) return pins;
	if (input.sortBy === "name") {
		const title = (chat: SidebarChat) => (chat.tabId ? input.openTitle(chat.tabId) : null)
			?? (chat.kind === "session" ? chat.session.title ?? chat.session.preview ?? input.untitledTitle : input.newChatTitle);
		return names.compare(title(a), title(b));
	}
	if (input.sortBy === "created") {
		const createdA = savedA?.createdAt ?? Infinity;
		const createdB = savedB?.createdAt ?? Infinity;
		return createdA === createdB ? 0 : createdA < createdB ? -1 : 1;
	}
	const recentA = savedA?.updatedAt ?? Infinity;
	const recentB = savedB?.updatedAt ?? Infinity;
	return recentA === recentB ? 0 : recentA > recentB ? -1 : 1;
}

/** Complete project lists in source order, before sorting, searching or collapsing. */
function projectChats(input: SidebarInput): SidebarGroup[] {
	const tabByFile = new Map(input.tabs.flatMap(tab => (tab.sessionFile ? [[tab.sessionFile, tab.id] as const] : [])));
	const listedPaths = new Set(input.projects.map(project => project.path));
	const removed = [...new Set(input.tabs.map(tab => tab.projectPath))]
		.filter(path => !listedPaths.has(path))
		.map((path): ProjectSummary => ({ path, name: folderName(path), sessionCount: 0, lastActivity: 0, exists: true }));
	return [...input.projects, ...removed].map(project => {
		const isRemoved = !listedPaths.has(project.path);
		const listed = input.sessionsByProject[project.path] ?? [];
		const files = new Set(listed.flatMap(session => [session.file, ...(session.previousSessionFiles ?? [])]));
		const unlisted: SidebarChat[] = input.tabs
			.filter(tab => tab.projectPath === project.path && !(tab.sessionFile && files.has(tab.sessionFile)))
			.map(tab => ({ kind: "open", key: `open:${tab.id}`, tabId: tab.id }));
		const saved: SidebarChat[] = listed
			.filter(session => !session.archived)
			.map(session => ({
				kind: "session", key: session.file, session,
				tabId: [session.file, ...(session.previousSessionFiles ?? [])].map(file => tabByFile.get(file)).find(Boolean) ?? null,
			}));
		const chats = [...unlisted, ...saved].filter(chat => !isRemoved || chat.tabId !== null);
		return { project, chats, total: chats.length, more: 0, open: isRemoved || input.expanded.includes(project.path), removed: isRemoved };
	});
}

function matchesChat(chat: SidebarChat, query: string, input: SidebarInput): boolean {
	return (chat.kind === "session" && matchesSession(chat.session, query))
		|| (chat.tabId !== null && (input.openTitle(chat.tabId)?.toLowerCase().includes(query) ?? false));
}

/**
 * Pins lead each sorted set; equal keys retain source order. Created projects use their earliest loaded saved
 * chat, including archived chats. Projects without a known creation date follow dated projects.
 */
export function sidebarGroups(input: SidebarInput): SidebarGroup[] {
	const query = input.query.trim().toLowerCase();
	const pins = new Set(input.pinnedProjects);
	const displayed = projectChats(input);
	const created = new Map(displayed.map(({ project }) => [
		project.path,
		(input.sessionsByProject[project.path] ?? []).reduce((earliest, session) => Math.min(earliest, session.createdAt), Infinity),
	]));
	const groups = displayed.sort((a, b) => {
		const pinned = Number(pins.has(b.project.path)) - Number(pins.has(a.project.path));
		if (pinned) return pinned;
		if (input.sortBy === "name") return names.compare(a.project.name, b.project.name);
		if (input.sortBy === "created") {
			const dateA = created.get(a.project.path) ?? Infinity;
			const dateB = created.get(b.project.path) ?? Infinity;
			return dateA === dateB ? 0 : dateA < dateB ? -1 : 1;
		}
		return b.project.lastActivity - a.project.lastActivity;
	});
	return groups.flatMap(group => {
		let chats = group.chats.sort((a, b) => compareChats(a, b, input));
		const nameMatch = query.length > 0 && group.project.name.toLowerCase().includes(query);
		if (query && !nameMatch) chats = chats.filter(chat => matchesChat(chat, query, input));
		if (query && chats.length === 0 && !nameMatch) return [];
		const all = Boolean(query) || group.removed || input.showAll.includes(group.project.path);
		const shown = all ? chats : chats.slice(0, COLLAPSED_LIMIT);
		return [{ ...group, chats: shown, more: chats.length - shown.length, open: Boolean(query) || group.open }];
	});
}

/** A flat Projects row keeps the same actions and status, with its project shown as trailing metadata. */
export type ProjectChat = SidebarChat & { projectPath: string; projectName: string };

/** All available chats across projects, independent of disclosure and per-project row limits. */
export function flatChats(input: SidebarInput): ProjectChat[] {
	const query = input.query.trim().toLowerCase();
	return projectChats(input)
		.flatMap(group => group.chats
			.filter(chat => !query || group.project.name.toLowerCase().includes(query) || matchesChat(chat, query, input))
			.map(chat => ({ ...chat, projectPath: group.project.path, projectName: group.project.name })))
		.sort((a, b) => compareChats(a, b, input));
}

/** Archived chats across every loaded project, newest first, under the same search. */
export function archivedChats(input: SidebarInput): SidebarChat[] {
	const query = input.query.trim().toLowerCase();
	const tabByFile = new Map(input.tabs.flatMap(tab => (tab.sessionFile ? [[tab.sessionFile, tab.id] as const] : [])));
	return Object.values(input.sessionsByProject)
		.flat()
		.filter(session => session.archived && (!query || matchesSession(session, query)))
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.map((session): SidebarChat => ({
			kind: "session", key: session.file, session,
			tabId: [session.file, ...(session.previousSessionFiles ?? [])].map(file => tabByFile.get(file)).find(Boolean) ?? null,
		}));
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
		const session = tab.sessionFile ? input.sessionsByProject[tab.projectPath]?.find(entry => entry.file === tab.sessionFile || entry.previousSessionFiles?.includes(tab.sessionFile!)) : undefined;
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
