/**
 * App-wide UI state: projects and their sessions, open chat tabs (with an optional split), layout,
 * and overlays. Chat behaviour lives in `SessionController`s keyed by tab id (see `controllers`).
 * Layout and open tabs persist to localStorage so the window comes back the way it was left.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppPreferences, OmpStatus, ProjectSummary, SessionSummary } from "@shared/ipc";
import { useComposerDrafts } from "../chat/composer/drafts";
import { whenLeaving } from "./leaveGuard";
import { SessionController } from "./session";

/** Id of the main area; focus lands here when Back cannot return it to the control that opened a page. */
export const MAIN_ID = "vo-main";

export interface ChatTab {
	id: string;
	projectPath: string;
	/** Saved session file; null for a brand-new chat until omp creates it. */
	sessionFile: string | null;
	/** Title known when the tab was opened (sidebar title); live titles come from the controller. */
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

interface AppState {
	prefs: AppPreferences | null;
	omp: OmpStatus | null;
	projects: ProjectSummary[];
	sessionsByProject: Record<string, SessionSummary[]>;
	activeProject: string | null;
	view: MainView;
	tabs: ChatTab[];
	activeTabId: string | null;
	/** Tab shown in the right half of a split, or null when not split. */
	splitTabId: string | null;
	focusedSplit: "primary" | "secondary";
	sidebarOpen: boolean;
	sidebarWidth: number;
	dockOpen: boolean;
	dockPane: string;
	dockWidth: number;
	sheet: OpenSheet | null;
	/** Full page shown while `view` is `page`. */
	page: OpenPage | null;
	/** Where Back on a page returns. */
	pageReturn: "home" | "chat";
	paletteOpen: boolean;
	/** Tab whose omp terminal sheet is open. */
	terminalTabId: string | null;
	search: string;
	expandedProjects: string[];

