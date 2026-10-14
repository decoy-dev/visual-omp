import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderMarkdown } from "../../transcript/render";

/** A reply's text as a screen reader should hear it: the rendered Markdown's text, without its syntax. */
function plainText(message: AssistantMessage): string {
	const markdown = message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n\n");
	if (!markdown.trim()) return "";
	const template = document.createElement("template");
	template.innerHTML = renderMarkdown(markdown);
	return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The transcript's one live channel (the transcript itself is not live, so the paced reveal never reaches a screen
 * reader in fragments). It announces each assistant message once, when its saved entry lands, and a reply that
 * stopped with an error or was stopped. Entries present when the chat loads are history and stay silent.
 */
export function ReplyAnnouncer({ entries, ready }: { entries: readonly SessionEntry[]; ready: boolean }): ReactNode {
	const { t } = useTranslation("chat");
	const seen = useRef<Set<string> | null>(null);
	const [announcement, setAnnouncement] = useState<{ id: string; text: string } | null>(null);
	useEffect(() => {
		if (!ready) return;
		if (!seen.current) {
			seen.current = new Set(entries.map(entry => entry.id));
			return;
		}
		// Several new entries at once (a room switch, a reconnect) announce only the latest reply.
		let latest: { id: string; message: AssistantMessage } | null = null;
		for (const entry of entries) {
			if (seen.current.has(entry.id)) continue;
			seen.current.add(entry.id);
			if (entry.type === "message" && entry.message.role === "assistant") latest = { id: entry.id, message: entry.message };
		}
		if (!latest) return;
		const { stopReason, errorMessage } = latest.message;
		const text =
			stopReason === "error"
				? [t("stopped.error"), errorMessage].filter(Boolean).join(". ")
				: stopReason === "aborted"
					? t("stopped.aborted")
					: plainText(latest.message);
		if (text) setAnnouncement({ id: latest.id, text: stopReason === "error" || stopReason === "aborted" ? text : t("replied", { text }) });
	}, [entries, ready, t]);
	// A new keyed node per announcement, so two identical replies in a row are both spoken.
	return (
		<div className="sr-only" role="status" aria-atomic="true">
			{announcement && <p key={announcement.id}>{announcement.text}</p>}
		</div>
	);
}
