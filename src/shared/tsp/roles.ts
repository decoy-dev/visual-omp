import type { TspNode } from "../tsp";

/** All omp names on which visual-omp makes a behavioral decision. */
export const TSP_ROLES = {
	session: "omp.session", editor: "omp.editor", editorShell: "omp.editor.shell", composerFocus: "omp.composer.focus",
	editorAsk: "omp.editor.ask", editorAskHidden: "omp.editor.ask.hidden",
	composerModel: "omp.composer.model", composerEffort: "omp.composer.effort", composerModelEffort: "omp.composer.model.effort",
	compaction: "omp.compaction", working: "omp.working",
	user: "omp.user", assistant: "omp.assistant", thinking: "omp.thinking", tool: "omp.tool", agent: "omp.agent",
	toastStatus: "omp.toast.status", noticeError: "omp.notice.error", noticeWarning: "omp.notice.warning",
	tree: "omp.overlay.tree", treeSelector: "omp.overlay.tree-selector", btwHistory: "omp.overlay.btwHistory",
	hookSelect: "omp.overlay.hook-select", hookConfirm: "omp.overlay.hook-confirm", hookInput: "omp.overlay.hook-input", hookEditor: "omp.overlay.hook-editor",
} as const;
const hookPartPrefixes = ["omp.hook-input", "omp.hook-editor"] as const;
export const TSP_ACTIONS = {
	submit: "submit", cancel: "cancel", page: "page", scope: "scope", tab: "tab", strip: "strip",
	confirm: "confirm", close: "close", yes: "yes", no: "no", assign: "assign", switch: "switch", summarize: "summarize",
	label: "label", labelSave: "label-save", filter: "filter", clear: "clear", copy: "copy",
	resume: "resume", click: "click",
	thinkingCycle: "thinking.cycle", use: "use",
	context: "status.context", cost: "status.cost", model: "status.model", path: "status.path",
} as const;
const knownActions: ReadonlySet<string> = new Set([...Object.values(TSP_ACTIONS), "toggle", "select", "activate", "open", "zoom"]);
export function isKnownAction(action: string): boolean { return knownActions.has(action); }
/** Recorded actions without an app interaction path stay display-only. */
export const TSP_READ_ONLY_ACTIONS: Readonly<Record<string, true>> = { external: true, expand: true, interrupt: true, "copy-message": true, rewind: true, task: true };
export const TSP_STATUS = { closing: "Closing session…" } as const;

/** Roles projected into transcript notices. Startup diagnostics use the warning role too. */
export const TSP_NOTICE_ROLES: Readonly<Record<string, "info" | "warning" | "error">> = Object.freeze({
	[TSP_ROLES.toastStatus]: "info", [TSP_ROLES.noticeError]: "error", [TSP_ROLES.noticeWarning]: "warning",
});
/** Claims are added only alongside working TSP consumers. Classic cards have no entries. */
export const TSP_CLAIMS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries([
		...Object.keys(TSP_NOTICE_ROLES).map(role => [role, "transcript-notices"]),
		...[TSP_ROLES.composerModel, TSP_ROLES.composerEffort, TSP_ROLES.composerModelEffort].map(role => [role, "composer-model"]),
	]),
);
const replicated = [TSP_ROLES.user, TSP_ROLES.assistant, TSP_ROLES.thinking, TSP_ROLES.tool, TSP_ROLES.agent];
export function isReplicatedRole(role?: string): boolean {
	return !!role && replicated.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
export function isClaimed(node: TspNode): boolean { return !!node.p?.role && Object.hasOwn(TSP_CLAIMS, node.p.role); }
export function isHookDialog(role?: string): boolean { return !!role && role.startsWith("omp.overlay.hook-"); }
/** omp 18.14's ordinary hook selector drops its role when picker support is advertised. */
export function isHookNode(node: TspNode): boolean {
	if (isHookDialog(node.p?.role)) return true;
	return node.k === "picker" && !node.p?.role && node.p?.noun === "options" && node.p.layout === "rows"
		&& node.p.actions?.length === 2 && node.p.actions.some(action => action.id === TSP_ACTIONS.confirm)
		&& node.p.actions.some(action => action.id === TSP_ACTIONS.close);
}
/** Select commits in omp's tree selector, so pointer selection must stay local. */
export function selectionCommits(role?: string, layout?: string): boolean {
	return role === TSP_ROLES.tree || role === TSP_ROLES.treeSelector || layout === "tree";
}
/** Baseline roles recorded from omp 18.15.0. Unknown additions stay readable. */
const knownRoles: ReadonlySet<string> = new Set([
	...Object.values(TSP_ROLES),
	"omp.actions", "omp.btn", "omp.composer.bar", "omp.composer.chips", "omp.composer.context",
	"omp.composer.extras", "omp.composer.line", "omp.composer.send", "omp.composer.usage",
	// Deferred shell/eval nativeTail blocks are unclaimed main output, not replicated tool messages.
	"omp.bash", "omp.eval",
	"omp.btw.empty", "omp.btw.empty.hint", "omp.btw.empty.title",
	"omp.form", "omp.form.field",
	"omp.hotkeys.group", "omp.hotkeys.table", "omp.hud", "omp.hud.downloads", "omp.hud.judge",
	"omp.composer.stop", "omp.hud.activity", "omp.hud.status", "omp.working.label", "omp.working.sep", "omp.working.stop",
	"omp.info.column", "omp.info.copy", "omp.info.copy.ic", "omp.info.field", "omp.info.group", "omp.info.identity",
	"omp.info.kv", "omp.info.label", "omp.info.note", "omp.info.nums", "omp.info.stats", "omp.info.total",
	"omp.jobs.empty", "omp.jobs.empty.note", "omp.jobs.empty.title", "omp.notice.warning",
	"omp.jobs.title", "omp.jobs.caption", "omp.app.ibtn", "omp.app.ibtn.set", "omp.app.qbtn", "omp.app.seg",
	"omp.overlay.hotkeys", "omp.overlay.jobs", "omp.overlay.report", "omp.overlay.sessionInfo",
	"omp.picker.title", "omp.prefs.preview.status", "omp.report.body",
	"omp.compaction.caption",
	"omp.status", "omp.status.context_pct", "omp.status.model", "omp.status.path", "omp.status.pi",
]);
export function isKnownRole(role?: string): boolean {
	return !role || knownRoles.has(role) || isReplicatedRole(role) || isHookDialog(role) || hookPartPrefixes.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
