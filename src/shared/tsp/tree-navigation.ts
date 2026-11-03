import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { isTreeSelectorNode } from "./roles";
import { liveSurfaces, walkNodes, type TspNodeTarget } from "./view-state";

/** Only one visible session selector can own navigation. Entry keys come from omp. */
export function treeSelector(surfaces: readonly TspSurfaceSnapshot[]): TspNodeTarget | null {
	const targets: TspNodeTarget[] = [];
	for (const surface of liveSurfaces(surfaces)) for (const node of walkNodes(surface.document)) {
		if (isTreeSelectorNode(node)) targets.push({ surface, node });
	}
	return targets.length === 1 ? targets[0]! : null;
}

/** Repeated at the serialized writer, including the selector's current filter and disabled state. */
export function assertTreeEntry(node: TspNode, entryId: string): void {
	if (!isTreeSelectorNode(node)) throw new Error("omp screen: The session tree selector changed. Open the tree again.");
	if (node.k === "picker") {
		const item = node.p?.items?.find(item => item.id === entryId);
		if (!item) throw new Error("omp screen: This entry is no longer in omp's session tree.");
		if (item.disabled) throw new Error(typeof item.disabled === "string" ? item.disabled : "omp screen: This session entry is disabled.");
		if (node.p?.order && !node.p.order.includes(entryId)) throw new Error("omp screen: This entry is hidden by omp's tree filter. Open the omp screen to change the filter.");
	} else if (node.k === "list") {
		const item = node.c?.find(item => item.k === "item" && (item.p?.key ?? item.id) === entryId && !item.p?.hidden);
		if (!item || item.k !== "item") throw new Error("omp screen: This entry is no longer in omp's session tree.");
		if (item.p?.disabled) throw new Error("omp screen: This session entry is disabled.");
	}
}
