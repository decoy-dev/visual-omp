import type { TspNode } from "../tsp";
import { TSP_ROLES } from "./roles";
import { unclaimed, type TspNodeTarget, type TspPresentationClaims, type TspSurfaces } from "./view-state";

/** Sheet-role columns remain discoverable after their question or spinner disappears. */
export function unclaimedDockPanels(surfaces: TspSurfaces, consumers: TspPresentationClaims): TspNodeTarget[] {
	const panels: TspNodeTarget[] = [];
	const visit = (node: TspNode, surface: TspNodeTarget["surface"]): void => {
		const role = node.p?.role;
		// Ask questions stay in the chat, with an explicit action for unsupported forms.
		if (node.p?.hidden || role === TSP_ROLES.editorAsk || role === TSP_ROLES.editorAskHidden || role === TSP_ROLES.askForm
			|| role === TSP_ROLES.activity || role === TSP_ROLES.loader || role === TSP_ROLES.working
			|| role?.startsWith("omp.hud") || role?.startsWith(TSP_ROLES.editor) || role?.startsWith("omp.composer") || role?.startsWith(TSP_ROLES.queue)) return;
		if (node.k === "rows" || node.k === "ansi" || role?.startsWith("omp.overlay.") || role === TSP_ROLES.sheetHead
			|| ["input", "editor", "button", "picker", "prefs", "list", "tabs"].includes(node.k) || node.p?.actions) {
			panels.push({ surface, node });
			return;
		}
		for (const child of node.c ?? []) visit(child, surface);
	};
	for (const surface of surfaces) if (!surface.closed && !surface.suspended) for (const node of unclaimed(surface, "dock", consumers.get(surface.open.id))) visit(node, surface);
	return panels;
}
