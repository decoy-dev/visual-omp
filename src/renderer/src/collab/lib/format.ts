/** Small pure formatting helpers shared across collab-web components. */

/** HTML-escape text destined for `dangerouslySetInnerHTML`. */
export function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** "$0.004", "$0.42", "$4.20" — tolerant of non-finite input. */
export function fmtCost(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
	return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/**
 * "847ms", "4.2s", "42s", "4m 05s", "1h 12m": the one duration style for rows and cards in the chat, matching
 * the "Worked for 1m 12s" line. Whole seconds are rounded before splitting, so 119.6s reads "2m 00s", never "1m 60s".
 */
export function fmtDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "0ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** "now", "42s ago", "5m ago", "3h ago", "2d ago". Input: epoch ms. */
export function relTime(tsMs: number): string {
	if (!Number.isFinite(tsMs)) return "";
	const delta = Date.now() - tsMs;
	if (delta < 10_000) return "now";
	const s = Math.floor(delta / 1000);
	if (s < 60) return `${s}s ago`;
	const min = Math.floor(s / 60);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/** "73%" from a 0–100 percent; em dash for null/non-finite. */
export function fmtPercent(p: number | null | undefined): string {
	if (p === null || p === undefined || !Number.isFinite(p)) return "—";
	return `${Math.round(Math.min(100, Math.max(0, p)))}%`;
}

/** Home-relative, middle-elided path: "~/…/packages/collab-web". */
export function shortenPath(p: string): string {
	if (typeof p !== "string" || p.length === 0) return "";
	let out = p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
	const segs = out.split("/");
	if (segs.length > 4) out = `${segs[0]}/…/${segs.slice(-2).join("/")}`;
	return out;
}
