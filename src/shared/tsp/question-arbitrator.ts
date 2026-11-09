import { CollabQuestionState as QuestionStateSchema } from "./question-match.schema";
import { matchQuestions, type CollabQuestionState, type HookQuestion, type QuestionMatch, type QuestionScope } from "./question-match";

const sameScope = (a: QuestionScope, b: QuestionScope): boolean => a.hostId === b.hostId && a.generation === b.generation && a.epoch === b.epoch;

function continuesForm(prior: HookQuestion, current: HookQuestion | undefined): boolean {
	if (prior.kind !== "form" || current?.kind !== "form" || !prior.formView || !current.formView) return false;
	const before = prior.formNavigation?.items;
	const after = current.formNavigation?.items;
	return !before || !after || before.length === after.length && before.every((item, index) => item === after[index]);
}

/** Main-owned mirror. A matched node remains blocked until BOTH channels have completed. */
export class QuestionArbitrator {
	#scope: QuestionScope | null = null;
	#state: CollabQuestionState | null = null;
	#bindings = new Map<string, { dialog: HookQuestion; reqId: number; requestFirstSeenMs: number }>();
	#answering = new Set<string>();
	#remoteOwned = new Set<string>();
	#nodeFirstSeen = new Map<string, number>();
	#requestFirstSeen = new Map<string, number>();
	readonly #clock: () => number;
	constructor(clock: () => number = () => performance.now()) { this.#clock = clock; }
	reset(scope: QuestionScope): void {
		if (this.#scope && sameScope(this.#scope, scope)) return;
		this.#scope = scope; this.#state = null; this.#bindings.clear(); this.#answering.clear();
		this.#remoteOwned.clear();
		this.#nodeFirstSeen.clear(); this.#requestFirstSeen.clear();
	}
	update(scope: QuestionScope, input: unknown): boolean {
		this.reset(scope);
		const parsed = QuestionStateSchema.safeParse(input);
		if (!parsed.success || !sameScope(scope, parsed.data)) return false;
		const state = parsed.data;
		if (this.#state && state.revision <= this.#state.revision) return false;
		const observedAt = this.#clock();
		const requestKeys = new Set<string>();
		for (const request of state.requests) {
			const key = JSON.stringify([state.connection, request.reqId]);
			requestKeys.add(key);
			if (!this.#requestFirstSeen.has(key)) this.#requestFirstSeen.set(key, observedAt);
		}
		for (const key of this.#requestFirstSeen.keys()) if (!requestKeys.has(key)) this.#requestFirstSeen.delete(key);
		this.#state = state;
		return true;
	}
	/** Shutdown can outlive collab, but cannot take an answer owned by another path. */
	canAnswerShutdown(scope: QuestionScope, dialogs: readonly HookQuestion[], surfaceId: string, nodeId: string): boolean {
		const match = this.matches(scope, dialogs).find(match => match.surfaceId === surfaceId && match.nodeId === nodeId);
		if (match?.status === "unmatched") return true;
		return match?.status === "unavailable" && !this.#remoteOwned.has(JSON.stringify([surfaceId, nodeId])) && !this.#state?.requests.length;
	}
	/** Called synchronously at the serialized writer, after the final arbitration check. */
	answer(scope: QuestionScope, dialogs: readonly HookQuestion[], surfaceId: string, nodeId: string, authority: "local" | "shutdown" = "local"): void {
		const match = this.matches(scope, dialogs).find(match => match.surfaceId === surfaceId && match.nodeId === nodeId);
		const allowed = authority === "shutdown" ? this.canAnswerShutdown(scope, dialogs, surfaceId, nodeId) : match?.status === "unmatched";
		if (!allowed) throw new Error(`omp screen: This question cannot be answered here (${match?.status ?? "no longer available"}).`);
		this.#answering.add(JSON.stringify([surfaceId, nodeId]));
	}
	/** Input authority may disappear before a hook's physical node leaves during teardown. */
	matches(scope: QuestionScope, dialogs: readonly HookQuestion[], physicalDialogs: readonly HookQuestion[] = dialogs): QuestionMatch[] {
		this.reset(scope);
		const matches = matchQuestions(scope, this.#state, dialogs);
		const observedAt = this.#clock();
		const nodeKeys = new Set(dialogs.map(dialog => JSON.stringify([dialog.surfaceId, dialog.nodeId])));
		const physicalNodeKeys = new Map(physicalDialogs.map(dialog => [JSON.stringify([dialog.surfaceId, dialog.nodeId]), dialog]));
		for (const key of nodeKeys) if (!this.#nodeFirstSeen.has(key)) this.#nodeFirstSeen.set(key, observedAt);
		for (const key of this.#nodeFirstSeen.keys()) if (!nodeKeys.has(key)) this.#nodeFirstSeen.delete(key);
		for (const key of this.#answering) if (!physicalNodeKeys.has(key)) this.#answering.delete(key);
		for (const key of this.#remoteOwned) if (!physicalNodeKeys.has(key)) this.#remoteOwned.delete(key);
		for (const [key, binding] of this.#bindings) {
			if (binding.dialog.kind === "form" && !continuesForm(binding.dialog, physicalNodeKeys.get(key))) {
				this.#bindings.delete(key);
				this.#remoteOwned.delete(key);
			} else if (this.#state?.connected && !physicalNodeKeys.has(key) && !this.#state.requests.some(request => request.reqId === binding.reqId)) this.#bindings.delete(key);
		}
		return matches.map((match, index) => {
			const key = JSON.stringify([match.surfaceId, match.nodeId]);
			const prior = this.#bindings.get(key);
			let result: QuestionMatch = match;
			if (this.#answering.has(key)) result = { surfaceId: match.surfaceId, nodeId: match.nodeId, status: "answering" };
			else if (prior && this.#state?.connected) {
				const form = continuesForm(prior.dialog, dialogs[index]);
				// A tab can hide the bound field before its guest request ends. Retain
				// ownership, not a fabricated match for whichever request arrives next.
				if (form ? match.status !== "matched" : !this.#state.requests.some(request => request.reqId === prior.reqId)) {
					result = { surfaceId: match.surfaceId, nodeId: match.nodeId, status: "settling", reqId: prior.reqId };
				}
			}
			if (result.status === "matched") {
				this.#remoteOwned.add(key);
				const requestFirstSeenMs = prior && prior.reqId === result.reqId ? prior.requestFirstSeenMs : this.#requestFirstSeen.get(JSON.stringify([this.#state!.connection, result.reqId]))!;
				this.#bindings.set(key, { dialog: dialogs[index]!, reqId: result.reqId!, requestFirstSeenMs });
			}
			if (result.status === "ambiguous" || result.status === "settling") this.#remoteOwned.add(key);
			else if (result.status === "unmatched") this.#remoteOwned.delete(key);
			const requestFirstSeenMs = result.reqId === undefined ? undefined : this.#bindings.get(key)?.requestFirstSeenMs;
			return { ...result, nodeFirstSeenMs: this.#nodeFirstSeen.get(key)!, ...(requestFirstSeenMs === undefined ? {} : { requestFirstSeenMs }) };
		});
	}
}
