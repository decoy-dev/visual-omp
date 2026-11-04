import type { TspHookAnswer } from "./dialogs.schema";
import type { TspNode } from "../tsp";
import type { TspRendererEvent, TspSurfaceSnapshot } from "../tsp-host";
import { isHookNode, isNativeHookNode, TSP_ACTIONS, TSP_ROLES } from "./roles";
import { liveSurfaces, walkNodes, type TspNodeTarget, type TspSurfaces } from "./view-state";

const completionActions: ReadonlySet<string> = new Set([TSP_ACTIONS.yes, TSP_ACTIONS.no, TSP_ACTIONS.confirm, TSP_ACTIONS.cancel, TSP_ACTIONS.close]);
/** A complete answer, validated and converted to native events at the writer. */
export type { TspHookAnswer } from "./dialogs.schema";

/** Find a visible descendant by its exact registered role, without inspecting painted text. */
export function findNodeByRole(root: TspNode, role: string): TspNode | null {
	for (const node of walkNodes(root)) if (node.p?.role === role) return node;
	return null;
}

/** Pure event builders. Callers still use the guarded host writer for authority and validation. */
export function activateItem(sf: string, node: TspNode, item: string): TspRendererEvent {
	return { ev: "activate", sf, id: node.id, item };
}
export function editField(sf: string, node: TspNode, text: string): TspRendererEvent {
	if (node.k !== "input" && node.k !== "editor") throw new Error("omp screen: The addressed node is not an editable field.");
	const len = (node.p?.text ?? "").length;
	return { ev: "edit", sf, id: node.id, from: 0, to: len, text, cursor: text.length, len };
}
export function dialogAction(sf: string, root: TspNode, act: string): TspRendererEvent | null {
	const declared = declaredHookAction(root, act);
	return declared ? { ev: "action", sf, ...declared } : null;
}
/** Closing/suspending the surface also removes a node's input lifetime. */
export function nodeHasLeft(surfaces: TspSurfaces, sf: string, id: string): boolean {
	return !liveSurfaces(surfaces).some(surface => surface.open.id === sf && [...walkNodes(surface.document)].some(node => node.id === id));
}

export interface HookDialog {
	node: TspNode;
	title: string;
	detail: string[];
	body: { kind: "select"; target: string; options: { id: string; label: string; description: string | null; disabled: boolean }[]; selected: number; confirm: boolean }
		| { kind: "input" | "editor"; target: string; value: string; readonly: boolean };
}
const plain = (text: string | readonly { t: string }[] | undefined): string => typeof text === "string" ? text : text?.map(span => span.t).join("") ?? "";

/**
 * Projects one visible hook subtree into native card facts. All picker items are retained.
 * It has no authority or effects: main's question match and guarded answer transaction decide writes.
 * Unknown hook content returns null so Rule 7 leaves it available in the generic omp screen.
 */
