/**
 * Fuzzy file matching for the @-mention picker: every query character must appear in order in the
 * path. Matches in the file name, at word starts and in consecutive runs rank higher; shorter paths
 * break ties.
 */

import { fileMentions, isMentionBoundary } from "../fileMentions";

export interface FuzzyMatch {
	path: string;
	score: number;
	/** Indices into `path` of the matched characters (for highlighting). */
	positions: number[];
}

const BOUNDARY = /[/_\-. ]/;

function scorePath(path: string, query: string): FuzzyMatch | null {
	const lower = path.toLowerCase();
	const nameStart = lower.lastIndexOf("/") + 1;
	const positions: number[] = [];
	let score = 0;
	let from = 0;
	let previous = -2;
	for (const char of query) {
		const index = lower.indexOf(char, from);
		if (index < 0) return null;
		positions.push(index);
		if (index === previous + 1) score += 6;
		if (index === 0 || BOUNDARY.test(lower[index - 1] ?? "")) score += 8;
		if (index >= nameStart) score += 4;
		score -= Math.min(index - from, 10) * 0.2;
		previous = index;
		from = index + 1;
	}
	// A query found wholly inside the file name beats one spread across folders.
	if (lower.slice(nameStart).includes(query)) score += 20;
	score -= path.length * 0.05;
	return { path, score, positions };
}

/** Best `limit` matches for `query` (case-insensitive). An empty query lists the shortest paths. */
export function fuzzyFiles(files: readonly string[], query: string, limit = 50): FuzzyMatch[] {
	const needle = query.trim().toLowerCase();
	if (!needle) {
		return [...files]
			.sort((a, b) => a.length - b.length || a.localeCompare(b))
			.slice(0, limit)
			.map(path => ({ path, score: 0, positions: [] }));
	}
	const matches: FuzzyMatch[] = [];
	for (const path of files) {
		const match = scorePath(path, needle);
		if (match) matches.push(match);
	}
	matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return matches.slice(0, limit);
}

/** The live query at the caret, including spaces inside an unclosed quoted prefix. */
export function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
	const before = text.slice(0, caret);
	for (const match of before.matchAll(/@(?:"([^"]*)|'([^']*)|((?!["'])[^\s@]*))$/g)) {
		if (isMentionBoundary(before, match.index)) return { start: match.index, query: match[1] ?? match[2] ?? match[3] ?? "" };
	}
	return null;
}

/** Ranges of `@path` mention tokens in `text` (for the chip highlight layer). */
export function mentionRanges(text: string): Array<{ start: number; end: number }> {
	return fileMentions(text).map(({ start, end }) => ({ start, end }));
}
