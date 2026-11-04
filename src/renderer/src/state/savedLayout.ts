/**
 * The window layout as `useApp` saves it to localStorage, read back field by field. The data comes from disk and may
 * be from another version or damaged, so a field that is missing or of the wrong type keeps the app's default and a
 * damaged chat entry is dropped, instead of the whole window failing to open.
 */
import { isRecord } from "../tool-render/util";
import { restoreUnseen } from "../features/onboarding/attention";
import type { AppState } from "./app";
import { layoutFrom, OVERVIEW_DOCK, restoreLayouts, withLayout } from "./dockLayout";

type SavedLayout = Partial<Pick<AppState, "tabs" | "unseenChats" | "activeTabId" | "splitTabId" | "focusedSplit" | "activeProject" | "sidebarOpen" | "sidebarWidth" | "docks" | "expandedProjects">>;

function isStringArray(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	for (const item of value) if (typeof item !== "string") return false;
	return true;
}

/** What `merge` takes from the saved layout; anything unusable is left out, so the default stays. */
export function readSavedLayout(saved: unknown): SavedLayout {
	if (!isRecord(saved)) return {};
	const entries = Array.isArray(saved.tabs) ? saved.tabs : [];
	const tabs = entries.flatMap(entry => {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.projectPath !== "string"
			|| typeof entry.sessionFile !== "string" || !(typeof entry.title === "string" || entry.title === null)) return [];
		return [{ id: entry.id, projectPath: entry.projectPath, sessionFile: entry.sessionFile, title: entry.title }];
	});
	const nullableString = (value: unknown): string | null => typeof value === "string" ? value : null;
	const { unseenChats, docks, sidebarOpen, sidebarWidth, expandedProjects } = saved;
	return {
		activeTabId: nullableString(saved.activeTabId),
		splitTabId: nullableString(saved.splitTabId),
		focusedSplit: saved.focusedSplit === "secondary" ? "secondary" : "primary",
		activeProject: nullableString(saved.activeProject),
		tabs,
		unseenChats: restoreUnseen(unseenChats, tabs.map(tab => tab.id)),
		docks: restoreLayouts(docks, tabs.map(tab => tab.id)),
		...(typeof sidebarOpen === "boolean" ? { sidebarOpen } : {}),
		...(typeof sidebarWidth === "number" && Number.isFinite(sidebarWidth) ? { sidebarWidth } : {}),
		...(isStringArray(expandedProjects) ? { expandedProjects: [...expandedProjects] } : {}),
	};
}

/**
 * The saved layout from version 1, when one panel layout served every chat (`dockOpen`, `dockPane`, `dockWidth`). It
 * becomes the overview's layout, so Home and project overviews keep it; restored chats start with the panel closed
 * at the default width. Anything that is not an object comes back empty, which `readSavedLayout` reads as defaults.
 */
export function migrateSavedLayout(saved: unknown): Record<string, unknown> {
	if (!isRecord(saved)) return {};
	// Migration keeps the persisted format's string-keyed, plain-record boundary.
	const constructor = saved.constructor;
	if (typeof constructor === "function" && (!isRecord(constructor.prototype) || !Object.hasOwn(constructor.prototype, "isPrototypeOf"))) return {};
	const record: Record<string, unknown> = {};
	for (const key of Reflect.ownKeys(saved)) {
		if (!Object.prototype.propertyIsEnumerable.call(saved, key) || key === "__proto__") continue;
		if (typeof key !== "string") return {};
		record[key] = saved[key];
	}
	const { dockOpen, dockPane, dockWidth, ...rest } = record;
	const layout = layoutFrom({ open: dockOpen, pane: dockPane, width: dockWidth });
	return { ...rest, docks: layout ? withLayout({}, OVERVIEW_DOCK, layout) : {} };
}
