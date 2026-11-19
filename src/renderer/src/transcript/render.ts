import { type Links, Marked, Renderer, type Token, type Tokens } from "@oh-my-pi/pi-utils/marked";
import { escapeHtml } from "../collab/lib/format";
import { i18n } from "../i18n";
import { MATH_PENDING, mathExtension } from "./math";
import { decorateColors } from "./colors";

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
type VisualAttributes = Partial<Record<"src" | "alt" | "title" | "width" | "height", string>>;

interface RawTag {
	start: number;
	name: string;
	closing: boolean;
	end: number;
	attributesAt: number;
}

const RAW_TEXT_TAGS: Record<string, true> = { code: true, pre: true, script: true, style: true, textarea: true, title: true, xmp: true, plaintext: true };
const VISUAL_ATTRIBUTES: Record<keyof VisualAttributes, true> = { src: true, alt: true, title: true, width: true, height: true };
const VISUAL_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const RASTER_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp)(?:;[^,]*)?,/i;
const CSS_IMAGE_DIMENSION = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|vw|vh|ch|em)$/i;

function rawTagAt(text: string, start: number): RawTag | null {
	const match = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(text.slice(start));
	if (!match) return null;
	let quote = "";
	for (let at = start + match[0].length; at < text.length; at++) {
		const character = text[at]!;
		if (quote) {
			if (character === quote) quote = "";
		} else if (character === '"' || character === "'") quote = character;
		else if (character === ">") {
			return { start, name: match[2]!.toLowerCase(), closing: Boolean(match[1]), end: at + 1, attributesAt: start + match[0].length };
		}
	}
	return null;
}

function visualAttributes(text: string, tag: RawTag): VisualAttributes {
	const attributes: VisualAttributes = {};
	VISUAL_ATTRIBUTE.lastIndex = 0;
	for (const match of text.slice(tag.attributesAt, tag.end - 1).replace(/\/\s*$/, "").matchAll(VISUAL_ATTRIBUTE)) {
		const name = match[1]!.toLowerCase();
		if (VISUAL_ATTRIBUTES[name as keyof VisualAttributes] !== true || attributes[name as keyof VisualAttributes] !== undefined) continue;
		const value = match[2] ?? match[3] ?? match[4];
		if (value !== undefined) attributes[name as keyof VisualAttributes] = unescapeHtml(value);
	}
	return attributes;
}

function cssDimension(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	if (!trimmed) return null;
	if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return `${trimmed}px`;
	if (!CSS_IMAGE_DIMENSION.test(trimmed) || Number.parseFloat(trimmed) < 0) return null;
	return trimmed;
}

function imageDimensions(attributes: VisualAttributes): { width: string | null; height: string | null; style: string } {
	const width = cssDimension(attributes.width);
	const height = cssDimension(attributes.height);
	if (!width && !height) return { width, height, style: "" };
	return {
		width,
		height,
		style: ` style="max-width:100%;width:${width ?? "auto"};height:${height ?? "auto"}"`,
	};
}

