import type { SessionEntry } from "@oh-my-pi/pi-wire";

const MAX_SUMMARY = 100;

/** Markdown decoration that reads as noise in a one-line OS notification (links keep their text). */
const MARKDOWN_NOISE = /[`*_~#>|]|\[([^\]]*)\]\([^)]*\)/g;

/**
 * One-line outcome of the latest turn for a notification body: the first line of text in omp's
 * newest reply (after the last user message), without markdown, capped at 100 characters.
 * Null when omp replied only with tool calls, or not at all.
 */
export function outcomeSummary(entries: readonly SessionEntry[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const { message } = entry;
		if (message.role === "user") return null;
		if (message.role !== "assistant") continue;
		const text = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
		const line = text
			.split("\n")
			.map(part =>
				part
					.replace(MARKDOWN_NOISE, "$1")
					.replace(/^\s*(?:[-+]|\d+\.)\s+/, "")
					.replace(/\s+/g, " ")
					.trim(),
			)
			.find(part => part.length > 0);
		if (!line) continue;
		return line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…` : line;
	}
	return null;
}
