import type { TspMenuItem, TspNode, TspText } from "../tsp";
import type { TspRendererEvent } from "../tsp-host";
import { isPlanTierAction, planOptionAction, TSP_ACTIONS, type TSP_PLAN_OPTIONS, TSP_ROLES } from "./roles";
import { liveSurfaces, region, walkNodes, type TspSurfaces } from "./view-state";

export type PlanAction = keyof typeof TSP_PLAN_OPTIONS;
export interface PlanReviewOption { id: string; label: string; selected: boolean; disabled: boolean; action: PlanAction | null; event?: TspRendererEvent }
export interface TspPlanReview {
	sf: string;
	id: string;
	title: string;
	body: string;
	optionsId: string | null;
	options: PlanReviewOption[];
	committed: boolean;
	cancelId: string | null;
	slider: { id: string; kind: "tabs" | "menu"; items: { id: string; label: string; detail?: string }[]; selected: number } | null;
}
const text = (value: TspText | undefined): string => typeof value === "string" ? value : value?.map(span => span.t).join("") ?? "";
function bodyText(node: TspNode): string {
	if (node.k === "md" || node.k === "doc") return node.p?.text ?? "";
	if (node.k === "text") return text(node.p?.text ?? node.p?.spans);
	return (node.c ?? []).filter(child => !child.p?.hidden).map(bodyText).filter(Boolean).join("\n\n");
}

