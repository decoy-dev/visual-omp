/**
 * The window layout as `useApp` saves it to localStorage, read back field by field. The data comes from disk and may
 * be from another version or damaged, so a field that is missing or of the wrong type keeps the app's default and a
 * damaged chat entry is dropped, instead of the whole window failing to open.
 */
import { z } from "zod";
import type { AppState } from "./app";
import { layoutFrom, OVERVIEW_DOCK, restoreLayouts, withLayout } from "./dockLayout";

/** A saved open chat. Only chats with a session file are saved; one without has nothing to restore. */
const SavedTab = z.object({ id: z.string(), projectPath: z.string(), sessionFile: z.string(), title: z.string().nullable() });

const Saved = z.object({
	tabs: z.array(z.unknown()).catch([]),
	activeTabId: z.string().nullable().catch(null),
	splitTabId: z.string().nullable().catch(null),
	focusedSplit: z.enum(["primary", "secondary"]).catch("primary"),
	activeProject: z.string().nullable().catch(null),
	sidebarOpen: z.boolean().optional().catch(undefined),
	sidebarWidth: z.number().optional().catch(undefined),
	/** Checked entry by entry in `restoreLayouts`. */
	docks: z.unknown().optional(),
	expandedProjects: z.array(z.string()).optional().catch(undefined),
});

type SavedLayout = Partial<Pick<AppState, "tabs" | "activeTabId" | "splitTabId" | "focusedSplit" | "activeProject" | "sidebarOpen" | "sidebarWidth" | "docks" | "expandedProjects">>;

/** What `merge` takes from the saved layout; anything unusable is left out, so the default stays. */
export function readSavedLayout(saved: unknown): SavedLayout {
	const parsed = Saved.safeParse(saved);
	if (!parsed.success) return {};
	const { tabs: entries, docks, sidebarOpen, sidebarWidth, expandedProjects, ...selection } = parsed.data;
	const tabs = entries.flatMap(entry => {
		const tab = SavedTab.safeParse(entry);
		return tab.success ? [tab.data] : [];
	});
	return {
		...selection,
		tabs,
		docks: restoreLayouts(docks, tabs.map(tab => tab.id)),
		...(sidebarOpen === undefined ? {} : { sidebarOpen }),
		...(sidebarWidth === undefined ? {} : { sidebarWidth }),
		...(expandedProjects === undefined ? {} : { expandedProjects }),
	};
}

/**
 * The saved layout from version 1, when one panel layout served every chat (`dockOpen`, `dockPane`, `dockWidth`). It
 * becomes the overview's layout, so Home and project overviews keep it; restored chats start with the panel closed
 * at the default width. Anything that is not an object comes back empty, which `readSavedLayout` reads as defaults.
 */
export function migrateSavedLayout(saved: unknown): Record<string, unknown> {
	const parsed = z.record(z.string(), z.unknown()).safeParse(saved);
	if (!parsed.success) return {};
	const { dockOpen, dockPane, dockWidth, ...rest } = parsed.data;
	const layout = layoutFrom({ open: dockOpen, pane: dockPane, width: dockWidth });
	return { ...rest, docks: layout ? withLayout({}, OVERVIEW_DOCK, layout) : {} };
}
