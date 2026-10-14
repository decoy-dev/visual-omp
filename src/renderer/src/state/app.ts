/**
 * App-wide UI state: projects and their sessions, open chats (`tabs`, with an optional split), layout,
 * and overlays. Chat behaviour lives in `SessionController`s keyed by open-chat id (see `controllers`).
 * Open chats keep running while another one shows; the sidebar lists them and switches between them.
 * Layout and open chats persist to localStorage so the window comes back the way it was left.
 */
import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppPreferences, OmpStatus, ProjectSummary, SessionSummary } from "@shared/ipc";
import { useComposerDrafts } from "../chat/composer/drafts";
import { confirmTabClose } from "../registry/guards";
import { chatTitle } from "../shell/hooks";
import { type ClosedChat, pushClosed, takeReopenable } from "./closedChats";
import { normalizeRestoredChatSelection, releaseKeepsNumbers } from "./chatSelection";
import { whenLeaving } from "./leaveGuard";
import { SessionController } from "./session";

/** Id of the main area; focus lands here when Back cannot return it to the control that opened a page. */
export const MAIN_ID = "vo-main";
/** Id of the sidebar. */
export const SIDEBAR_ID = "vo-sidebar";

/** An open chat: it has a SessionController and may have omp running, whether or not it is showing. */
export interface ChatTab {
	id: string;
	projectPath: string;
	/** Saved session file; null for a brand-new chat until omp creates it. */
	sessionFile: string | null;
	/** Title known when the chat was opened (sidebar title); live titles come from the controller. */
	title: string | null;
}

/** `home`: the project overview. `page`: a full page (`page`), with Back returning to `pageReturn`. */
export type MainView = "home" | "chat" | "page";

export interface OpenSheet {
	id: string;
	props: unknown;
}

export interface OpenPage {
	id: string;
	props: unknown;
	/** Increments on every `openPage`, so a page can apply a new deep link while it is already open. */
	seq: number;
}

export interface AppState {
	prefs: AppPreferences | null;
	omp: OmpStatus | null;
	projects: ProjectSummary[];
	sessionsByProject: Record<string, SessionSummary[]>;
	activeProject: string | null;
	view: MainView;
	/** Open chats, in the order they were opened. */
	tabs: ChatTab[];
	activeTabId: string | null;
	/** Chat shown in the right half of a split, or null when not split. */
	splitTabId: string | null;
	focusedSplit: "primary" | "secondary";
	sidebarOpen: boolean;
	sidebarWidth: number;
	/** Persisted: the side panel is open. At narrow widths it may stand aside for the chat (`chatOverDock`). */
	dockOpen: boolean;
	dockPane: string;
	dockWidth: number;
	sheet: OpenSheet | null;
	/** Full page shown while `view` is `page`. */
	page: OpenPage | null;
	/** Where Back on a page returns. */
	pageReturn: "home" | "chat";
	paletteOpen: boolean;
	/** Chat whose omp terminal sheet is open. */
	terminalTabId: string | null;
	/** Sidebar search (filters the sidebar only). */
	search: string;
	expandedProjects: string[];
	/** Projects whose whole chat list shows in the sidebar ("Show N more chats"). */
	expandedChatLists: string[];
	/**
	 * When the window is too narrow for the chat and the side panel together (`dockTooNarrow`), show the chat
	 * and keep the panel open for wider windows. Set by explicit chat navigation and "Back to chat"; cleared when
	 * the panel is opened or a pane is chosen. Not persisted.
	 */
	chatOverDock: boolean;

