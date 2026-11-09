import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { projectPlanReview } from "./plan-review";
import { advisorScope } from "./advisor";

/** All omp names on which visual-omp makes a behavioral decision. */
export const TSP_ROLES = {
	session: "omp.session", editor: "omp.editor", editorShell: "omp.editor.shell", composerFocus: "omp.composer.focus",
	editorAsk: "omp.editor.ask", editorAskHidden: "omp.editor.ask.hidden",
	composerModel: "omp.composer.model", composerEffort: "omp.composer.effort", composerModelEffort: "omp.composer.model.effort",
	compaction: "omp.compaction", working: "omp.working", workingLabel: "omp.working.label", loader: "omp.loader",
	queue: "omp.queue", queueItem: "omp.queue.item", approvalChoices: "omp.approval.choices", composerChips: "omp.composer.chips",
	user: "omp.user", assistant: "omp.assistant", thinking: "omp.thinking", tool: "omp.tool", agent: "omp.agent",
	userShell: "omp.bash", userPython: "omp.eval",
	toastStatus: "omp.toast.status", noticeError: "omp.notice.error", noticeWarning: "omp.notice.warning", activity: "omp.activity",
	tree: "omp.overlay.tree", treeSelector: "omp.overlay.tree-selector", btwHistory: "omp.overlay.btwHistory",
	hookSelect: "omp.overlay.hook-select", hookConfirm: "omp.overlay.hook-confirm", hookInput: "omp.overlay.hook-input", hookEditor: "omp.overlay.hook-editor",
	hookInputTitle: "omp.hook-input.title", hookInputDescription: "omp.hook-input.detail",
	hookEditorTitle: "omp.hook-editor.title", hookEditorDescription: "omp.hook-editor.detail",
	planReview: "omp.overlay.planReview", planBody: "omp.plan.body", planOptions: "omp.plan.options",
	planSlider: "omp.plan.slider", planStrategy: "omp.plan.strategy", planTools: "omp.plan.tools",
	planPrompt: "omp.plan.prompt", planToc: "omp.plan.toc", planNote: "omp.plan.note", planFeedback: "omp.plan.feedback",
	planSave: "omp.overlay.planSave", advisor: "omp.overlay.advisor",
	btwThread: "omp.btw.thread", btwTurn: "omp.btw.turn", btwQuestion: "omp.btw.question", btwFollowup: "omp.btw.followup",
	btwAnswer: "omp.btw.answer", btwMeta: "omp.btw.meta", btwError: "omp.btw.error", btwPending: "omp.btw.pending",
	btwList: "omp.btw.list", btwListIdle: "omp.btw.list.idle", btwComposer: "omp.btw.composer",
	btwInject: "omp.btw.inject",
	btwNote: "omp.btw.note", btwNotice: "omp.btw.notice", btwCopied: "omp.btw.copied",
	btwBody: "omp.btw.body", btwReader: "omp.btw.reader", btwHistoryList: "omp.btw.history",
	btwEmpty: "omp.btw.empty", btwEmptyTitle: "omp.btw.empty.title", btwEmptyHint: "omp.btw.empty.hint",
	overlayHints: "omp.overlay.hints", retryHint: "omp.hint.retry",
	composerFact: "omp.composer.fact", composerCache: "omp.composer.cache", composerCacheCard: "omp.composer.cache.card",
} as const;
const nativeHookRoles: ReadonlySet<string> = new Set([TSP_ROLES.hookSelect, TSP_ROLES.hookConfirm, TSP_ROLES.hookInput, TSP_ROLES.hookEditor]);
const hookPartPrefixes = ["omp.hook-input", "omp.hook-editor"] as const;
export const TSP_ACTIONS = {
	submit: "submit", cancel: "cancel", page: "page", scope: "scope", tab: "tab", strip: "strip",
	confirm: "confirm", close: "close", yes: "yes", no: "no", assign: "assign", switch: "switch", summarize: "summarize",
	label: "label", labelSave: "label-save", filter: "filter", clear: "clear", copy: "copy",
	resume: "resume", click: "click",
	thinkingCycle: "thinking.cycle", use: "use",
	copyPlan: "copyPlan", externalEditor: "externalEditor", save: "save",
	btwFollowUp: "follow-up", btwSend: "send", btwDiscard: "discard", btwStop: "stop", btwCopy: "copy-answer", btwInject: "inject",
	context: "status.context", cost: "status.cost", model: "status.model", path: "status.path",
} as const;
const knownActions: ReadonlySet<string> = new Set([...Object.values(TSP_ACTIONS), "toggle", "select", "activate", "open", "zoom"]);
export function isKnownAction(action: string): boolean { return knownActions.has(action); }
/** Recorded actions without an app interaction path stay display-only. */
export const TSP_READ_ONLY_ACTIONS: Readonly<Record<string, true>> = { external: true, expand: true, interrupt: true, "copy-message": true, rewind: true, task: true, approve: true, deny: true, hide: true, note: true, "queue.edit": true, "status.git": true, "status.cache": true, "jobs.open": true, edit: true, add: true, delete: true };
export const TSP_STATUS = { closing: "Closing session…" } as const;
export const TSP_TREE = {
	summaryTitle: "Summarize branch?", noSummary: "No summary",
	navigated: "Navigated to selected point", already: "Already at this point",
} as const;
/** omp 18.15's picker omits the legacy tree-selector role. */
export function isTreeSelectorNode(node: TspNode): boolean {
	return node.k === "picker" && node.p?.layout === "tree" && node.p.noun === "entries"
		&& node.p.actions?.some(action => action.id === TSP_ACTIONS.switch && !action.disabled) === true
		|| node.k === "list" && (node.p?.role === TSP_ROLES.tree || node.p?.role === TSP_ROLES.treeSelector);
}
export const TSP_BTW_STATUS = { running: "Answering", cancelled: "Cancelled", error: "Failed", interrupted: "Interrupted" } as const;
export const TSP_PLAN_OPTIONS = {
	execute: "Approve and execute", compact: "Approve and compact context", keep: "Approve and keep context",
	refine: "Refine plan", save: "Save and quit",
} as const;
export const TSP_ADVISOR = {
	command: "/advisor configure", title: "Advisors", fileSection: "file", addAction: "add",
	projectFile: "WATCHDOG.yml · project", userFile: "WATCHDOG.yml · user",
	projectScope: "Scope: project", userScope: "Scope: user",
	savedProject: "Saved project WATCHDOG.yml", savedUser: "Saved user WATCHDOG.yml", errorPrefix: "Advisor config:",
} as const;

