export const RELEASE_HIGHLIGHT_CATEGORIES = ["Security", "New", "Improved", "Changed", "Fixed", "Removed"] as const;
export type ReleaseHighlightCategory = typeof RELEASE_HIGHLIGHT_CATEGORIES[number];
export type ReleaseNoticeKind = "IMPORTANT" | "WARNING" | "CAUTION" | "NOTE" | "TIP";

export interface ReleaseHighlight {
	category: string;
	/** Markdown without the category prefix or optional headline title. */
	body: string;
	title: string | null;
}
export interface ReleaseHighlights {
	overview: string;
	notice: { kind: ReleaseNoticeKind; body: string } | null;
	headlines: ReleaseHighlight[];
	groups: { category: string; items: ReleaseHighlight[] }[];
	/** Unstructured content in Highlights is retained through the ordinary Markdown renderer. */
	remaining: string;
	detailed: string;
	warnings: string[];
}
interface Line { text: string; start: number; end: number }
interface Block { start: number; end: number; raw: string; item?: ReleaseHighlight; notice?: NonNullable<ReleaseHighlights["notice"]> }
interface HighlightSection { start: number; contentStart: number; end: number; blocks: Block[] }

export function isReleaseHighlightCategory(category: string): category is ReleaseHighlightCategory {
	return RELEASE_HIGHLIGHT_CATEGORIES.some(known => known === category);
}

function categoryRank(category: string): number {
	const rank = RELEASE_HIGHLIGHT_CATEGORIES.findIndex(known => known === category);
	return rank < 0 ? RELEASE_HIGHLIGHT_CATEGORIES.length : rank;
}

/** A stable sort keeps authored order within each category and across unknown categories. */
export function sortReleaseHighlights(items: readonly ReleaseHighlight[]): ReleaseHighlight[] {
	return [...items].sort((a, b) => categoryRank(a.category) - categoryRank(b.category));
}

function findHighlights(source: string): HighlightSection | null {
	const lines: Line[] = [];
	for (const match of source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
		if (!match[0]) continue;
		lines.push({ text: match[0].replace(/[\r\n]+$/, ""), start: match.index, end: match.index + match[0].length });
	}
	let heading = -1;
	let endLine = lines.length;
	let fence: { marker: string; length: number } | null = null;
	for (const [index, line] of lines.entries()) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
		if (marker) {
			const run = marker[1]!;
			if (!fence) fence = { marker: run[0]!, length: run.length };
			else if (run[0] === fence.marker && run.length >= fence.length && !marker[2]?.trim()) fence = null;
			continue;
		}
		if (fence) continue;
		if (heading < 0 && /^### Highlights[ \t]*#*[ \t]*$/.test(line.text)) heading = index;
		else if (heading >= 0 && /^#{1,3}[ \t]+/.test(line.text)) { endLine = index; break; }
	}
	if (heading < 0) return null;
	const blocks: Block[] = [];
	for (let index = heading + 1; index < endLine; index++) {
		const line = lines[index]!;
		const bullet = /^[-*+] \*\*([^*\r\n]+):\*\*[ \t]+(.+)$/.exec(line.text);
		const alert = /^>\s*\[!(IMPORTANT|WARNING|CAUTION|NOTE|TIP)\][ \t]*$/.exec(line.text);
		if (!bullet && !alert) {
			// Fenced examples are documents, never release highlight items.
			const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text);
			if (marker) {
				const run = marker[1]!;
				while (++index < endLine) if (new RegExp(`^ {0,3}${run[0]}{${run.length},}[ \\t]*$`).test(lines[index]!.text)) break;
			}
			continue;
		}
		let last = index;
		if (alert) {
			while (last + 1 < endLine && /^>/.test(lines[last + 1]!.text)) last++;
		} else {
			while (last + 1 < endLine) {
				const next = lines[last + 1]!.text;
				if (/^[ \t]+\S/.test(next)) { last++; continue; }
				if (!next.trim() && last + 2 < endLine && /^[ \t]+\S/.test(lines[last + 2]!.text)) { last++; continue; }
				break;
			}
		}
		const end = lines[last]!.start + lines[last]!.text.length;
		const raw = source.slice(line.start, end);
		if (alert) {
			blocks.push({ start: line.start, end, raw, notice: { kind: alert[1] as ReleaseNoticeKind, body: lines.slice(index + 1, last + 1).map(line => line.text.replace(/^>[ \t]?/, "")).join("\n") } });
		} else if (bullet) {
			const content = [bullet[2]!, ...lines.slice(index + 1, last + 1).map(line => line.text.replace(/^(?: {2}|\t)/, ""))].join("\n");
			const headline = /^\*\*([^*\n]+\.)\*\*(?:\s+|$)([\s\S]*)$/.exec(content);
			blocks.push({ start: line.start, end, raw, item: { category: bullet[1]!.trim(), title: headline ? headline[1]! : null, body: headline ? headline[2]! : content } });
		}
		index = last;
	}
	return { start: lines[heading]!.start, contentStart: lines[heading]!.end, end: lines[endLine]?.start ?? source.length, blocks };
}

