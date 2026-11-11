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

function nextBacktickRun(text: string, from: number, length = 0): number {
	for (let start = from; start < text.length;) {
		if (text[start] !== "`") {
			start++;
			continue;
		}
		let end = start + 1;
		while (text[end] === "`") end++;
		let slashes = 0;
		for (let at = start - 1; at >= 0 && text[at] === "\\"; at--) slashes++;
		if (slashes % 2 === 0 && (length === 0 || end - start === length)) return start;
		start = end;
	}
	return -1;
}

/** Keep a question-summary cutoff outside any inline-code span it crosses. */
export function truncateInlineCode(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	let end = maxLength;
	let opening = nextBacktickRun(text, 0);
	while (opening >= 0 && opening < end) {
		let openingEnd = opening + 1;
		while (text[openingEnd] === "`") openingEnd++;
		const closing = nextBacktickRun(text, openingEnd, openingEnd - opening);
		if (closing < 0) {
			opening = nextBacktickRun(text, openingEnd);
			continue;
		}
		let closingEnd = closing + 1;
		while (text[closingEnd] === "`") closingEnd++;
		if (closingEnd > end) {
			end = closingEnd;
			break;
		}
		opening = nextBacktickRun(text, closingEnd);
	}
	while (end > 0 && end < text.length && text[end - 1] === "`" && text[end] === "`") end--;
	return `${text.slice(0, end)}${end < text.length ? "…" : ""}`;
}

function questionInlineHtml(text: string, renderPlain: (plain: string) => string): string {
	let html = "";
	let cursor = 0;
	let opening = nextBacktickRun(text, 0);
	while (opening >= 0) {
		let openingEnd = opening + 1;
		while (text[openingEnd] === "`") openingEnd++;
		const length = openingEnd - opening;
		const closing = nextBacktickRun(text, openingEnd, length);
		if (closing < 0) {
			opening = nextBacktickRun(text, openingEnd);
			continue;
		}
		let closingEnd = closing + 1;
		while (text[closingEnd] === "`") closingEnd++;
		html += renderPlain(text.slice(cursor, opening));
		html += `<code class="tr-inline-code">${decorateColors(escapeHtml(text.slice(openingEnd, closing)), true)}</code>`;
		cursor = closingEnd;
		opening = nextBacktickRun(text, cursor);
	}
	return html + renderPlain(text.slice(cursor));
}

function literalInlineHtml(text: string, renderPlain: (plain: string) => string): string {
	let html = "";
	let cursor = 0;
	const code = /(`+)([^`]*?)\1/g;
	for (const match of text.matchAll(code)) {
		html += renderPlain(text.slice(cursor, match.index));
		html += `${match[1]}${decorateColors(escapeHtml(match[2] ?? ""), true)}${match[1]}`;
		cursor = match.index + match[0].length;
	}
	return html + renderPlain(text.slice(cursor));
}

/** Plain text stays literal unless a caller opts into question-style inline code. */
export function colorTextHtml(
	text: string,
	renderPlain = (plain: string) => decorateColors(escapeHtml(plain)),
	renderInlineCode = false,
): string {
	let html = "";
	let cursor = 0;
	// Keep the existing fence grammar separate so inline delimiters cannot consume a fence opener.
	const fences = /(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*(?=(?:`+|~+)[ \t]*(?=\n|$))\2[`~]*[ \t]*(?=\n|$)|(?![\s\S])))/gm;
	for (const match of text.matchAll(fences)) {
		const plain = text.slice(cursor, match.index);
		html += renderInlineCode ? questionInlineHtml(plain, renderPlain) : literalInlineHtml(plain, renderPlain);
		html += escapeHtml(match[0]);
		cursor = match.index + match[0].length;
	}
	const plain = text.slice(cursor);
	return html + (renderInlineCode ? questionInlineHtml(plain, renderPlain) : literalInlineHtml(plain, renderPlain));
}
