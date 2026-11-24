import type { TspComposerFacts, TspSurfaceSnapshot } from "../../../shared/tsp-host";
import type { TspNode } from "../../../shared/tsp";
import { liveSurfaces, region, screenSurface, walkNodes } from "../../../shared/tsp/view-state";
import { isHookNode, TSP_ROLES } from "../../../shared/tsp/roles";

/**
 * omp's editor suggestions (a `#30` in a message offers GitHub references), hoisted from the editor into the layer.
 * They belong to the main editor, so they are not a menu; the send path closes them first (`TspSession`).
 */
export function editorSuggestions(surface: TspSurfaceSnapshot): TspNode | undefined {
	return region(surface, "layer").find(node => !node.p?.hidden && node.p?.role === TSP_ROLES.autocomplete);
}

/** Composer ownership is independent of UI claims, which only decide presentation. */
export function composerFacts(surfaces: readonly TspSurfaceSnapshot[]): TspComposerFacts {
	const live = liveSurfaces(surfaces);
	const nodes = live.flatMap(surface => [...walkNodes(surface.document)]);
	const approval = nodes.some(node => node.p?.role === TSP_ROLES.approvalChoices);
	const ask = nodes.some(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden);
	const helperFocused = nodes.some(node => node.p?.role === TSP_ROLES.composerFocus);
	const panel = !!screenSurface(live) || helperFocused
		|| live.some(surface => region(surface, "layer").some(node => !node.p?.hidden && node.k !== "toast" && node.p?.role !== TSP_ROLES.autocomplete
			&& ![...walkNodes(node)].some(child => child.p?.role === TSP_ROLES.approvalChoices)))
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
	const queuedItems = live.flatMap(surface => region(surface, "dock").flatMap(root => [...walkNodes(root)]))
		.filter(node => node.p?.role === TSP_ROLES.queueItem)
		.map(node => ({
			text: (node.c ?? []).find(child => child.k === "text")?.p?.text ?? "",
			kind: (node.p?.title === "After yield" ? "followUp" : "steer") as "steer" | "followUp",
		}));
	const queued = queuedItems.map(item => item.text);
	const text = target?.node.k === "editor" ? target.node.p?.text ?? "" : "";
	const cursor = target?.node.k === "editor" ? target.node.p?.cursor : undefined;
	// Focus inside the editor's suggestions is still the editor's.
	const suggestions = target ? editorSuggestions(target.surface) : undefined;
	const suggestionFocus = !!suggestions && !!target?.surface.focus && [...walkNodes(suggestions)].some(node => node.id === target.surface.focus);
	return {
		sendable: target?.node.k === "editor" && target.node.p?.sendable === true && (target.surface.focus === target.node.id || suggestionFocus || approval) && !ask && !panel,
		text, cursor: typeof cursor === "number" ? cursor : text.length,
		ghost: target?.node.k === "editor" ? target.node.p?.ghost ?? "" : "",
		editorId: target?.node.id ?? null, surfaceId: target?.surface.open.id ?? null, queued,
		// Dock queue pills belong to the main chat only while its editor is in the dock: a focused subagent's header
		// (`omp.composer.focus`) means they are that helper's queue, and a selector that replaces the editor also
		// removes that header while the helper stays focused, so the queue then has no known owner.
		...(!helperFocused && target ? { queuedItems } : {}),
		blockedBy: panel ? "panel" : approval ? "approval" : ask ? "ask" : null,
	};
}
