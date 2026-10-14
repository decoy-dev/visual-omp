/**
 * How often each command has been run, so the empty palette can suggest the user's favourites.
 * Stored in localStorage; counts only (no timestamps, no arguments).
 */
const STORAGE_KEY = "visual-omp:command-usage";

/** The stored counts; anything else (hand-edited, older format) counts as no history. */
function load(): Record<string, number> {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return Object.values(parsed).every(count => typeof count === "number") ? (parsed as Record<string, number>) : {};
	} catch {
		return {};
	}
}

export function recordUse(commandId: string): void {
	const usage = load();
	usage[commandId] = (usage[commandId] ?? 0) + 1;
	localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
}

/**
 * Up to `limit` ids from `available`, most used first. Never-used favourites from `fallback` fill the
 * remaining places so a new user still sees useful suggestions.
 */
export function mostUsed(available: readonly string[], fallback: readonly string[], limit = 5): string[] {
	const usage = load();
	const allowed = new Set(available);
	const used = available
		.filter(id => (usage[id] ?? 0) > 0)
		.sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0))
		.slice(0, limit);
	for (const id of fallback) {
		if (used.length >= limit) break;
		if (allowed.has(id) && !used.includes(id)) used.push(id);
	}
	return used;
}
