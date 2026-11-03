import { z } from "zod";
import type { TspText } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { isHookNode, TSP_ROLES } from "./roles";
import { walkNodes } from "./view-state";

const Option = z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })]);
export const CollabQuestion = z.discriminatedUnion("kind", [
	z.object({ reqId: z.number().int().nonnegative(), kind: z.literal("select"), title: z.string(), options: z.array(Option) }),
	z.object({ reqId: z.number().int().nonnegative(), kind: z.literal("editor"), title: z.string(), prefill: z.string().optional() }),
]);
export type CollabQuestion = z.infer<typeof CollabQuestion>;
export const CollabQuestionState = z.strictObject({
	hostId: z.string(), generation: z.number().int().nonnegative(), epoch: z.number().int().nonnegative(),
	connection: z.number().int().nonnegative(), revision: z.number().int().nonnegative(), connected: z.boolean(),
	requests: z.array(CollabQuestion),
});
export type CollabQuestionState = z.infer<typeof CollabQuestionState>;
export interface QuestionScope { hostId: string; generation: number; epoch: number }
export interface HookQuestion { surfaceId: string; nodeId: string; title: string; kind: "select" | "editor" | "local"; options?: { label: string; description?: string }[]; field?: string }
export interface QuestionMatch {
	surfaceId: string; nodeId: string;
	status: "matched" | "ambiguous" | "unmatched" | "unavailable" | "settling" | "answering";
	reqId?: number;
	/** Diagnostic observation times from main's single monotonic clock. Never input authority. */
	nodeFirstSeenMs?: number;
	requestFirstSeenMs?: number;
}
const text = (value: string): string => value.trim().replace(/\s+/g, " ");
const sameScope = (a: QuestionScope, b: QuestionScope): boolean => a.hostId === b.hostId && a.generation === b.generation && a.epoch === b.epoch;
function questionText(value: TspText | undefined): string {
	return typeof value === "string" ? value : value?.map(span => span.t).join("") ?? "";
}

/** Only live, current-generation surfaces may supply input targets. Unknown hooks stay local/read-only. */
export function hookQuestions(surfaces: readonly (TspSurfaceSnapshot & { documentGeneration?: number | null })[], generation: number): HookQuestion[] {
	const result: HookQuestion[] = [];
	for (const surface of surfaces) {
		if (surface.closed || surface.suspended || (surface.documentGeneration !== undefined && surface.documentGeneration !== generation)) continue;
		for (const node of walkNodes(surface.document)) {
			if (!isHookNode(node)) continue;
			const children = [...walkNodes(node)];
			const picker = children.find(child => child.k === "picker" || child.k === "list");
			const field = children.find(child => child.k === "editor" || child.k === "input");
			const kind = node.k === "picker" || node.p?.role === TSP_ROLES.hookSelect || node.p?.role === TSP_ROLES.hookConfirm ? "select" : node.p?.role === TSP_ROLES.hookEditor ? "editor" : "local";
			const items = picker?.k === "picker" ? picker.p?.items : children.filter(child => child.k === "item").map(child => child.p!);
			const titleNode = children.find(child => child.p?.role?.endsWith(".title") || child.p?.role?.endsWith(".eyebrow"));
			const title = node.k === "overlay" ? questionText(node.p?.head) : node.k === "picker" ? node.p?.title ?? "" : "";
			result.push({ surfaceId: surface.open.id, nodeId: node.id, kind, title: title || (titleNode?.k === "text" ? questionText(titleNode.p?.spans) : ""), options: items?.map(item => ({ label: questionText(item.label), ...(item.detail ? { description: questionText(item.detail) } : {}) })), field: field?.p?.text });
		}
	}
	return result;
}

function compatible(dialog: HookQuestion, request: CollabQuestion): boolean {
	if (dialog.kind !== request.kind || !text(dialog.title) || text(dialog.title) !== text(request.title)) return false;
	if (request.kind === "editor") return dialog.field === undefined || dialog.field === (request.prefill ?? "");
	if (!dialog.options || dialog.options.length !== request.options.length) return false;
	return dialog.options.every((option, index) => {
		const raw = request.options[index]!;
		const other = typeof raw === "string" ? { label: raw } : raw;
		return text(option.label) === text(other.label) && (!option.description || !other.description || text(option.description) === text(other.description));
	});
}

/** Mutual uniqueness, never first-match-wins. Any pending collab request blocks uncertain local answers. */
export function matchQuestions(scope: QuestionScope, state: CollabQuestionState | null, dialogs: readonly HookQuestion[]): QuestionMatch[] {
	const current = state && sameScope(scope, state) && state.connected;
	const candidates = dialogs.map(dialog => current ? state.requests.filter(request => compatible(dialog, request)) : []);
	return dialogs.map((dialog, index) => {
		const matches = candidates[index]!;
		if (!current) return { ...dialog, status: "unavailable" };
		if (state.requests.length === 0) return { ...dialog, status: dialogs.filter(other => other.surfaceId === dialog.surfaceId && other.nodeId === dialog.nodeId).length === 1 ? "unmatched" : "ambiguous" };
		const request = matches[0];
		if (matches.length === 1 && candidates.filter(list => list.some(candidate => candidate.reqId === request!.reqId)).length === 1) return { ...dialog, status: "matched", reqId: request!.reqId };
		return { ...dialog, status: "ambiguous" };
	});
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
		const parsed = CollabQuestionState.safeParse(input);
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
		const physicalNodeKeys = new Set(physicalDialogs.map(dialog => JSON.stringify([dialog.surfaceId, dialog.nodeId])));
		for (const key of nodeKeys) if (!this.#nodeFirstSeen.has(key)) this.#nodeFirstSeen.set(key, observedAt);
		for (const key of this.#nodeFirstSeen.keys()) if (!nodeKeys.has(key)) this.#nodeFirstSeen.delete(key);
		for (const key of this.#answering) if (!physicalNodeKeys.has(key)) this.#answering.delete(key);
		for (const key of this.#remoteOwned) if (!physicalNodeKeys.has(key)) this.#remoteOwned.delete(key);
		for (const [key, binding] of this.#bindings) {
			if (this.#state?.connected && !physicalNodeKeys.has(key) && !this.#state.requests.some(request => request.reqId === binding.reqId)) this.#bindings.delete(key);
		}
		return matches.map((match, index) => {
			const key = JSON.stringify([match.surfaceId, match.nodeId]);
			const prior = this.#bindings.get(key);
			let result: QuestionMatch = match;
			if (this.#answering.has(key)) result = { surfaceId: match.surfaceId, nodeId: match.nodeId, status: "answering" };
			else if (prior && this.#state?.connected && !this.#state.requests.some(request => request.reqId === prior.reqId)) result = { surfaceId: match.surfaceId, nodeId: match.nodeId, status: "settling", reqId: prior.reqId };
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
