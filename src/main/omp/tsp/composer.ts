import type { TspComposerFacts, TspSurfaceSnapshot } from "../../../shared/tsp-host";
import type { TspNode } from "../../../shared/tsp";
import { liveSurfaces, region, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { isHookNode, TSP_ROLES } from "../../../shared/tsp/roles";

/** Composer ownership is independent of UI claims, which only decide presentation. */
export function composerFacts(surfaces: readonly TspSurfaceSnapshot[]): TspComposerFacts {
	const live = liveSurfaces(surfaces);
	const nodes = live.flatMap(surface => [...walkNodes(surface.document)]);
	const approval = nodes.some(node => node.p?.role === TSP_ROLES.approvalChoices);
	const ask = nodes.some(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden);
	const panel = !!screenSurface(live) || nodes.some(node => node.p?.role === TSP_ROLES.composerFocus)
		|| live.some(surface => region(surface, "layer").some(node => !node.p?.hidden && node.k !== "toast" && ![...walkNodes(node)].some(child => child.p?.role === TSP_ROLES.approvalChoices)))
		|| (!approval && nodes.some(isHookNode));
	let target: { surface: TspSurfaceSnapshot; node: TspNode } | undefined;
	for (const surface of live) {
		if (surface.open.mode !== "inline" || surface.open.role !== TSP_ROLES.session) continue;
		const search = (node: TspNode, inside: boolean): TspNode | undefined => {
			if (node.p?.hidden) return;
			const role = node.p?.role;
			const main = role?.startsWith(TSP_ROLES.editor) ? role === TSP_ROLES.editor : inside;
			if (main && node.k === "editor" && node.p?.mode !== "PTY") return node;
			for (const child of node.c ?? []) { const found = search(child, main); if (found) return found; }
			return undefined;
		};
		const dock = surface.document.c?.find(node => node.id === "dock");
		if (dock) { const node = search(dock, false); if (node) target = { surface, node }; }
	}
	const queued = live.flatMap(surface => region(surface, "dock").flatMap(root => [...walkNodes(root)]))
		.filter(node => node.p?.role === TSP_ROLES.queueItem)
		.map(node => (node.c ?? []).find(child => child.k === "text")?.p?.text ?? "");
	const text = target?.node.k === "editor" ? target.node.p?.text ?? "" : "";
	const cursor = target?.node.k === "editor" ? target.node.p?.cursor : undefined;
	return {
		sendable: target?.node.k === "editor" && target.node.p?.sendable === true && (target.surface.focus === target.node.id || approval) && !ask && !panel,
		text, cursor: typeof cursor === "number" ? cursor : text.length,
		ghost: target?.node.k === "editor" ? target.node.p?.ghost ?? "" : "",
		editorId: target?.node.id ?? null, surfaceId: target?.surface.open.id ?? null, queued,
		blockedBy: panel ? "panel" : approval ? "approval" : ask ? "ask" : null,
	};
}
