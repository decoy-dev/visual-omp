import { create } from "zustand";
import { composerText, onComposerAction, useComposerDrafts } from "../../chat/composer/drafts";
import type { SessionController } from "../../state/session";

export type RedirectState = "stopping" | "editing" | "failed";
export const usePreviewRedirect = create<Record<string, RedirectState | undefined>>(() => ({}));
const active = new Map<string, () => void>();

export function cancelPreviewRedirect(tabId: string): void {
	active.get(tabId)?.();
	usePreviewRedirect.setState({ [tabId]: undefined });
}

/** Hold the queue before aborting and retain it while the person writes their correction. */
export function stopAndRedirect(session: SessionController, name: string, prefix: (name: string) => string): void {
	const tabId = session.tabId;
	cancelPreviewRedirect(tabId);
	const { promise, resolve: release } = Promise.withResolvers<void>();
	session.holdQueue(promise);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe = () => {};
	let unlisten = () => {};
	let settled = false;
	let confirmed = false;
	const finish = (failed = false) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe(); unlisten(); release();
		active.delete(tabId);
		usePreviewRedirect.setState({ [tabId]: failed ? "failed" : undefined });
	};
	active.set(tabId, finish);
	usePreviewRedirect.setState({ [tabId]: "stopping" });
	unlisten = onComposerAction(tabId, () => finish());
	const stopped = () => {
		if (session.getSnapshot().working || settled || confirmed) return;
		confirmed = true;
		clearTimeout(timer);
		unsubscribe();
		const drafts = useComposerDrafts.getState();
		drafts.setDraft(tabId, prefix(name) + composerText(drafts, tabId));
		drafts.focus(tabId);
		usePreviewRedirect.setState({ [tabId]: "editing" });
	};
	unsubscribe = session.subscribe(stopped);
	timer = setTimeout(() => finish(true), 10_000);
	session.abort();
	stopped();
}