function projectDockPlanReview(node: TspNode, dock: TspNode, sf: string, title: string, body: TspNode): TspPlanReview | null {
	const nodes = [...walkNodes(node)];
	const dockNodes = [...walkNodes(dock)];
	const dockIds = new Set(dockNodes.map(child => child.id));
	const approveGroup = dockNodes.find((child): child is Extract<TspNode, { k: "buttons" }> => child.k === "buttons" && child.p?.role === TSP_ROLES.planApprove && !child.p?.hidden);
	if (!approveGroup) return null;
	const approveChildren = (approveGroup.c ?? []).filter(child => !child.p?.hidden);
	const mainBtn = approveChildren.find((child): child is Extract<TspNode, { k: "button" }> => child.k === "button");
	const moreMenu = approveChildren.find((child): child is Extract<TspNode, { k: "menu" }> => child.k === "menu");
	const mainClick = mainBtn && !Array.isArray(mainBtn.p?.actions) ? mainBtn.p?.actions?.click : undefined;
	if (!mainBtn || !moreMenu || approveChildren.length !== 2 || (mainClick !== "approve" && mainClick !== "refine")) return null;
	if (mainBtn.p?.actions?.dblclick || mainBtn.p?.actions?.menu?.length || mainBtn.p?.actions?.hold?.length || mainBtn.p?.actions?.outside) return null;
	if (moreMenu.p?.disabled === true || typeof moreMenu.p?.disabled === "string") return null;

	const modelMenus = dockNodes.filter((child): child is Extract<TspNode, { k: "menu" }> => child.k === "menu" && child.p?.role === TSP_ROLES.planModel && !child.p?.hidden);
	if (modelMenus.length > 1) return null;
	const modelMenu = modelMenus[0];
	if (modelMenu?.p?.disabled === true || typeof modelMenu?.p?.disabled === "string") return null;

	const saveBtns = dockNodes.filter((child): child is Extract<TspNode, { k: "button" }> => child.k === "button" && !child.p?.hidden && !Array.isArray(child.p?.actions) && child.p?.actions?.click === TSP_ACTIONS.save);
	const cancelBtns = dockNodes.filter((child): child is Extract<TspNode, { k: "button" }> => child.k === "button" && !child.p?.hidden && !Array.isArray(child.p?.actions) && child.p?.actions?.click === TSP_ACTIONS.cancel);
	if (saveBtns.length > 1 || cancelBtns.length > 1) return null;
	const saveBtn = saveBtns[0];
	const cancelBtn = cancelBtns[0];
	if (saveBtn?.p?.actions && (saveBtn.p.actions.dblclick || saveBtn.p.actions.menu?.length || saveBtn.p.actions.hold?.length || saveBtn.p.actions.outside)) return null;
	if (cancelBtn?.p?.actions && (cancelBtn.p.actions.dblclick || cancelBtn.p.actions.menu?.length || cancelBtn.p.actions.hold?.length || cancelBtn.p.actions.outside)) return null;

	const allowedActionIds = new Set([
		mainBtn.id,
		moreMenu.id,
		...(modelMenu ? [modelMenu.id] : []),
		...(saveBtn ? [saveBtn.id] : []),
		...(cancelBtn ? [cancelBtn.id] : []),
	]);
	if (nodes.some(child =>
		child.p?.role === TSP_ROLES.planFeedback
		|| ["input", "editor", "picker", "prefs", "tree", "checklist", "effort"].includes(child.k)
		|| (child.k === "list" && child.p?.role !== TSP_ROLES.planToc)
		|| child.k === "tabs"
		|| (child.k === "buttons" && child.id !== approveGroup.id)
		|| ((child.k === "button" || child.k === "menu") && (!dockIds.has(child.id) || !allowedActionIds.has(child.id)))
		|| (child.p?.actions && child.k !== "list" && !allowedActionIds.has(child.id))
	)) return null;

	const rawChoices = moreMenu.p?.items;
	if (!rawChoices?.length) return null;
	const parsedChoices: { id: "execute" | "compact" | "keep"; label: string; disabled: boolean }[] = [];
	for (const entry of rawChoices as readonly TspMenuItem[]) {
		if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || entry.items?.length) return null;
		const action = entry.id === "execute" || entry.id === "compact" || entry.id === "keep" ? entry.id : null;
		if (!action) return null;
		const label = entry.label ?? "";
		if (planOptionAction(label) !== action) return null;
		parsedChoices.push({ id: action, label, disabled: entry.disabled === true || typeof entry.disabled === "string" });
	}
	const firstEnabledIndex = parsedChoices.findIndex(choice => !choice.disabled);
	const options: PlanReviewOption[] = parsedChoices.map((choice, index) => ({
		id: choice.id,
		label: choice.label,
		selected: index === firstEnabledIndex,
		disabled: choice.disabled,
		action: choice.id,
		event: { ev: "action", sf, id: moreMenu.id, act: choice.id },
	}));
	if (mainClick === "refine") {
		options.push({
			id: mainBtn.id,
			label: text(mainBtn.p?.text) || "Refine plan",
			selected: false,
			disabled: mainBtn.p?.disabled === true || typeof mainBtn.p?.disabled === "string" || !!mainBtn.p?.busy,
			action: "refine",
			event: { ev: "action", sf, id: mainBtn.id, act: "refine" },
		});
	}
	if (saveBtn) {
		options.push({
			id: saveBtn.id,
			label: text(saveBtn.p?.text) || "Save",
			selected: false,
			disabled: saveBtn.p?.disabled === true || typeof saveBtn.p?.disabled === "string" || !!saveBtn.p?.busy,
			action: "saveCopy",
			event: { ev: "action", sf, id: saveBtn.id, act: "save" },
		});
	}

	let slider: TspPlanReview["slider"] = null;
	if (modelMenu) {
		const rawTiers = modelMenu.p?.items;
		if (!rawTiers?.length) return null;
		const tierItems: { id: string; label: string; detail?: string; checked: boolean }[] = [];
		for (const entry of rawTiers as readonly TspMenuItem[]) {
			if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || !isPlanTierAction(entry.id) || entry.radio !== "tier" || entry.disabled === true || typeof entry.disabled === "string" || entry.items?.length) {
				return null;
			}
			tierItems.push({
				id: entry.id,
				label: entry.label ?? entry.id,
				...(entry.detail ? { detail: entry.detail } : {}),
				checked: entry.checked === true,
			});
		}
		slider = {
			id: modelMenu.id,
			kind: "menu",
			items: tierItems.map(({ id, label, detail }) => ({ id, label, ...(detail ? { detail } : {}) })),
			selected: tierItems.findIndex(item => item.checked),
		};
	}

	return { sf, id: node.id, title, body: bodyText(body), optionsId: null, options, committed: false, cancelId: cancelBtn?.id ?? null, slider };
}