	init(): Promise<void>;
	refreshProjects(): Promise<void>;
	loadSessions(projectPath: string): Promise<void>;
	setPrefs(patch: Partial<AppPreferences>): Promise<void>;
	refreshOmp(): Promise<void>;
	openProject(path: string): void;
	toggleProjectExpanded(path: string): void;
	/**
	 * Start a chat; `extraArgs` are omp launch flags for its first start (e.g. `--from-claude`).
	 * Resolves to the new tab id, or null when there is no project or the user kept editing a page with
	 * unsaved changes. Callers that fall back to "Create project" check for a project first.
	 */
	newChat(projectPath?: string, options?: { extraArgs?: string[] }): Promise<string | null>;
	/**
	 * Move a chat that has not sent anything yet to another folder: its omp stops and a fresh one
	 * starts in `projectPath` in the same tab position, keeping the composer draft. Returns the new
	 * tab id, or null when the chat can no longer move (see `canRetarget`).
	 */
	retargetChat(tabId: string, projectPath: string): string | null;
	openSession(session: SessionSummary, options?: { split?: boolean }): void;
	activateTab(tabId: string): void;
	closeTab(tabId: string): Promise<void>;
	toggleSplit(): void;
	focusSplit(which: "primary" | "secondary"): void;
	goHome(): void;
	toggleSidebar(): void;
	setSidebarWidth(width: number): void;
	toggleDock(open?: boolean): void;
	showPane(paneId: string): void;
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
}

const controllers = new Map<string, SessionController>();

/** The SessionController behind a chat tab. */
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

/** Show an open chat, or focus its half of a split. */
function showTab(tabId: string): void {
	const tab = useApp.getState().tabs.find(entry => entry.id === tabId);
	if (!tab) return;
	ensureController(tab);
	useApp.setState(state => ({
		...(state.splitTabId === tabId ? { focusedSplit: "secondary" as const } : { activeTabId: tabId, focusedSplit: "primary" as const }),
		activeProject: tab.projectPath,
		view: "chat",
	}));
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
					set(state => ({ tabs: [...state.tabs, tab], activeTabId: tab.id, activeProject: path, view: "chat", focusedSplit: "primary" }));
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
					const existing = get().tabs.find(tab => tab.sessionFile === session.file);
					if (existing) {
						if (options?.split) set({ splitTabId: existing.id, focusedSplit: "secondary", view: "chat" });
						else showTab(existing.id);
						return;
					}
					const tab: ChatTab = { id: newTabId(), projectPath: session.cwd, sessionFile: session.file, title: session.title };
					ensureController(tab);
					set(state => ({
						tabs: [...state.tabs, tab],
						view: "chat",
						activeProject: session.cwd,
						...(options?.split
							? { splitTabId: tab.id, focusedSplit: "secondary" as const }
							: { activeTabId: tab.id, focusedSplit: "primary" as const }),
					}));
				});
			},

			activateTab(tabId) {
				void whenLeaving(() => showTab(tabId));
			},

			async closeTab(tabId) {
				const controller = controllers.get(tabId);
				controllers.delete(tabId);
				set(state => {
					const index = state.tabs.findIndex(tab => tab.id === tabId);
					const tabs = state.tabs.filter(tab => tab.id !== tabId);
					const splitTabId = state.splitTabId === tabId ? null : state.splitTabId;
					let activeTabId = state.activeTabId;
					if (activeTabId === tabId) activeTabId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null;
					if (activeTabId && activeTabId === splitTabId) activeTabId = tabs.find(tab => tab.id !== splitTabId)?.id ?? null;
					return {
						tabs,
						activeTabId,
						splitTabId,
						focusedSplit: "primary",
						// A page stays open when its last chat closes; Back then returns to the project.
						view: activeTabId || state.view === "page" ? state.view : "home",
						pageReturn: activeTabId ? state.pageReturn : "home",
						terminalTabId: state.terminalTabId === tabId ? null : state.terminalTabId,
					};
				});
				await controller?.dispose();
			},

			toggleSplit() {
				const { splitTabId, tabs, activeTabId } = get();
				if (splitTabId) {
					set({ splitTabId: null, focusedSplit: "primary" });
					return;
				}
				const other = tabs.find(tab => tab.id !== activeTabId);
				if (other) void whenLeaving(() => set({ splitTabId: other.id, focusedSplit: "secondary", view: "chat" }));
			},

			focusSplit(which) {
				set({ focusedSplit: which });
			},

			goHome() {
				void whenLeaving(() => set({ view: "home" }));
			},

			toggleSidebar() {
				set(state => ({ sidebarOpen: !state.sidebarOpen }));
			},

			setSidebarWidth(width) {
				set({ sidebarWidth: Math.min(320, Math.max(200, width)) });
			},

			toggleDock(open) {
				set(state => ({ dockOpen: open ?? !state.dockOpen }));
			},

			showPane(paneId) {
				set({ dockOpen: true, dockPane: paneId });
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
					set(state => ({ page: null, view: state.pageReturn === "chat" && state.tabs.length > 0 ? "chat" : "home" }));
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
		}),
		{
			name: "visual-omp:layout",
			version: 1,
			partialize: state => ({
				// Chats that never produced a session file have nothing to restore.
				tabs: state.tabs.filter(tab => tab.sessionFile !== null),
				activeTabId: state.activeTabId,
				splitTabId: state.splitTabId,
				activeProject: state.activeProject,
				// A page is not restored; the window reopens on what the page replaced.
				view: state.view === "page" ? state.pageReturn : state.view,
				sidebarOpen: state.sidebarOpen,
				sidebarWidth: state.sidebarWidth,
				dockOpen: state.dockOpen,
				dockPane: state.dockPane,
				dockWidth: state.dockWidth,
				expandedProjects: state.expandedProjects,
			}),
		},
	),
);

// Restored tabs need their controllers before the first render. ChatArea, the tab strip and the
// sidebar look controllers up while rendering and get no signal when one appears later, so a chat
// restored into view would otherwise stay blank until the user switched away and back. Hydration
// from localStorage is synchronous, so the tabs are already here; init() adopts running hosts.
for (const tab of useApp.getState().tabs) ensureController(tab);

/** The tab that keyboard commands act on: the focused half of a split, else the active tab. */
export function focusedTabId(state: Pick<AppState, "activeTabId" | "splitTabId" | "focusedSplit" | "view">): string | null {
	if (state.view !== "chat") return null;
	return state.focusedSplit === "secondary" && state.splitTabId ? state.splitTabId : state.activeTabId;
}

/** Controller for the chat keyboard commands act on. */
export function focusedController(): SessionController | null {
	return controllerFor(focusedTabId(useApp.getState()));
}

/** Every live controller (quit warnings, notifications). */
export function allControllers(): SessionController[] {
	return [...controllers.values()];
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
