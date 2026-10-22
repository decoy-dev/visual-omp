/**
 * Files pane state that outlives the pane (expanded folders, viewer tabs, the tree's width, folder listings) and
 * `openInFiles`, which the transcript and the Outputs pane call without loading the pane itself.
 *
 * What the pane shows belongs to the chat it shows in, like the side panel itself (`state/dockLayout.ts`): each open
 * chat has its own folders, tabs and tree width (`filesView`), and they go when the chat closes. Project overviews,
 * which are not one chat, keep one per project. Folder listings are shared, since they are the disk's.
 */
import { create } from "zustand";
import type { DirEntry } from "@shared/ipc";
import { dockKey, useApp } from "../../state/app";
import { OVERVIEW_DOCK } from "../../state/dockLayout";

const HIDDEN: Record<string, true> = { ".git": true, node_modules: true };

export interface ViewFiles {
	expanded: string[];
	tabs: string[];
	active: string | null;
	/** The tree is hidden so the viewer takes the pane's width (only while tabs are open). */
	treeHidden: boolean;
	/** The tree's width beside an open file, as the user dragged it. */
	treeWidth: number;
}

export const TREE_MIN_WIDTH = 120;
export const TREE_MAX_WIDTH = 360;

const OVERVIEW_PREFIX = "project:";

/** Key of the Files state a pane shows: the chat's (`tabId`), else the project overview's. */
export function filesView(tabId: string | null, projectPath: string): string {
	return tabId ?? `${OVERVIEW_PREFIX}${projectPath}`;
}

interface FilesState {
	byView: Record<string, ViewFiles>;
	children: Record<string, DirEntry[] | "error">;
	toggle(view: string, dir: string, open?: boolean): void;
	open(view: string, path: string): void;
	close(view: string, path: string): void;
	activate(view: string, path: string): void;
	setTreeHidden(view: string, hidden: boolean): void;
	setTreeWidth(view: string, width: number): void;
	load(dir: string): Promise<void>;
}

export const EMPTY_VIEW: ViewFiles = { expanded: [], tabs: [], active: null, treeHidden: false, treeWidth: 180 };

export const useFiles = create<FilesState>((set, get) => {
	const patch = (view: string, change: (current: ViewFiles) => ViewFiles) =>
		set(state => ({ byView: { ...state.byView, [view]: change(state.byView[view] ?? EMPTY_VIEW) } }));
	return {
		byView: {},
		children: {},
		toggle(view, dir, open) {
			patch(view, current => {
				const isOpen = current.expanded.includes(dir);
				const next = open ?? !isOpen;
				if (next === isOpen) return current;
				return { ...current, expanded: next ? [...current.expanded, dir] : current.expanded.filter(entry => entry !== dir) };
			});
			if (open !== false && !get().children[dir]) void get().load(dir);
		},
		open(view, path) {
			patch(view, current => ({ ...current, tabs: current.tabs.includes(path) ? current.tabs : [...current.tabs, path], active: path }));
		},
		close(view, path) {
			patch(view, current => {
				const index = current.tabs.indexOf(path);
				const tabs = current.tabs.filter(entry => entry !== path);
				const active = current.active === path ? (tabs[index] ?? tabs[index - 1] ?? null) : current.active;
				// With no tab left the tree fills the pane again, so it comes back for the next file opened from it.
				return { ...current, tabs, active, treeHidden: tabs.length > 0 && current.treeHidden };
			});
		},
		activate(view, path) {
			patch(view, current => ({ ...current, active: path }));
		},
		setTreeHidden(view, hidden) {
			patch(view, current => (current.treeHidden === hidden ? current : { ...current, treeHidden: hidden }));
		},
		setTreeWidth(view, width) {
			const treeWidth = Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, Math.round(width)));
			patch(view, current => (current.treeWidth === treeWidth ? current : { ...current, treeWidth }));
		},
		async load(dir) {
			try {
				const entries = await window.vomp.invoke("fs:list", dir);
				set(state => ({ children: { ...state.children, [dir]: entries.filter(entry => !Object.hasOwn(HIDDEN, entry.name)) } }));
			} catch {
				set(state => ({ children: { ...state.children, [dir]: "error" } }));
			}
		},
	};
});

// A closed chat's Files state goes with it.
useApp.subscribe((state, previous) => {
	if (state.tabs === previous.tabs) return;
	const { byView } = useFiles.getState();
	const gone = Object.keys(byView).filter(view => !view.startsWith(OVERVIEW_PREFIX) && !state.tabs.some(tab => tab.id === view));
	if (gone.length === 0) return;
	useFiles.setState({ byView: Object.fromEntries(Object.entries(byView).filter(([view]) => !gone.includes(view))) });
});

/**
 * Open a file or folder as a viewer tab in the Files pane (tool cards' "Open in Files", file links in
 * replies). Any absolute path works, inside the project or not; a trailing separator is dropped so
 * `dir/` and `dir` share one tab. `tabId` is the chat the request came from: its Files pane gets the tab
 * and its side panel opens on Files (`showPane`); without it, the panel on show (a chat's, or the
 * project overview's). A request from a chat that has closed since does nothing. `focus` hides that
 * pane's tree so the viewer takes the pane's width; without it the tree stays as the user left it.
 */
export function openInFiles(projectPath: string, path: string, options?: { focus?: boolean; tabId?: string | null }): void {
	const app = useApp.getState();
	const scope = options?.tabId ?? dockKey(app);
	const chat = scope === OVERVIEW_DOCK ? null : scope;
	if (chat && !app.tabs.some(tab => tab.id === chat)) return;
	const view = filesView(chat, projectPath);
	const files = useFiles.getState();
	files.open(view, path.replace(/(?<=[^\\/:])[\\/]+$/, ""));
	if (options?.focus) files.setTreeHidden(view, true);
	app.showPane("files", scope);
}
