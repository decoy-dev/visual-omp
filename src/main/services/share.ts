import type { ShareLinkResult } from "@shared/contracts/share";

/**
 * Parse `omp share` stdout (omp has no JSON mode for it):
 * `Share URL: <url>`, optional `Gist: <url>`, optional `Note: large content was trimmed …`.
 */
export function parseShareOutput(stdout: string): ShareLinkResult | null {
	const url = /^Share URL:\s*(\S+)/m.exec(stdout)?.[1];
	if (!url) return null;
	return {
		url,
		gistUrl: /^Gist:\s*(\S+)/m.exec(stdout)?.[1] ?? null,
		truncated: /^Note: large content was trimmed/m.test(stdout),
	};
}

/** Parse `omp --export` stdout: `Exported to: <path>` (the path may contain spaces). */
export function parseExportOutput(stdout: string): string | null {
	return /^Exported to:\s*(.+?)\s*$/m.exec(stdout)?.[1] ?? null;
}

/** A filesystem-safe default file name for a session export. */
export function exportFileName(title: string | null, sessionId: string): string {
	const base = (title ?? "")
		.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80)
		.replace(/[. ]+$/, "");
	return `${base || `omp-session-${sessionId.slice(0, 8)}`}.html`;
}
