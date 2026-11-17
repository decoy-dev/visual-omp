/**
 * The token count at which omp summarizes a chat (omp's fixed `compaction.thresholdTokens`). The app sets it
 * globally in omp's config and per chat through the chat's own config overlay.
 */

/** A stored compaction point: a positive whole token count, or null for omp's own settings. */
export function compactAtValue(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** "400K", "1.2M": how the app shows a token count. */
export function formatCompactAt(tokens: number): string {
	return tokens.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
}
