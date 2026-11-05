/** Helper user entries carry omp's assignment preamble, IRC messages and injected harness notices.
 * Replies, thinking, tool results and custom notices use the shared TranscriptBody unchanged.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { contentText, parseIrcText, stripNoticeMarkup } from "../../chat/transcript/notices";
import { stripAssignmentPreamble } from "./derive";

export type HelperTranscriptItem =
	/** The first user message: the parent's assignment without omp's preamble. */
	| { kind: "assignment"; id: string; text: string }
	/** An IRC message; `interrupted` when it ended one of the helper's waits. */
	| { kind: "message"; id: string; from: string; text: string; interrupted: boolean }
	/** A harness notice or reminder, as one line of plain text. */
	| { kind: "notice"; id: string; text: string }
	/** A later user message with no omp markup. */
	| { kind: "prompt"; id: string; text: string };

type UserPart = { kind: "message"; from: string; text: string; interrupted: boolean } | { kind: "notice"; text: string } | { kind: "prompt"; text: string };

const WAIT_INTERRUPTED = /^\s*\[Wait interrupted by message\]\s*/;
/** omp's older wording for the same interruption: the header, then the parent's message. */
const LEGACY_WAIT_INTERRUPTED = /^\s*Current interruptible wait interrupted: IRC message from parent agent `([^`]+)`\.\s*Parent IRC message:\s*/;
/** One `<irc …>…</irc>` block; `parseIrcText` reads its sender and message. */
const IRC_BLOCK = /<irc\b[\s\S]*?<\/irc>/g;
const BUDGET_NOTICE = /^\s*\[budget notice\]\s*/;
const WRAPPER_TAG = /<\/?system-(?:notice|reminder)>/;

/** The parts of one later user message: IRC messages in order, then whatever text is left outside them. */
function classifyInjected(text: string): UserPart[] {
	const legacy = LEGACY_WAIT_INTERRUPTED.exec(text);
	if (legacy) return [{ kind: "message", from: legacy[1] ?? "", text: text.slice(legacy[0].length).trim(), interrupted: true }];
	const interrupted = WAIT_INTERRUPTED.test(text);
	const body = text.replace(WAIT_INTERRUPTED, "");
	const parts: UserPart[] = [];
	for (const block of body.match(IRC_BLOCK) ?? []) {
		const irc = parseIrcText(block);
		if (irc) parts.push({ kind: "message", from: irc.from ?? "", text: irc.body, interrupted });
	}
	const rest = body.replace(IRC_BLOCK, "").trim();
	if (!rest) return parts;
	if (WRAPPER_TAG.test(rest)) parts.push({ kind: "notice", text: stripNoticeMarkup(rest).replace(/\s+/g, " ").trim() });
	else if (BUDGET_NOTICE.test(rest)) parts.push({ kind: "notice", text: rest.replace(BUDGET_NOTICE, "").replace(/\s+/g, " ").trim() });
	else parts.push({ kind: "prompt", text: rest });
	return parts;
}

/** User-message parts keyed to their original entry, on the active branch from root to leaf. */
export function helperTranscript(entries: readonly SessionEntry[]): HelperTranscriptItem[] {
	let assigned = false;
	return entries.flatMap((entry): HelperTranscriptItem[] => {
		if (entry.type !== "message") return [];
		const message = entry.message;
		if (message.role === "user") {
			const text = contentText(message.content);
			if (!assigned) {
				assigned = true;
				return [{ kind: "assignment", id: entry.id, text: stripAssignmentPreamble(text).trim() }];
			}
			return classifyInjected(text)
				.filter(part => part.text)
				.map((part, index) => ({ ...part, id: `${entry.id}:${index}` }));
		}
		return [];
	});
}
