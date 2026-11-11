import { Lexer, type Token } from "marked";

/**
 * The plain text omp shows for an inline-Markdown string: omp 18.18.8's `pi-tui` `plainInline`, which runs
 * `renderInlineMarkdown` and removes ANSI styling. This reproduces paragraphs of plain text, code, emphasis, links (their
 * text), escapes and HTML entities. Anything else omp renders differently or through its own extensions (HTML, math,
 * strikethrough, breaks, images, other blocks) returns null, so callers fall back to comparing the literal text.
 */
export function inlineMarkdownText(source: string): string | null {
	// omp tokenizes `$…$`, `\(…\)` and `\[…\]` as math before marked runs; marked's own strikethrough tokens decline below.
	if (/\$|\\[([]/.test(source)) return null;
	let result = "";
	for (const token of Lexer.lex(source)) {
		if (token.type === "space") continue;
		if (token.type !== "paragraph") return null;
		const shown = inline(token.tokens ?? []);
		if (shown === null) return null;
		result += shown;
	}
	return result;
}

function inline(tokens: readonly Token[]): string | null {
	let result = "";
	for (const token of tokens) {
		let shown: string | null;
		if (token.type === "codespan" || token.type === "escape") shown = token.text;
		else if (token.type === "text") shown = token.tokens?.length ? inline(token.tokens) : entities(token.text);
		else if (token.type === "strong" || token.type === "em" || token.type === "link") shown = inline(token.tokens ?? []);
		else return null;
		if (shown === null) return null;
		result += shown;
	}
	return result;
}

/** omp's `normalizeHtmlEntitiesForTerminal`: nbsp becomes a space and an invalid code point is dropped. */
function entities(raw: string): string {
	const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (_match, entity: string) => {
		const lower = entity.toLowerCase();
		if (named[lower]) return named[lower];
		const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
		return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
	});
}
