/** Draft completions are transient. Only explicit Tab acceptance edits the composer. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { PredictionCapture } from "@shared/contracts/composer";

export interface WordSuggestion {
	folder: string;
	text: string;
	cursor: number;
	suffix: string;
}

/** One shown word gets one feedback frame, whether accepted or typed past. */
export class WordFeedback {
	#shown: WordSuggestion | null = null;
	constructor(readonly send: (suggestion: WordSuggestion, accepted: boolean) => void) {}
	show(suggestion: WordSuggestion | null, typed?: string): void {
		const previous = this.#shown;
		if (previous && typed === previous.text + previous.suffix) {
			this.#shown = null;
			return;
		}
		if (previous && suggestion && previous.folder === suggestion.folder &&
			previous.text + previous.suffix === suggestion.text + suggestion.suffix && suggestion.text.startsWith(previous.text)) {
			this.#shown = suggestion;
			return;
		}
		this.finish(false);
		this.#shown = suggestion;
	}
	finish(accepted: boolean): void {
		const shown = this.#shown;
		this.#shown = null;
		if (shown) this.send(shown, accepted);
	}
}


/** Keep the remaining suffix visible while the person types through the predicted word. */
export function projectWord(word: WordSuggestion | null, folder: string, text: string, cursor: number): WordSuggestion | null {
	if (!word || word.folder !== folder || cursor !== text.length || !text.startsWith(word.text)) return null;
	const completed = word.text + word.suffix;
	if (!completed.startsWith(text) || completed.length <= text.length) return null;
	return { folder, text, cursor, suffix: completed.slice(text.length) };
}

export interface GhostSource { draft: string; mode: string | null; hostId: string | null; generation: number; }
export interface GhostAcceptance { text: string | null; capture?: PredictionCapture; }
export function ghostSourceUnchanged(source: GhostSource, current: GhostSource): boolean {
	return source.draft === current.draft && source.mode === current.mode && source.hostId === current.hostId && source.generation === current.generation;
}
export function predictionSuffix(prediction: string | null, draft: string): string | null {
	return prediction && !draft.includes("\n") && prediction.startsWith(draft) && draft.length < prediction.length ? prediction.slice(draft.length) : null;
}

export function useGhostText(options: { folder: string; tabId: string; hostId: string | null; generation: number; draft: string; caret: number; enabled: boolean; idle: boolean }) {
	const { folder, tabId, hostId, generation, draft, caret, enabled, idle } = options;
	const [word, setWord] = useState<WordSuggestion | null>(null);
	const [prediction, setPrediction] = useState<{ hostId: string; generation: number; text: string } | null>(null);
	const feedback = useRef<WordFeedback | null>(null);
	if (!feedback.current) feedback.current = new WordFeedback((suggestion, accepted) => {
		void window.vomp.invoke("composer:predictFeedback", suggestion.folder, suggestion.text, suggestion.cursor, suggestion.suffix, accepted).catch(() => {});
	});
	const next = prediction?.hostId === hostId && prediction.generation === generation && idle ? prediction.text : null;
	const nextSuffix = enabled && caret === draft.length ? predictionSuffix(next, draft) : null;
	const shownWord = useMemo(() => enabled ? projectWord(word, folder, draft, caret) : null, [enabled, word, folder, draft, caret]);
	const suffix = nextSuffix ?? shownWord?.suffix ?? null;

	useEffect(() => {
		const owner = crypto.randomUUID();
		void window.vomp.invoke("composer:retainPredictions", folder, owner).catch(() => {});
		return () => { void window.vomp.invoke("composer:releasePredictions", folder, owner).catch(() => {}); };
	}, [folder]);

	useEffect(() => {
		if (!enabled || caret !== draft.length || !draft || nextSuffix) return;
		let current = true;
		const timer = setTimeout(() => {
			void window.vomp.invoke("composer:predictWord", folder, draft, caret).then(suffix => {
				if (current) setWord(previous => suffix ? { folder, text: draft, cursor: caret, suffix } : projectWord(previous, folder, draft, caret));
			}).catch(() => { if (current) setWord(null); });
		}, 150);
		return () => { current = false; clearTimeout(timer); };
	}, [enabled, folder, draft, caret, nextSuffix]);

	useEffect(() => {
		feedback.current!.show(nextSuffix ? null : shownWord, draft);
	}, [shownWord, draft, nextSuffix]);
	useEffect(() => () => feedback.current!.finish(false), []);

	useEffect(() => {
		if (!hostId || !idle || !enabled) return;
		let current = true;
		let timer: ReturnType<typeof setTimeout>;
		const poll = async () => {
			try {
				const text = await window.vomp.invoke("composer:tuiPrediction", hostId);
				if (current) setPrediction(text ? { hostId, generation, text } : null);
			} catch { if (current) setPrediction(null); }
			if (current) timer = setTimeout(() => void poll(), 600);
		};
		void poll();
		return () => { current = false; clearTimeout(timer); };
	}, [hostId, generation, idle, enabled]);


	return {
		suffix,
		/** Word Tab inserts a space; a next-message capture uses the exact trusted editor API. */
		async accept(): Promise<GhostAcceptance | null> {
			if (nextSuffix && hostId && next) {
				const capture = await window.vomp.invoke("composer:takePrediction", { hostId, generation, tabId, nativeDraft: draft, expectedGhost: next });
				setPrediction(null);
				return capture ? { text: capture.blocked || capture.error ? null : capture.text, capture } : null;
			}
			if (!shownWord) return null;
			feedback.current!.finish(true);
			setWord(null);
			return { text: draft + shownWord.suffix + " " };
		},
	};
}
