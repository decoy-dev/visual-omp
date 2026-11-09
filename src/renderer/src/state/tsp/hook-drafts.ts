import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { HookDialog } from "@shared/tsp/dialogs";
import type { QuestionScope } from "@shared/tsp/question-match";

const drafts = new Map<string, { observed: string; text: string }>();
const listeners = new Set<() => void>();
const MAX_DRAFTS = 64;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };

/** Text never crosses a host, generation, epoch, surface or hook/field identity. */
export function hookDraftKey(scope: QuestionScope, surfaceId: string, dialog: HookDialog): string | null {
	if (dialog.body.kind === "select") return null;
	return JSON.stringify([scope.hostId, scope.generation, scope.epoch, surfaceId, dialog.node.id,
		dialog.node.p?.role, dialog.body.target, dialog.body.kind, dialog.title, dialog.detail]);
}

export function clearHookDraft(key: string | null): void {
	if (key && drafts.delete(key)) notify();
}

/** Cards and the generic omp screen share unfinished text while keeping their guarded answer paths. */
export function useHookDraft(key: string | null, observed: string): [string, (text: string) => void] {
	const [local, setLocal] = useState(observed);
	const snapshot = useCallback(() => {
		if (!key) return local;
		const saved = drafts.get(key);
		return saved?.observed === observed ? saved.text : observed;
	}, [key, observed, local]);
	const text = useSyncExternalStore(subscribe, snapshot);
	useEffect(() => {
		if (!key) setLocal(observed);
		if (key && drafts.has(key) && drafts.get(key)!.observed !== observed) clearHookDraft(key);
	}, [key, observed]);
	const setText = useCallback((text: string) => {
		if (!key) { setLocal(text); return; }
		drafts.delete(key);
		drafts.set(key, { observed, text });
		if (drafts.size > MAX_DRAFTS) drafts.delete(drafts.keys().next().value!);
		notify();
	}, [key, observed]);
	return [text, setText];
}
