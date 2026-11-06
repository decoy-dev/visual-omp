import { DOMParser } from "@xmldom/xmldom";

interface ElementRange { tag: string; start: number; openEnd: number; end: number; complete: boolean; parent: ElementRange | null }
const VOID: Record<string, true> = { area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, param: true, source: true, track: true, wbr: true };
const RAW: Record<string, true> = { script: true, style: true, textarea: true, title: true };
const STRUCTURAL: Record<string, true> = { html: true, head: true, body: true, table: true, thead: true, tbody: true, tfoot: true, tr: true, colgroup: true, select: true, optgroup: true };

/** A source scanner, not an HTML reserializer: quoted attributes and raw text never become markup. */
function elements(source: string): { found: ElementRange[]; partialTag: number | null } {
	const found: ElementRange[] = [];
	const stack: ElementRange[] = [];
	let offset = 0;
	let partialTag: number | null = null;
	while (offset < source.length) {
		const raw = stack.at(-1);
		if (raw && RAW[raw.tag]) {
			const close = new RegExp(`</${raw.tag}\\s*>`, "ig");
			close.lastIndex = offset;
			const match = close.exec(source);
			if (!match) break;
			raw.end = close.lastIndex;
			raw.complete = true;
			stack.pop();
			offset = close.lastIndex;
			continue;
		}
		const start = source.indexOf("<", offset);
		if (start < 0) break;
		if (source.startsWith("<!--", start)) {
			const end = source.indexOf("-->", start + 4);
			if (end < 0) break;
			offset = end + 3;
			continue;
		}
		let end = start + 1;
		let quote = "";
		for (; end < source.length; end++) {
			const char = source[end]!;
			if (quote) { if (char === quote) quote = ""; }
			else if (char === '"' || char === "'") quote = char;
			else if (char === ">") break;
		}
		if (end === source.length) { partialTag = start; break; }
		const token = source.slice(start, end + 1);
		const match = /^<\s*(\/?)\s*([a-z][\w:-]*)\b/i.exec(token);
		offset = end + 1;
		if (!match) continue;
		const tag = match[2]!.toLowerCase();
		if (match[1]) {
			const index = stack.findLastIndex(element => element.tag === tag);
			if (index >= 0) for (const element of stack.splice(index)) { element.end = offset; element.complete = true; }
		} else {
			const complete = Boolean(VOID[tag] || /\/\s*>$/.test(token));
			const element = { tag, start, openEnd: offset, end: complete ? offset : source.length, complete, parent: stack.at(-1) ?? null };
			found.push(element);
			if (!complete) stack.push(element);
		}
	}
	return { found, partialTag };
}

function changedElement(previous: string | null, source: string): ElementRange | null {
	if (previous === source) return null;
	let changed = 0;
	if (previous !== null) while (changed < previous.length && changed < source.length && previous[changed] === source[changed]) changed++;
	const { found, partialTag } = elements(source);
	const candidates = found.filter(element => {
		if (RAW[element.tag] || STRUCTURAL[element.tag]) return false;
		for (let parent = element.parent; parent; parent = parent.parent) if (parent.tag === "head" || RAW[parent.tag]) return false;
		return true;
	});
	const appendedPartial = previous !== null && changed === previous.length && partialTag !== null;
	let target = (appendedPartial ? candidates.findLast(element => element.complete && element.end <= partialTag) : null)
		?? candidates.findLast(element => element.start <= changed && element.end > changed)
		?? candidates.find(element => element.start >= changed)
		?? candidates.at(-1);
	while (target?.parent && STRUCTURAL[target.parent.tag] && !["html", "body"].includes(target.parent.tag)) target = target.parent;
	return target ?? null;
}

/** Find the first changed body element, or the last completed descendant before an appended incomplete tag. */
export function htmlChangeOffset(previous: string | null, source: string): number | null {
	return changedElement(previous, source)?.start ?? null;
}

function authorId(opening: string): string | null {
	const tag = /^<\s*[a-z][\w:-]*/i.exec(opening);
	const attributes = opening.slice(tag?.[0].length ?? 0);
	const pattern = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	for (const attribute of attributes.matchAll(pattern)) {
		if (attribute[1]?.toLowerCase() !== "id") continue;
		const raw = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
		if (!raw.includes("&")) return raw;
		// Existing dependency, used only to decode an attribute. No document or page script is executed.
		return new DOMParser({ onError: () => {} }).parseFromString(`<x id="${raw.replace(/"/g, "&quot;")}"/>`, "text/html").documentElement?.getAttribute("id") ?? raw;
	}
	return null;
}

export function markHtmlChange(previous: string | null, source: string, generatedId: string): { body: string; anchor?: string } {
	let target = changedElement(previous, source);
	// Fragment navigation can focus a link or control itself. Use its container so app loads do not imitate user focus.
	while (target && (/^(?:a|button|input|select|textarea|summary|audio|video|iframe|object|embed)$/.test(target.tag)
		|| /\s(?:tabindex|contenteditable)(?:\s|=|>)/i.test(source.slice(target.start, target.openEnd)))) target = target.parent;
	if (!target) return { body: source };
	if (!/^[a-z0-9-]+$/.test(generatedId)) throw new Error("Invalid HTML preview marker.");
	const opening = source.slice(target.start, target.openEnd);
	const existingId = authorId(opening);
	// An empty author id has no fragment target. Keep it unchanged rather than adding a duplicate id.
	if (existingId === "") return { body: source };
	const anchor = existingId ?? generatedId;
	const attribute = ` data-${generatedId}=""${existingId === null ? ` id="${generatedId}"` : ""}`;
	const insertAt = target.start + (/^<\s*[a-z][\w:-]*/i.exec(opening)?.[0].length ?? 0);
	const marked = source.slice(0, insertAt) + attribute + source.slice(insertAt);
	// Attribute-only targeting leaves flex/grid children, sibling selectors and inline flow intact.
	const selector = `[data-${generatedId}]`;
	const css = `<style>${selector}{scroll-margin-top:48px;animation:vomp-preview-change 1.4s ease-out}@keyframes vomp-preview-change{from{outline:3px solid Highlight;outline-offset:4px}to{outline:3px solid transparent;outline-offset:4px}}@media(prefers-reduced-motion:reduce){${selector}{animation-timing-function:steps(1)}}</style>`;
	// A streamed tail may still be inside a tag or raw-text element. Put CSS before that tail, after the doctype.
	const prolog = /^\s*<!doctype[^>]*>/i.exec(marked)?.[0].length ?? 0;
	return { body: marked.slice(0, prolog) + css + marked.slice(prolog), anchor };
}
