import { z } from "zod";
import type { TspNode } from "../tsp";
import type { TspRendererEvent } from "../tsp-host";
import { isHookNode, TSP_ACTIONS } from "./roles";
import { walkNodes } from "./view-state";

const Target = { sf: z.string().min(1), id: z.string().min(1) };
const completionActions: ReadonlySet<string> = new Set([TSP_ACTIONS.yes, TSP_ACTIONS.no, TSP_ACTIONS.confirm, TSP_ACTIONS.cancel, TSP_ACTIONS.close]);
/** A complete answer, validated and converted to native events at the writer. */
export const TspHookAnswer = z.discriminatedUnion("kind", [
	z.strictObject({ ...Target, kind: z.literal("choose"), target: z.string().min(1), item: z.string() }),
	z.strictObject({ ...Target, kind: z.literal("text"), target: z.string().min(1), text: z.string(), len: z.number().int().nonnegative() }),
	z.strictObject({ ...Target, kind: z.literal("action"), target: z.string().min(1), act: z.string().min(1) }),
	z.strictObject({ ...Target, kind: z.literal("cancel") }),
]);
export type TspHookAnswer = z.infer<typeof TspHookAnswer>;

export function declaredHookAction(root: TspNode, act: string): { id: string; act: string } | null {
	for (const node of walkNodes(root)) {
		const actions = node.p?.actions;
		if (Array.isArray(actions)) {
			const action = actions.find(action => action.id === act && !action.disabled);
			if (action) return { id: node.id, act };
		} else if (actions?.click === act) return { id: node.id, act };
	}
	return null;
}

/** Uses current ids, declared buttons and observed UTF-16 length. Never invents yes/no choices. */
export function hookAnswerEvents(root: TspNode, answer: TspHookAnswer): TspRendererEvent[] {
	if (!isHookNode(root) || root.id !== answer.id) throw new Error("TSP preview: The question is no longer available.");
	const nodes = [...walkNodes(root)];
	const target = "target" in answer ? nodes.find(node => node.id === answer.target) : undefined;
	const action = (act: string, fallback?: TspNode): TspRendererEvent => {
		const declared = declaredHookAction(root, act);
		if (declared) return { ev: "action", sf: answer.sf, ...declared };
		if (fallback && !nodes.some(node => node.p?.actions)) return { ev: "action", sf: answer.sf, id: fallback.id, act };
		throw new Error("TSP preview: omp has not declared that question action.");
	};
	switch (answer.kind) {
		case "choose": {
			if (!target || (target.k !== "picker" && target.k !== "list")) throw new Error("TSP preview: The question list is no longer available.");
			const item = target.k === "picker" ? target.p?.items?.find(item => item.id === answer.item) : target.c?.find(item => (item.p?.key ?? item.id) === answer.item)?.p;
			if (!item || ("disabled" in item && item.disabled)) throw new Error("TSP preview: The question option is no longer available.");
			return [{ ev: "activate", sf: answer.sf, id: target.id, item: answer.item }];
		}
		case "text": {
			if (!target || (target.k !== "input" && target.k !== "editor") || target.p?.readonly || (target.p?.text ?? "").length !== answer.len) throw new Error("TSP preview: The question field changed before the answer could be sent.");
			return [{ ev: "edit", sf: answer.sf, id: target.id, from: 0, to: answer.len, text: answer.text, cursor: answer.text.length, len: answer.len }, action(TSP_ACTIONS.submit, target)];
		}
		case "action": {
			if (!completionActions.has(answer.act)) throw new Error("TSP preview: Submit this question through its complete answer controls.");
			if (answer.act === TSP_ACTIONS.confirm && nodes.some(node => node.k === "picker" || node.k === "list")) throw new Error("TSP preview: Choose a question option by item id.");
			const declared = declaredHookAction(root, answer.act);
			if (!target || !declared || declared.id !== target.id) throw new Error("TSP preview: omp has not declared that question action.");
			return [{ ev: "action", sf: answer.sf, ...declared }];
		}
		case "cancel": {
			const declared = declaredHookAction(root, TSP_ACTIONS.cancel) ?? declaredHookAction(root, TSP_ACTIONS.close);
			return declared ? [{ ev: "action", sf: answer.sf, ...declared }] : [];
		}
	}
}