	init(): Promise<void>;
	refreshProjects(): Promise<void>;
	loadSessions(projectPath: string): Promise<void>;
	setPrefs(patch: Partial<AppPreferences>): Promise<void>;
	refreshOmp(): Promise<void>;
	openProject(path: string): void;
	toggleProjectExpanded(path: string): void;
	/**
	 * Start a chat; `extraArgs` are omp launch flags for its first start (e.g. `--from-claude`); `split`
	 * opens it beside the chat that is showing. Resolves to the new chat id, or null when there is no
	 * project or the user kept editing a page with unsaved changes. Callers that fall back to "Create
	 * project" check for a project first.
	 */
	newChat(projectPath?: string, options?: { extraArgs?: string[]; split?: boolean }): Promise<string | null>;
	/**
	 * Move a chat that has not sent anything yet to another folder: its omp stops and a fresh one
	 * starts in `projectPath` in the same place, keeping the composer draft. Returns the new chat id,
	 * or null when the chat can no longer move (see `canRetarget`).
	 */
	retargetChat(tabId: string, projectPath: string): string | null;
	openSession(session: SessionSummary, options?: { split?: boolean }): void;
	/**
	 * Show an open chat (or focus its half of a split). The chat that was showing keeps running. `split`
	 * shows it beside the chat on the left instead.
	 */
	activateTab(tabId: string, options?: { split?: boolean }): void;
	/**
	 * Close an open chat and stop its omp. `closeChat` asks first while it is working. A saved chat goes on the
	 * "Reopen closed chat" stack with its unsent text.
	 */
	closeTab(tabId: string): Promise<void>;
	/**
	 * Show the most recently closed chat that is not open again and whose file still exists, with its unsent text,
	 * without starting omp. Resolves false when there is none or the user kept editing a page.
	 */
	reopenClosedChat(): Promise<boolean>;
	/**
	 * Split view on or off. Turning it on shows the most recently viewed other open chat beside the
	 * focused one, or starts a new chat there when no other chat is open.
	 */
	toggleSplit(): void;
	focusSplit(which: "primary" | "secondary"): void;
	toggleSidebar(): void;
	setSidebarWidth(width: number): void;
	/** Open, close or toggle the side panel. Toggling while the chat covers it at a narrow width shows it. */
	toggleDock(open?: boolean): void;
	showPane(paneId: string): void;
	/** Narrow window: show the chat in place of the expanded side panel, which stays open for wider windows. */
	returnToChat(): void;
	setDockWidth(width: number): void;
	openSheet(id: string, props?: unknown): void;
	closeSheet(): void;
	/** Show a full page in the main area; Back (`closePage`) returns to the chat or project it replaced. */
	openPage(id: string, props?: unknown): void;
	closePage(): void;
	setPaletteOpen(open: boolean): void;
	openTerminal(tabId?: string | null): void;
	closeTerminal(): void;
	setSearch(search: string): void;
	/** Show every chat of a project in the sidebar. */
	showMoreChats(projectPath: string): void;
}

const controllers = new Map<string, SessionController>();

/** The SessionController behind an open chat. */
export function controllerFor(tabId: string | null | undefined): SessionController | null {
	return tabId ? (controllers.get(tabId) ?? null) : null;
}

function ensureController(tab: ChatTab, extraArgs?: string[]): SessionController {
	let controller = controllers.get(tab.id);
	if (!controller) {
		controller = new SessionController({ tabId: tab.id, projectPath: tab.projectPath, sessionFile: tab.sessionFile, extraArgs });
		controllers.set(tab.id, controller);
		if (tab.sessionFile) {
			void controller.loadHistory();
			void controller.checkOwnership();
		}
		const synced = controller;
		synced.subscribe(() => {
			const file = synced.sessionFile;
			if (!file) return;
			const current = useApp.getState().tabs.find(entry => entry.id === tab.id);
			if (current && current.sessionFile !== file) {
				useApp.setState(state => ({ tabs: state.tabs.map(entry => (entry.id === tab.id ? { ...entry, sessionFile: file } : entry)) }));
			}
		});
	}
	return controller;
}

