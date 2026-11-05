/** One status-bar layout for every project and chat. Missing fields retain today's items. */
export interface StatusBarPreference {
	hidden: string[];
	order: string[];
}

export const LOCKED_STATUS_ITEMS = ["app.update", "omp.status"] as const;
export const OPTIONAL_STATUS_ITEMS = ["chat.context", "chat.model", "chat.thinking", "chat.queue", "chat.time", "chat.helpers"] as const;
export const DEFAULT_STATUS_BAR: StatusBarPreference = { hidden: [...OPTIONAL_STATUS_ITEMS], order: [] };

