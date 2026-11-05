import { createStore } from "zustand/vanilla";
import { useCallback } from "react";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { useComposerDrafts } from "../../chat/composer/drafts";
import type { SessionController } from "../../state/session";
import type { Helper } from "./derive";

interface Focus { helper: Helper; opener: HTMLElement | null }
const store = createStore<{ chats: ReadonlyMap<string, Focus> }>(() => ({ chats: new Map() }));
const cleanup = new WeakSet<SessionController>();

/** Helpers replace only their originating chat column; changing chats does not change this selection. */
export function openHelper(session: SessionController, helper: Helper): void {
	if (!cleanup.has(session)) {
		cleanup.add(session);
		session.onEvent(event => { if (event.kind === "disposed") closeHelper(session, false); });
	}
	const chats = new Map(store.getState().chats);
	chats.set(session.tabId, { helper, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null });
	store.setState({ chats });
}

export function closeHelper(session: SessionController, restoreFocus = true): void {
	const focus = store.getState().chats.get(session.tabId);
	const previous = document.activeElement;
	if (!focus) return;
	const chats = new Map(store.getState().chats);
	chats.delete(session.tabId);
	store.setState({ chats });
	if (restoreFocus) requestAnimationFrame(() => {
		if (document.activeElement !== previous && document.activeElement !== document.body && document.activeElement !== focus.opener) return;
		if (store.getState().chats.has(session.tabId)) return;
		if (focus.opener?.isConnected && !focus.opener.closest("[inert]")) focus.opener.focus();
		else useComposerDrafts.getState().focus(session.tabId);
	});
}

export function useHelperFocus(tabId: string): Helper | null {
	const snapshot = useCallback(() => store.getState().chats.get(tabId)?.helper ?? null, [tabId]);
	return useVisualSnapshot(store.subscribe, snapshot);
}
