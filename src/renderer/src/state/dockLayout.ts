/**
 * The side panel's layout (open or closed, the pane it shows, its width) belongs to the chat it opened in. Each open
 * chat has its own, keyed by its open-chat id; Home, project overviews and pages that did not come from a chat share
 * one (`OVERVIEW_DOCK`). A chat with no entry shows the panel closed at the default width, and only layouts that
 * differ from the default are stored, so the map holds no more than the chats whose panel someone touched.
 */
import type { MainView } from "./app";

export interface DockLayout {
	open: boolean;
	/** Pane id (`diff`, `files`, `tasks`…). */
	pane: string;
	width: number;
}

export type DockLayouts = Readonly<Record<string, DockLayout>>;

export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 640;
export const DEFAULT_DOCK: DockLayout = { open: false, pane: "diff", width: 420 };
/** Key of the layout the views that are not one chat share. Open-chat ids start with `t`, so it never clashes. */
export const OVERVIEW_DOCK = "overview";

/**
 * Whose layout shows: the focused chat's in the chat view (the focused half of a split) and on a page opened from
 * a chat, which returns to it; the shared overview layout everywhere else.
 */
export function dockScope(view: MainView, pageReturn: Exclude<MainView, "page">, focusedChat: string | null): string {
	const chat = view === "chat" || (view === "page" && pageReturn === "chat");
	return chat && focusedChat ? focusedChat : OVERVIEW_DOCK;
}

export function layoutFor(docks: DockLayouts, key: string): DockLayout {
	return docks[key] ?? DEFAULT_DOCK;
}

function clampWidth(width: number): number {
	return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)));
}

/**
 * A chat that was only viewed goes back to being a saved row when the user leaves it (`releaseIfUnused`), unless its
 * panel is open or was resized: then it stays open, so the panel is there when the user comes back. Which pane a
 * closed panel would show is not worth keeping a chat open for.
 */
export function keepsChatOpen(layout: DockLayout): boolean {
	return layout.open || layout.width !== DEFAULT_DOCK.width;
}

function isDefault(layout: DockLayout): boolean {
	return layout.open === DEFAULT_DOCK.open && layout.pane === DEFAULT_DOCK.pane && layout.width === DEFAULT_DOCK.width;
}

/** `docks` with `patch` applied to `key`'s layout; the same object when nothing changes, and no entry once it is the default again. */
export function withLayout(docks: DockLayouts, key: string, patch: Partial<DockLayout>): DockLayouts {
	const current = layoutFor(docks, key);
	const next: DockLayout = { ...current, ...patch, ...(patch.width === undefined ? {} : { width: clampWidth(patch.width) }) };
	if (next.open === current.open && next.pane === current.pane && next.width === current.width) return docks;
	const { [key]: _replaced, ...rest } = docks;
	return isDefault(next) ? rest : { ...rest, [key]: next };
}

/** `docks` with `from`'s layout moved to `to` (a chat that moved to another folder keeps its panel). */
export function moveLayout(docks: DockLayouts, from: string, to: string): DockLayouts {
	const { [from]: moved, ...rest } = docks;
	return moved ? { ...rest, [to]: moved } : docks;
}

/** Only the layouts of the given open chats and the overview's: what a closed chat had goes with it. */
export function keepLayouts(docks: DockLayouts, chatIds: readonly string[]): DockLayouts {
	const kept = Object.entries(docks).filter(([key]) => key === OVERVIEW_DOCK || chatIds.includes(key));
	return kept.length === Object.keys(docks).length ? docks : Object.fromEntries(kept);
}

/** A saved layout read back, or null when any field is missing or of the wrong type. */
export function layoutFrom(value: unknown): DockLayout | null {
	if (typeof value !== "object" || value === null || !("open" in value) || !("pane" in value) || !("width" in value)) return null;
	const { open, pane, width } = value;
	if (typeof open !== "boolean" || typeof pane !== "string" || typeof width !== "number" || !Number.isFinite(width)) return null;
	return { open, pane, width: clampWidth(width) };
}

/** Saved layouts read back for the restored chats (and the overview); anything malformed or for a chat that is gone is dropped. */
export function restoreLayouts(saved: unknown, chatIds: readonly string[]): DockLayouts {
	if (typeof saved !== "object" || saved === null) return {};
	const restored: Record<string, DockLayout> = {};
	for (const [key, value] of Object.entries(saved)) {
		const layout = layoutFrom(value);
		if (layout && !isDefault(layout) && (key === OVERVIEW_DOCK || chatIds.includes(key))) restored[key] = layout;
	}
	return restored;
}
