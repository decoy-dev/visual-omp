import { useCallback } from "react";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { create } from "zustand";
import type { LiveSubject } from "./types";

export interface PreviewChat {
	subjects: readonly LiveSubject[];
	related: readonly string[];
	/** Null follows the newest subject. */
	selected: string | null;
	dismissed: readonly string[];
}
export const EMPTY_CHAT: PreviewChat = { subjects: [], related: [], selected: null, dismissed: [] };
interface PreviewState {
	chats: Record<string, PreviewChat>;
	update(tabId: string, subjects: readonly LiveSubject[], related: readonly string[]): void;
	select(tabId: string, id: string): void;
	close(tabId: string): void;
	forget(tabId: string): void;
}
export const useLivePreview = create<PreviewState>((set) => ({
	chats: {},
	update(tabId, subjects, related) {
		set(state => {
			const before = state.chats[tabId] ?? EMPTY_CHAT;
			const selected = before.selected && before.subjects.find(subject => subject.id === before.selected);
			const retained = selected && !subjects.some(subject => subject.id === selected.id) ? [...subjects, selected] : subjects;
			// A quiet snapshot after a turn keeps the final frame until another output starts.
			const next = retained.length ? retained : before.subjects;
			const stableRelated = related.length === before.related.length && related.every((path, index) => path === before.related[index]) ? before.related : related;
			return { chats: { ...state.chats, [tabId]: { ...before, subjects: next, related: stableRelated } } };
		});
	},
	select(tabId, id) {
		set(state => {
			const chat = state.chats[tabId] ?? EMPTY_CHAT;
			return { chats: { ...state.chats, [tabId]: { ...chat, selected: id === chat.subjects[0]?.id ? null : id, dismissed: chat.dismissed.filter(value => value !== id) } } };
		});
	},
	close(tabId) {
		set(state => {
			const chat = state.chats[tabId] ?? EMPTY_CHAT;
			return { chats: { ...state.chats, [tabId]: { ...chat, selected: null, dismissed: chat.subjects.map(subject => subject.id) } } };
		});
	},
	forget(tabId) {
		set(state => { const { [tabId]: _chat, ...chats } = state.chats; return { chats }; });
	},
}));

/** Keep tracking outputs while hidden without repainting their streaming preview. */
export function usePreviewChat(tabId: string | null): PreviewChat {
	const snapshot = useCallback(() => tabId ? useLivePreview.getState().chats[tabId] ?? EMPTY_CHAT : EMPTY_CHAT, [tabId]);
	return useVisualSnapshot(useLivePreview.subscribe, snapshot);
}
export function visibleSubjects(chat: PreviewChat): readonly LiveSubject[] {
	return chat.subjects.filter(subject => !chat.dismissed.includes(subject.id));
}
