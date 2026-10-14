/**
 * What the Usage & limits page shows: open provider rows, range, table sort, table filters, table page,
 * scroll position and the last recorded-usage summary. Kept for the session (not saved to disk), so
 * opening a chat from the table and coming back finds the report as it was left.
 */
import type { SpendSummary } from "@shared/contracts/extensions";
import { create } from "zustand";
import type { ChatFilters, ChatSortKey, SortDirection, UsageRange } from "./model";

/**
 * Read once when the page opens, so they stay outside the reactive store: saving the position on
 * every scroll event would otherwise re-render the table.
 */
export const usageMemory: { scrollTop: number; spend: SpendSummary | null } = { scrollTop: 0, spend: null };

export interface ChatSort {
	key: ChatSortKey;
	direction: SortDirection;
}

interface UsageViewState extends ChatFilters {
	range: UsageRange;
	sort: ChatSort;
	/** Zero-based table page. */
	page: number;
	/** Providers whose limits row is open to its account and window detail. */
	expanded: ReadonlySet<string>;
	setExpanded(provider: string, open: boolean): void;
	setRange(range: UsageRange): void;
	setSort(sort: ChatSort): void;
	setFilters(filters: Partial<ChatFilters>): void;
	clearFilters(): void;
	setPage(page: number): void;
}

/** Cost, highest first: the default investigative sort. */
export const DEFAULT_SORT: ChatSort = { key: "cost", direction: "desc" };

/** Changing what the table lists returns it to the first page. */
export const useUsageView = create<UsageViewState>()(set => ({
	range: 7,
	sort: DEFAULT_SORT,
	query: "",
	project: null,
	model: null,
	page: 0,
	expanded: new Set(),
	setExpanded: (provider, open) =>
		set(state => {
			const expanded = new Set(state.expanded);
			if (open) expanded.add(provider);
			else expanded.delete(provider);
			return { expanded };
		}),
	setRange: range => set({ range, page: 0 }),
	setSort: sort => set({ sort, page: 0 }),
	setFilters: filters => set({ ...filters, page: 0 }),
	clearFilters: () => set({ query: "", project: null, model: null, page: 0 }),
	setPage: page => set({ page }),
}));
