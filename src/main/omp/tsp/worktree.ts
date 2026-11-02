import type { TspRendererEvent, TspSurfaceSnapshot } from "../../../shared/tsp-host";
import { activateItem, hookDialog } from "../../../shared/tsp/dialogs";
import { isHookNode } from "../../../shared/tsp/roles";
import { liveSurfaces, walkNodes } from "../../../shared/tsp/view-state";

export interface WorktreeExitConfirmation {
	sf: string;
	id: string;
	title: string;
	detail: string;
	keep: TspRendererEvent;
	remove: TspRendererEvent;
}

/** Only the owned-worktree exit confirm has a main-owned shutdown answer path. */
export function worktreeExitConfirmation(surfaces: readonly TspSurfaceSnapshot[]): WorktreeExitConfirmation | null {
	const hooks = liveSurfaces(surfaces).flatMap(surface => [...walkNodes(surface.document)].filter(isHookNode).map(node => ({ surface, node })));
	if (hooks.length !== 1) return null;
	const { surface, node } = hooks[0]!;
	const dialog = hookDialog(node);
	if (!dialog || dialog.title !== "Remove worktree?" || dialog.body.kind !== "select" || !dialog.body.confirm || dialog.detail.length === 0) return null;
	const options = dialog.body.options;
	if (options.length !== 2 || options[0]?.label !== "Yes" || options[1]?.label !== "No" || options.some(option => option.disabled)) return null;
	const list = [...walkNodes(node)].find(child => child.id === dialog.body.target);
	if (!list) return null;
	return {
		sf: surface.open.id, id: node.id, title: dialog.title, detail: dialog.detail.join("\n"),
		keep: activateItem(surface.open.id, list, options[1]!.id),
		remove: activateItem(surface.open.id, list, options[0]!.id),
	};
}