/** omp 18.15+ plan overlay (list options and omp 19.2 dock layout). Unknown decision layouts remain available in the omp screen. */
export function projectPlanReview(node: TspNode, sf: string): TspPlanReview | null {
	if (node.k !== "overlay" || node.p?.role !== TSP_ROLES.planReview || node.p.hidden) return null;
	const nodes = [...walkNodes(node)];
	const body = nodes.find(child => child.p?.role === TSP_ROLES.planBody);
	const options = nodes.find((child): child is Extract<TspNode, { k: "list" }> => child.k === "list" && child.p?.role === TSP_ROLES.planOptions);
	const dock = nodes.find(child => child.p?.role === TSP_ROLES.planDock && !child.p?.hidden);
	if (options && dock) return null;
	if (dock) {
		if (!body) return null;
		return projectDockPlanReview(node, dock, sf, text(node.p.head), body);
	}
	const tools = nodes.find(child => child.p?.role === TSP_ROLES.planTools);
	const toolIds = new Set(tools ? [...walkNodes(tools)].map(child => child.id) : []);
	if (nodes.some(child =>
		child.p?.role === TSP_ROLES.planFeedback
		|| ["input", "editor", "picker", "prefs", "tree", "checklist", "effort", "buttons", "menu"].includes(child.k)
		|| (child.k === "list" && child.p?.role !== TSP_ROLES.planOptions && child.p?.role !== TSP_ROLES.planToc)
		|| (child.k === "tabs" && child.p?.role !== TSP_ROLES.planStrategy)
		|| (child.k === "button" && (!toolIds.has(child.id) || ![TSP_ACTIONS.cancel, TSP_ACTIONS.copyPlan, TSP_ACTIONS.externalEditor].some(action => action === child.p?.actions?.click)))
		|| (child.p?.actions && child.k !== "list" && child.k !== "tabs" && child.k !== "button")
	)) return null;
	const committed = !options && nodes.some(child => child.k === "spinner");
	if (!body || (!options && !committed)) return null;
	const choices: PlanReviewOption[] = (options?.c ?? []).filter((child): child is Extract<TspNode, { k: "item" }> => child.k === "item" && !child.p?.hidden).map(child => {
		const label = text(child.p?.label);
		const action = planOptionAction(label);
		const id = child.p?.key ?? child.id;
		return { id, label, selected: id === options?.p?.selected, disabled: child.p?.disabled === true, action };
	});
	// The card can only claim decisions it knows how to present.
	if (options && (!choices.length || choices.some(choice => !choice.action))) return null;
	const tabs = nodes.find((child): child is Extract<TspNode, { k: "tabs" }> => child.k === "tabs" && child.p?.role === TSP_ROLES.planStrategy);
	const cancel = tools && [...walkNodes(tools)].find(child => child.p?.actions?.click === TSP_ACTIONS.cancel);
	return { sf, id: node.id, title: text(node.p.head), body: bodyText(body), optionsId: options?.id ?? null, options: choices, committed, cancelId: cancel?.id ?? null,
		slider: tabs ? { id: tabs.id, kind: "tabs", items: (tabs.p?.items ?? []).map(item => ({ id: item.id, label: text(item.label) })), selected: (tabs.p?.items ?? []).findIndex(item => item.id === tabs.p?.active) } : null };
}
export function planReview(surfaces: TspSurfaces): TspPlanReview | null {
	for (const surface of [...liveSurfaces(surfaces)].reverse()) {
		const top = region(surface, "layer").filter(node => !node.p?.hidden && node.k !== "toast").at(-1);
		if (top) return projectPlanReview(top, surface.open.id);
	}
	return null;
}

