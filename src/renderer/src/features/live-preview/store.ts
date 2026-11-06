import { useCallback } from "react";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { create } from "zustand";
import type { LiveSubject, OfficeFrameSnapshot } from "./types";

interface OfficeFrameHead { path: string; format: OfficeFrameSnapshot["format"]; revision: number }

export interface PreviewChat {
	subjects: readonly LiveSubject[];
	related: readonly string[];
	/** Null follows the newest accepted subject, checking new Office candidates first. */
	selected: string | null;
	dismissed: readonly string[];
	officeFrames: Record<string, OfficeFrameSnapshot>;
	/** Latest successful revision, including a presentation too large to retain. */
	officeHeads: Record<string, OfficeFrameHead>;
	officeChecks: Record<string, { path: string | null; format: string; revision: number; safe: boolean | null }>;
}
export const EMPTY_CHAT: PreviewChat = { subjects: [], related: [], selected: null, dismissed: [], officeFrames: {}, officeHeads: {}, officeChecks: {} };
interface PreviewState {
	chats: Record<string, PreviewChat>;
	update(tabId: string, subjects: readonly LiveSubject[], related: readonly string[]): void;
	select(tabId: string, id: string): void;
	close(tabId: string): void;
	forget(tabId: string): void;
	retainOffice(tabId: string, subjectId: string, snapshot: OfficeFrameSnapshot): void;
	readOffice(tabId: string, subjectId: string, path: string | null, format: string, revision: number): OfficeFrameSnapshot | null;
	discardOffice(tabId: string, subjectId: string, path: string | null, format: string): void;
	checkOffice(tabId: string, subject: LiveSubject, safe: boolean | null): void;
}

