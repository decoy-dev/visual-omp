/**
 * Which thoughts the transcript shows open (DESIGN §3.5). Normal view opens only the thought omp is writing, when
 * "Show thinking as omp thinks" is on; a thought the reader opened or closed by clicking its header keeps that choice.
 * Choices live at transcript scope, keyed by `thoughtKey`, so they survive the streamed reply turning into its saved
 * entry and the thought moving into a step group. Thinking and Verbose open every thought and record nothing.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-wire";
import type { TranscriptMode } from "./Transcript";

/**
 * A thought's identity: its message's time and its block index. The streamed reply and its saved entry share both,
 * and a thought drawn inside a step group keeps them (`BlockRef.messageTime`, `BlockRef.index`).
 */
export function thoughtKey(messageTime: number, index: number): string {
	return `${messageTime}:${index}`;
}

/** Index of the thought omp is writing (the last block while the reply still streams) when the setting is on, else -1. */
export function writingThought(message: AssistantMessage, pending: boolean, liveThinking: boolean): number {
	const last = message.content.length - 1;
	const block = message.content[last];
	return liveThinking && pending && block?.type === "thinking" && block.narration !== true ? last : -1;
}

/** Whether a thought shows open: every one in Thinking and Verbose; in Normal the reader's choice, else only while omp writes it. */
export function thoughtOpen(mode: TranscriptMode, choice: boolean | undefined, writing: boolean): boolean {
	return mode !== "normal" || (choice ?? writing);
}

/** The reader's choices, by `thoughtKey`, with a subscription for `useSyncExternalStore`. */
export class ThoughtChoices {
	#choices: ReadonlyMap<string, boolean> = new Map();
	#listeners = new Set<() => void>();

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): ReadonlyMap<string, boolean> => this.#choices;

	/** The reader clicked a thought's header while it showed `open`. Only Normal view records the choice. */
	toggle(mode: TranscriptMode, key: string, open: boolean): void {
		if (mode !== "normal") return;
		this.#choices = new Map(this.#choices).set(key, !open);
		for (const listener of this.#listeners) listener();
	}
}
