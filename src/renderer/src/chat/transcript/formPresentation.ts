import { askFormPresentation } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";
import { usePresentationAvailability, usePresentationClaims } from "../../state/tsp/presentation-claims";
import { useTsp } from "../../state/tsp/useTsp";

/** Visible or available form consumers can retain layout after collab retires its request. */
export function usePresentedForm(hostId: string | null, generation: number): string | null {
	const { snapshot } = useTsp(hostId);
	const current = snapshot?.hostId === hostId && snapshot.generation === generation && snapshot.lifecycle === "live" ? snapshot : null;
	const active = usePresentationClaims(hostId, current?.epoch);
	const available = usePresentationAvailability(hostId, current?.epoch);
	if (!current) return null;
	for (const surface of current.surfaces) {
		if (surface.closed || surface.suspended || surface.documentGeneration !== generation) continue;
		const activeNodes = active.get(surface.open.id);
		const availableNodes = available.get(surface.open.id);
		if (!activeNodes?.size && !availableNodes?.size) continue;
		for (const node of walkNodes(surface.document)) {
			if ((activeNodes?.has(node.id) || availableNodes?.has(node.id)) && askFormPresentation(node)) {
				// This identity describes presentation only. Request and prompt authority remain in collab.
				return JSON.stringify([hostId, generation, current.epoch, surface.open.id, node.id]);
			}
		}
	}
	return null;
}
