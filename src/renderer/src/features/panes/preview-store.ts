import { create } from "zustand";

interface History {
	entries: string[];
	index: number;
	/** Bumped by Reload to remount the frame. */
	nonce: number;
}

interface PreviewState {
	byScope: Record<string, History>;
	go(scope: string, url: string): void;
	step(scope: string, delta: number): void;
	reload(scope: string): void;
}

export const NO_HISTORY: History = { entries: [], index: -1, nonce: 0 };

export const usePreview = create<PreviewState>(set => ({
	byScope: {},
	go: (scope, url) =>
		set(state => {
			const current = state.byScope[scope] ?? NO_HISTORY;
			const entries = [...current.entries.slice(0, current.index + 1), url];
			return { byScope: { ...state.byScope, [scope]: { entries, index: entries.length - 1, nonce: current.nonce } } };
		}),
	step: (scope, delta) =>
		set(state => {
			const current = state.byScope[scope] ?? NO_HISTORY;
			const index = Math.min(current.entries.length - 1, Math.max(0, current.index + delta));
			return { byScope: { ...state.byScope, [scope]: { ...current, index } } };
		}),
	reload: scope =>
		set(state => {
			const current = state.byScope[scope] ?? NO_HISTORY;
			return { byScope: { ...state.byScope, [scope]: { ...current, nonce: current.nonce + 1 } } };
		}),
}));
