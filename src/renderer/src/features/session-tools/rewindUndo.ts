import { composerText, useComposerDrafts } from "../../chat/composer/drafts";
import { i18n } from "../../i18n";
import type { SessionController } from "../../state/session";
import { dismissToast, toast } from "../../ui/toast";

const pending = new WeakMap<SessionController, () => void>();

export function cancelRewindUndo(session: SessionController): void {
	pending.get(session)?.();
}

/** Tern restores the preceding tree leaf and the draft displaced by a user-message rewind. */
export interface RewindCheckpoint {
	draft: string;
	current(): boolean;
	dispose(): void;
}
export function rewindCheckpoint(session: SessionController): RewindCheckpoint {
	const before = session.getSnapshot();
	const file = session.sessionFile;
	const host = before.host;
	const draft = composerText(useComposerDrafts.getState(), session.tabId);
	let sent = false;
	const off = session.onEvent(event => { if (event.kind === "sent" || event.kind === "disposed" || event.kind === "exited") sent = true; });
	const current = () => {
		const view = session.getSnapshot();
		return !sent && !view.working && !view.readOnly && session.sessionFile === file
			&& view.host?.hostId === host?.hostId && view.host?.generation === host?.generation
			&& view.host?.tspEpoch === host?.tspEpoch && view.host?.sessionId === host?.sessionId
			&& view.host?.phase !== "exited" && view.guest?.entries.length === before.guest?.entries.length;
	};
	return { draft, current, dispose: off };
}

export function offerRewindUndo(session: SessionController, checkpoint: RewindCheckpoint, restoreDraft: boolean, restore: (assertCurrent: () => void, confirmLeaf: (leaf: string | null) => void) => Promise<void>): void {
	let active = true;
	let running = false;
	let off = () => {};
	let offEvent = () => {};
	let id = "";
	let expectedLeaf = session.getSnapshot().displayLeaf;
	const current = () => checkpoint.current() && session.getSnapshot().displayLeaf === expectedLeaf;
	const release = () => {
		active = false; off(); offEvent(); checkpoint.dispose();
		if (pending.get(session) === cancel) pending.delete(session);
	};
	const cancel = () => { release(); dismissToast(id); };
	const assertCurrent = () => {
		if (!active || !current()) throw new Error(i18n.t("session:navigate.undoExpired"));
	};
	pending.set(session, cancel);
	id = toast({
		tone: "ok", message: i18n.t("session:navigate.rewound"),
		onDismiss: () => { if (!running) release(); },
		action: { label: i18n.t("session:navigate.undo"), onClick: () => {
			if (!active || running || !current()) { cancel(); return; }
			running = true;
			void restore(assertCurrent, leaf => { assertCurrent(); expectedLeaf = leaf; }).then(() => {
				assertCurrent();
				if (restoreDraft) useComposerDrafts.getState().setDraft(session.tabId, checkpoint.draft);
				useComposerDrafts.getState().focus(session.tabId);
				toast({ tone: "ok", message: i18n.t("session:navigate.undone") });
			}).catch(error => {
				toast({ tone: "warn", message: error instanceof Error ? error.message : String(error) });
			}).finally(release);
		} },
	});
	off = session.subscribe(() => { if (!current()) cancel(); });
	offEvent = session.onEvent(event => { if (event.kind === "sent" || event.kind === "disposed" || event.kind === "exited") cancel(); });
	if (!current()) cancel();
}