function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function webImageUrl(source: string): URL | null {
	if (!/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[\\/]{2}/.test(source)) return null;
	try {
		const url = /^[\\/]{2}/.test(source) ? new URL(source, "https://relative.invalid/") : new URL(source);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function localPathSource(source: string): boolean {
	return !/^[a-z][a-z\d+.-]*:/i.test(source) || /^[a-z]:[\\/]/i.test(source);
}

function renderRemoteImage(url: URL, attributes: VisualAttributes): string {
	const alt = attributes.alt || i18n.t("chat:visual.remoteImage");
	const { width, height } = imageDimensions(attributes);
	const title = attributes.title ? ` data-image-title="${escapeHtml(attributes.title)}"` : "";
	return `<span class="vomp-remote-image" data-remote-image="${escapeHtml(url.href)}" data-image-alt="${escapeHtml(attributes.alt ?? "")}"${title}${width ? ` data-image-width="${escapeHtml(width)}"` : ""}${height ? ` data-image-height="${escapeHtml(height)}"` : ""}><span>${escapeHtml(alt)}</span><span class="vomp-image-host">${escapeHtml(url.host)}</span><button type="button" data-load-image aria-label="${escapeHtml(i18n.t("chat:visual.loadImageFrom", { host: url.host }))}">${escapeHtml(i18n.t("chat:visual.loadImage"))}</button><span data-image-status role="status"></span></span>`;
}

function renderRawImage(source: string, tag: RawTag): string {
	const raw = source.slice(tag.start, tag.end);
	const attributes = visualAttributes(source, tag);
	const path = attributes.src?.trim();
	if (!path) return escapeHtml(unescapeHtml(raw));
	const dimensions = imageDimensions(attributes);
	const title = attributes.title ? ` title="${escapeHtml(attributes.title)}"` : "";
	const dataTitle = attributes.title ? ` data-image-title="${escapeHtml(attributes.title)}"` : "";
	const alt = escapeHtml(attributes.alt ?? "");
	const url = webImageUrl(path);
	if (url) return renderRemoteImage(url, attributes);
	if (/^data:/i.test(path)) {
		if (!RASTER_DATA_IMAGE.test(path)) return escapeHtml(unescapeHtml(raw));
		return `<img class="vomp-reply-image" tabindex="0" src="${escapeHtml(path)}" alt="${alt}"${title}${dimensions.style}>`;
	}
	if (!localPathSource(path)) return alt || escapeHtml(unescapeHtml(raw));
	const width = dimensions.width ? ` data-image-width="${escapeHtml(dimensions.width)}"` : "";
	const height = dimensions.height ? ` data-image-height="${escapeHtml(dimensions.height)}"` : "";
	const fallback = attributes.alt ? `<span data-image-fallback>${alt}</span>` : "";
	const label = escapeHtml(i18n.t("chat:visual.openImageFile", { name: fileName(path) }));
	const linkText = escapeHtml(i18n.t("chat:visual.imageFileLink"));
	return `<span class="vomp-local-image" data-local-image-src="${escapeHtml(path)}" data-image-alt="${alt}"${dataTitle}${width}${height}>${fallback}<a class="vomp-local-image-file" data-local-file-src="${escapeHtml(path)}" data-local-image-file="" aria-label="${label}" role="link" tabindex="0">${linkText}</a></span>`;
}

function renderRawIframe(source: string, tag: RawTag): string {
	const attributes = visualAttributes(source, tag);
	const path = attributes.src?.trim();
	if (!path) return escapeHtml(unescapeHtml(source.slice(tag.start, tag.end)));
	const url = webImageUrl(path);
	const title = attributes.title?.trim() || (url ? url.href : fileName(path));
	const titleAttribute = ` title="${escapeHtml(title)}"`;
	if (url) return `<a class="vomp-iframe-link" href="${escapeHtml(url.href)}" target="_blank" rel="noopener"${titleAttribute}>${escapeHtml(title)}</a>`;
	if (!localPathSource(path)) return escapeHtml(title);
	const label = escapeHtml(i18n.t("chat:visual.openLocalPage", { name: title }));
	return `<a class="vomp-iframe-link" data-local-file-src="${escapeHtml(path)}" aria-label="${label}" role="link" tabindex="0"${titleAttribute}>${escapeHtml(title)}</a>`;
}

function renderRawHtml(text: string): string {
	const source = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
	if (source === "") return "";
	let output = "";
	let cursor = 0;
	let search = 0;
	while (search < source.length) {
		const start = source.indexOf("<", search);
		if (start < 0) break;
		if (source.startsWith("<!--", start) || source.startsWith("<![CDATA[", start)) {
			const delimiter = source.startsWith("<!--", start) ? "-->" : "]]>";
			const end = source.indexOf(delimiter, start + 2);
			search = end < 0 ? source.length : end + delimiter.length;
			continue;
		}
		const tag = rawTagAt(source, start);
		if (!tag) {
			search = start + 1;
			continue;
		}
		if (tag.closing && tag.name === "iframe") {
			output += escapeHtml(unescapeHtml(source.slice(cursor, start)));
			cursor = tag.end;
			search = tag.end;
			continue;
		}
		if (tag.closing || (tag.name !== "img" && tag.name !== "iframe")) {
			if (!tag.closing && RAW_TEXT_TAGS[tag.name] === true) {
				const close = new RegExp(`<\\/\\s*${tag.name}\\s*>`, "ig");
				close.lastIndex = tag.end;
				const match = close.exec(source);
				search = match ? close.lastIndex : source.length;
			} else {
				search = tag.end;
			}
			continue;
		}
		if (tag.name === "img") {
			output += escapeHtml(unescapeHtml(source.slice(cursor, start)));
			output += renderRawImage(source, tag);
			cursor = tag.end;
			search = tag.end;
			continue;
		}
		const close = /<\/\s*iframe\s*>/ig;
		close.lastIndex = tag.end;
		const match = close.exec(source);
		if (!match) {
			output += escapeHtml(unescapeHtml(source.slice(cursor, start)));
			output += renderRawIframe(source, tag);
			cursor = tag.end;
			search = tag.end;
			continue;
		}
		output += escapeHtml(unescapeHtml(source.slice(cursor, start)));
		output += renderRawIframe(source, tag);
		cursor = close.lastIndex;
		search = close.lastIndex;
	}
	return output + escapeHtml(unescapeHtml(source.slice(cursor)));
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
		text(token) {
			if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
			return decorateColors(plain.text.call(this, token));
		},
		codespan(token) {
			return `<code>${decorateColors(escapeHtml(token.text), true)}</code>`;
		},
		// Only images and iframe links are interpreted from raw HTML. Every other tag stays escaped.
		html({ text }) {
			return renderRawHtml(text);
		},
		link({ href, title, tokens, autolink, text }) {
			const inner = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
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
