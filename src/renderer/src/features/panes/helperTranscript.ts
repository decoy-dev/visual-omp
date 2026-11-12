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
	| { kind: "prompt"; id: string; text: string }
	/** One or more omp step prompts, with its harness directive removed. */
	| { kind: "step"; id: string; steps: { number: number; total: number; text: string }[] };

type UserPart = { kind: "message"; from: string; text: string; interrupted: boolean } | { kind: "notice"; text: string } | { kind: "prompt"; text: string };

const WAIT_INTERRUPTED = /^\s*\[Wait interrupted by message\]\s*/;
/** omp's older wording for the same interruption: the header, then the parent's message. */
const LEGACY_WAIT_INTERRUPTED = /^\s*Current interruptible wait interrupted: IRC message from parent agent `([^`]+)`\.\s*Parent IRC message:\s*/;
/** One `<irc …>…</irc>` block; `parseIrcText` reads its sender and message. */
const IRC_BLOCK = /<irc\b[\s\S]*?<\/irc>/g;
const BUDGET_NOTICE = /^\s*\[budget notice\]\s*/;
const WRAPPER_TAG = /<\/?system-(?:notice|reminder)>/;

/** omp 18.19.0's closing line of a step prompt (`prompts/system/subagent-step.md`): stop after these steps, or the last ones. */
const STEP_DIRECTIVE = /^(?:Do ONLY (this step|these steps), then report (?:with a terminal `yield`|as your final message)\. Step ([1-9]\d*) arrives after; NEVER start it early\.|Last (step|steps): your (?:terminal `yield`|final message) is the result of the whole assignment and MUST cover every step\.)$/;
const FIRST_HEADING = /^# Step ([1-9]\d*) of ([1-9]\d*)\n/;
/** omp sends a stepped spawn in at most four prompts. */
const MAX_STEP_PROMPTS = 4;

/** How many steps each prompt carries, as omp's `promptSizes` (task/steps.ts): 5 steps go out 2-1-1-1, 9 go out 3-2-2-2. */
function stepPromptSizes(total: number): number[] {
	const prompts = Math.min(total, MAX_STEP_PROMPTS);
	const base = Math.floor(total / prompts);
	return Array.from({ length: prompts }, (_, index) => base + (index < total % prompts ? 1 : 0));
}

/**
 * The steps of one omp step prompt (`task.steps`, omp 18.19.0). omp writes each step as `# Step N of M` and its
 * text verbatim, then a blank line and a closing instruction to the helper, which is harness text like the assignment
 * preamble. The first step, the number of steps and the closing line must match the prompt omp sends at that point,
 * and every later heading in a grouped prompt must occur exactly once after a blank line; step text that repeats
 * one makes the split ambiguous. Any other text returns null and keeps its existing classification.
 */
function parseStepPrompt(text: string): { number: number; total: number; text: string }[] | null {
	const lines = text.trim().split("\n");
	const directive = STEP_DIRECTIVE.exec(lines.pop() ?? "");
	if (!directive || lines.pop() !== "") return null;
	const body = lines.join("\n");
	const heading = FIRST_HEADING.exec(body);
	if (!heading) return null;
	const first = Number(heading[1]);
	const total = Number(heading[2]);
	if (!Number.isSafeInteger(total) || first > total) return null;
	// The prompt omp sends that starts at `first`, and how many steps it carries.
	const sizes = stepPromptSizes(total);
	let start = 1;
	let index = 0;
	while (index < sizes.length && start < first) start += sizes[index++] ?? 0;
	const count = sizes[index];
	if (start !== first || count === undefined) return null;
	const last = index === sizes.length - 1;
	const ok = directive[1] !== undefined
		? !last && (directive[1] === "these steps") === count > 1 && Number(directive[2]) === first + count
		: last && (directive[3] === "steps") === count > 1;
	if (!ok) return null;
	const bounds = [0];
	for (let number = first + 1; number < first + count; number++) {
		const marker = `\n\n# Step ${number} of ${total}\n`;
		const at = body.indexOf(marker);
		if (at < 0 || at < (bounds.at(-1) ?? 0) || body.indexOf(marker, at + 1) >= 0) return null;
		bounds.push(at + 2);
	}
	const steps = bounds.map((from, offset) => {
		const block = body.slice(from, bounds[offset + 1] ?? body.length);
		return { number: first + offset, total, text: block.slice(block.indexOf("\n") + 1).trim() };
	});
	return steps.some(step => !step.text) ? null : steps;
}

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
				const assignment = stripAssignmentPreamble(text).trim();
				const steps = parseStepPrompt(assignment);
				return steps ? [{ kind: "step", id: entry.id, steps }] : [{ kind: "assignment", id: entry.id, text: assignment }];
			}
			const steps = parseStepPrompt(text);
			if (steps) return [{ kind: "step", id: entry.id, steps }];
			return classifyInjected(text)
				.filter(part => part.text)
				.map((part, index) => ({ ...part, id: `${entry.id}:${index}` }));
		}
		return [];
	});
}
