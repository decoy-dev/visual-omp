import type { TspAdvisorAction } from "./advisor.schema";
import type { AdvisorScope } from "../contracts/advisor";
import type { TspNode, TspOpen } from "../tsp";
import type { TspRendererEvent } from "../tsp-host";
import { TSP_ACTIONS, TSP_ADVISOR, TSP_ROLES } from "./roles";
import { liveSurfaces, walkNodes, type TspNodeTarget, type TspSurfaces } from "./view-state";

/** Expected scope binds a save to the file the app prepared, including at the serialized writer. */
export type { TspAdvisorAction } from "./advisor.schema";
export interface AdvisorOverlay extends TspNodeTarget { scope: AdvisorScope }

/** omp 18.15 uses roleless prefs when supported, otherwise its registered overlay and list. */
export function advisorScope(root: TspNode, mode?: TspOpen["mode"]): AdvisorScope | null {
	if (root.p?.hidden) return null;
	if (root.k === "prefs") {
		if (mode !== "screen" || root.p?.role !== undefined || root.p?.title !== TSP_ADVISOR.title || root.p.editing || root.c?.length) return null;
		const files = root.p.sections?.filter(section => section.id === TSP_ADVISOR.fileSection);
		if (files?.length !== 1) return null;
		const file = files[0]!;
		const actions = [TSP_ACTIONS.save, TSP_ADVISOR.addAction, TSP_ACTIONS.scope];
		if (file.rows.length !== actions.length || actions.some(act => file.rows.filter(row => row.id === act && row.control.k === "action" && row.control.act === act).length !== 1)) return null;
		return file.title === TSP_ADVISOR.projectFile ? "project" : file.title === TSP_ADVISOR.userFile ? "user" : null;
	}
	if (root.k !== "overlay" || root.p?.role !== TSP_ROLES.advisor) return null;
	const list = [...walkNodes(root)].find(node => node.k === "list");
	const scope = list?.c?.find(item => item.k === "item" && item.p?.key === TSP_ACTIONS.scope);
	const label = scope?.k === "item" ? scope.p?.label : undefined;
	const text = typeof label === "string" ? label : label?.map(span => span.t).join("");
	return text === TSP_ADVISOR.projectScope ? "project" : text === TSP_ADVISOR.userScope ? "user" : null;
}

export function advisorOverlay(surfaces: TspSurfaces): AdvisorOverlay | null {
	const found: AdvisorOverlay[] = [];
	for (const surface of liveSurfaces(surfaces)) for (const node of walkNodes(surface.document)) {
		const scope = advisorScope(node, surface.open.mode);
		if (scope) found.push({ surface, node, scope });
	}
	return found.length === 1 ? found[0]! : null;
}

/** Builds only declared file actions, preserving ids rather than predicting list positions. */
export function advisorActionEvents(target: TspNodeTarget, action: TspAdvisorAction): TspRendererEvent[] {
	const { node: root, surface } = target;
	const scope = advisorScope(root, surface.open.mode);
	if (!scope || root.id !== action.id) throw new Error("The advisor configuration is no longer available.");
	if (scope !== action.scope) throw new Error("The advisor configuration scope changed before applying. Try again.");
	const event = (act: string): TspRendererEvent => {
		if (root.k === "prefs") {
			// Close is a built-in prefs route, as in omp's native settings page.
			if (act === TSP_ACTIONS.close) return { ev: "action", sf: action.sf, id: root.id, act };
			const row = root.p?.sections?.find(section => section.id === TSP_ADVISOR.fileSection)?.rows.find(row => row.id === act);
			if (!row || row.disabled || row.control.k !== "action" || row.control.act !== act) throw new Error(`omp no longer offers the advisor ${act} action.`);
			return { ev: "action", sf: action.sf, id: root.id, act };
		}
		const list = [...walkNodes(root)].find(node => node.k === "list");
		const item = list?.c?.find(item => item.k === "item" && !item.p?.hidden && item.p?.key === act);
		if (!list || item?.k !== "item" || item.p?.disabled) throw new Error(`omp no longer offers the advisor ${act} item.`);
		return { ev: "activate", sf: action.sf, id: list.id, item: item.p?.key ?? item.id };
	};
	return action.act === "apply" ? [event(TSP_ACTIONS.save), event(TSP_ACTIONS.close)] : [event(action.act)];
}
