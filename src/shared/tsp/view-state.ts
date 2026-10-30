import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { isClaimed, isReplicatedRole, TSP_ROLES } from "./roles";

export interface TspNodeTarget { surface: TspSurfaceSnapshot; node: TspNode }
export type TspSurfaces = readonly TspSurfaceSnapshot[];

export function* walkNodes(node: TspNode): Generator<TspNode> {
	if (node.p?.hidden) return;
	yield node;
	for (const child of node.c ?? []) yield* walkNodes(child);
}
export function region(surface: TspSurfaceSnapshot, id: "main" | "dock" | "layer"): readonly TspNode[] {
	return surface.document.c?.find(node => node.id === id)?.c ?? [];
}
export function liveSurfaces(surfaces: TspSurfaces): TspSurfaceSnapshot[] {
	return surfaces.filter(surface => !surface.closed && !surface.suspended);
}
/** The last visible layer node is omp's topmost overlay, including data-first pickers. */
export function openOverlay(surfaces: TspSurfaces): TspNodeTarget | null {
	for (const surface of [...liveSurfaces(surfaces)].reverse()) {
		const nodes = region(surface, "layer").filter(node => !node.p?.hidden && node.k !== "toast" && !isClaimed(node));
		const node = nodes.at(-1);
		if (node) return { surface, node };
	}
	return null;
}
export function screenSurface(surfaces: TspSurfaces): TspSurfaceSnapshot | null {
	return liveSurfaces(surfaces).findLast(surface => surface.open.mode === "screen") ?? null;
}
export function focusedNode(surfaces: TspSurfaces): TspNodeTarget | null {
	for (const surface of [...liveSurfaces(surfaces)].reverse()) {
		if (!surface.focus) continue;
		for (const node of walkNodes(surface.document)) if (node.id === surface.focus) return { surface, node };
	}
	return null;
}
/** Returns the live main composer only when omp explicitly opens its submit gate. */
export function composer(surfaces: TspSurfaces): TspNodeTarget | null {
	for (const surface of liveSurfaces(surfaces)) {
		if (surface.open.mode !== "inline" || surface.open.role !== TSP_ROLES.session) continue;
		if ([...walkNodes(surface.document)].some(node => node.p?.role === TSP_ROLES.composerFocus)) continue;
		const find = (node: TspNode, main: boolean): TspNode | null => {
			const role = node.p?.role;
			const inComposer = role?.startsWith(TSP_ROLES.editor) ? role === TSP_ROLES.editor : main;
			if (inComposer && node.id === surface.focus && node.k === "editor" && node.p?.sendable === true && node.p.mode !== "PTY") return node;
			for (const child of node.c ?? []) { const result = find(child, inComposer); if (result) return result; }
			return null;
		};
		const dock = surface.document.c?.find(node => node.id === "dock");
		if (dock) { const node = find(dock, false); if (node) return { surface, node }; }
	}
	return null;
}
/** Keep whole unclaimed subtrees; replicated transcript and the app composer never appear twice. */
export function unclaimed(surface: TspSurfaceSnapshot, area: "main" | "dock" | "layer"): readonly TspNode[] {
	const project = (node: TspNode): TspNode[] => {
		if (node.p?.hidden || isClaimed(node) || (area === "main" && isReplicatedRole(node.p?.role))) return [];
		if (node.p?.role === TSP_ROLES.editor) return [];
		const children = node.c?.flatMap(project);
		if ((node.k === "col" || node.k === "row") && !node.p?.role && !node.p?.actions && !children?.length) return [];
		return [{ ...node, ...(children ? { c: children } : {}) } as TspNode];
	};
	return region(surface, area).flatMap(project);
}
