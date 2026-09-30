/** Pure helpers for the usage dashboard. */
import type { SpendChat } from "@shared/contracts/extensions";
import type { UsageLimit } from "@shared/contracts/usage";
import { toCsv } from "../format";

/** omp's used-fraction resolution order (see `UsageLimit`); null when the limit reports nothing usable. */
export function usedFraction(limit: UsageLimit): number | null {
	const { amount } = limit;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) return amount.used / amount.limit;
	if (amount.used !== undefined && amount.unit === "percent") return amount.used / 100;
	if (amount.remainingFraction !== undefined) return 1 - amount.remainingFraction;
	return null;
}

/** DESIGN §4.18: ok below 70%, warn from 70%, err from 90% (or when the provider says exhausted). */
export function limitTone(fraction: number | null, status: UsageLimit["status"]): "ok" | "warn" | "err" {
	if (status === "exhausted" || (fraction ?? 0) >= 0.9) return "err";
	if (status === "warning" || (fraction ?? 0) >= 0.7) return "warn";
	return "ok";
}

export type ChatSortKey = "title" | "model" | "inputTokens" | "outputTokens" | "cost" | "durationMs";
export type SortDirection = "asc" | "desc";

/** Prompt tokens as the table shows them: fresh input plus cache reads and writes. */
export function promptTokens(chat: SpendChat): number {
	return chat.inputTokens + chat.cacheReadTokens + chat.cacheWriteTokens;
}

export function sortChats(chats: readonly SpendChat[], key: ChatSortKey, direction: SortDirection): SpendChat[] {
	const sign = direction === "asc" ? 1 : -1;
	return [...chats].sort((a, b) => {
		if (key === "title" || key === "model") {
			const left = (a[key] ?? "").toLocaleLowerCase();
			const right = (b[key] ?? "").toLocaleLowerCase();
			// Untitled rows stay at the bottom whichever way the column is sorted.
			if (!left !== !right) return left ? -1 : 1;
			return sign * left.localeCompare(right);
		}
		if (key === "inputTokens") return sign * (promptTokens(a) - promptTokens(b));
		return sign * (a[key] - b[key]);
	});
}

export function chatsCsv(chats: readonly SpendChat[], untitled: string): string {
	return toCsv(
		["chat", "project", "model", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "requests", "duration_s", "first_activity", "last_activity", "session_file"],
		chats.map(chat => [
			chat.title ?? untitled,
			chat.cwd,
			chat.model ?? "",
			chat.inputTokens,
			chat.outputTokens,
			chat.cacheReadTokens,
			chat.cacheWriteTokens,
			chat.cost.toFixed(4),
			chat.requests,
			Math.round(chat.durationMs / 1000),
			new Date(chat.firstAt).toISOString(),
			new Date(chat.lastAt).toISOString(),
			chat.file,
		]),
	);
}
