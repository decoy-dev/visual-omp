import { DEFAULT_STATUS_BAR, LOCKED_STATUS_ITEMS, STATUS_BAR_ITEMS_078, STATUS_BAR_KNOWN_ITEMS, type StatusBarPreference } from "./statusBar";

/** Ignore damaged fields independently, de-duplicate ids and never hide recovery controls. */
export function normalizeStatusBar(value: unknown): StatusBarPreference {
	const stored = value && typeof value === "object" ? value as Partial<StatusBarPreference> : {};
	const ids = (value: unknown, fallback: readonly string[]) => Array.isArray(value)
		? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
		: [...fallback];
	const seen = ids(stored.seen, STATUS_BAR_ITEMS_078);
	const hidden = ids(stored.hidden, DEFAULT_STATUS_BAR.hidden);
	for (const id of DEFAULT_STATUS_BAR.hidden) if (!seen.includes(id) && !hidden.includes(id)) hidden.push(id);
	return {
		hidden: hidden.filter(id => !LOCKED_STATUS_ITEMS.some(locked => locked === id)),
		order: ids(stored.order, []),
		seen: [...new Set([...seen, ...STATUS_BAR_KNOWN_ITEMS])],
	};
}
