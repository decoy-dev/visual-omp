/**
 * Files pane state that outlives the pane (expanded folders, viewer tabs, folder listings) and
 * `openInFiles`, which the transcript and the Outputs pane call without loading the pane itself.
 */
import { create } from "zustand";
import type { DirEntry } from "@shared/ipc";
import { useApp } from "../../state/app";

const HIDDEN: Record<string, true> = { ".git": true, node_modules: true };

interface ProjectFiles {
	expanded: string[];
	tabs: string[];
	active: string | null;
	/** The tree is hidden so the viewer takes the pane's width (only while tabs are open). */
	treeHidden: boolean;
}

interface FilesState {
	byProject: Record<string, ProjectFiles>;
	children: Record<string, DirEntry[] | "error">;
	toggle(project: string, dir: string, open?: boolean): void;
	open(project: string, path: string): void;
	close(project: string, path: string): void;
	activate(project: string, path: string): void;
	setTreeHidden(project: string, hidden: boolean): void;
	load(dir: string): Promise<void>;
}

export const EMPTY_PROJECT: ProjectFiles = { expanded: [], tabs: [], active: null, treeHidden: false };

export const useFiles = create<FilesState>((set, get) => {
	const patch = (project: string, change: (current: ProjectFiles) => ProjectFiles) =>
		set(state => ({ byProject: { ...state.byProject, [project]: change(state.byProject[project] ?? EMPTY_PROJECT) } }));
	return {
		byProject: {},
		children: {},
		toggle(project, dir, open) {
			patch(project, current => {
				const isOpen = current.expanded.includes(dir);
				const next = open ?? !isOpen;
				if (next === isOpen) return current;
				return { ...current, expanded: next ? [...current.expanded, dir] : current.expanded.filter(entry => entry !== dir) };
			});
			if (open !== false && !get().children[dir]) void get().load(dir);
		},
		open(project, path) {
			patch(project, current => ({ ...current, tabs: current.tabs.includes(path) ? current.tabs : [...current.tabs, path], active: path }));
		},
		close(project, path) {
			patch(project, current => {
				const index = current.tabs.indexOf(path);
				const tabs = current.tabs.filter(entry => entry !== path);
				const active = current.active === path ? (tabs[index] ?? tabs[index - 1] ?? null) : current.active;
				// With no tab left the tree fills the pane again, so it comes back for the next file opened from it.
				return { ...current, tabs, active, treeHidden: tabs.length > 0 && current.treeHidden };
			});
		},
		activate(project, path) {
			patch(project, current => ({ ...current, active: path }));
		},
		setTreeHidden(project, hidden) {
			patch(project, current => (current.treeHidden === hidden ? current : { ...current, treeHidden: hidden }));
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

/**
 * Open a file or folder as a viewer tab in the Files pane (tool cards' "Open in Files", file links in
 * replies). Any absolute path works, inside the project or not; a trailing separator is dropped so
 * `dir/` and `dir` share one tab. `focus` hides the project's tree so the viewer takes the pane's
 * width; without it the tree stays as the user left it.
 */
export function openInFiles(projectPath: string, path: string, options?: { focus?: boolean }): void {
	const files = useFiles.getState();
	files.open(projectPath, path.replace(/(?<=[^\\/:])[\\/]+$/, ""));
	if (options?.focus) files.setTreeHidden(projectPath, true);
	useApp.getState().showPane("files");
}
