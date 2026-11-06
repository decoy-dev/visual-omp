/** One status-bar layout for every project and chat. Missing fields retain today's items. */
export interface StatusBarPreference {
	hidden: string[];
	order: string[];
	/** Item ids known when this layout was last read. Absent on 0.7.8 layouts. */
	seen?: string[];
}

export const LOCKED_STATUS_ITEMS = ["app.update", "omp.status"] as const;
export const OPTIONAL_STATUS_ITEMS = ["chat.context", "chat.model", "chat.thinking", "chat.queue", "chat.time", "chat.helpers", "chat.cache"] as const;
/** Frozen migration baseline: these registrations shipped before layouts recorded seen ids. */
export const STATUS_BAR_ITEMS_078 = [
	"git.branch", "git.changes", "git.pr", "projects.shared", "usage-limits",
	"app.update", "omp.status", "app.cpu", "app.memory",
	"chat.context", "chat.model", "chat.thinking", "chat.queue", "chat.time", "chat.helpers",
] as const;
export const STATUS_BAR_KNOWN_ITEMS = [...new Set<string>([...STATUS_BAR_ITEMS_078, ...OPTIONAL_STATUS_ITEMS])];
export const DEFAULT_STATUS_BAR: StatusBarPreference = { hidden: [...OPTIONAL_STATUS_ITEMS], order: [], seen: STATUS_BAR_KNOWN_ITEMS };