let tabSeq = 0;
function newTabId(): string {
	return `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;
}

let pageSeq = 0;
/** Focused element when the current page opened. */
let pageOpener: HTMLElement | null = null;

/** Open chats, most recently shown first (picks the chat that "Open side by side" puts beside the focused one). */
let recentTabs: string[] = [];
/** Chats closed in this window, newest first, for "Reopen closed chat". */
let closedChats: ClosedChat[] = [];
/** Set once init() has adopted running omp hosts; before that a restored chat may still have one. */
let hostsAdopted = false;

/** The most recently shown open chat other than `exclude`. */
function recentOtherTab(tabs: readonly ChatTab[], exclude: (string | null)[]): string | null {
	const open = tabs.filter(tab => !exclude.includes(tab.id));
	return recentTabs.find(id => open.some(tab => tab.id === id)) ?? open.at(-1)?.id ?? null;
}

/**
 * Release rule: an open chat the user moved away from goes back to being a saved row when omp never started for
 * it (it only showed the saved transcript), nothing was sent, its composer holds no text or files, and removing it
 * renumbers no chat that was already open (`releaseKeepsNumbers`; `before` is the list before this change).
 */
function releaseIfUnused(tabId: string, before: readonly ChatTab[]): void {
	const state = useApp.getState();
	const controller = controllers.get(tabId);
	if (!controller || tabId === state.activeTabId || tabId === state.splitTabId || tabId === state.terminalTabId) return;
	if (!releaseKeepsNumbers(tabId, state.tabs, before)) return;
	if (controller.getSnapshot().mode !== "history" || controller.hostId || controller.inputSent) return;
	const drafts = useComposerDrafts.getState();
	if (drafts.drafts[tabId]?.trim() || (drafts.attachments[tabId]?.length ?? 0) > 0) return;
	controllers.delete(tabId);
	recentTabs = recentTabs.filter(id => id !== tabId);
	useApp.setState(current => ({ tabs: current.tabs.filter(tab => tab.id !== tabId) }));
	drafts.forget(tabId);
	void controller.dispose();
}

/** Show an open chat, or focus its half of a split. */
function showTab(tabId: string): void {
	const tab = useApp.getState().tabs.find(entry => entry.id === tabId);
	if (!tab) return;
	ensureController(tab);
	useApp.setState(state => ({
		...(state.splitTabId === tabId ? { focusedSplit: "secondary" as const } : { activeTabId: tabId, focusedSplit: "primary" as const }),
		activeProject: tab.projectPath,
		view: "chat",
		chatOverDock: true,
	}));
}

/** Narrowest the chat may get beside the side panel before the panel takes the main area instead. */
export const MIN_CHAT_WIDTH = 480;

/**
 * Window layout widths (DESIGN §3), the one definition Shell draws and the fit math reads. The floating side panel
 * sits on a strip of canvas with `DOCK_INSET` on each side; the sheet has a 1px seam against the sidebar. The resize
 * handles overlap their neighbours (-mx-0.5 on a 4px handle), so they take no width.
 */
export const DOCK_INSET = 8;
const SHEET_SEAM = 1;

/**
 * The side panel is open but the window is too narrow for it beside the chat, so it takes the main area
 * (with "Back to chat") unless the user went back to the chat (`chatOverDock`). Full pages hide the panel.
 * Everything beside the chat counts: sidebar and seam, panel and its gutters.
 */
export function dockTooNarrow(state: Pick<AppState, "dockOpen" | "dockWidth" | "sidebarOpen" | "sidebarWidth" | "view">, windowWidth: number): boolean {
	const occupied = (state.sidebarOpen ? state.sidebarWidth + SHEET_SEAM : 0) + state.dockWidth + 2 * DOCK_INSET;
	return state.dockOpen && state.view !== "page" && windowWidth - occupied < MIN_CHAT_WIDTH;
}

function subscribeResize(listener: () => void): () => void {
	window.addEventListener("resize", listener);
	return () => window.removeEventListener("resize", listener);
}

/** The window's width in CSS px, re-rendering on resize. */
export function useWindowWidth(): number {
	return useSyncExternalStore(subscribeResize, () => window.innerWidth);
}

/**
 * Whether the side panel is on screen: open, not hidden by a full page, and, when the window is too narrow for it
 * beside the chat, not standing aside for the chat. For controls that show or toggle it (header toggle, work chip).
 */
export function useDockVisible(): boolean {
	const width = useWindowWidth();
	return useApp(state => state.dockOpen && state.view !== "page" && (!state.chatOverDock || !dockTooNarrow(state, width)));
}

/**
 * The page's back link or selected section where it shows now inside `scope`: the selected rail item, the narrow
 * rail's select (NavRail marks both `data-nav-target`), else the back link. Only a visible, non-inert control counts.
 */
function pageNavFocusTarget(scope: HTMLElement | null): HTMLElement | null {
	if (!scope) return null;
	const usable = (element: HTMLElement | null): element is HTMLElement =>
		element !== null && element.getClientRects().length > 0 && !element.closest("[inert]");
	for (const marked of scope.querySelectorAll<HTMLElement>("[data-nav-target]")) {
		const control = marked.matches("button") ? marked : marked.querySelector<HTMLElement>("button");
		if (usable(control)) return control;
	}
	for (const back of scope.querySelectorAll<HTMLElement>("[data-page-back] button")) if (usable(back)) return back;
	return null;
}

export const useApp = create<AppState>()(
	persist(
		(set, get) => ({
			prefs: null,
			omp: null,
			projects: [],
			sessionsByProject: {},
			activeProject: null,
			view: "home",
			tabs: [],
			activeTabId: null,
			splitTabId: null,
			focusedSplit: "primary",
			sidebarOpen: true,
			sidebarWidth: 264,
			dockOpen: false,
			dockPane: "diff",
			dockWidth: 420,
			sheet: null,
			page: null,
			pageReturn: "home",
			paletteOpen: false,
			terminalTabId: null,
			search: "",
			expandedProjects: [],
			expandedChatLists: [],
			chatOverDock: false,

			async init() {
				const [prefs, omp] = await Promise.all([
					window.vomp.invoke("app:prefs:get"),
					window.vomp.invoke("omp:status"),
				]);
				set({ prefs, omp });
				window.vomp.on("app:prefs", next => set({ prefs: next }));
				window.vomp.on("sessions:changed", () => {
					void get().refreshProjects();
					const { activeProject } = get();
					if (activeProject) void get().loadSessions(activeProject);
				});
				// Controllers for restored tabs. omp processes survive a renderer reload (and a closed
				// macOS window): adopt the one already running for each tab instead of starting a second
				// writer on the same session, and stop hosts no tab owns any more.
				const running = await window.vomp.invoke("host:list");
				const adopted = new Set<string>();
				for (const tab of get().tabs) {
					const controller = ensureController(tab);
					const host = running.find(entry => entry.phase !== "exited" && entry.sessionFile === tab.sessionFile && !adopted.has(entry.hostId));
					if (host) {
						adopted.add(host.hostId);
						controller.attach(host);
					}
				}
				for (const host of running) if (host.phase !== "exited" && !adopted.has(host.hostId)) void window.vomp.invoke("host:stop", host.hostId);
				hostsAdopted = true;
				await get().refreshProjects();
			},

			async refreshProjects() {
				const projects = await window.vomp.invoke("sessions:projects");
				set(state => ({ projects, activeProject: state.activeProject ?? projects[0]?.path ?? null }));
				const expanded = get().expandedProjects;
				await Promise.all(expanded.map(path => get().loadSessions(path)));
			},

			async loadSessions(projectPath) {
				const sessions = await window.vomp.invoke("sessions:list", projectPath);
				set(state => ({ sessionsByProject: { ...state.sessionsByProject, [projectPath]: sessions } }));
			},

			async setPrefs(patch) {
				set({ prefs: await window.vomp.invoke("app:prefs:set", patch) });
			},

			async refreshOmp() {
				set({ omp: await window.vomp.invoke("omp:status", true) });
			},

			openProject(path) {
				void whenLeaving(() => {
					set(state => ({
						activeProject: path,
						view: "home",
						expandedProjects: state.expandedProjects.includes(path) ? state.expandedProjects : [...state.expandedProjects, path],
					}));
					void get().loadSessions(path);
				});
			},

			toggleProjectExpanded(path) {
				const expanded = get().expandedProjects;
				const open = expanded.includes(path);
				set({ expandedProjects: open ? expanded.filter(entry => entry !== path) : [...expanded, path] });
				if (!open) void get().loadSessions(path);
			},

			async newChat(projectPath, options) {
				const path = projectPath ?? get().activeProject;
				if (!path) return null;
				const result = await whenLeaving(() => {
					const tab: ChatTab = { id: newTabId(), projectPath: path, sessionFile: null, title: null };
					const controller = ensureController(tab, options?.extraArgs);
					set(state => ({
						tabs: [...state.tabs, tab],
						activeProject: path,
						view: "chat",
						chatOverDock: true,
						...(options?.split && state.activeTabId
							? { splitTabId: tab.id, focusedSplit: "secondary" as const }
							: { activeTabId: tab.id, focusedSplit: "primary" as const }),
					}));
					// A new chat starts omp right away so the first message is quick.
					void controller.ensureLive();
					return tab.id;
				});
				return result.left ? result.value : null;
			},

			retargetChat(tabId, projectPath) {
				const old = get().tabs.find(entry => entry.id === tabId);
				const previous = controllers.get(tabId);
				if (!old || !previous || !canRetarget(previous)) return null;
				if (old.projectPath === projectPath) return tabId;
				const tab: ChatTab = { id: newTabId(), projectPath, sessionFile: null, title: null };
				const controller = ensureController(tab);
				controllers.delete(tabId);
				const drafts = useComposerDrafts.getState();
				drafts.setDraft(tab.id, drafts.drafts[tabId] ?? "");
				drafts.addAttachments(tab.id, drafts.attachments[tabId] ?? []);
				drafts.setMode(tab.id, drafts.modes[tabId] ?? null);
				drafts.forget(tabId);
				const swap = (id: string | null) => (id === tabId ? tab.id : id);
				set(state => ({
					tabs: state.tabs.map(entry => (entry.id === tabId ? tab : entry)),
					activeTabId: swap(state.activeTabId),
					splitTabId: swap(state.splitTabId),
					terminalTabId: swap(state.terminalTabId),
					activeProject: projectPath,
					view: "chat",
				}));
				void previous.dispose();
				void controller.ensureLive();
				drafts.focus(tab.id);
				return tab.id;
			},

			openSession(session, options) {
				void whenLeaving(() => {
					const state = get();
					// A split needs a chat on the left that is not the one being opened.
					const existing = state.tabs.find(tab => tab.sessionFile === session.file);
					const split = options?.split === true && state.activeTabId !== null && state.activeTabId !== existing?.id;
					if (existing) {
						if (split) set({ splitTabId: existing.id, focusedSplit: "secondary", view: "chat", activeProject: session.cwd, chatOverDock: true });
						else showTab(existing.id);
						return;
					}
					const tab: ChatTab = { id: newTabId(), projectPath: session.cwd, sessionFile: session.file, title: session.title };
					ensureController(tab);
					set(current => ({
						tabs: [...current.tabs, tab],
						view: "chat",
						chatOverDock: true,
						activeProject: session.cwd,
						...(split ? { splitTabId: tab.id, focusedSplit: "secondary" as const } : { activeTabId: tab.id, focusedSplit: "primary" as const }),
					}));
				});
			},

			activateTab(tabId, options) {
				void whenLeaving(() => {
					const { activeTabId, tabs } = get();
					const tab = tabs.find(entry => entry.id === tabId);
					if (options?.split && tab && activeTabId && activeTabId !== tabId) {
						set({ splitTabId: tabId, focusedSplit: "secondary", view: "chat", activeProject: tab.projectPath, chatOverDock: true });
					} else showTab(tabId);
				});
			},

			async closeTab(tabId) {
				const controller = controllers.get(tabId);
				controllers.delete(tabId);
				const closing = get().tabs.find(tab => tab.id === tabId);
				const drafts = useComposerDrafts.getState();
				if (closing?.sessionFile) {
					const title = chatTitle(controller?.getSnapshot() ?? null, closing.title);
					closedChats = pushClosed(closedChats, { projectPath: closing.projectPath, sessionFile: closing.sessionFile, title, draft: drafts.drafts[tabId] ?? "" });
				}
				drafts.forget(tabId);
				set(state => {
					const tabs = state.tabs.filter(tab => tab.id !== tabId);
					let activeTabId = state.activeTabId;
					let splitTabId = state.splitTabId === tabId ? null : state.splitTabId;
					if (activeTabId === tabId) {
						// The other half of a split takes over; otherwise the chat shown before this one.
						activeTabId = splitTabId ?? recentOtherTab(tabs, []);
						splitTabId = null;
					}
					return {
						tabs,
						activeTabId,
						splitTabId,
						focusedSplit: "primary",
						activeProject: tabs.find(tab => tab.id === activeTabId)?.projectPath ?? state.activeProject,
						// A page stays open when its last chat closes; Back then returns to the project.
						view: activeTabId || state.view === "page" ? state.view : "home",
						pageReturn: activeTabId ? state.pageReturn : "home",
						terminalTabId: state.terminalTabId === tabId ? null : state.terminalTabId,
					};
				});
				await controller?.dispose();
			},

			async reopenClosedChat() {
				const { chat, skipped } = await takeReopenable(
					closedChats,
					file => get().tabs.some(tab => tab.sessionFile === file),
					file => window.vomp.invoke("fs:exists", file),
				);
				const taken = chat ? [chat, ...skipped] : skipped;
				closedChats = closedChats.filter(entry => !taken.includes(entry));
				if (!chat) return false;
				const result = await whenLeaving(() => {
					const existing = get().tabs.find(tab => tab.sessionFile === chat.sessionFile);
					if (existing) {
						showTab(existing.id);
						return;
					}
					const tab: ChatTab = { id: newTabId(), projectPath: chat.projectPath, sessionFile: chat.sessionFile, title: chat.title };
					ensureController(tab);
					if (chat.draft) useComposerDrafts.getState().setDraft(tab.id, chat.draft);
					set(state => ({
						tabs: [...state.tabs, tab],
						activeTabId: tab.id,
						focusedSplit: "primary",
						activeProject: chat.projectPath,
						view: "chat",
						chatOverDock: true,
					}));
				});
				if (!result.left) closedChats = pushClosed(closedChats, chat);
				return result.left;
			},

			toggleSplit() {
				const { splitTabId, tabs, activeTabId } = get();
				if (splitTabId) {
					set({ splitTabId: null, focusedSplit: "primary" });
					return;
				}
				const primary = tabs.find(tab => tab.id === activeTabId);
				if (!primary) return;
				const other = recentOtherTab(tabs, [primary.id]);
				if (other) void whenLeaving(() => set({ splitTabId: other, focusedSplit: "secondary", view: "chat", chatOverDock: true }));
				else void get().newChat(primary.projectPath, { split: true });
			},

			focusSplit(which) {
				set({ focusedSplit: which });
			},

			toggleSidebar() {
				const showing = !get().sidebarOpen;
				// A page's back link and section nav change sides with the sidebar (they render inline while it is hidden).
				// Focus on them, or anywhere in a sidebar that is going away, follows them to where they show next.
				const focused = document.activeElement;
				const inSidebar = focused?.closest(`#${SIDEBAR_ID}`) != null;
				const onPage = get().view === "page";
				const onMoving = onPage && focused?.closest(`#${MAIN_ID} :is([data-nav-rail], [data-page-back])`) != null;
				set({ sidebarOpen: showing });
				if (showing ? !onMoving : !inSidebar) return;
				// They move once the sidebar has mounted or played its exit, so look for them for up to a second.
				const scopeId = showing ? SIDEBAR_ID : MAIN_ID;
				const until = performance.now() + 1000;
				const follow = () => {
					const target = onPage ? pageNavFocusTarget(document.getElementById(scopeId)) : null;
					if (target) target.focus();
					else if (onPage && performance.now() < until) requestAnimationFrame(follow);
					else if (!showing) document.getElementById(MAIN_ID)?.focus();
				};
				requestAnimationFrame(follow);
			},

			setSidebarWidth(width) {
				set({ sidebarWidth: Math.min(320, Math.max(200, width)) });
			},

			toggleDock(open) {
				set(state => {
					// The panel is open but standing aside for the chat: toggling shows it.
					if (open === undefined && state.dockOpen && state.chatOverDock && dockTooNarrow(state, window.innerWidth)) return { chatOverDock: false };
					const dockOpen = open ?? !state.dockOpen;
					return dockOpen ? { dockOpen, chatOverDock: false } : { dockOpen };
				});
			},

			showPane(paneId) {
				set({ dockOpen: true, dockPane: paneId, chatOverDock: false });
			},

			returnToChat() {
				set({ chatOverDock: true });
			},

			setDockWidth(width) {
				set({ dockWidth: Math.min(640, Math.max(320, width)) });
			},

			openSheet(id, props) {
				set({ sheet: { id, props }, paletteOpen: false });
			},

			closeSheet() {
				set({ sheet: null });
			},

			openPage(id, props) {
				void whenLeaving(() => {
					// Back returns focus here; an opener inside the chat stays mounted while the page shows.
					if (get().view !== "page" && document.activeElement instanceof HTMLElement) pageOpener = document.activeElement;
					set(state => ({
						page: { id, props, seq: ++pageSeq },
						pageReturn: state.view === "page" ? state.pageReturn : state.view,
						view: "page",
						paletteOpen: false,
						sheet: null,
					}));
				});
			},

			closePage() {
				void whenLeaving(() => {
					set(state => ({ page: null, view: state.pageReturn === "chat" && state.tabs.length > 0 ? "chat" : "home", chatOverDock: true }));
					const opener = pageOpener;
					pageOpener = null;
					// After the chat is visible and interactive again.
					requestAnimationFrame(() => {
						if (opener?.isConnected && !opener.closest("[inert]")) opener.focus();
						else document.getElementById(MAIN_ID)?.focus();
					});
				});
			},

			setPaletteOpen(open) {
				set({ paletteOpen: open });
			},

			openTerminal(tabId) {
				const target = tabId ?? focusedTabId(get());
				if (!target) return;
				// Anything typed in the raw terminal bypasses the composer; treat the chat as used.
				controllers.get(target)?.markInput();
				set({ terminalTabId: target });
			},

			closeTerminal() {
				set({ terminalTabId: null });
			},

			setSearch(search) {
				set({ search });
			},

			showMoreChats(projectPath) {
				set(state => ({ expandedChatLists: state.expandedChatLists.includes(projectPath) ? state.expandedChatLists : [...state.expandedChatLists, projectPath] }));
			},
		}),
		{
			name: "visual-omp:layout",
			version: 1,
			partialize: state => {
				const persistedTabs = state.tabs.filter(tab => tab.sessionFile !== null);
				const normalized = normalizeRestoredChatSelection({ ...state, tabs: persistedTabs });
				return {
					// Chats that never produced a session file have nothing to restore.
					tabs: persistedTabs,
					activeTabId: normalized.activeTabId,
					splitTabId: normalized.splitTabId,
					focusedSplit: normalized.focusedSplit,
					activeProject: normalized.activeProject,
					// Pages and transient views are not restored.
					view: normalized.view,
					sidebarOpen: state.sidebarOpen,
					sidebarWidth: state.sidebarWidth,
					dockOpen: state.dockOpen,
					dockPane: state.dockPane,
					dockWidth: state.dockWidth,
					expandedProjects: state.expandedProjects,
				};
			},
			merge: (persistedState, currentState) => {
				const persisted = persistedState as Partial<AppState>;
				const tabs = (persisted.tabs ?? currentState.tabs).filter(tab => tab.sessionFile !== null);
				const merged = { ...currentState, ...persisted, tabs };
				return { ...merged, ...normalizeRestoredChatSelection(merged) };
			},
		},
	),
);

