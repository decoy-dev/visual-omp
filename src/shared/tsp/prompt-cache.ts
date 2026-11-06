import type { TspHostSnapshot } from "../tsp-host";
import { TSP_ROLES } from "./roles";
import { region, walkNodes } from "./view-state";

export interface PromptCacheFact {
	label: string;
	detail: string;
	warning: boolean;
}

/** omp owns the prediction, expiry, reason and resend estimate. Never infer them from billed usage. */
export function promptCacheFact(snapshot: TspHostSnapshot | null | undefined, host: { hostId: string; generation: number; tspEpoch?: number } | null | undefined): PromptCacheFact | null {
	if (!host || !snapshot || snapshot.hostId !== host.hostId || snapshot.generation !== host.generation
		|| snapshot.epoch !== host.tspEpoch || snapshot.lifecycle !== "live" || !snapshot.negotiated
		|| snapshot.documentGeneration !== host.generation || snapshot.closing) return null;
	for (const surface of snapshot.surfaces) {
		if (surface.closed || surface.suspended || surface.documentGeneration !== host.generation
			|| surface.open.mode !== "inline" || surface.open.role !== TSP_ROLES.session) continue;
		for (const root of region(surface, "dock")) for (const node of walkNodes(root)) {
			if (node.k !== "seg" || node.p?.role !== TSP_ROLES.composerCache) continue;
			const label = node.p.aria?.trim();
			const detail = node.p.title?.trim();
			if (label && detail) return { label, detail, warning: node.p.tone === "warning" };
		}
	}
	return null;
}
