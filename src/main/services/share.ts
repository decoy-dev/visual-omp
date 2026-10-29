import { isAbsolute } from "node:path";
import type { AnonymizedCopyResult, ShareLinkResult } from "@shared/contracts/share";

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

/** `session pack` and `session unpack` print exactly one absolute path on stdout. */
export function parseTransferOutput(stdout: string): string | null {
	const path = stdout.replace(/\r?\n$/, "");
	return path && !/[\r\n]/.test(path) && isAbsolute(path) ? path : null;
}

/** `omp anonymize` prints a completion line followed by review notes and any skipped transcripts. */
export function parseAnonymizeOutput(stdout: string): Omit<AnonymizedCopyResult, "report"> | null {
	const match = /^Anonymized ([1-9]\d*) transcripts? → (.+?)\r?$/m.exec(stdout);
	if (!match) return null;
	const path = match[2]!;
	const transcriptCount = Number(match[1]);
	return isAbsolute(path) && Number.isSafeInteger(transcriptCount) ? { path, transcriptCount } : null;
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
