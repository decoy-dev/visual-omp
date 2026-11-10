import { openOverlay, screenSurface, unclaimed, type TspNodeTarget, type TspPresentationClaims, type TspSurfaces } from "@shared/tsp/view-state";
import { unclaimedDockPanels } from "@shared/tsp/dock-panels";
import type { TspHostSnapshot } from "@shared/tsp-host";

function nodeKey(kind: string, target: TspNodeTarget): string {
	const { surface, node } = target;
	return JSON.stringify([kind, surface.open.id, node.id, node.k, node.p?.role]);
}

/** Identity excludes repaint sequences, progress and selection changes within the same native UI. */
export function unpresentedScreenKey(surfaces: TspSurfaces, consumers: TspPresentationClaims): string | null {
	const tokens: string[] = [];
	const overlay = openOverlay(surfaces, false, consumers);
	if (overlay) tokens.push(nodeKey("overlay", overlay));
	const screen = screenSurface(surfaces);
	if (screen) {
		if (!consumers.get(screen.open.id)?.size) tokens.push(JSON.stringify(["screen", screen.open.id]));
		else for (const area of ["main", "dock", "layer"] as const) for (const node of unclaimed(screen, area, consumers.get(screen.open.id))) tokens.push(nodeKey(`screen:${area}`, { surface: screen, node }));
	}
	for (const dock of unclaimedDockPanels(surfaces, consumers)) tokens.push(nodeKey("dock", dock));
	return tokens.length ? JSON.stringify(tokens.sort()) : null;
}
export function screenCandidateKey(snapshot: TspHostSnapshot, consumers: TspPresentationClaims): string | null {
	const surfaces = snapshot.surfaces.filter(surface => surface.documentGeneration === snapshot.generation);
	const key = unpresentedScreenKey(surfaces, consumers);
	return key === null ? null : JSON.stringify([snapshot.hostId, snapshot.generation, snapshot.epoch, key]);
}