/** Parse only the authored Highlights convention. Legacy documents retain their original rendering. */
export function parseReleaseHighlights(source: string): ReleaseHighlights | null {
	const section = findHighlights(source);
	if (!section || !section.blocks.some(block => block.item)) return null;
	const items = sortReleaseHighlights(section.blocks.flatMap(block => block.item ? [block.item] : []));
	const notices = section.blocks.flatMap(block => block.notice ? [block.notice] : []);
	const headlines = items.filter(item => item.title !== null);
	const groups: ReleaseHighlights["groups"] = [];
	for (const item of items) {
		if (item.title !== null) continue;
		let group = groups.at(-1);
		if (group?.category !== item.category) { group = { category: item.category, items: [] }; groups.push(group); }
		group.items.push(item);
	}
	let remaining = "";
	let cursor = section.contentStart;
	let noticeRemoved = false;
	for (const block of section.blocks) {
		if (!block.item && (!block.notice || noticeRemoved)) continue;
		remaining += source.slice(cursor, block.start);
		cursor = block.end;
		if (block.notice) noticeRemoved = true;
	}
	remaining += source.slice(cursor, section.end);
	return {
		overview: source.slice(0, section.start).trim(),
		notice: notices[0] ?? null,
		headlines,
		groups,
		remaining: remaining.trim(),
		detailed: source.slice(section.end),
		warnings: highlightWarnings(section.blocks),
	};
}

function highlightWarnings(blocks: readonly Block[]): string[] {
	const unknown = new Set<string>();
	let headlines = 0;
	let notices = 0;
	for (const block of blocks) {
		if (block.notice) notices++;
		if (!block.item) continue;
		if (block.item.title !== null) headlines++;
		if (!isReleaseHighlightCategory(block.item.category)) unknown.add(block.item.category);
	}
	return [
		...[...unknown].map(category => `Unknown Highlights category: ${category}.`),
		...(headlines > 2 ? [`Highlights has ${headlines} headlines; use at most 2.`] : []),
		...(notices > 1 ? [`Highlights has ${notices} notices; use at most 1.`] : []),
	];
}

/** Marker limits apply even when a Highlights section contains no categorized bullets. */
export function releaseHighlightWarnings(source: string): string[] {
	const section = findHighlights(source);
	return section ? highlightWarnings(section.blocks) : [];
}

/** Reorder raw blocks only. The overview, detailed changes and line endings remain byte-for-byte intact. */
export function orderReleaseHighlights(source: string): string {
	const section = findHighlights(source);
	if (!section || !section.blocks.some(block => block.item)) return source;
	const ordered = [...section.blocks].sort((a, b) => {
		if (a.notice || b.notice) return a.notice ? b.notice ? 0 : -1 : 1;
		return categoryRank(a.item!.category) - categoryRank(b.item!.category);
	});
	let result = "";
	let cursor = 0;
	for (const [index, block] of section.blocks.entries()) {
		result += source.slice(cursor, block.start) + ordered[index]!.raw;
		cursor = block.end;
	}
	return result + source.slice(cursor);
}
