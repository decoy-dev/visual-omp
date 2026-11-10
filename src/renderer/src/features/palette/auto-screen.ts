import { openOverlay, screenSurface, unclaimed, type TspNodeTarget, type TspPresentationClaims, type TspSurfaces } from "@shared/tsp/view-state";
import { unclaimedDockPanels } from "@shared/tsp/dock-panels";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { TspNode } from "@shared/tsp";

export const SCREEN_SETTLE_MS = 300;

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
/** Arbitration excludes automatic candidates even when no native card can claim them. */
function withoutQuestions(node: TspNode, excluded: ReadonlySet<string>): TspNode | null {
	if (excluded.has(node.id)) return null;
	let children: TspNode[] | undefined;
	for (const [index, child] of (node.c ?? []).entries()) {
		const next = withoutQuestions(child, excluded);
		if (next !== child) children ??= node.c!.slice(0, index);
		if (children && next) children.push(next);
	}
	return children ? { ...node, c: children } as TspNode : node;
}

export function screenCandidateKey(snapshot: TspHostSnapshot, consumers: TspPresentationClaims, automatic = false): string | null {
	let surfaces = snapshot.surfaces.filter(surface => surface.documentGeneration === snapshot.generation);
	let presented = consumers;
	if (automatic && snapshot.questionMatches?.some(match => match.status !== "unmatched")) {
		const guarded = new Map<string, ReadonlySet<string>>(consumers);
		for (const match of snapshot.questionMatches) {
			if (match.status === "unmatched") continue;
			guarded.set(match.surfaceId, new Set([...(guarded.get(match.surfaceId) ?? []), match.nodeId]));
		}
		surfaces = surfaces.flatMap(surface => {
			const excluded = guarded.get(surface.open.id);
			if (!excluded) return [surface];
			const document = withoutQuestions(surface.document, excluded);
			return document ? [{ ...surface, document }] : [];
		});
		// Retain exact ids so screen-mode surfaces project any remaining regions individually.
		presented = guarded;
	}
	const key = unpresentedScreenKey(surfaces, presented);
	return key === null ? null : JSON.stringify([snapshot.hostId, snapshot.generation, snapshot.epoch, key]);
}

/** Semantic observations reset continuity even when visual batching skips a brief disappearance. */
export class ScreenSettle {
	#key: string | null = null;
	#since = 0;
	observe(key: string | null, now: number): void {
		if (key === this.#key) return;
		this.#key = key;
		this.#since = now;
	}
	remaining(key: string, now: number): number {
		this.observe(key, now);
		return Math.max(0, SCREEN_SETTLE_MS - (now - this.#since));
	}
}