/** Conservative UTF-16 and container accounting; retained state contains presentation data only. */
export function officeSnapshotBytes(snapshot: OfficeFrameSnapshot): number {
	if (snapshot.format === "docx") return 256 + (snapshot.path.length + snapshot.body.length + snapshot.styles.length) * 2;
	return 256 + snapshot.path.length * 2 + snapshot.sheets.reduce((total, sheet) => total + 128 + sheet.name.length * 2, 0)
		+ snapshot.window.cells.reduce((total, row) => total + 32 + row.reduce((sum, text) => sum + 32 + text.length * 2, 0), 0);
}
export const useLivePreview = create<PreviewState>((set, get) => ({
	chats: {},
	update(tabId, subjects, related) {
		set(state => {
			const before = state.chats[tabId] ?? EMPTY_CHAT;
			const selected = before.selected && before.subjects.find(subject => subject.id === before.selected);
			const retained = selected && !subjects.some(subject => subject.id === selected.id) ? [...subjects, selected] : subjects;
			// A quiet snapshot after a turn keeps the final frame until another output starts.
			const next = retained.length ? retained : before.subjects;
			const stableRelated = related.length === before.related.length && related.every((path, index) => path === before.related[index]) ? before.related : related;
			const officeFrames = Object.fromEntries(Object.entries(before.officeFrames).filter(([id, snapshot]) => next.some(subject => subject.id === id
				&& subject.path === snapshot.path && subject.format === snapshot.format && snapshot.revision <= subject.revision)));
			const officeHeads = Object.fromEntries(Object.entries(before.officeHeads).filter(([id, head]) => next.some(subject => subject.id === id
				&& subject.path === head.path && subject.format === head.format && head.revision <= subject.revision)));
			const officeChecks = Object.fromEntries(Object.entries(before.officeChecks).filter(([id, check]) => next.some(subject => subject.id === id
				&& subject.path === check.path && subject.format === check.format && subject.revision === check.revision)));
			return { chats: { ...state.chats, [tabId]: { ...before, subjects: next, related: stableRelated, officeFrames, officeHeads, officeChecks } } };
		});
	},
	select(tabId, id) {
		set(state => {
			const chat = state.chats[tabId] ?? EMPTY_CHAT;
			const newest = chat.subjects[0];
			const following = newest?.id === id && (!isOfficeSubject(newest) || chat.officeChecks[id]?.safe === true);
			return { chats: { ...state.chats, [tabId]: { ...chat, selected: following ? null : id, dismissed: chat.dismissed.filter(value => value !== id) } } };
		});
	},
	close(tabId) {
		set(state => {
			const chat = state.chats[tabId] ?? EMPTY_CHAT;
			return { chats: { ...state.chats, [tabId]: { ...chat, selected: null, dismissed: chat.subjects.map(subject => subject.id), officeFrames: {}, officeHeads: {} } } };
		});
	},
	forget(tabId) {
		set(state => { const { [tabId]: _chat, ...chats } = state.chats; return { chats }; });
	},
	retainOffice(tabId, subjectId, snapshot) {
		set(state => {
			const chat = state.chats[tabId];
			const limit = 32 * 1024 * 1024;
			const subject = chat?.subjects.find(subject => subject.id === subjectId);
			const head = chat?.officeHeads[subjectId];
			const latest = head?.path === snapshot.path && head.format === snapshot.format ? head.revision : -1;
			if (!chat || !subject || chat.dismissed.includes(subjectId) || subject.path !== snapshot.path || subject.format !== snapshot.format
				|| snapshot.revision > subject.revision || snapshot.revision < latest) return state;
			const retainable = officeSnapshotBytes(snapshot) <= limit && (snapshot.format !== "xlsx"
				|| (snapshot.window.rowEnd - snapshot.window.rowStart <= 48 && snapshot.window.colEnd - snapshot.window.colStart <= 30
					&& snapshot.window.cells.length <= 48 && snapshot.window.cells.every(row => row.length <= 30 && row.every(text => text.length <= 1000))));
			// An invalid same-revision window must not replace a valid one; a newer success always supersedes older data.
			if (!retainable && snapshot.revision === latest) return state;
			const officeHeads = { ...chat.officeHeads, [subjectId]: { path: snapshot.path, format: snapshot.format, revision: snapshot.revision } };
			const frames = { ...chat.officeFrames };
			delete frames[subjectId];
			if (retainable) frames[subjectId] = snapshot;
			let size = Object.values(frames).reduce((total, frame) => total + officeSnapshotBytes(frame), 0);
			for (const id of Object.keys(frames)) {
				if (size <= limit) break;
				size -= officeSnapshotBytes(frames[id]!); delete frames[id];
			}
			return { chats: { ...state.chats, [tabId]: { ...chat, officeFrames: frames, officeHeads } } };
		});
	},
	readOffice(tabId, subjectId, path, format, revision) {
		const chat = get().chats[tabId], subject = chat?.subjects.find(subject => subject.id === subjectId), snapshot = chat?.officeFrames[subjectId], head = chat?.officeHeads[subjectId];
		return subject && snapshot && head && !chat!.dismissed.includes(subjectId) && subject.path === path && subject.format === format
			&& snapshot.path === path && snapshot.format === format && head.path === path && head.format === format && snapshot.revision === head.revision
			&& snapshot.revision <= revision && snapshot.revision <= subject.revision ? snapshot : null;
	},
	discardOffice(tabId, subjectId, path, format) {
		set(state => {
			const chat = state.chats[tabId], snapshot = chat?.officeFrames[subjectId];
			if (!chat || !snapshot || snapshot.path !== path || snapshot.format !== format) return state;
			const { [subjectId]: _removed, ...officeFrames } = chat.officeFrames;
			return { chats: { ...state.chats, [tabId]: { ...chat, officeFrames } } };
		});
	},
	checkOffice(tabId, subject, safe) {
		set(state => {
			const chat = state.chats[tabId];
			const current = chat?.subjects.find(item => item.id === subject.id);
			if (!chat || !current || current.path !== subject.path || current.format !== subject.format || current.revision !== subject.revision
				|| chat.officeChecks[subject.id]?.safe === safe) return state;
			return { chats: { ...state.chats, [tabId]: { ...chat, officeChecks: { ...chat.officeChecks,
				[subject.id]: { path: subject.path, format: subject.format, revision: subject.revision, safe } } } } };
		});
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

export const isOfficeSubject = (subject: LiveSubject): boolean => ["docx", "xlsx", "pptx"].includes(subject.format);

/** Unknown Office candidates are checked without displacing an already previewable output. */
export function followedSubject(chat: PreviewChat): LiveSubject | undefined {
	const subjects = visibleSubjects(chat);
	const selected = subjects.find(subject => subject.id === chat.selected);
	if (selected) return selected;
	const candidate = subjects.find(subject => chat.officeChecks[subject.id]?.safe !== false && chat.officeChecks[subject.id]?.safe !== null);
	if (!candidate || !isOfficeSubject(candidate) || chat.officeChecks[candidate.id]?.safe === true) return candidate ?? subjects[0];
	return subjects.find(subject => !isOfficeSubject(subject) || chat.officeChecks[subject.id]?.safe === true) ?? candidate;
}
