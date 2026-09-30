import { stat } from "node:fs/promises";
import type { MemoryEntrySummary, MemoryListOptions, MemoryListResult } from "@shared/contracts/memory";

const PREVIEW_CHARS = 280;
export const DEFAULT_LIST_LIMIT = 200;

/** Whitespace-collapsed head of `text` for list rows. */
export function preview(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : collapsed;
}

/**
 * Epoch ms of a stored timestamp: ISO strings, SQLite `CURRENT_TIMESTAMP` text (`YYYY-MM-DD HH:MM:SS`,
 * UTC without a zone marker) or epoch seconds/ms numbers. Null when absent or unparseable.
 */
export function parseTimestamp(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
	const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
	const ms = Date.parse(sqliteUtc);
	return Number.isNaN(ms) ? null : ms;
}

/** mtime in whole epoch ms, or null when the file is missing. */
export async function mtimeMs(path: string): Promise<number | null> {
	return stat(path).then(
		s => Math.trunc(s.mtimeMs),
		() => null,
	);
}

/** Apply the text filter and pagination of `memory:list` to fully materialized file-backed entries. */
export function paginate(
	entries: Array<MemoryEntrySummary & { text: string }>,
	options: MemoryListOptions,
): MemoryListResult {
	const query = options.query?.trim().toLowerCase();
	const matching = query ? entries.filter(entry => entry.text.toLowerCase().includes(query)) : entries;
	const offset = Math.max(0, options.offset ?? 0);
	const limit = Math.max(0, options.limit ?? DEFAULT_LIST_LIMIT);
	return {
		entries: matching.slice(offset, offset + limit).map(({ text: _text, ...summary }) => summary),
		total: matching.length,
	};
}
