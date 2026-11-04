import { hookDialogTarget, nodeHasLeft, type HookDialog, type TspHookAnswer } from "@shared/tsp/dialogs";
import type { TspHostSource } from "../../state/tsp/hosts";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { OmpDialog } from "./ompDialog";

/** Reuse the classic card's presentation without losing native item ids or field text. */
export function nativeDialog(dialog: HookDialog): OmpDialog {
	const base = { title: dialog.title, detail: dialog.detail, cancelKey: "escape" };
	const body = dialog.body;
	return body.kind === "select" ? { ...base, kind: "select", confirm: body.confirm, options: body.options, selected: body.selected, hidden: 0, query: null, help: null }
		: { ...base, kind: body.kind, value: body.value, submitKey: body.kind === "input" ? "enter" : "C-enter" };
}

/** Current-generation presentation only. Read-only arbitration is kept separate from visibility. */
export function currentHook(snapshot: TspHostSnapshot | null, hostId: string | null, generation: number | undefined) {
	if (!snapshot || snapshot.hostId !== hostId || snapshot.generation !== generation || snapshot.lifecycle !== "live") return null;
	return hookDialogTarget(snapshot.surfaces.filter(surface => surface.documentGeneration === generation));
}

/** Pure complete-answer builders. Only host:tsp-answer may write these transactions. */
export function dialogAnswer(sf: string, dialog: HookDialog, answer: { index: number } | { text: string } | { cancel: true }): TspHookAnswer {
	const base = { sf, id: dialog.node.id };
	if ("cancel" in answer) return { ...base, kind: "cancel" };
	if ("index" in answer && dialog.body.kind === "select") {
		const item = dialog.body.options[answer.index];
		if (!item || item.disabled) throw new Error("omp screen: The question option is no longer available.");
		return { ...base, kind: "choose", target: dialog.body.target, item: item.id };
	}
	if ("text" in answer && dialog.body.kind !== "select") return { ...base, kind: "text", target: dialog.body.target, text: answer.text, len: dialog.body.value.length };
	throw new Error("omp screen: The question changed before the answer could be sent.");
}

/**
 * Subscription-only completion wait, shared with later semantic consumers. Subscribe before writing.
 * An epoch/room replacement ends the addressed node's lifetime. Timeout is failure, never success.
 * Abort on unmount or a failed write so no timer or document listener outlives its consumer.
 */
export function waitForNodeToLeave(store: Pick<TspHostSource, "getSnapshot" | "subscribe">, scope: Pick<TspHostSnapshot, "hostId" | "generation" | "epoch">, sf: string, id: string, signal?: AbortSignal, timeoutMs = 8000): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let off = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const finish = (error?: unknown) => { off(); clearTimeout(timer); signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
	const abort = () => finish(new Error("omp screen: The question answer was interrupted."));
	const check = () => {
		const snapshot = store.getSnapshot();
		if (!snapshot) return;
		if (snapshot.hostId !== scope.hostId || snapshot.generation !== scope.generation || snapshot.epoch !== scope.epoch || snapshot.lifecycle !== "live" || nodeHasLeft(snapshot.surfaces, sf, id)) finish();
	};
	off = store.subscribe(check);
	timer = setTimeout(() => finish(new Error("omp screen: omp has not closed the question yet.")), timeoutMs);
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort(); else check();
	return promise;
}
