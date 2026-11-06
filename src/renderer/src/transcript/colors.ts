import { escapeHtml } from "../collab/lib/format";

/** Short forms belong to inline code only, so prose issue and PR numbers stay ordinary text. */
export function decorateColors(text: string, inlineCode = false): string {
	let scanned = 0;
	let pathPrefix = false;
	const entity = /&(?:[a-z]+|#\d+|#x[\da-f]+);/iy;
	return text.replace(/#[0-9a-f]+/gi, (value: string, offset: number) => {
		const length = value.length - 1;
		if (length !== 6 && length !== 8 && !(inlineCode && (length === 3 || length === 4))) return value;
		if (/[\p{L}\p{N}_/#&]/u.test(text[offset - 1] ?? "") || /[\p{L}\p{N}_-]/u.test(text[offset + value.length] ?? "")) return value;
		if (text[offset - 1] === "{" && text[offset + value.length] === "}") return value;
		// Scan each prefix once, retaining URL/path state only until the next whitespace.
		while (scanned < offset) {
			const char = text[scanned] ?? "";
			if (/\s/.test(char)) pathPrefix = false;
			else if (char === "&") {
				entity.lastIndex = scanned;
				const escaped = entity.exec(text);
				if (escaped) { scanned = entity.lastIndex; continue; }
				pathPrefix = true;
			} else if (char === "/" || char === "?" || char === "=") pathPrefix = true;
			scanned++;
		}
		if (pathPrefix) return value;
		const hex = value.slice(1).toUpperCase();
		const normalized = `#${length < 5 ? [...hex].map(char => char + char).join("") : hex}`;
		return `${value}<span class="vomp-color-swatch" aria-hidden="true" title="${normalized}" style="--swatch-color:${normalized}"></span>`;
	});
}

/** Plain question text keeps its literal Markdown punctuation and fenced code unchanged. */
export function colorTextHtml(text: string, renderPlain = (plain: string) => decorateColors(escapeHtml(plain))): string {
	let html = "";
	let cursor = 0;
	// A closing fence can be longer, but its entire run must use the opener's character.
	const code = /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*(?=(?:`+|~+)[ \t]*(?=\n|$))\2[`~]*[ \t]*(?=\n|$)|(?![\s\S])))|(`+)([^`]*?)\3/gm;
	for (const match of text.matchAll(code)) {
		html += renderPlain(text.slice(cursor, match.index));
		html += match[1] !== undefined ? escapeHtml(match[0]) : `${match[3]}${decorateColors(escapeHtml(match[4] ?? ""), true)}${match[3]}`;
		cursor = match.index + match[0].length;
	}
	return html + renderPlain(text.slice(cursor));
}