// Restored chats need their controllers before the first render. ChatArea, the sidebar and the
// session header look controllers up while rendering and get no signal when one appears later, so a
// chat restored into view would otherwise stay blank until the user switched away and back. Hydration
// from localStorage is synchronous, so the chats are already here; init() adopts running hosts.
for (const tab of useApp.getState().tabs) ensureController(tab);

// Track which chat was shown most recently, keep the project in step with the focused chat (the side panel,
// status bar and project commands follow `activeProject`, so focusing the other half of a split moves them to
// that chat's project), and release a chat the user left (see `releaseIfUnused`).
useApp.subscribe((state, previous) => {
	const focused = state.focusedSplit === "secondary" && state.splitTabId ? state.splitTabId : state.activeTabId;
	if (focused && recentTabs[0] !== focused) recentTabs = [focused, ...recentTabs.filter(id => id !== focused)];
	if (state.tabs !== previous.tabs) recentTabs = recentTabs.filter(id => state.tabs.some(tab => tab.id === id));
	if (state.view === "chat" && focused) {
		const project = state.tabs.find(tab => tab.id === focused)?.projectPath;
		if (project && project !== state.activeProject) useApp.setState({ activeProject: project });
	}
	if (!hostsAdopted) return;
	for (const left of [previous.activeTabId, previous.splitTabId]) {
		if (left && left !== state.activeTabId && left !== state.splitTabId) releaseIfUnused(left, previous.tabs);
	}
});

