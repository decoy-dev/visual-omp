/**
 * A multi-question `ask` answered as one series (DESIGN §4.8). omp hands a collab guest one
 * question at a time and cannot go back, so the app walks the whole series from the tool call's
 * arguments, keeps each answer locally, and only then replays the answers against omp's
 * sequential guest requests (coding-agent `#runGuestAskQuestion` in extension-ui-controller.ts):
 *
 * - single choice: a radio select of the question's options + Other + Chat; the reply is one label
 * - multiple choice: a checkbox select of the options + Other (+ Next once anything is checked) + Chat,
 *   one toggle per request; Next ends the question
 * - Other: an editor titled "Custom answer: " + question; its text ends the question
 *
 * Option labels on the wire can carry a disambiguating suffix, so answers map to options by index.
 * Pure functions only: the driver in `askSeriesStore.ts` feeds them requests.
 */
import type { CollabUiRequest, SessionEntry, ToolCallContent, WireMessage } from "@oh-my-pi/pi-wire";
import { isRecord } from "../../tool-render/util";

// Sentinel labels and the custom-answer title prefix appended by omp's guest ask (extension-ui-controller.ts).
export const ASK_OTHER = "Other (type your own)";
export const ASK_CHAT = "Chat about this";
export const ASK_NEXT = "Next →";
export const CUSTOM_ANSWER_PREFIX = "Custom answer: ";

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	id: string;
	question: string;
	options: AskOption[];
	multi: boolean;
	recommended?: number;
}

/** One question's answer: option indices (at most one for single choice) and the trimmed "Other" text ("" = none). */
export interface AskAnswer {
	selected: readonly number[];
	custom: string;
}

/** Where the replay is: the question being answered and whether omp's next request is its select or its custom-answer editor. */
export interface ReplayCursor {
	question: number;
	awaiting: "select" | "editor";
	/** Requests answered for this question so far; bounds a multi-select that never reflects its toggles. */
	steps: number;
}

export type ReplayStep =
	| { kind: "answer"; value: string; cursor: ReplayCursor; done: boolean }
	| { kind: "mismatch"; reason: string };

export const REPLAY_START: ReplayCursor = { question: 0, awaiting: "select", steps: 0 };

/** omp's `sanitizeCarriageReturns`: the guest request title is the question run through it. */
export function sanitizeText(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replaceAll("\r\n", "\n").replace(/\r+/g, " ");
}

/** The ask tool's questions, coerced the way omp's `normalizeDialogQuestions` does; null when the arguments hold none. */
export function parseAskQuestions(args: unknown): AskQuestion[] | null {
	if (!isRecord(args) || !Array.isArray(args.questions)) return null;
	const questions: AskQuestion[] = [];
	for (const entry of args.questions) {
		if (!isRecord(entry)) continue;
		const options: AskOption[] = [];
		if (Array.isArray(entry.options)) {
			for (const option of entry.options) {
				if (!isRecord(option)) continue;
				const description = typeof option.description === "string" ? sanitizeText(option.description.trim()) : "";
				options.push({ label: typeof option.label === "string" ? option.label : "", ...(description ? { description } : {}) });
			}
		}
		questions.push({
			id: typeof entry.id === "string" ? entry.id : "?",
			question: typeof entry.question === "string" ? entry.question : "",
			options,
			multi: entry.multi === true,
			...(typeof entry.recommended === "number" && Number.isInteger(entry.recommended) ? { recommended: entry.recommended } : {}),
		});
	}
	return questions.length > 0 ? questions : null;
}

/** The option omp preselects for a single choice: `recommended`, clamped to the list. */
export function initialIndex(question: AskQuestion): number {
	return Math.max(0, Math.min(question.recommended ?? 0, Math.max(0, question.options.length - 1)));
}

/** The answer a question starts with: omp's preselected option for a single choice, nothing for multiple choice. */
export function defaultAnswer(question: AskQuestion): AskAnswer {
	return { selected: !question.multi && question.options.length > 0 ? [initialIndex(question)] : [], custom: "" };
}

/** A single choice needs one option or text; multiple choice needs at least one option or text (omp's Next gating). */
export function isComplete(question: AskQuestion, answer: AskAnswer | undefined): boolean {
	if (!answer) return false;
	if (answer.custom.trim()) return true;
	return question.multi ? answer.selected.length > 0 : answer.selected.length === 1;
}

function optionLabel(request: CollabUiRequest & { kind: "select" }, index: number): string | undefined {
	const option = request.options[index];
	if (option === undefined) return undefined;
	return typeof option === "string" ? option : option.label;
}

