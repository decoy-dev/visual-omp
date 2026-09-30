/**
 * Per-chat composer drafts. Every chat tab keeps its unsent text (and attached files) across tab
 * switches and app restarts. Other features put text into a chat's composer through this store:
 *
 *   useComposerDrafts.getState().insert(tabId, "@src/app.ts ")   // at the caret, focuses the box
 *   useComposerDrafts.getState().setDraft(tabId, "Explain …")     // replace the whole draft
 *   useComposerDrafts.getState().focus(tabId)                     // focus that chat's composer
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** An image waiting to go out with the next message (other files become `@path` mentions). */
export interface Attachment {
	/** Absolute path on disk. */
	path: string;
	/** Display name (file name). */
	name: string;
}

/** Shell (`!`) / Python (`$`) quick modes; null = normal message. */
export type ComposerMode = "shell" | "python";

/** A mounted composer's textarea hooks, so inserts land at the caret. */
export interface ComposerEditor {
	insertAtCaret(text: string): void;
	focus(): void;
}

interface DraftState {
	drafts: Record<string, string>;
	attachments: Record<string, Attachment[]>;
	/** Queue-less focus requests for tabs whose composer is not mounted yet. */
	pendingFocus: Record<string, true>;
	/** Per-tab quick mode (not persisted). */
	modes: Record<string, ComposerMode | null>;
	setMode(tabId: string, mode: ComposerMode | null): void;
	/** Insert text at the caret of the tab's composer (appended when it isn't mounted) and focus it. */
	insert(tabId: string, text: string): void;
	/** Replace the tab's whole draft. */
	setDraft(tabId: string, text: string): void;
	/** Focus the tab's composer (on mount when it isn't visible yet). */
	focus(tabId: string): void;
	addAttachments(tabId: string, items: Attachment[]): void;
	removeAttachment(tabId: string, path: string): void;
	clearAttachments(tabId: string): void;
	/** Forget everything for a closed tab. */
	forget(tabId: string): void;
}

const editors = new Map<string, ComposerEditor>();

/** Called by the mounted Composer; returns the unregister function. */
export function registerComposerEditor(tabId: string, editor: ComposerEditor): () => void {
	editors.set(tabId, editor);
	return () => {
		if (editors.get(tabId) === editor) editors.delete(tabId);
	};
}

/** Join an insert onto existing text with a single separating space. */
export function appendWithSpace(current: string, text: string): string {
	if (!current) return text;
	return /\s$/.test(current) || /^\s/.test(text) ? current + text : `${current} ${text}`;
}

export const useComposerDrafts = create<DraftState>()(
	persist(
		(set, get) => ({
			drafts: {},
			attachments: {},
			pendingFocus: {},
			modes: {},
			setMode(tabId, mode) {
				set(state => ({ modes: { ...state.modes, [tabId]: mode } }));
			},
			insert(tabId, text) {
				const editor = editors.get(tabId);
				if (editor) {
					editor.insertAtCaret(text);
					editor.focus();
					return;
				}
				set(state => ({
					drafts: { ...state.drafts, [tabId]: appendWithSpace(state.drafts[tabId] ?? "", text) },
					pendingFocus: { ...state.pendingFocus, [tabId]: true },
				}));
			},
			setDraft(tabId, text) {
				set(state => ({ drafts: { ...state.drafts, [tabId]: text } }));
			},
			focus(tabId) {
				const editor = editors.get(tabId);
				if (editor) editor.focus();
				else set(state => ({ pendingFocus: { ...state.pendingFocus, [tabId]: true } }));
			},
			addAttachments(tabId, items) {
				const existing = get().attachments[tabId] ?? [];
				const fresh = items.filter(item => !existing.some(have => have.path === item.path));
				if (fresh.length === 0) return;
				set(state => ({ attachments: { ...state.attachments, [tabId]: [...existing, ...fresh] } }));
			},
			removeAttachment(tabId, path) {
				set(state => ({
					attachments: { ...state.attachments, [tabId]: (state.attachments[tabId] ?? []).filter(item => item.path !== path) },
				}));
			},
			clearAttachments(tabId) {
				set(state => ({ attachments: { ...state.attachments, [tabId]: [] } }));
			},
			forget(tabId) {
				set(state => {
					const { [tabId]: _draft, ...drafts } = state.drafts;
					const { [tabId]: _files, ...attachments } = state.attachments;
					const { [tabId]: _focus, ...pendingFocus } = state.pendingFocus;
					const { [tabId]: _mode, ...modes } = state.modes;
					return { drafts, attachments, pendingFocus, modes };
				});
			},
		}),
		{
			name: "vomp.composer.drafts",
			storage: createJSONStorage(() => localStorage),
			partialize: state => ({ drafts: state.drafts, attachments: state.attachments }),
		},
	),
);

/** Consume a pending focus request for `tabId`; true when one was waiting. */
export function takePendingFocus(tabId: string): boolean {
	if (!useComposerDrafts.getState().pendingFocus[tabId]) return false;
	useComposerDrafts.setState(state => {
		const { [tabId]: _done, ...pendingFocus } = state.pendingFocus;
		return { pendingFocus };
	});
	return true;
}