/** The chat that keyboard commands act on: the focused half of a split, else the active chat. */
export function focusedTabId(state: Pick<AppState, "activeTabId" | "splitTabId" | "focusedSplit" | "view">): string | null {
	if (state.view !== "chat") return null;
	return state.focusedSplit === "secondary" && state.splitTabId ? state.splitTabId : state.activeTabId;
}

/** Controller for the chat keyboard commands act on. */
export function focusedController(): SessionController | null {
	return controllerFor(focusedTabId(useApp.getState()));
}

/** A closed chat is waiting on the "Reopen closed chat" stack (its file may since have gone). */
export function canReopenChat(): boolean {
	return closedChats.length > 0;
}

/** Every live controller (quit warnings, notifications). */
export function allControllers(): SessionController[] {
	return [...controllers.values()];
}

/** Close an open chat, asking first while omp is working in it (`registry/guards.ts`). */
export async function closeChat(tabId: string): Promise<void> {
	if (controllers.get(tabId)?.getSnapshot().working && !(await confirmTabClose(tabId))) return;
	await useApp.getState().closeTab(tabId);
}

/**
 * A chat can still move to another folder while nothing has been sent: no input sent or on its
 * way (recorded synchronously by the controller, so delayed collab frames cannot hide it), no saved
 * session file, no conversation entries, nothing queued, not working, and not read-only.
 */
export function canRetarget(controller: SessionController): boolean {
	const view = controller.getSnapshot();
	if (controller.inputSent || controller.sessionFile || view.readOnly || view.working || view.queue.length > 0) return false;
	return !view.guest?.entries.some(entry => entry.type === "message" || entry.type === "custom_message");
}