export function hookDialog(doc: TspNode): HookDialog | null {
	const root = [...walkNodes(doc)].find(isNativeHookNode);
	if (!root) return null;
	const nodes = [...walkNodes(root)];
	const list = nodes.find(node => node.k === "picker" || node.k === "list");
	if (list?.k === "picker" || list?.k === "list") {
		const options = list.k === "picker"
			? (list.p?.items ?? []).map(item => ({ id: item.id, label: plain(item.label), description: plain(item.detail) || null, disabled: !!item.disabled }))
			: (list.c ?? []).filter(node => node.k === "item").map(item => ({ id: item.p?.key ?? item.id, label: plain(item.p?.label), description: plain(item.p?.detail) || null, disabled: !!item.p?.disabled }));
		if (!options.length) return null;
		const title = list.p?.title ?? (root.k === "overlay" ? plain(root.p?.head) : "");
		const detail = list.k === "picker" ? plain(list.p?.subtitle) : "";
		return { node: root, title, detail: detail ? detail.split("\n") : [], body: {
			kind: "select", target: list.id, options, selected: Math.max(0, options.findIndex(option => option.id === list.p?.selected)),
			confirm: root.p?.role === TSP_ROLES.hookConfirm || options.length === 2 && options[0]?.label === "Yes" && options[1]?.label === "No",
		} };
	}
	const field = nodes.find(node => node.k === "input" || node.k === "editor");
	if (!field || (field.k !== "input" && field.k !== "editor")) return null;
	const title = findNodeByRole(root, root.p?.role === TSP_ROLES.hookEditor ? TSP_ROLES.hookEditorTitle : TSP_ROLES.hookInputTitle);
	const description = findNodeByRole(root, root.p?.role === TSP_ROLES.hookEditor ? TSP_ROLES.hookEditorDescription : TSP_ROLES.hookInputDescription);
	return { node: root, title: title?.k === "text" ? plain(title.p?.spans) || title.p?.text || "" : root.k === "overlay" ? plain(root.p?.head) : "",
		detail: description?.k === "text" ? (plain(description.p?.spans) || description.p?.text || "").split("\n") : [],
		body: { kind: root.p?.role === TSP_ROLES.hookInput ? "input" : "editor", target: field.id, value: field.p?.text ?? "", readonly: !!field.p?.readonly } };
}

/** Hook roots eligible for the native card. Surface selection remains explicit at the callsite. */
export function hookDialogTarget(surfaces: readonly TspSurfaceSnapshot[]): (TspNodeTarget & { dialog: HookDialog }) | null {
	for (const surface of [...liveSurfaces(surfaces)].reverse()) {
		const dialog = hookDialog(surface.document);
		if (dialog) return { surface, node: dialog.node, dialog };
	}
	return null;
}

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
	if (!isHookNode(root) || root.id !== answer.id) throw new Error("omp screen: The question is no longer available.");
	const nodes = [...walkNodes(root)];
	const target = "target" in answer ? nodes.find(node => node.id === answer.target) : undefined;
	const action = (act: string, fallback?: TspNode): TspRendererEvent => {
		const declared = declaredHookAction(root, act);
		if (declared) return { ev: "action", sf: answer.sf, ...declared };
		if (fallback && !nodes.some(node => node.p?.actions)) return { ev: "action", sf: answer.sf, id: fallback.id, act };
		throw new Error("omp screen: omp has not declared that question action.");
	};
	switch (answer.kind) {
		case "choose": {
			if (!target || (target.k !== "picker" && target.k !== "list")) throw new Error("omp screen: The question list is no longer available.");
			const item = target.k === "picker" ? target.p?.items?.find(item => item.id === answer.item) : target.c?.find(item => (item.p?.key ?? item.id) === answer.item)?.p;
			if (!item || ("disabled" in item && item.disabled)) throw new Error("omp screen: The question option is no longer available.");
			return [activateItem(answer.sf, target, answer.item)];
		}
		case "text": {
			if (!target || (target.k !== "input" && target.k !== "editor") || target.p?.readonly || (target.p?.text ?? "").length !== answer.len) throw new Error("omp screen: The question field changed before the answer could be sent.");
			return [editField(answer.sf, target, answer.text), action(TSP_ACTIONS.submit, target)];
		}
		case "action": {
			if (!completionActions.has(answer.act)) throw new Error("omp screen: Submit this question through its complete answer controls.");
			if (answer.act === TSP_ACTIONS.confirm && nodes.some(node => node.k === "picker" || node.k === "list")) throw new Error("omp screen: Choose a question option by item id.");
			const declared = declaredHookAction(root, answer.act);
			if (!target || !declared || declared.id !== target.id) throw new Error("omp screen: omp has not declared that question action.");
			return [{ ev: "action", sf: answer.sf, ...declared }];
		}
		case "cancel": {
			const declared = declaredHookAction(root, TSP_ACTIONS.cancel) ?? declaredHookAction(root, TSP_ACTIONS.close);
			return declared ? [{ ev: "action", sf: answer.sf, ...declared }] : [];
		}
	}
}
