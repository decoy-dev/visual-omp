import type { StatusBarPreference } from "@shared/statusBar";
import { normalizeStatusBar } from "@shared/statusBarPreference";
import type { StatusItemSpec } from "../../registry/slots";
import { orderedStatusItems, statusItemLocked } from "./layout";

export function showStatusItem(preference: StatusBarPreference, item: StatusItemSpec, show: boolean): StatusBarPreference {
	const current = normalizeStatusBar(preference);
	return { ...current, hidden: show || statusItemLocked(item) ? current.hidden.filter(id => id !== item.id) : [...new Set([...current.hidden, item.id])] };
}

/** Reorder within the existing left or right group, including hidden entries. */
export function moveStatusItem(items: readonly StatusItemSpec[], preference: StatusBarPreference, id: string, to: number): StatusBarPreference {
	const ordered = orderedStatusItems(items, preference);
	const item = ordered.find(item => item.id === id);
	if (!item) return preference;
	const group = ordered.filter(candidate => candidate.side === item.side);
	const from = group.findIndex(candidate => candidate.id === id);
	const target = Math.max(0, Math.min(group.length - 1, to));
	if (target === from) return preference;
	group.splice(from, 1);
	group.splice(target, 0, item);
	return { ...preference, order: ordered.filter(candidate => candidate.side !== item.side).concat(group).map(candidate => candidate.id) };
}