/** omp's "Save plan" prompt: one path field, an optional default name, Cancel and Save. */
export interface TspPlanSave {
	sf: string;
	id: string;
	inputId: string;
	text: string;
	/** The file omp writes when the path is left empty ("Empty saves to …"). */
	defaultPath: string | null;
	saveId: string;
	cancelId: string;
}
/** The "Empty saves to <path>" line under omp's path field; null for any other text. */
function defaultSaveName(node: TspNode): string | null {
	if (node.k !== "text" || !Array.isArray(node.p?.spans)) return null;
	const paths = node.p.spans.filter(span => span.s === "path");
	const rest = node.p.spans.filter(span => span.s !== "path").map(span => span.t).join("").trim();
	return paths.length === 1 && rest === "Empty saves to" && paths[0]!.t ? paths[0]!.t : null;
}
/**
 * Projects only the recorded shape: layout (`col`, `row`, `spacer`), one editable path input, at most one
 * "Empty saves to" line, and enabled Cancel and Save buttons. Anything else stays in the omp screen.
 */
export function projectPlanSave(node: TspNode, sf: string): TspPlanSave | null {
	if (node.k !== "overlay" || node.p?.role !== TSP_ROLES.planSave || node.p.hidden || node.p.actions) return null;
	let input: Extract<TspNode, { k: "input" }> | null = null;
	let defaultPath: string | null = null;
	let save: TspNode | null = null;
	let cancel: TspNode | null = null;
	for (const child of [...walkNodes(node)].slice(1)) {
		if (child.k === "button") {
			const click = child.p?.actions?.click;
			if (child.p?.disabled || child.p?.busy) return null;
			if (click === TSP_ACTIONS.save && !save) save = child;
			else if (click === TSP_ACTIONS.cancel && !cancel) cancel = child;
			else return null;
			continue;
		}
		if (child.p && "actions" in child.p && child.p.actions) return null;
		if (child.k === "input") {
			if (input || child.p?.readonly || child.p?.typeahead) return null;
			input = child;
		} else if (child.k === "text") {
			if (defaultPath !== null) return null;
			defaultPath = defaultSaveName(child);
			if (defaultPath === null) return null;
		} else if (child.k !== "col" && child.k !== "row" && child.k !== "spacer") return null;
	}
	if (!input || !save || !cancel) return null;
	return { sf, id: node.id, inputId: input.id, text: input.p?.text ?? "", defaultPath, saveId: save.id, cancelId: cancel.id };
}
/**
 * omp 18.22.0's Save keeps its review open under the "Save plan" prompt. The card keeps presenting that review
 * and answers the prompt itself.
 */
export function planSavePrompt(surfaces: TspSurfaces): { review: TspPlanReview; save: TspPlanSave } | null {
	for (const surface of [...liveSurfaces(surfaces)].reverse()) {
		const layers = region(surface, "layer").filter(node => !node.p?.hidden && node.k !== "toast");
		const top = layers.at(-1);
		if (!top) continue;
		const save = projectPlanSave(top, surface.open.id);
		const below = layers.at(-2);
		const review = save && below ? projectPlanReview(below, surface.open.id) : null;
		return save && review ? { review, save } : null;
	}
	return null;
}
export function planChoice(review: TspPlanReview, action: PlanAction): TspRendererEvent {
	const option = review.options.find(option => option.action === action);
	if (review.committed || !option || option.disabled) throw new Error("omp did not offer that plan choice.");
	if (option.event) return option.event;
	if (!review.optionsId) throw new Error("omp did not offer that plan choice.");
	return { ev: "activate", sf: review.sf, id: review.optionsId, item: option.id };
}
export function planSliderEvent(review: TspPlanReview, index: number): TspRendererEvent {
	const slider = review.slider;
	if (!slider || review.committed || index < 0 || index >= slider.items.length) throw new Error("omp did not offer that plan tier.");
	const item = slider.items[index]!;
	return slider.kind === "menu"
		? { ev: "action", sf: review.sf, id: slider.id, act: item.id, checked: true }
		: { ev: "select", sf: review.sf, id: slider.id, item: item.id };
}
