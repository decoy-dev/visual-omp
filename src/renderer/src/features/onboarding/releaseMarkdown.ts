import { Marked, Renderer } from "marked";
import { escapeHtml } from "../../collab/lib/format";
import { safeHref } from "../../transcript/render";

const plain = new Renderer();

/** Release notes are documents: raw HTML is escaped and images never load. */
const markdown = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html: ({ text }) => escapeHtml(text),
		image: ({ text }) => escapeHtml(text),
		link({ href, title, tokens }) {
			const label = this.parser.parseInline(tokens);
			const url = safeHref(href);
			return url ? `<a href="${escapeHtml(url)}"${title ? ` title="${escapeHtml(title)}"` : ""} rel="noopener noreferrer">${label}</a>` : label;
		},
		table(token) {
			return `<div class="tr-table">${plain.table.call(this, token)}</div>\n`;
		},
	},
});

export function renderReleaseMarkdown(source: string): string {
	try {
		return markdown.parse(source, { async: false });
	} catch {
		return escapeHtml(source);
	}
}
