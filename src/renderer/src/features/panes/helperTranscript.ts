/**
 * A helper's own session as the Tasks pane's conversation dialog shows it. omp writes everything it sends a helper as
 * a user message: first the parent's assignment (wrapped in `subagent-user-prompt.md`), later the IRC messages that
 * reach it (prefixed "[Wait interrupted by message]" when one ended a wait) and harness notices in
 * `<system-notice>` / `<system-reminder>` tags. Each is classified here so the dialog shows what it is instead of the
 * markup. Displayed `custom_message` entries pass through for the chat's notice rows.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { isReplyWrite, toolResultReplies } from "../../chat/friendly";
import { contentText, noticeVisible, parseIrcText, parseNotice, stripNoticeMarkup } from "../../chat/transcript/notices";
import { replyText } from "../../chat/transcript/turns";
import { stripAssignmentPreamble } from "./derive";

type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;

export type HelperTranscriptItem =
	/** The first user message: the parent's assignment without omp's preamble. */
	| { kind: "assignment"; id: string; text: string }
	/** An IRC message; `interrupted` when it ended one of the helper's waits. */
	| { kind: "message"; id: string; from: string; text: string; interrupted: boolean }
	/** A harness notice or reminder, as one line of plain text. */
	| { kind: "notice"; id: string; text: string }
	/** A later user message with no omp markup. */
	| { kind: "prompt"; id: string; text: string }
	| { kind: "reply"; id: string; text: string; tools: string[] }
	| { kind: "custom"; id: string; entry: CustomMessageEntry };

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

/** The dialog's rows for a helper's session entries (active branch, root to leaf). */
export function helperTranscript(entries: readonly SessionEntry[]): HelperTranscriptItem[] {
	let assigned = false;
	return entries.flatMap((entry): HelperTranscriptItem[] => {
		if (entry.type === "custom_message") return entry.display && noticeVisible(parseNotice(entry)) ? [{ kind: "custom", id: entry.id, entry }] : [];
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
		if (message.role === "toolResult") {
			return toolResultReplies(message.details).map((text, index) => ({ kind: "reply", id: `${entry.id}:reply:${index}`, text, tools: [] }));
		}
		if (message.role !== "assistant") return [];
		let text = "";
		let afterReplyWrite = false;
		for (const block of message.content) {
			const value = replyText(block);
			if (!value) continue;
			const replyWrite = block.type === "toolCall" && isReplyWrite(block.name, block.arguments);
			if (text && (replyWrite || afterReplyWrite)) text += "\n\n";
			text += value;
			afterReplyWrite = replyWrite;
		}
		const tools = message.content.flatMap(block => (block.type === "toolCall" && !isReplyWrite(block.name, block.arguments) ? [block.intent ?? block.name] : []));
		return [{ kind: "reply", id: entry.id, text, tools }];
	});
}
