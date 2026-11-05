import { LOCKED_STATUS_ITEMS, type StatusBarPreference } from "@shared/statusBar";
import type { StatusItemSpec } from "../../registry/slots";

export function statusItemLocked(item: Pick<StatusItemSpec, "id" | "locked">): boolean {
	return item.locked === true || LOCKED_STATUS_ITEMS.some(id => id === item.id);
}

/** Unknown saved ids are harmless; newly registered items follow their registry order on their side. */
export function orderedStatusItems(items: readonly StatusItemSpec[], preference: StatusBarPreference): StatusItemSpec[] {
	const rank = new Map(preference.order.map((id, index) => [id, index]));
	return [...items].sort((a, b) => a.side.localeCompare(b.side) || (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.order - b.order);
}

export function visibleStatusItems(items: readonly StatusItemSpec[], preference: StatusBarPreference): StatusItemSpec[] {
	return orderedStatusItems(items, preference).filter(item => statusItemLocked(item) || !preference.hidden.includes(item.id));
}

