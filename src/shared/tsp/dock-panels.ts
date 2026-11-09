import type { TspNode } from "../tsp";
import { TSP_ROLES } from "./roles";
import { unclaimed, type TspPresentationClaims, type TspSurfaces } from "./view-state";

/** Sheet-role columns remain discoverable after their question or spinner disappears. */
export function hasUnclaimedDockPanel(surfaces: TspSurfaces, consumers: TspPresentationClaims): boolean {
	const panel = (node: TspNode): boolean => {
		const role = node.p?.role;
		// Ask questions stay in the chat, with an explicit action for unsupported forms.
		if (node.p?.hidden || role === TSP_ROLES.editorAsk || role === TSP_ROLES.editorAskHidden || role === TSP_ROLES.askForm
			|| role === TSP_ROLES.activity || role === TSP_ROLES.loader || role === TSP_ROLES.working
			|| role?.startsWith("omp.hud") || role?.startsWith(TSP_ROLES.editor) || role?.startsWith("omp.composer") || role?.startsWith(TSP_ROLES.queue)) return false;
		if (node.k === "rows" || node.k === "ansi" || role?.startsWith("omp.overlay.") || role === TSP_ROLES.sheetHead) return true;
		if (["input", "editor", "button", "picker", "prefs", "list", "tabs"].includes(node.k) || node.p?.actions) return true;
		return node.c?.some(panel) ?? false;
	};
	return surfaces.some(surface => !surface.closed && !surface.suspended && unclaimed(surface, "dock", consumers.get(surface.open.id)).some(panel));
}
