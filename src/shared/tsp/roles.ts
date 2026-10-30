import type { TspNode } from "../tsp";

/** All omp names on which visual-omp makes a behavioral decision. */
export const TSP_ROLES = {
	session: "omp.session", editor: "omp.editor", editorShell: "omp.editor.shell", composerFocus: "omp.composer.focus",
	user: "omp.user", assistant: "omp.assistant", thinking: "omp.thinking", tool: "omp.tool", agent: "omp.agent",
	toastStatus: "omp.toast.status", noticeError: "omp.notice.error", noticeWarning: "omp.notice.warning",
	tree: "omp.overlay.tree", treeSelector: "omp.overlay.tree-selector", btwHistory: "omp.overlay.btwHistory",
	hookSelect: "omp.overlay.hook-select", hookConfirm: "omp.overlay.hook-confirm", hookInput: "omp.overlay.hook-input", hookEditor: "omp.overlay.hook-editor",
} as const;
export const TSP_ACTIONS = {
	submit: "submit", cancel: "cancel", page: "page", scope: "scope", tab: "tab", strip: "strip",
	confirm: "confirm", close: "close", assign: "assign", switch: "switch", summarize: "summarize",
	label: "label", labelSave: "label-save", filter: "filter", clear: "clear", copy: "copy",
	context: "status.context", cost: "status.cost", model: "status.model", path: "status.path",
} as const;
const knownActions: ReadonlySet<string> = new Set([...Object.values(TSP_ACTIONS), "toggle", "select", "activate", "open", "zoom"]);
export function isKnownAction(action: string): boolean { return knownActions.has(action); }
export const TSP_STATUS = { closing: "Closing session…" } as const;

/** Claims are added only alongside working TSP consumers. Classic cards have no entries. */
export const TSP_CLAIMS: Readonly<Record<string, string>> = Object.freeze({});
const replicated = [TSP_ROLES.user, TSP_ROLES.assistant, TSP_ROLES.thinking, TSP_ROLES.tool, TSP_ROLES.agent];
export function isReplicatedRole(role?: string): boolean {
	return !!role && replicated.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
export function isClaimed(node: TspNode): boolean { return !!node.p?.role && Object.hasOwn(TSP_CLAIMS, node.p.role); }
export function isHookDialog(role?: string): boolean { return !!role && role.startsWith("omp.overlay.hook-"); }
/** Select commits in omp's tree selector, so pointer selection must stay local. */
export function selectionCommits(role?: string, layout?: string): boolean {
	return role === TSP_ROLES.tree || role === TSP_ROLES.treeSelector || layout === "tree";
}
export function roleInteraction(role?: string): "display-only" | "interactive" {
	return isHookDialog(role) ? "display-only" : "interactive";
}
/** Baseline roles recorded from omp 18.14.0. Unknown additions stay readable. */
const knownRoles: ReadonlySet<string> = new Set([
	...Object.values(TSP_ROLES),
	"omp.actions", "omp.btn", "omp.composer.bar", "omp.composer.chips", "omp.composer.context",
	"omp.composer.extras", "omp.composer.line", "omp.composer.model", "omp.composer.send", "omp.composer.usage",
	"omp.hotkeys.group", "omp.hotkeys.table", "omp.hud", "omp.hud.downloads", "omp.hud.judge",
	"omp.info.column", "omp.info.copy", "omp.info.copy.ic", "omp.info.field", "omp.info.group", "omp.info.identity",
	"omp.info.kv", "omp.info.label", "omp.info.note", "omp.info.nums", "omp.info.stats", "omp.info.total",
	"omp.jobs.empty", "omp.jobs.empty.note", "omp.jobs.empty.title", "omp.notice.warning",
	"omp.overlay.hotkeys", "omp.overlay.jobs", "omp.overlay.report", "omp.overlay.sessionInfo",
	"omp.picker.title", "omp.prefs.preview.status", "omp.report.body",
	"omp.status", "omp.status.context_pct", "omp.status.model", "omp.status.path", "omp.status.pi",
]);
export function isKnownRole(role?: string): boolean {
	return !role || knownRoles.has(role) || isReplicatedRole(role) || isHookDialog(role);
}
