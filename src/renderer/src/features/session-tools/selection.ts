import type { AssistantMessage, WireModel } from '@oh-my-pi/pi-wire';
import type { SessionHistory } from '../../state/history';
import { liveEntries, type SessionView, type SessionMode } from '../../state/session';
import type { SessionEntry } from '@oh-my-pi/pi-wire';

export const selectReadOnly = (view: SessionView) => view.readOnly;
export const selectCurrentModel = (view: SessionView) => view.guest?.state?.model;

export interface ModelSelection {
	readOnly: boolean;
	entries: readonly SessionEntry[] | null;
	history: SessionHistory | null;
	leaf: string | null;
	live: WireModel | undefined;
	stream: AssistantMessage | null;
}
export function selectModel(view: SessionView): ModelSelection {
	return { readOnly: view.readOnly, entries: liveEntries(view), history: view.history, leaf: view.displayLeaf, live: view.guest?.state?.model, stream: view.guest?.stream ?? null };
}

/** Text and thinking tokens cannot change the model button; fallback metadata can. */
export function sameStreamModel(left: AssistantMessage | null, right: AssistantMessage | null): boolean {
	if (left === right) return true;
	if (!left || !right || left.provider !== right.provider) return false;
	let a = 0;
	let b = 0;
	for (;;) {
		while (a < left.content.length && left.content[a].type !== 'fallback') a++;
		while (b < right.content.length && right.content[b].type !== 'fallback') b++;
		if (a === left.content.length || b === right.content.length) return a === left.content.length && b === right.content.length;
		const first = left.content[a++];
		const second = right.content[b++];
		if (first.type !== 'fallback' || second.type !== 'fallback' || first.from?.model !== second.from?.model || first.to?.model !== second.to?.model) return false;
	}
}
export function sameModelSelection(left: ModelSelection, right: ModelSelection): boolean {
	return left.readOnly === right.readOnly && left.entries === right.entries && left.history === right.history && left.leaf === right.leaf && left.live === right.live && sameStreamModel(left.stream, right.stream);
}

export function selectThinking(view: SessionView) {
	return { entries: liveEntries(view), history: view.history, leaf: view.displayLeaf, hostId: view.host?.hostId ?? null, generation: view.host?.generation ?? 0, transport: view.host?.transport, event: view.guest?.thinkingEvent ?? null, selector: view.guest?.thinkingSelector ?? null, effective: view.guest?.state?.thinkingLevel };
}

export interface AccountSelection {
	mode: SessionMode;
	hostId: string | null;
	generation: number;
	sessionId: string | null;
	provider: string | null;
	readOnly: boolean;
	working: boolean;
}
export function selectAccount(view: SessionView): AccountSelection {
	return { mode: view.mode, hostId: view.host?.hostId ?? null, generation: view.host?.generation ?? 0, sessionId: view.host?.sessionId ?? null, provider: view.guest?.state?.model?.provider ?? null, readOnly: view.readOnly, working: view.working };
}
