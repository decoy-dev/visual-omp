import { z } from "zod";
import type { TspText } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { isHookDialog, TSP_ROLES } from "./roles";
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
export interface QuestionMatch { surfaceId: string; nodeId: string; status: "matched" | "ambiguous" | "unmatched" | "unavailable" | "settling"; reqId?: number }
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
			if (!isHookDialog(node.p?.role)) continue;
			const children = [...walkNodes(node)];
			const picker = children.find(child => child.k === "picker" || child.k === "list");
			const field = children.find(child => child.k === "editor" || child.k === "input");
			const kind = node.p?.role === TSP_ROLES.hookSelect ? "select" : node.p?.role === TSP_ROLES.hookEditor ? "editor" : "local";
			const items = picker?.k === "picker" ? picker.p?.items : children.filter(child => child.k === "item").map(child => child.p!);
			result.push({ surfaceId: surface.open.id, nodeId: node.id, kind, title: node.k === "overlay" ? questionText(node.p?.head) : "", options: items?.map(item => ({ label: questionText(item.label), ...(item.detail ? { description: questionText(item.detail) } : {}) })), field: field?.p?.text });
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
		if (state.requests.length === 0) return { ...dialog, status: "unmatched" };
		const request = matches[0];
		if (matches.length === 1 && candidates.filter(list => list.some(candidate => candidate.reqId === request!.reqId)).length === 1) return { ...dialog, status: "matched", reqId: request!.reqId };
		return { ...dialog, status: "ambiguous" };
	});
}

/** Main-owned mirror. A matched node remains blocked until BOTH channels have completed. */
export class QuestionArbitrator {
	#scope: QuestionScope | null = null;
	#state: CollabQuestionState | null = null;
	#bindings = new Map<string, { dialog: HookQuestion; reqId: number }>();
	reset(scope: QuestionScope): void {
		if (this.#scope && sameScope(this.#scope, scope)) return;
		this.#scope = scope; this.#state = null; this.#bindings.clear();
	}
	update(scope: QuestionScope, input: unknown): boolean {
		this.reset(scope);
		const parsed = CollabQuestionState.safeParse(input);
		if (!parsed.success || !sameScope(scope, parsed.data)) return false;
		const state = parsed.data;
		if (this.#state && state.revision <= this.#state.revision) return false;
		if (!state.connected || this.#state?.connection !== state.connection) this.#bindings.clear();
		this.#state = state;
		return true;
	}
	matches(scope: QuestionScope, dialogs: readonly HookQuestion[]): QuestionMatch[] {
		this.reset(scope);
		const matches = matchQuestions(scope, this.#state, dialogs);
		for (const [key, binding] of this.#bindings) {
			if (!dialogs.some(dialog => dialog.surfaceId === binding.dialog.surfaceId && dialog.nodeId === binding.dialog.nodeId) && !this.#state?.requests.some(request => request.reqId === binding.reqId)) this.#bindings.delete(key);
		}
		return matches.map((match, index) => {
			const key = JSON.stringify([match.surfaceId, match.nodeId]);
			const prior = this.#bindings.get(key);
			if (prior && !this.#state?.requests.some(request => request.reqId === prior.reqId)) return { surfaceId: match.surfaceId, nodeId: match.nodeId, status: "settling", reqId: prior.reqId };
			if (match.status === "matched") this.#bindings.set(key, { dialog: dialogs[index]!, reqId: match.reqId! });
			return match;
		});
	}
}
