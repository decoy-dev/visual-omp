/** File mentions use omp's file-mentions.ts grammar and boundary rule. */
const MENTION_BOUNDARY = /[\s([{<"'`]/;

export function isMentionBoundary(text: string, index: number): boolean {
	return index === 0 || MENTION_BOUNDARY.test(text[index - 1] ?? "");
}

/** Match omp's picker, leaving quoted directory completions open so typing can continue. */
export function formatFileMention(path: string, options: { isDirectory?: boolean; isQuotedPrefix?: boolean } = {}): string {
	const needsQuotes = options.isQuotedPrefix || /\s/.test(path) || path.includes('"') || path.startsWith("'");
	if (!needsQuotes) return `@${path}`;
	// omp has no quote escaping. Preserve an unrepresentable path as plain text instead of a truncated mention.
	if (path.includes('"') && path.includes("'")) return path;
	const quote = path.includes('"') ? "'" : '"';
	return `@${quote}${path}${options.isDirectory ? "" : quote}`;
}

export interface FileMention {
	start: number;
	end: number;
	path: string;
	quoted: boolean;
}

/** Complete tokens only; unquoted paths retain omp's whitespace-delimited behavior. */
export function fileMentions(text: string): FileMention[] {
	const found: FileMention[] = [];
	for (const match of text.matchAll(/@(?:"([^"]+)"|'([^']+)'|([^\s@]+))/g)) {
		if (!isMentionBoundary(text, match.index)) continue;
		found.push({ start: match.index, end: match.index + match[0].length, path: match[1] ?? match[2] ?? match[3]!, quoted: match[1] !== undefined || match[2] !== undefined });
	}
	return found;
}
