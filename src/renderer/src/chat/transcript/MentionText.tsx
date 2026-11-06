import { useMemo } from "react";
import { escapeHtml } from "../../collab/lib/format";
import { colorTextHtml, decorateColors } from "../../transcript/colors";
import { fileMentions } from "../fileMentions";

/** Called only for prose after the whole message's code spans and fences have been identified. */
function mentionHtml(text: string): string {
	let html = "";
	let at = 0;
	for (const mention of fileMentions(text)) {
		html += decorateColors(escapeHtml(text.slice(at, mention.start)));
		html += `<span class="rounded-sm bg-accent-muted text-accent shadow-[0_0_0_2px_var(--accent-muted)]">${escapeHtml(text.slice(mention.start, mention.end))}</span>`;
		at = mention.end;
	}
	return html + decorateColors(escapeHtml(text.slice(at)));
}

/** Sent mentions are chips in prose; literal code retains the existing whole-message color handling. */
export function MentionText({ text }: { text: string }) {
	const html = useMemo(() => colorTextHtml(text, mentionHtml), [text]);
	return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