/** Roles projected into transcript notices. Startup diagnostics use the warning role too. */
export const TSP_NOTICE_ROLES: Readonly<Record<string, "info" | "warning" | "error">> = Object.freeze({
	[TSP_ROLES.toastStatus]: "info", [TSP_ROLES.noticeError]: "error", [TSP_ROLES.noticeWarning]: "warning",
});
/** Claims are added only alongside working TSP consumers. Classic cards have no entries. */
export const TSP_CLAIMS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries([
		...Object.keys(TSP_NOTICE_ROLES).map(role => [role, "transcript-notices"]),
		...[TSP_ROLES.composerModel, TSP_ROLES.composerEffort, TSP_ROLES.composerModelEffort].map(role => [role, "composer-model"]),
		...[...nativeHookRoles].map(role => [role, "hook-dialog-card"]),
		[TSP_ROLES.advisor, "advisor-apply"],
		...[TSP_ROLES.userShell, TSP_ROLES.userPython].map(role => [role, "transcript-user-runs"]),
		[TSP_ROLES.btwHistory, "btw-pane"],
	]),
);
const replicated = [TSP_ROLES.user, TSP_ROLES.assistant, TSP_ROLES.thinking, TSP_ROLES.tool, TSP_ROLES.agent];
export function isReplicatedRole(role?: string): boolean {
	return !!role && replicated.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
export function isClaimable(node: TspNode, surface?: TspSurfaceSnapshot): boolean {
	if (isTreeSelectorNode(node)) return true;
	if (node.k === "prefs" || node.p?.role === TSP_ROLES.advisor) return advisorScope(node, surface?.open.mode) !== null;
	if (node.p?.role === TSP_ROLES.userShell || node.p?.role === TSP_ROLES.userPython) return isUserRunNode(node);
	if (node.p?.role === TSP_ROLES.planReview) return projectPlanReview(node, "") !== null;
	if (isHookNode(node)) {
		if (!isNativeHookNode(node)) return false;
		const supported = (child: TspNode): boolean => !child.p?.hidden && (child.k === "picker" && !!child.p?.items?.length || child.k === "list" && !!child.c?.some(item => item.k === "item" && !item.p?.hidden) || child.k === "input" || child.k === "editor" || !!child.c?.some(supported));
		return supported(node);
	}
	return !!node.p?.role && Object.hasOwn(TSP_CLAIMS, node.p.role);
}
/** Always-present consumers retain static claims; conditional native cards require active ownership. */
export function isClaimed(node: TspNode): boolean {
	const consumer = node.p?.role ? TSP_CLAIMS[node.p.role] : undefined;
	return consumer === "transcript-notices" || consumer === "composer-model";
}
/** Only the data-first user-run shape is projected; unsupported shapes retain the generic fallback. */
export function isUserRunNode(node: TspNode): node is Extract<TspNode, { k: "tool" }> {
	return node.k === "tool" && (node.p?.role === TSP_ROLES.userShell && node.p.name === "bash" || node.p?.role === TSP_ROLES.userPython && node.p.name === "eval")
		&& typeof node.p.command === "string" && !!node.p.command.trim()
		&& (node.p.status === "running" || node.p.status === "done" || node.p.status === "error" || node.p.status === "cancelled");
}
export function isHookDialog(role?: string): boolean { return !!role && role.startsWith("omp.overlay.hook-"); }
/** omp 18.14's ordinary hook selector drops its role when picker support is advertised. */
export function isHookNode(node: TspNode): boolean {
	if (isHookDialog(node.p?.role)) return true;
	return node.k === "picker" && !node.p?.role && node.p?.noun === "options" && node.p.layout === "rows"
		&& node.p.actions?.length === 2 && node.p.actions.some(action => action.id === TSP_ACTIONS.confirm)
		&& node.p.actions.some(action => action.id === TSP_ACTIONS.close);
}
/** Only the recorded hook vocabulary has a native card; future hook roles keep the fallback. */
export function isNativeHookNode(node: TspNode): boolean {
	return node.p?.role ? nativeHookRoles.has(node.p.role) : isHookNode(node);
}
/** Select commits in omp's tree selector, so pointer selection must stay local. */
export function selectionCommits(role?: string, layout?: string): boolean {
	return role === TSP_ROLES.tree || role === TSP_ROLES.treeSelector || layout === "tree";
}
/** Baseline roles plus reviewed 18.16 additions. Unclaimed content stays in the omp screen. */
const knownRoles: ReadonlySet<string> = new Set([
	...Object.values(TSP_ROLES),
	"omp.actions", "omp.btn", "omp.composer.bar", "omp.composer.chips", "omp.composer.context",
	"omp.composer.extras", "omp.composer.line", "omp.composer.send", "omp.composer.usage",
	// User shell and Python runs use conditional transcript ownership.
	// Recorded approval details and execution chrome remain visible through the generic screen.
	"omp.approval.choice", "omp.approval.details", "omp.approval.title", "omp.editor.ask.approval",
	"omp.run", "omp.run.foot", "omp.run.state", "omp.run.time",
	"omp.ask.option", "omp.ask.options", "omp.ask.other", "omp.ask.question",
	"omp.composer.chip", "omp.composer.fact", "omp.queue.edit",
	// Prediction alternatives retain the generic list.
	"omp.autocomplete", "omp.select",
	"omp.form", "omp.form.field",
	"omp.hotkeys.group", "omp.hotkeys.table", "omp.hud", "omp.hud.downloads", "omp.hud.judge",
	"omp.composer.stop", "omp.hud.activity", "omp.hud.status", "omp.working.sep", "omp.working.stop",
	"omp.info.column", "omp.info.copy", "omp.info.copy.ic", "omp.info.field", "omp.info.group", "omp.info.identity",
	"omp.info.kv", "omp.info.label", "omp.info.note", "omp.info.nums", "omp.info.stats", "omp.info.total",
	"omp.jobs.empty", "omp.jobs.empty.note", "omp.jobs.empty.title", "omp.notice.warning",
	"omp.jobs.title", "omp.jobs.caption", "omp.app.ibtn", "omp.app.ibtn.set", "omp.app.qbtn", "omp.app.seg",
	"omp.overlay.hotkeys", "omp.overlay.jobs", "omp.overlay.report", "omp.overlay.sessionInfo",
	"omp.picker.title", "omp.prefs.preview.status", "omp.report.body",
	"omp.compaction.caption",
	"omp.overlay.cleanse", "omp.sheet.head", "omp.cleanse.live",
	"omp.hud.pill", "omp.hud.seg", "omp.run.facts",
	"omp.status", "omp.status.context_pct", "omp.status.model", "omp.status.path", "omp.status.pi",
]);
export function isKnownRole(role?: string): boolean {
	return !role || knownRoles.has(role) || role.startsWith(`${TSP_ROLES.planToc}.`) || isReplicatedRole(role) || isHookDialog(role) || hookPartPrefixes.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