/**
 * omp's display labels for the question's options (`disambiguateDisplayLabels`): each label with
 * carriage returns cleaned, and a " (2)", " (3)"… suffix on one that repeats an earlier label or a sentinel.
 */
export function displayLabels(question: AskQuestion): string[] {
	const taken = new Set<string>([ASK_OTHER, ASK_CHAT, ASK_NEXT]);
	return question.options.map(option => {
		const base = sanitizeText(option.label);
		let candidate = base;
		for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
		taken.add(candidate);
		return candidate;
	});
}

/**
 * Why `request` is not omp's select for `question`, or null when it is. Checks the title, the
 * marker, every option label in order (as omp displays them) and the sentinel rows after them.
 */
export function selectMismatch(question: AskQuestion, request: CollabUiRequest): string | null {
	if (request.kind !== "select") return `expected a select, got ${request.kind}`;
	if (request.title !== sanitizeText(question.question)) return "the title is a different question";
	const count = question.options.length;
	if ((request.selectionMarker ?? "radio") !== (question.multi ? "checkbox" : "radio")) return "the selection marker differs";
	if (request.markableCount !== undefined && request.markableCount !== count) return "the option count differs";
	const checked = request.checkedIndices ?? [];
	if (checked.some(index => !Number.isInteger(index) || index < 0 || index >= count)) return "a checked index is out of range";
	const tail = question.multi ? [ASK_OTHER, ...(checked.length > 0 ? [ASK_NEXT] : []), ASK_CHAT] : [ASK_OTHER, ASK_CHAT];
	if (request.options.length !== count + tail.length) return "the option count differs";
	const expected = [...displayLabels(question), ...tail];
	for (let index = 0; index < expected.length; index++) {
		if (optionLabel(request, index) !== expected[index]) return index < count ? "the options differ" : "the trailing options differ";
	}
	return null;
}

/** omp's first request of the series: question 1's select with nothing checked. */
export function isSeriesStart(questions: readonly AskQuestion[], request: CollabUiRequest): boolean {
	const first = questions[0];
	return questions.length > 1 && first !== undefined && selectMismatch(first, request) === null && request.kind === "select" && !request.checkedIndices?.length;
}

/** Text without whitespace, which `boundPromptTitle` collapses and wraps at the terminal width. */
function compact(text: string): string {
	return text.replace(/\s+/g, "");
}

/**
 * Why `request` is not omp's custom-answer editor for question `index`, or null when it is. omp titles it
 * `boundPromptTitle("Custom answer: ", question)`: flattened, wrapped to the terminal width and, past three
 * rows, cut with "…". A cut title must still be a prefix of this question's title and of no other's.
 */
export function editorMismatch(questions: readonly AskQuestion[], index: number, request: CollabUiRequest): string | null {
	if (request.kind !== "editor") return "expected the custom answer editor";
	const titleFor = (question: AskQuestion) => compact(CUSTOM_ANSWER_PREFIX + sanitizeText(question.question));
	const question = questions[index];
	if (!question) return "expected no custom answer editor";
	const title = compact(request.title);
	const expected = titleFor(question);
	if (title === expected) return null;
	const kept = title.endsWith("…") ? title.slice(0, -1) : null;
	if (kept === null || kept.length <= compact(CUSTOM_ANSWER_PREFIX).length || !expected.startsWith(kept)) {
		return "the custom answer editor is for a different question";
	}
	if (questions.some((other, at) => at !== index && titleFor(other).startsWith(kept))) return "the custom answer editor's cut title fits more than one question";
	return null;
}

function advance(cursor: ReplayCursor, total: number, value: string): ReplayStep {
	const question = cursor.question + 1;
	return { kind: "answer", value, cursor: { question, awaiting: "select", steps: 0 }, done: question >= total };
}

/**
 * The reply to omp's next request while replaying `answers`, and where the replay goes next. A request
 * that does not have the expected shape is a mismatch: the caller stops replaying and lets the user
 * answer by hand.
 */
