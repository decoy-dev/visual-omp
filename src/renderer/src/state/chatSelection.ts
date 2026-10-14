export interface RestoredChatSelection<T extends { id: string; projectPath: string }> {
	tabs: T[];
	activeTabId: string | null;
	splitTabId: string | null;
	focusedSplit: "primary" | "secondary";
	activeProject: string | null;
	view: "home" | "chat" | "page";
	pageReturn: "home" | "chat";
}

/** Keep persisted chat selection consistent with the tabs that can actually be restored. */
export function normalizeRestoredChatSelection<T extends { id: string; projectPath: string }>(state: RestoredChatSelection<T>): RestoredChatSelection<T> {
	const ids = new Set(state.tabs.map(tab => tab.id));
	let activeTabId = state.activeTabId && ids.has(state.activeTabId) ? state.activeTabId : null;
	let splitTabId = state.splitTabId && ids.has(state.splitTabId) ? state.splitTabId : null;
	if (splitTabId === activeTabId) splitTabId = null;
	if (!activeTabId && splitTabId) {
		activeTabId = splitTabId;
		splitTabId = null;
	}
	activeTabId ??= state.tabs.at(-1)?.id ?? null;

	const focusedSplit = splitTabId ? state.focusedSplit : "primary";
	const view = state.view === "page"
		? state.pageReturn === "chat" && activeTabId ? "chat" : "home"
		: state.view === "chat" && !activeTabId ? "home" : state.view;
	// A project overview keeps its own project; a chat view follows the chat that has focus.
	const focusedId = focusedSplit === "secondary" ? splitTabId : activeTabId;
	const activeProject = view === "chat" ? (state.tabs.find(tab => tab.id === focusedId)?.projectPath ?? state.activeProject) : state.activeProject;

	return { ...state, activeTabId, splitTabId, focusedSplit, activeProject, view };
}

/**
 * Releasing `tabId` renumbers no chat that was already open: every chat after it in `tabs` arrived in the same
 * change (`before` is the list before it). Browsing from one saved chat to the next releases the one left behind,
 * while a preview with older chats after it stays, so ⌘1-⌘9 never shift under the user.
 */
export function releaseKeepsNumbers<T extends { id: string }>(tabId: string, tabs: readonly T[], before: readonly T[]): boolean {
	const index = tabs.findIndex(tab => tab.id === tabId);
	if (index < 0) return false;
	const existed = new Set(before.map(tab => tab.id));
	return tabs.slice(index + 1).every(tab => !existed.has(tab.id));
}
