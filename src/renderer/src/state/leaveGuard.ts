/**
 * One guard for unsaved edits on pages. An editor with pending changes calls `useLeaveGuard(true,
 * discard)`; navigation that would leave it (Back, Esc, another page, a chat, a project, a Settings
 * section or scope change) goes through `whenLeaving`, which asks "Discard your changes?" first
 * (`shell/LeaveConfirm.tsx`). Discarding calls each editor's `discard` to reset its edits, then runs the
 * navigation. A guard stays registered until its editor reports clean or unmounts.
 */
import { useEffect, useRef } from "react";
import { create } from "zustand";

interface Guard {
	/** Resets the editor's pending edits. */
	discard(): void;
}

const dirtyGuards = new Map<symbol, Guard>();

interface LeaveConfirmState {
	/** Navigation waiting for the user's answer; null when no question is showing. */
	pending: { navigate: () => void; cancel: () => void } | null;
}

export const useLeaveConfirm = create<LeaveConfirmState>(() => ({ pending: null }));

/** Mark the calling editor as holding unsaved edits while `dirty` is true; `discard` resets those edits. */
export function useLeaveGuard(dirty: boolean, discard: () => void): void {
	const latest = useRef(discard);
	latest.current = discard;
	useEffect(() => {
		if (!dirty) return;
		const token = Symbol("leave-guard");
		dirtyGuards.set(token, { discard: () => latest.current() });
		return () => {
			dirtyGuards.delete(token);
		};
	}, [dirty]);
}

/**
 * Run `navigate` now, or after the user agrees to discard unsaved edits. Resolves `left: true` when
 * the navigation ran and `left: false` when it did not (the user kept editing, or a newer navigation
 * request replaced this one while the question was showing).
 */
export function whenLeaving<T>(navigate: () => T): Promise<{ left: true; value: T } | { left: false }> {
	if (dirtyGuards.size === 0) return Promise.resolve({ left: true, value: navigate() });
	const { promise, resolve } = Promise.withResolvers<{ left: true; value: T } | { left: false }>();
	// One question at a time; the latest request wins.
	useLeaveConfirm.getState().pending?.cancel();
	useLeaveConfirm.setState({
		pending: {
			navigate: () => resolve({ left: true, value: navigate() }),
			cancel: () => resolve({ left: false }),
		},
	});
	return promise;
}

/** Answer the pending question. Discarding resets every guarded editor, then navigates. */
export function resolveLeave(discard: boolean): void {
	const { pending } = useLeaveConfirm.getState();
	useLeaveConfirm.setState({ pending: null });
	if (!pending) return;
	if (!discard) {
		pending.cancel();
		return;
	}
	for (const guard of [...dirtyGuards.values()]) guard.discard();
	pending.navigate();
}