export function replayStep(
	questions: readonly AskQuestion[],
	answers: readonly (AskAnswer | undefined)[],
	cursor: ReplayCursor,
	request: CollabUiRequest,
): ReplayStep {
	const question = questions[cursor.question];
	if (!question) return { kind: "mismatch", reason: "omp asked again after the last answer" };
	const answer = answers[cursor.question];
	if (!answer || !isComplete(question, answer)) return { kind: "mismatch", reason: `question ${cursor.question + 1} has no answer` };
	if (answer.selected.some(index => !Number.isInteger(index) || index < 0 || index >= question.options.length)) {
		return { kind: "mismatch", reason: "an answer points past the options" };
	}
	const custom = answer.custom.trim();

	if (cursor.awaiting === "editor") {
		const mismatch = editorMismatch(questions, cursor.question, request);
		if (mismatch) return { kind: "mismatch", reason: mismatch };
		return advance(cursor, questions.length, custom);
	}

	const mismatch = selectMismatch(question, request);
	if (mismatch) return { kind: "mismatch", reason: mismatch };
	if (request.kind !== "select") return { kind: "mismatch", reason: "expected a select" };
	const other: ReplayStep = { kind: "answer", value: ASK_OTHER, cursor: { ...cursor, awaiting: "editor", steps: cursor.steps + 1 }, done: false };

	if (!question.multi) {
		if (custom) return other;
		const label = optionLabel(request, answer.selected[0] ?? 0);
		if (label === undefined) return { kind: "mismatch", reason: "the chosen option is missing" };
		return advance(cursor, questions.length, label);
	}

	// One toggle per request until omp's checked set equals the answer, then Other or Next.
	if (cursor.steps > question.options.length * 2 + 1) return { kind: "mismatch", reason: "the choices did not take effect" };
	const checked = new Set(request.checkedIndices ?? []);
	const wanted = new Set(answer.selected);
	const toggle = answer.selected.find(index => !checked.has(index)) ?? [...checked].find(index => !wanted.has(index));
	if (toggle !== undefined) {
		const label = optionLabel(request, toggle);
		if (label === undefined) return { kind: "mismatch", reason: "the chosen option is missing" };
		return { kind: "answer", value: label, cursor: { ...cursor, steps: cursor.steps + 1 }, done: false };
	}
	if (custom) return other;
	return advance(cursor, questions.length, ASK_NEXT);
}

// ---------------- Finding the running ask ----------------

export interface RunningAsk {
	toolCallId: string;
	questions: AskQuestion[];
}

export interface AskSource {
	activeTools: ReadonlyMap<string, { toolCallId: string; toolName: string; args: unknown }>;
	entries: readonly SessionEntry[];
	stream: WireMessage | null;
	working: boolean;
}

function toolCalls(message: WireMessage | null | undefined): ToolCallContent[] {
	if (!message || message.role !== "assistant") return [];
	return message.content.filter((block): block is ToolCallContent => block.type === "toolCall");
}

/** What the mirror shows of a tool call: made and still waiting, finished with a result, or not there at all. */
export function toolCallState(source: Pick<AskSource, "entries" | "stream">, toolCallId: string): "pending" | "done" | "missing" {
	for (let index = source.entries.length - 1; index >= 0; index--) {
		const entry = source.entries[index];
		if (entry?.type !== "message") continue;
		const { message } = entry;
		if (message.role === "toolResult" && message.toolCallId === toolCallId) return "done";
		if (toolCalls(message).some(call => call.id === toolCallId)) return "pending";
	}
	return toolCalls(source.stream).some(call => call.id === toolCallId) ? "pending" : "missing";
}

/**
 * The ask tool call is still waiting: it is running, or (after a reconnect drops the running tools) the
 * turn is still going and the mirror holds that very call without a result.
 */
export function isAskRunning(source: AskSource, toolCallId: string): boolean {
	return source.activeTools.has(toolCallId) || (source.working && toolCallState(source, toolCallId) === "pending");
}

/**
 * The running `ask` call with more than one question whose first question is `title`: from the
 * running tools, else the streamed or saved assistant message of the current turn.
 */
export function findSeriesAsk(source: AskSource, title: string): RunningAsk | null {
	const matches = (args: unknown): AskQuestion[] | null => {
		const questions = parseAskQuestions(args);
		return questions && questions.length > 1 && sanitizeText(questions[0]?.question ?? "") === title ? questions : null;
	};
	for (const tool of [...source.activeTools.values()].reverse()) {
		if (tool.toolName !== "ask") continue;
		const questions = matches(tool.args);
		if (questions) return { toolCallId: tool.toolCallId, questions };
	}
	if (!source.working) return null;
	const candidates = [...toolCalls(source.stream)];
	for (let index = source.entries.length - 1; index >= 0; index--) {
		const entry = source.entries[index];
		if (entry?.type !== "message") continue;
		if (entry.message.role === "user") break;
		candidates.push(...toolCalls(entry.message));
	}
	for (const call of candidates) {
		if (call.name !== "ask" || toolCallState(source, call.id) !== "pending") continue;
		const questions = matches(call.arguments);
		if (questions) return { toolCallId: call.id, questions };
	}
	return null;
}
