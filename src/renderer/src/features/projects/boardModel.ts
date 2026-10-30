import type { SessionSummary } from "@shared/ipc";
import { chatStatus, type ChatStatus } from "../../shell/hooks";
import type { ChatTab } from "../../state/app";
import type { SessionView } from "../../state/session";
import type { UnseenChats } from "../onboarding/attention";

export const RECENT_LIMIT = 5;
export const BOARD_GROUPS = ["waiting", "working", "unseen", "recent"] as const;
export type BoardGroup = typeof BOARD_GROUPS[number];
export interface BoardRow {
	key: string;
	tab: ChatTab | null;
	session: SessionSummary | null;
	view: SessionView | null;
	status: ChatStatus;
	unseen: UnseenChats[string] | undefined;
}
export type ProjectBoardGroups = Record<BoardGroup, BoardRow[]>;

/** Attention takes precedence over unopened results. No completion or verification state is inferred. */
export function boardGroup(status: ChatStatus, unseen: BoardRow["unseen"]): BoardGroup {
	if (status === "needsInput" || status === "error") return "waiting";
	if (status === "working" || status === "helpersWorking") return "working";
	return unseen ? "unseen" : "recent";
}

/** Union of this project's open and saved chats, ordered by immutable start time within each group. */
export function projectBoard(
	path: string,
	tabs: readonly ChatTab[],
	sessions: readonly SessionSummary[] | undefined,
	unseenChats: UnseenChats,
	views: ReadonlyMap<string, SessionView | null>,
): ProjectBoardGroups {
	const open = tabs.filter(tab => tab.projectPath === path);
	const matched = new Set<string>();
	const rows: BoardRow[] = [];
	const add = (tab: ChatTab | null, session: SessionSummary | null) => {
		const view = tab ? views.get(tab.id) ?? null : null;
		rows.push({ key: session?.file ?? tab!.id, tab, session, view, status: chatStatus(view), unseen: tab ? unseenChats[tab.id] : undefined });
	};
	for (const session of sessions ?? []) {
		if (session.archived) continue;
		const tab = open.find(tab => tab.sessionFile === session.file || session.previousSessionFiles?.includes(tab.sessionFile ?? "")) ?? null;
		if (tab) matched.add(tab.id);
		add(tab, session);
	}
	for (const tab of open) if (!matched.has(tab.id)) add(tab, null);
	const openOrder = new Map(open.map((tab, index) => [tab.id, index]));
	rows.sort((left, right) => {
		if (!left.session && !right.session) return openOrder.get(left.tab!.id)! - openOrder.get(right.tab!.id)!;
		if (!left.session) return -1;
		if (!right.session) return 1;
		return right.session.createdAt - left.session.createdAt || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
	});
	const groups: ProjectBoardGroups = { waiting: [], working: [], unseen: [], recent: [] };
	for (const row of rows) groups[boardGroup(row.status, row.unseen)].push(row);
	return groups;
}

/** The Recent disclosure never limits attention groups. */
export function recentFold(rows: readonly BoardRow[], all: boolean): { first: readonly BoardRow[]; rest: readonly BoardRow[]; hidden: number } {
	return { first: rows.slice(0, RECENT_LIMIT), rest: all ? rows.slice(RECENT_LIMIT) : [], hidden: Math.max(0, rows.length - RECENT_LIMIT) };
}

/** First observations stay silent, including saved history arriving after the board mounts. */
export class WaitingTracker {
	#waiting = new Map<string, boolean>();
	update(groups: ProjectBoardGroups): BoardRow[] {
		const next = new Map<string, boolean>();
		const entered: BoardRow[] = [];
		for (const group of BOARD_GROUPS) for (const row of groups[group]) {
			const id = row.tab?.id ?? row.key;
			const waiting = group === "waiting";
			if (waiting && this.#waiting.get(id) === false) entered.push(row);
			next.set(id, waiting);
		}
		this.#waiting = next;
		return entered;
	}
}
