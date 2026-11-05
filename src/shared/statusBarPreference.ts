import { DEFAULT_STATUS_BAR, LOCKED_STATUS_ITEMS, type StatusBarPreference } from "./statusBar";

/** Ignore damaged fields independently, de-duplicate ids and never hide recovery controls. */
export function normalizeStatusBar(value: unknown): StatusBarPreference {
	const stored = value && typeof value === "object" ? value as Partial<StatusBarPreference> : {};
	const ids = (value: unknown, fallback: readonly string[]) => Array.isArray(value)
		? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
		: [...fallback];
	return {
		hidden: ids(stored.hidden, DEFAULT_STATUS_BAR.hidden).filter(id => !LOCKED_STATUS_ITEMS.some(locked => locked === id)),
		order: ids(stored.order, []),
	};
}
