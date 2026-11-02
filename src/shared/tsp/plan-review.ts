import type { TspNode, TspText } from "../tsp";
import type { TspRendererEvent } from "../tsp-host";
import { TSP_ACTIONS, TSP_PLAN_OPTIONS, TSP_ROLES } from "./roles";
import { liveSurfaces, region, walkNodes, type TspSurfaces } from "./view-state";

export type PlanAction = keyof typeof TSP_PLAN_OPTIONS;
export interface PlanReviewOption { id: string; label: string; selected: boolean; disabled: boolean; action: PlanAction | null }
export interface TspPlanReview {
	sf: string;
	id: string;
	title: string;
	body: string;
	optionsId: string | null;
	options: PlanReviewOption[];
	committed: boolean;
	cancelId: string | null;
	slider: { id: string; items: { id: string; label: string }[]; selected: number } | null;
}
const text = (value: TspText | undefined): string => typeof value === "string" ? value : value?.map(span => span.t).join("") ?? "";
function bodyText(node: TspNode): string {
	if (node.k === "md") return node.p?.text ?? "";
	if (node.k === "text") return text(node.p?.text ?? node.p?.spans);
	return (node.c ?? []).filter(child => !child.p?.hidden).map(bodyText).filter(Boolean).join("\n\n");
}

/** omp 18.15.0's plan overlay. Unknown decision layouts remain available in the omp screen. */
export function projectPlanReview(node: TspNode, sf: string): TspPlanReview | null {
	if (node.k !== "overlay" || node.p?.role !== TSP_ROLES.planReview || node.p.hidden) return null;
	const nodes = [...walkNodes(node)];
	const tools = nodes.find(child => child.p?.role === TSP_ROLES.planTools);
	const toolIds = new Set(tools ? [...walkNodes(tools)].map(child => child.id) : []);
	if (nodes.some(child =>
		child.p?.role === TSP_ROLES.planFeedback
		|| ["input", "editor", "picker", "prefs", "tree", "checklist", "effort"].includes(child.k)
		|| (child.k === "list" && child.p?.role !== TSP_ROLES.planOptions && child.p?.role !== TSP_ROLES.planToc)
		|| (child.k === "tabs" && child.p?.role !== TSP_ROLES.planStrategy)
		|| (child.k === "button" && (!toolIds.has(child.id) || ![TSP_ACTIONS.cancel, TSP_ACTIONS.copyPlan, TSP_ACTIONS.externalEditor].some(action => action === child.p?.actions?.click)))
		|| (child.p?.actions && child.k !== "list" && child.k !== "tabs" && child.k !== "button")
	)) return null;
	const body = nodes.find(child => child.p?.role === TSP_ROLES.planBody);
	const options = nodes.find((child): child is Extract<TspNode, { k: "list" }> => child.k === "list" && child.p?.role === TSP_ROLES.planOptions);
	const committed = !options && nodes.some(child => child.k === "spinner");
	if (!body || (!options && !committed)) return null;
	const choices: PlanReviewOption[] = (options?.c ?? []).filter((child): child is Extract<TspNode, { k: "item" }> => child.k === "item" && !child.p?.hidden).map(child => {
		const label = text(child.p?.label);
		const action = (Object.keys(TSP_PLAN_OPTIONS) as PlanAction[]).find(action => label.startsWith(TSP_PLAN_OPTIONS[action])) ?? null;
		const id = child.p?.key ?? child.id;
		return { id, label, selected: id === options?.p?.selected, disabled: child.p?.disabled === true, action };
	});
	// The card can only claim decisions it knows how to present.
	if (options && (!choices.length || choices.some(choice => !choice.action))) return null;
	const tabs = nodes.find((child): child is Extract<TspNode, { k: "tabs" }> => child.k === "tabs" && child.p?.role === TSP_ROLES.planStrategy);
	const cancel = tools && [...walkNodes(tools)].find(child => child.p?.actions?.click === TSP_ACTIONS.cancel);
	return { sf, id: node.id, title: text(node.p.head), body: bodyText(body), optionsId: options?.id ?? null, options: choices, committed, cancelId: cancel?.id ?? null,
		slider: tabs ? { id: tabs.id, items: (tabs.p?.items ?? []).map(item => ({ id: item.id, label: text(item.label) })), selected: (tabs.p?.items ?? []).findIndex(item => item.id === tabs.p?.active) } : null };
}
export function planReview(surfaces: TspSurfaces): TspPlanReview | null {
	for (const surface of [...liveSurfaces(surfaces)].reverse()) {
		const top = region(surface, "layer").filter(node => !node.p?.hidden && node.k !== "toast").at(-1);
		if (top) return projectPlanReview(top, surface.open.id);
	}
	return null;
}
export function planChoice(review: TspPlanReview, action: PlanAction): TspRendererEvent {
	const option = review.options.find(option => option.action === action);
	if (!review.optionsId || review.committed || !option || option.disabled) throw new Error("omp did not offer that plan choice.");
	return { ev: "activate", sf: review.sf, id: review.optionsId, item: option.id };
}
