import type { CollabQuestion, CollabQuestionState } from "./question-match.schema";
import type { HookQuestion } from "./hook-questions";
import { inlineMarkdownText } from "./inline-markdown";

export type { CollabQuestion, CollabQuestionState } from "./question-match.schema";
export interface QuestionScope { hostId: string; generation: number; epoch: number }
export interface QuestionMatch {
	surfaceId: string; nodeId: string;
	status: "matched" | "ambiguous" | "unmatched" | "unavailable" | "settling" | "answering";
	reqId?: number;
	/** Diagnostic observation times from main's single monotonic clock. Never input authority. */
	nodeFirstSeenMs?: number;
	requestFirstSeenMs?: number;
}
const text = (value: string): string => value.trim().replace(/\s+/g, " ");
/** Literal text, or omp's rendering of its inline Markdown, which native selectors use for option labels and descriptions. */
function sameInline(native: string, source: string): boolean {
	const shown = text(native);
	if (shown === text(source)) return true;
	const rendered = inlineMarkdownText(source);
	return rendered !== null && shown === text(rendered);
}
/**
 * omp's native selector renders a question's first line as inline Markdown and keeps its detail lines literal, while
 * collab carries the source, so "save `path`" arrives natively as "save path". The literal comparison still applies
 * to omp versions and questions without that rendering.
 */
function sameSelectorTitle(native: string, source: string): boolean {
	const shown = text(native);
	if (shown === text(source)) return true;
	const [heading = "", ...detail] = source.split(/\r?\n/);
	const rendered = inlineMarkdownText(heading);
	return rendered !== null && shown === text([rendered, ...detail].join("\n"));
}
const sameScope = (a: QuestionScope, b: QuestionScope): boolean => a.hostId === b.hostId && a.generation === b.generation && a.epoch === b.epoch;
function compatible(dialog: HookQuestion, request: CollabQuestion): boolean {
	if (dialog.kind === "form") return dialog.formFields?.some(field => {
		if (!text(field.title) || text(field.title) !== text(request.title)) return false;
		if (request.kind === "editor") return field.kind === "text" || field.other;
		const options = request.options.map(option => text(typeof option === "string" ? option : option.label));
		if (options.at(-1) === "Next →") options.pop();
		return field.options?.length === options.length && field.options.every((option, index) => text(option) === options[index]);
	}) === true;
	if (dialog.kind !== request.kind || !text(dialog.title)) return false;
	// omp's text-entry dialogs show their titles literally.
	if (request.kind === "editor") return text(dialog.title) === text(request.title) && (dialog.field === undefined || dialog.field === (request.prefill ?? ""));
	if (!sameSelectorTitle(dialog.title, request.title)) return false;
	if (!dialog.options || dialog.options.length !== request.options.length) return false;
	return dialog.options.every((option, index) => {
		const raw = request.options[index]!;
		const other = typeof raw === "string" ? { label: raw } : raw;
		return sameInline(option.label, other.label) && (!option.description || !other.description || sameInline(option.description, other.description));
	});
}

/** Mutual uniqueness, never first-match-wins. Any pending collab request blocks uncertain local answers. */
export function matchQuestions(scope: QuestionScope, state: CollabQuestionState | null, dialogs: readonly HookQuestion[]): QuestionMatch[] {
	const current = state && sameScope(scope, state) && state.connected;
	const candidates = dialogs.map(dialog => current ? state.requests.filter(request => compatible(dialog, request)) : []);
	return dialogs.map((dialog, index) => {
		const matches = candidates[index]!;
		if (!current) return { ...dialog, status: "unavailable" };
		if (state.requests.length === 0) return { ...dialog, status: dialogs.filter(other => other.surfaceId === dialog.surfaceId && other.nodeId === dialog.nodeId).length === 1 ? "unmatched" : "ambiguous" };
		const request = matches[0];
		if (matches.length === 1 && candidates.filter(list => list.some(candidate => candidate.reqId === request!.reqId)).length === 1) return { ...dialog, status: "matched", reqId: request!.reqId };
		return { ...dialog, status: "ambiguous" };
	});
}

