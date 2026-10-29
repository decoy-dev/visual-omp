import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderMarkdown } from "../../transcript/render";
import type { ActiveTool } from "../../collab/lib/client";
import { AnnouncementTracker } from "./announcements";
import { replyText } from "./turns";

/** A reply's text as a screen reader should hear it: the rendered Markdown's text, without its syntax. */
export function plainMarkdown(markdown: string): string {
	if (!markdown.trim()) return "";
	const template = document.createElement("template");
	template.innerHTML = renderMarkdown(markdown);
	return (template.content.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function plainText(message: AssistantMessage): string {
	return plainMarkdown(message.content.flatMap(block => replyText(block) ?? []).join("\n\n"));
}

/**
 * The transcript's one live channel (the transcript itself is not live, so the paced reveal never reaches a screen
 * reader in fragments). It announces each saved assistant reply and newly recorded model fallback once.
 * Loaded history and resynchronized entries stay silent; streamed provider fallbacks are not repeated when saved.
 */
export function ReplyAnnouncer({ entries, stream, active, ready, session }: { entries: readonly SessionEntry[]; stream: AssistantMessage | null; active?: ReadonlyMap<string, ActiveTool>; ready: boolean; session: string }): ReactNode {
	const { t } = useTranslation("chat");
	const [tracker] = useState(() => new AnnouncementTracker());
	const [announcement, setAnnouncement] = useState<{ id: string; text: string } | null>(null);
	useEffect(() => {
		const next = tracker.update(entries, stream, ready, session, active);
		const parts: string[] = [];
		for (const item of next) {
			if ("fallback" in item) {
				const fallback = item.fallback;
				parts.push(t(`modelFallback.${fallback.source === "provider" ? "provider" : fallback.from ? "changed" : "unknown"}`, { from: fallback.from, to: fallback.to }));
				continue;
			}
			if ("text" in item) {
				const text = plainMarkdown(item.text);
				if (text) parts.push(t("replied", { text }));
				continue;
			}
			const { stopReason, errorMessage } = item.message;
			const text =
				stopReason === "error"
					? [t("stopped.error"), errorMessage].filter(Boolean).join(". ")
					: stopReason === "aborted"
						? t("stopped.aborted")
						: plainText(item.message);
			if (text) parts.push(stopReason === "error" || stopReason === "aborted" ? text : t("replied", { text }));
		}
		if (parts.length > 0) setAnnouncement({ id: next.map(item => item.id).join(":"), text: parts.join(" ") });
	}, [entries, stream, active, ready, session, t, tracker]);
	// A new keyed node per announcement, so two identical replies in a row are both spoken.
	return (
		<div className="sr-only" role="status" aria-atomic="true">
			{announcement && <p key={announcement.id}>{announcement.text}</p>}
		</div>
	);
}
