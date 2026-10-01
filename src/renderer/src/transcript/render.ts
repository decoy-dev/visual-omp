import { type Links, Marked, type Token } from "@oh-my-pi/pi-utils/marked";
import { escapeHtml } from "../collab/lib/format";
import { mathExtension } from "./math";

function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	let protocol: string;
	try {
		// Resolve the scheme exactly as the browser will: the URL parser strips leading
		// C0 controls and embedded tab/newline that a text check would carry through.
		({ protocol } = new URL(trimmed, "https://relative.invalid/"));
	} catch {
		return null;
	}
	if (protocol === "https:" || protocol === "http:" || protocol === "mailto:") return trimmed;
	return null; // unknown scheme (javascript:, data:, …)
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
	},
	breaks: true,
});
md.use(mathExtension);

/** The whole message as one HTML string (saved messages and every non-streaming surface). */
export function renderMarkdown(text: string): string {
	try {
		return md.parse(text, { async: false });
	} catch {
		return escapeHtml(text);
	}
}

/** One top-level Markdown block: `key` identifies its source, `html` is what it renders to. */
export interface MarkdownBlock {
	key: string;
	html: string;
}

/** The opening line of an own-line display block (`MATH_BLOCK_DOLLAR` / `MATH_BLOCK_BRACKET` in math-delimiters). */
const MATH_BLOCK_OPENER = /^ {0,3}(?:\$\$|\\\[)[ \t]*\n/;

/**
 * Renders a message that is still streaming as one HTML string per top-level block.
 *
 * Marked's parser renders top-level tokens independently and concatenates them, so the blocks
 * join to exactly what {@link renderMarkdown} returns for the same tokens. Each call keeps the
 * HTML of finished blocks (and their KaTeX output) from the previous call, keyed by the block's
 * raw source plus the message's reference definitions, because a definition that arrives later
 * changes how an earlier `[label]` renders.
 *
 * When the text only grew, lexing restarts two blocks before the end instead of at the start, so
 * a long reply does not cost a full lex on every frame. Marked tokenizes each block from the text
 * ahead of it, except that it merges some blocks into a preceding paragraph, so the restart point
 * also moves back past paragraphs. A token whose `raw` no longer matches the text, or any change
 * to the reference definitions, falls back to a full lex.
 */
export class MarkdownBlocks {
	#source = "";
	#tokens: Token[] = [];
	#links = "{}";
	#html = new Map<string, string>();

	render(text: string): MarkdownBlock[] {
		let blocks: MarkdownBlock[];
		try {
			// The lexer normalizes line endings first; doing it here keeps `raw` aligned with `source`.
			const source = text.replace(/\r\n|\r/g, "\n");
			if (!this.#lexTail(source)) {
				const tokens = md.lexer(source);
				this.#tokens = tokens;
				this.#links = JSON.stringify(tokens.links);
			}
			this.#source = source;
			blocks = this.#tokens.map(token => {
				const key = `${this.#links}\u0000${token.raw}`;
				return { key, html: this.#html.get(key) ?? md.parser([token]) };
			});
		} catch {
			this.#source = "";
			this.#tokens = [];
			this.#links = "{}";
			blocks = [{ key: `\u0001${text}`, html: escapeHtml(text) }];
		}
		this.#html = new Map(blocks.map(block => [block.key, block.html]));
		return blocks;
	}

	/** Re-lexes only the end of `source` when it extends the previous text. False means lex it all. */
	#lexTail(source: string): boolean {
		if (!source.startsWith(this.#source)) return false;
		const tokens = this.#tokens;
		let restart = tokens.length;
		for (let blocks = 0; restart > 0 && blocks < 2; ) if (tokens[--restart]?.type !== "space") blocks++;
		// An own-line `$$` or `\[` without its closer yet lexes as ordinary blocks, and the closer
		// turns everything from the opener on into one math block, however far back it is.
		const opener = tokens.findIndex(token => token.type !== "math" && MATH_BLOCK_OPENER.test(token.raw));
		if (opener !== -1) restart = Math.min(restart, opener);
		while (restart > 0 && (tokens[restart - 1]?.type === "paragraph" || tokens[restart - 1]?.type === "text")) restart--;
		const kept = tokens.slice(0, restart);
		const seeded: Links = Object.create(null);
		let offset = 0;
		for (const token of kept) {
			if (!source.startsWith(token.raw, offset)) return false;
			offset += token.raw.length;
			// Only a definition's first occurrence becomes a `def` token, so this rebuilds the full lexer's map.
			if (token.type === "def" && !(token.tag in seeded)) seeded[token.tag] = { href: token.href, title: token.title };
		}
		const lexer = new md.Lexer(md.defaults);
		Object.assign(lexer.tokens.links, seeded);
		const tail = lexer.lex(source.slice(offset));
		if (JSON.stringify(lexer.tokens.links) !== this.#links) return false;
		this.#tokens = [...kept, ...tail];
		return true;
	}
}
