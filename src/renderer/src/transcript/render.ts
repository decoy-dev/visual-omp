import { type Links, Marked, Renderer, type Token, type Tokens } from "@oh-my-pi/pi-utils/marked";
import { escapeHtml } from "../collab/lib/format";
import { i18n } from "../i18n";
import { MATH_PENDING, mathExtension } from "./math";

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
export function safeHref(href: string): string | null {
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

/** A cell that reads as a number ("1,204", "-3.5%", "$12", "240ms", "2.1 GB"), once inline marks are stripped. */
const NUMERIC_CELL = /^[-+−~≈]?[$€£¥]?\d[\d,_]*(?:\.\d+)?\s?(?:%|[kKMGT]B?|B|ms|s|x|×)?$/;

/** `> [!NOTE]` and its kin (GitHub alert syntax). Text after the marker on its line becomes the title. */
const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*/i;

/** marked's own renderer, for the plain code block inside the header frame. */
const plain = new Renderer();
/** omp charts only top-level tables, leaving quoted and list-nested tables as their original data. */
const chartTables = new WeakSet<Tokens.Table>();

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
		image(token) {
			const href = token.href.trim();
			let url: URL;
			let absolute = true;
			try { url = new URL(href); } catch {
				absolute = false;
				try { url = new URL(href, "https://relative.invalid/"); } catch { return escapeHtml(token.text); }
			}
			const networkPath = /^[\\/]{2}/.test(href);
			if ((url.protocol === "https:" || url.protocol === "http:") && (absolute || networkPath || url.hostname !== "relative.invalid")) {
				const alt = token.text || i18n.t("chat:visual.remoteImage");
				return `<span class="vomp-remote-image" data-remote-image="${escapeHtml(url.href)}" data-image-alt="${escapeHtml(token.text)}"><span>${escapeHtml(alt)}</span><span class="vomp-image-host">${escapeHtml(url.host)}</span><button type="button" data-load-image aria-label="${escapeHtml(i18n.t("chat:visual.loadImageFrom", { host: url.host }))}">${escapeHtml(i18n.t("chat:visual.loadImage"))}</button><span data-image-status role="status"></span></span>`;
			}
			if (!absolute || /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml)[;,]/i.test(href) || url.protocol === "blob:") return plain.image.call(this, token).replace("<img ", '<img tabindex="0" ');
			return escapeHtml(token.text);
		},
		// A header row (language, Copy button) over the block. The button is wired by `copyCode` in Markdown.tsx.
		code(token) {
			const lang = (token.lang ?? "").match(/^\S*/)?.[0] ?? "";
			if (lang.toLowerCase() === "svg" || lang.toLowerCase() === "mermaid") {
				const fence = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1];
				const last = token.raw.trimEnd().split("\n").at(-1) || "";
				const closed = fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(last);
				return `<div class="vomp-diagram" data-diagram="${lang.toLowerCase()}"${closed ? "" : " data-fence-open"}><div data-diagram-image></div><details open><summary>${escapeHtml(i18n.t("chat:visual.source"))}</summary>${plain.code(token)}</details></div>\n`;
			}
			const label = escapeHtml(i18n.t("chat:copyCode"));
			return `<div class="tr-code"><div class="tr-code-head"><span class="tr-code-lang">${escapeHtml(lang)}</span><button type="button" class="tr-code-copy" data-copy-code aria-label="${label}" title="${label}"></button></div>${plain.code(token)}</div>\n`;
		},
		// A scrolling frame around the table; columns of numbers align right in mono.
		table(token) {
			const numeric = token.header.map((_, column) => {
				const texts = token.rows.map(row => row[column]?.text.replace(/[`*_~]/g, "").trim() ?? "");
				return texts.some(text => NUMERIC_CELL.test(text)) && texts.every(text => text === "" || NUMERIC_CELL.test(text));
			});
			const cell = (value: Tokens.TableCell, column: number) => {
				const tag = value.header ? "th" : "td";
				const align = value.align ?? (numeric[column] ? "right" : null);
				return `<${tag}${align ? ` align="${align}"` : ""}${numeric[column] ? ' class="tr-num"' : ""}>${this.parser.parseInline(value.tokens)}</${tag}>`;
			};
			const head = `<tr>${token.header.map(cell).join("")}</tr>`;
			const body = token.rows.map(row => `<tr>${row.map(cell).join("")}</tr>`).join("");
			const table = `<div class="tr-table"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>`;
			if (!chartTables.has(token)) return `${table}\n`;
			const data = escapeHtml(JSON.stringify({ header: token.header.map(value => value.text), rows: token.rows.map(row => row.map(value => value.text)) }));
			return `${table}<div class="vomp-chart" data-table-chart="${data}"></div>\n`;
		},
		// Task items drop the list marker; the checkbox (read-only, as marked renders it) takes its place.
		listitem(item) {
			return item.task ? `<li class="tr-task">${this.parser.parse(item.tokens)}</li>\n` : false;
		},
		// `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]` become tone cards; other quotes stay quotes.
		blockquote(token) {
			const [first, ...rest] = token.tokens;
			if (first?.type !== "paragraph") return false;
			const paragraph = first as Tokens.Paragraph;
			const lead = paragraph.tokens[0];
			const leadText = lead?.type === "text" ? (lead as Tokens.Text).text : "";
			const marker = CALLOUT_MARKER.exec(leadText);
			if (!marker) return false;
			const tone = (marker[1] ?? "note").toLowerCase();
			const title = leadText.slice(marker[0].length).trim() || i18n.t(`chat:callout.${tone}`);
			let inline = paragraph.tokens.slice(1);
			if (inline[0]?.type === "br") inline = inline.slice(1);
			const lede = inline.length > 0 ? `<p>${this.parser.parseInline(inline)}</p>\n` : "";
			return `<div class="tr-callout" data-tone="${tone}" role="note"><p class="tr-callout-title"><span class="tr-callout-icon" aria-hidden="true"></span>${escapeHtml(title)}</p>\n${lede}${this.parser.parse(rest)}</div>\n`;
		},
	},
	breaks: true,
});
md.use(mathExtension);

/** The whole message as one HTML string (saved messages and every non-streaming surface). */
export function renderMarkdown(text: string): string {
	try {
		const tokens = md.lexer(text);
		for (const token of tokens) if (token.type === "table") chartTables.add(token as Tokens.Table);
		return md.parser(tokens);
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
				if (token.type === "table") chartTables.add(token as Tokens.Table);
				const key = `${this.#links}\u0000${token.raw}`;
				const html = this.#html.get(key) ?? md.parser([token]);
				// Math shown as source while KaTeX loads: a key of its own (never a cache hit), so the block
				// renders again, typeset, on the first update after KaTeX arrives.
				return { key: html.includes(MATH_PENDING) ? `${key}\u0002` : key, html };
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
