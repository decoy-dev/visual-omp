/**
 * Token-level ("word") diff for paired removed/added lines, so the Diff pane can emphasize exactly
 * what changed inside a line (`--diff-*-line` over the `--diff-*-bg` row tint).
 */
import type { GitDiffLine } from "@shared/contracts/git";

/** Half-open [start, end) character range. */
export type Range = readonly [number, number];

/** Longer lines skip the O(n·m) token LCS and just tint the whole row. */
const MAX_TOKENS = 400;

const TOKEN = /\w+|\s+|[^\w\s]/g;

function mergeRanges(ranges: Range[]): Range[] {
	const merged: [number, number][] = [];
	for (const [start, end] of ranges) {
		const last = merged[merged.length - 1];
		if (last && last[1] === start) last[1] = end;
		else merged.push([start, end]);
	}
	return merged;
}

/** Changed character ranges in `before` and `after`; empty arrays when the lines are identical. */
export function wordDiff(before: string, after: string): { removed: Range[]; added: Range[] } {
	const a = before.match(TOKEN) ?? [];
	const b = after.match(TOKEN) ?? [];
	if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
		return { removed: before ? [[0, before.length]] : [], added: after ? [[0, after.length]] : [] };
	}
	// LCS table over tokens, filled from the end so the walk below goes forward.
	const width = b.length + 1;
	const table = new Uint16Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
		}
	}
	const removed: Range[] = [];
	const added: Range[] = [];
	let i = 0;
	let j = 0;
	let offA = 0;
	let offB = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			offA += a[i++].length;
			offB += b[j++].length;
		} else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
			added.push([offB, offB + b[j].length]);
			offB += b[j++].length;
		} else {
			removed.push([offA, offA + a[i].length]);
			offA += a[i++].length;
		}
	}
	return { removed: mergeRanges(removed), added: mergeRanges(added) };
}

/**
 * Emphasis ranges per line index of a hunk: each run of deletions directly followed by additions
 * is paired line-by-line (1st − with 1st +, …). Unpaired lines get no inner emphasis.
 */
export function hunkEmphasis(lines: readonly GitDiffLine[]): Map<number, Range[]> {
	const emphasis = new Map<number, Range[]>();
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind !== "del") {
			i++;
			continue;
		}
		const delStart = i;
		while (i < lines.length && lines[i].kind === "del") i++;
		const addStart = i;
		while (i < lines.length && lines[i].kind === "add") i++;
		const pairs = Math.min(addStart - delStart, i - addStart);
		for (let k = 0; k < pairs; k++) {
			const { removed, added } = wordDiff(lines[delStart + k].text, lines[addStart + k].text);
			emphasis.set(delStart + k, removed);
			emphasis.set(addStart + k, added);
		}
	}
	return emphasis;
}
