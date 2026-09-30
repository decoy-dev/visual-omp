/** Palette ranking: plain-language titles first, then aliases, hints and the omp slash command. */
import { defaultFilter } from "cmdk";

export interface SearchText {
	/** Primary label (plain-language title). */
	text: string;
	/** Aliases, hint, slash command, project name… */
	keywords: readonly string[];
}

/**
 * cmdk scores word-prefix hits ≥ ~0.15 and letters scattered through a long title or alias list
 * below ~0.03; those scattered hits are noise, not matches.
 */
const MIN_SCORE = 0.05;

/**
 * Items matching `query`, best first (stable for ties). An empty query keeps every item in order.
 * A title match always beats an alias-only match of the same quality.
 */
export function rank<T>(items: readonly T[], query: string, describe: (item: T) => SearchText, limit = Number.POSITIVE_INFINITY): T[] {
	const search = query.trim();
	if (!search) return items.slice(0, limit);
	const scored: Array<{ item: T; score: number; index: number }> = [];
	items.forEach((item, index) => {
		const { text, keywords } = describe(item);
		const title = defaultFilter(text, search);
		const alias = title >= MIN_SCORE ? 0 : defaultFilter(text, search, [...keywords]);
		const score = title >= MIN_SCORE ? 1 + title : alias >= MIN_SCORE ? alias : 0;
		if (score > 0) scored.push({ item, score, index });
	});
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	return scored.slice(0, limit).map(entry => entry.item);
}

/** Fuzzy path hits (abbreviations, typos) must be this close to count. */
const MIN_FILE_FUZZY = 0.3;

/**
 * Project files for a query: names starting with it, then names containing it, then paths
 * containing it (shorter paths first in each tier). Only when nothing contains the text literally
 * do close fuzzy matches show, so long paths never match on scattered letters.
 */
export function rankFiles(files: readonly string[], query: string, limit: number): string[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const tiers: string[][] = [[], [], []];
	for (const path of files) {
		const lower = path.toLowerCase();
		const name = lower.slice(lower.lastIndexOf("/") + 1);
		if (name.startsWith(needle)) tiers[0]?.push(path);
		else if (name.includes(needle)) tiers[1]?.push(path);
		else if (lower.includes(needle)) tiers[2]?.push(path);
	}
	const literal = tiers.flatMap(tier => tier.sort((a, b) => a.length - b.length || a.localeCompare(b)));
	if (literal.length > 0) return literal.slice(0, limit);
	return files
		.map(path => ({ path, score: defaultFilter(path, needle) }))
		.filter(entry => entry.score >= MIN_FILE_FUZZY)
		.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
		.slice(0, limit)
		.map(entry => entry.path);
}

/** Split an i18n comma-list ("summarize, free space") into trimmed words. */
export function keywordList(value: string): string[] {
	return value
		.split(",")
		.map(word => word.trim())
		.filter(Boolean);
}
