import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { PromptHistoryItem } from "@shared/ipc";
import { contentText } from "../transcript/notices";
import type { ComposerMode } from "./drafts";

export type HistoryDirection = "older" | "newer";
export interface HistoryDraft {
	text: string;
	start: number;
	end: number;
}

/** Match the prefixes omp treats as local execution, including its excluded variants. */
export function historyMode(text: string): ComposerMode | null {
	if (text.startsWith("!")) return "shell";
	if (/^\$\$?(?:\s|$)/.test(text)) return "python";
	return null;
}

/** Preserve excluded commands verbatim, since doubling the sigil changes what omp records. */
function modeText(text: string, mode: ComposerMode | null): string {
	if (mode === "shell" && !text.startsWith("!!")) return text.slice(1);
	if (mode === "python" && !text.startsWith("$$")) return text.slice(1).replace(/^\s/, "");
	return text;
}

/** Prefer transcript text; consume duplicate source records once, keeping repeated sends distinct. */
function supplement(primary: readonly PromptHistoryItem[], extra: readonly PromptHistoryItem[]): PromptHistoryItem[] {
	const used = new Set<number>();
	const missing = extra.filter(item => {
		// omp's database timestamps have second precision. Delivery records precede their transcript echoes.
		const index = primary.findIndex((candidate, index) => !used.has(index) && candidate.text === item.text && candidate.timestamp >= item.timestamp - 999);
		if (index < 0) return true;
		used.add(index);
		return false;
	});
	return [...primary, ...missing].sort((a, b) => a.timestamp - b.timestamp);
}

/** All sources belong to this session. Queued drafts are deliberately absent. */
export function promptHistory(
	entries: readonly SessionEntry[],
	delivered: readonly PromptHistoryItem[],
	stored: readonly PromptHistoryItem[],
	mode: ComposerMode | null,
): string[] {
	const transcript = entries.flatMap(entry => {
		if (entry.type !== "message" || entry.message.role !== "user" || entry.message.synthetic) return [];
		return [{ text: contentText(entry.message.content), timestamp: entry.message.timestamp }];
	});
	// omp re-adds transcript prompts to its database when it rebuilds the TUI, with fresh timestamps.
	// Those records cannot establish a new send; the transcript already preserves their occurrences.
	const transcriptText = new Set(transcript.map(item => item.text));
	const storedExtras = stored.filter(item => !transcriptText.has(item.text));
	const merged = supplement(supplement(transcript, delivered), storedExtras);
	const result: string[] = [];
	for (const item of merged) {
		if (!item.text.trim() || historyMode(item.text) !== mode) continue;
		const text = modeText(item.text, mode);
		if (result.at(-1) !== text) result.push(text);
	}
	return result;
}

/** Arrow selection shortcuts retain native behavior. Lines here are newline-delimited editor lines. */
export function historyAtCaret(direction: HistoryDirection, draft: HistoryDraft): boolean {
	if (draft.start !== draft.end) return false;
	return direction === "older"
		? !draft.text.slice(0, draft.start).includes("\n")
		: !draft.text.slice(draft.end).includes("\n");
}

/** The existing highlight mirror has the textarea's font, width, wrapping and scroll position. */
export function historyOnVisualBoundary(direction: HistoryDirection, draft: HistoryDraft, mirror: HTMLElement | null): boolean {
	if (!historyAtCaret(direction, draft)) return false;
	if (!mirror || !draft.text) return true;
	const caretRect = (offset: number): DOMRect | null => {
		const walker = mirror.ownerDocument.createTreeWalker(mirror, 4 /* SHOW_TEXT */);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const length = node.textContent?.length ?? 0;
			if (offset > length) { offset -= length; continue; }
			const range = mirror.ownerDocument.createRange();
			range.setStart(node, offset);
			range.collapse(true);
			const rect = range.getBoundingClientRect();
			return rect.height > 0 ? rect : null;
		}
		return null;
	};
	// Hidden or unlaid-out mirrors cannot measure a caret. Keep the newline rule in those cases.
	const caret = caretRect(draft.start);
	const edge = caretRect(direction === "older" ? 0 : draft.text.length);
	return !caret || !edge || Math.abs(caret.top - edge.top) < edge.height / 2;
}

/** One mounted composer owns its cursor and original draft. Attachments never enter this state. */
export class PromptHistoryCursor {
	#browse: { items: readonly string[]; index: number; draft: HistoryDraft; mode: ComposerMode | null } | null = null;

	get browsing(): boolean { return this.#browse !== null; }

	reset(): void { this.#browse = null; }

	/** External inserts, edits, mode changes and queue edits turn the recalled text into the draft. */
	sync(text: string, mode: ComposerMode | null): void {
		if (this.#browse && (this.#browse.items[this.#browse.index] !== text || this.#browse.mode !== mode)) this.reset();
	}

	restore(): HistoryDraft | null {
		const draft = this.#browse?.draft ?? null;
		this.reset();
		return draft;
	}

	navigate(direction: HistoryDirection, draft: HistoryDraft, items: readonly string[], mode: ComposerMode | null): HistoryDraft | null {
		this.sync(draft.text, mode);
		if (!historyAtCaret(direction, draft)) return null;
		if (!this.#browse) {
			if (direction === "newer" || !items.length) return null;
			this.#browse = { items, index: items.length, draft, mode };
		}
		const browse = this.#browse;
		const index = browse.index + (direction === "older" ? -1 : 1);
		if (index === browse.items.length) return this.restore();
		if (index < 0) return null;
		browse.index = index;
		const text = browse.items[index]!;
		// Like omp, older recalls start at the first line; newer recalls end at the last.
		const caret = direction === "older" ? 0 : text.length;
		return { text, start: caret, end: caret };
	}
}
