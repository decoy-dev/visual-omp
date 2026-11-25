import type { TspMenuEntry, TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { projectPlanReview, projectPlanSave } from "./plan-review";
import { advisorScope } from "./advisor";
import { commandReport } from "./reports";
import { settledCommandPanel } from "./command-panels";
import { shellProps } from "./shell";

/** All omp names on which visual-omp makes a behavioral decision. */
export const TSP_ROLES = {
	session: "omp.session", editor: "omp.editor", editorShell: "omp.editor.shell", composerFocus: "omp.composer.focus",
	editorBash: "omp.editor.bash", editorPython: "omp.editor.python", editorBtw: "omp.editor.btw", editorBtwAsk: "omp.editor.btw-ask",
	editorAsk: "omp.editor.ask", editorAskHidden: "omp.editor.ask.hidden", askCard: "omp.ask.card",
	askCardHead: "omp.ask.card.head", askFold: "omp.ask.fold", askOpen: "omp.ask.open", askLegend: "omp.ask.legend", workingStop: "omp.working.stop",
	autocomplete: "omp.autocomplete",
	askForm: "omp.ask.form", askSection: "omp.ask.section", askField: "omp.ask.field",
	askText: "omp.ask.text", askHeading: "omp.ask.heading", askLabel: "omp.ask.label",
	askOptions: "omp.ask.options", askOption: "omp.ask.option", askCheck: "omp.ask.check",
	askWell: "omp.ask.well", askWellMulti: "omp.ask.well.multi", askSummary: "omp.ask.summary",
	askBullets: "omp.ask.bullets", askPre: "omp.ask.pre", askTable: "omp.ask.table", askError: "omp.ask.error",
	askHead: "omp.ask.head", askQuestions: "omp.ask.questions", askAnswers: "omp.ask.answers", askNotice: "omp.ask.notice", askNote: "omp.ask.note",
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
	planReview: "omp.overlay.planReview", planBody: "omp.plan.body", planDoc: "omp.plan.doc", planDock: "omp.plan.dock",
	planApprove: "omp.plan.approve", planModel: "omp.plan.model", planOptions: "omp.plan.options",
	planSlider: "omp.plan.slider", planStrategy: "omp.plan.strategy", planTools: "omp.plan.tools",
	planPrompt: "omp.plan.prompt", planToc: "omp.plan.toc", planNote: "omp.plan.note", planFeedback: "omp.plan.feedback",
	planSave: "omp.overlay.planSave", advisor: "omp.overlay.advisor",
	btwThread: "omp.btw.thread", btwTurn: "omp.btw.turn", btwQuestion: "omp.btw.question", btwFollowup: "omp.btw.followup",
	btwAnswer: "omp.btw.answer", btwMeta: "omp.btw.meta", btwError: "omp.btw.error", btwPending: "omp.btw.pending",
	btwList: "omp.btw.list", btwListIdle: "omp.btw.list.idle", btwComposer: "omp.btw.composer",
	btwInject: "omp.btw.inject",
	btwNote: "omp.btw.note", btwNoteQuestion: "omp.btw.note.question", btwNotice: "omp.btw.notice", btwCopied: "omp.btw.copied",
	btwBody: "omp.btw.body", btwReader: "omp.btw.reader", btwHistoryList: "omp.btw.history",
	btwEmpty: "omp.btw.empty", btwEmptyTitle: "omp.btw.empty.title", btwEmptyHint: "omp.btw.empty.hint",
	overlayHints: "omp.overlay.hints", retryHint: "omp.hint.retry",
	composerFact: "omp.composer.fact", composerCache: "omp.composer.cache", composerCacheCard: "omp.composer.cache.card",
	report: "omp.overlay.report", reportBody: "omp.report.body", omfg: "omp.overlay.omfg", cleanse: "omp.overlay.cleanse", sheetHead: "omp.sheet.head",
} as const;
const nativeHookRoles: ReadonlySet<string> = new Set([TSP_ROLES.hookSelect, TSP_ROLES.hookConfirm, TSP_ROLES.hookInput, TSP_ROLES.hookEditor]);
const hookPartPrefixes = ["omp.hook-input", "omp.hook-editor"] as const;
export const TSP_ACTIONS = {
	submit: "submit", cancel: "cancel", page: "page", scope: "scope", tab: "tab", strip: "strip",
	confirm: "confirm", close: "close", yes: "yes", no: "no", assign: "assign", switch: "switch", summarize: "summarize",
	label: "label", labelSave: "label-save", filter: "filter", clear: "clear", copy: "copy",
	resume: "resume", click: "click", next: "next", show: "show", hide: "hide",
	thinkingCycle: "thinking.cycle", use: "use",
	copyPlan: "copyPlan", externalEditor: "externalEditor", save: "save",
	btwFollowUp: "follow-up", btwSend: "send", btwDiscard: "discard", btwStop: "stop", btwCopy: "copy-answer", btwInject: "inject",
	context: "status.context", cost: "status.cost", model: "status.model", path: "status.path", usage: "status.usage", tree: "status.tree",
	unpin: "unpin", follow: "follow",
	shellViz: "shell-viz",
} as const;
const knownActions: ReadonlySet<string> = new Set([...Object.values(TSP_ACTIONS), "toggle", "select", "activate", "open", "zoom"]);
/** Form controls are enabled only for declared targets inside a current ask root. */
export function isAskFormAction(action: string): boolean {
	if (action === TSP_ACTIONS.next || action === TSP_ACTIONS.show || action === TSP_ACTIONS.hide) return true;
	const match = /^edit:(0|[1-9]\d*)$/.exec(action);
	return match !== null && match[0] === action && Number.isSafeInteger(Number(match[1]));
}
/** omp 19.1.0's jobs sheet source menu picks one stream source (`source:<id>`). */
export function isJobsSourceAction(action: string): boolean {
	return /^source:[^\u0000-\u001f\u007f]+$/.test(action);
}
export function isPlanReviewChoiceAction(action: string): boolean {
	return action === "execute" || action === "compact" || action === "keep" || action === "refine";
}
export function isPlanTierAction(action: string): boolean {
	return /^tier:(?:0|[1-9]\d{0,3})$/.test(action);
}
/** Extract declared action ids from `actions.menu` / `actions.hold`, ignoring separators and section headers. */
export function menuEntryActions(entries: readonly TspMenuEntry[] | undefined): string[] {
	if (!entries) return [];
	const actions: string[] = [];
	for (const entry of entries) {
		if (typeof entry === "string") {
			if (entry !== "-" && entry !== "---") actions.push(entry);
		} else if ("id" in entry) actions.push(entry.id);
	}
	return actions;
}
export function isKnownAction(action: string): boolean {
	return knownActions.has(action) || isAskFormAction(action) || isAskCardAction(action) || isJobsSourceAction(action) || isPlanReviewChoiceAction(action) || isPlanTierAction(action);
}
/** Recorded actions without an app interaction path stay display-only. */
// The BTW note controls (omp 18.21.0) stay omp's own: the app opens the side-question history with `/btw` instead.
export const TSP_READ_ONLY_ACTIONS: Readonly<Record<string, true>> = { external: true, expand: true, interrupt: true, "copy-message": true, rewind: true, task: true, approve: true, deny: true, note: true, "save-note": true, "queue.edit": true, "status.git": true, "status.cache": true, "jobs.open": true, edit: true, add: true, delete: true, "btw-copy": true, "btw-branch": true, "btw-blur": true, "btw-history": true, "btw-fold": true, "btw-focus": true, "btw-stop": true };
/**
 * omp 19.0.0's ask card in the transcript opens a folded question (`open:<question>`) and picks or flips an option pill
 * (`pick:<question>:<option>`) without submitting. The omp screen sends them only for the control inside a visible card
 * that declares that exact action, as it does for the form controls above.
 */
export function isAskCardAction(action: string): boolean {
	return /^(?:open:(?:0|[1-9]\d{0,5})|pick:(?:0|[1-9]\d{0,5}):(?:0|[1-9]\d{0,5}))$/.test(action);
}
export function isReadOnlyAction(action: string): boolean {
	return Object.hasOwn(TSP_READ_ONLY_ACTIONS, action);
}
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
/**
 * Plan Review option labels. `save` is "Save and quit" through omp 18.21; omp 18.22.0 replaced it with `saveCopy`,
 * "Save", which writes the plan to a file the user names and keeps the review open. omp 18.22.0 also lists
 * Refine only while its own review has annotations or deleted sections.
 */
export const TSP_PLAN_OPTIONS = {
	execute: "Approve and execute", compact: "Approve and compact context", keep: "Approve and keep context",
	refine: "Refine plan", save: "Save and quit", saveCopy: "Save",
} as const;
/** The option an omp label stands for: a prefix match ("Approve and keep context (~4k / 128k)"), except bare "Save". */
export function planOptionAction(label: string): keyof typeof TSP_PLAN_OPTIONS | null {
	if (label === TSP_PLAN_OPTIONS.saveCopy) return "saveCopy";
	return (Object.keys(TSP_PLAN_OPTIONS) as (keyof typeof TSP_PLAN_OPTIONS)[]).find(action => action !== "saveCopy" && label.startsWith(TSP_PLAN_OPTIONS[action])) ?? null;
}
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
		...[TSP_ROLES.editorAsk, TSP_ROLES.editorAskHidden].map(role => [role, "collab-form-card"]),
		...[TSP_ROLES.userShell, TSP_ROLES.userPython].map(role => [role, "transcript-user-runs"]),
		[TSP_ROLES.report, "command-report"],
		...[TSP_ROLES.cleanse, TSP_ROLES.omfg].map(role => [role, "command-panel-result"]),
		[TSP_ROLES.btwHistory, "btw-pane"],
	]),
);
const replicated = [TSP_ROLES.user, TSP_ROLES.assistant, TSP_ROLES.thinking, TSP_ROLES.tool, TSP_ROLES.agent];
export function isReplicatedRole(role?: string): boolean {
	return !!role && replicated.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
export interface AskFormPresentation {
	view: "fields" | "review" | "hidden";
	body: TspNode | null;
	navigation?: { active: string; items: string[] };
}

function* askNodes(node: TspNode): Generator<TspNode> {
	if (node.p?.hidden) return;
	yield node;
	for (const child of node.c ?? []) yield* askNodes(child);
}

/** Recorded HTML form presentations only. Legacy question lists remain generic. */
export function askFormPresentation(node: TspNode): AskFormPresentation | null {
	if (node.k !== "col" || node.p?.hidden || (node.p?.role !== TSP_ROLES.editorAsk && node.p?.role !== TSP_ROLES.editorAskHidden)) return null;
	const parts = [...askNodes(node)];
	const bodies = parts.filter(part => part.p?.role === TSP_ROLES.askForm);
	const tabs = parts.filter(part => part.p?.role === TSP_ROLES.askQuestions);
	const answers = parts.filter(part => part.p?.role === TSP_ROLES.askAnswers);
	const action = (name: string): boolean => parts.some(part => part.k === "button" && part.p?.actions?.click === name);
	if (node.p.role === TSP_ROLES.editorAskHidden) {
		// Legacy non-HTML asks share these roles and actions, but label cancellation Skip.
		return !bodies.length && !tabs.length && !answers.length && parts.some(part => part.k === "text" && part.p?.role === TSP_ROLES.askSummary) && action(TSP_ACTIONS.show) && parts.some(part => part.k === "button" && part.p?.actions?.click === TSP_ACTIONS.cancel && part.p.text === "Cancel")
			? { view: "hidden", body: null } : null;
	}
	let navigation: AskFormPresentation["navigation"];
	if (tabs.length) {
		const tab = tabs[0]!;
		if (tabs.length !== 1 || tab.k !== "tabs" || !tab.p?.active || !tab.p.items.length) return null;
		const items = tab.p.items.map(item => item.id);
		if (new Set(items).size !== items.length || !items.includes(tab.p.active) || !items.includes("review")) return null;
		navigation = { active: tab.p.active, items };
	}
	if (bodies.length === 1 && !answers.length && navigation?.active !== "review") {
		const body = bodies[0]!;
		if (body.k !== "col" || !body.c?.length) return null;
		let fields = 0;
		for (const field of askNodes(body)) {
			if (field.p?.role !== TSP_ROLES.askField) continue;
			if (field.k !== "col" || ![...askNodes(field)].some(part => part.k === "input" || part.k === "editor" || part.k === "list" && part.p?.role === TSP_ROLES.askOptions || part.k === "text" && (part.p?.role === TSP_ROLES.askWell || part.p?.role === TSP_ROLES.askWellMulti))) return null;
			fields++;
		}
		if (!fields) return null;
		return { view: "fields", body, ...(navigation ? { navigation } : {}) };
	}
	if (!bodies.length && navigation?.active === "review" && answers.length === 1 && answers[0]!.k === "kv" && action(TSP_ACTIONS.submit) && action(TSP_ACTIONS.cancel)) {
		return { view: "review", body: null, navigation };
	}
	return null;
}

export function isClaimable(node: TspNode, surface?: TspSurfaceSnapshot): boolean {
	if (node.k === "shell") return !node.p?.hidden && shellProps(node.p) !== null;
	if (node.p?.role === TSP_ROLES.report) return commandReport(node) !== null;
	if (node.p?.role === TSP_ROLES.cleanse || node.p?.role === TSP_ROLES.omfg) return settledCommandPanel(node) !== null;
	if (isTreeSelectorNode(node)) return true;
	if (node.k === "prefs" || node.p?.role === TSP_ROLES.advisor) return advisorScope(node, surface?.open.mode) !== null;
	if (node.p?.role === TSP_ROLES.userShell || node.p?.role === TSP_ROLES.userPython) return isUserRunNode(node);
	if (node.p?.role === TSP_ROLES.planReview) return projectPlanReview(node, "") !== null;
	if (node.p?.role === TSP_ROLES.planSave) return projectPlanSave(node, "") !== null;
	if (node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden) return askFormPresentation(node) !== null;
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
	"omp.ask.other", "omp.ask.question",
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
	// omp 18.21.0's side-answer note in the transcript; the BTW driver reads its question and opens the history.
	"omp.btw.note.head", "omp.btw.note.status", "omp.btw.note.tag", "omp.btw.note.tool", "omp.btw.note.tools", "omp.btw.note.turn",
	"omp.status", "omp.status.context_pct", "omp.status.model", "omp.status.path", "omp.status.pi",
	// omp 19.0.0's ask card in the transcript (main region); questions still arrive as collab requests.
	"omp.ask.card", "omp.ask.card.body", "omp.ask.card.head", "omp.ask.card.progress", "omp.ask.card.tag",
	"omp.ask.fold", "omp.ask.fold.answer", "omp.ask.fold.head", "omp.ask.fold.mark", "omp.ask.fold.note", "omp.ask.fold.question", "omp.ask.fold.well",
	"omp.ask.intro", "omp.ask.legend", "omp.ask.open", "omp.ask.pill", "omp.ask.pill.more", "omp.ask.pills", "omp.ask.group", "omp.ask.header", "omp.ask.preview", "omp.ask.skip",
	// omp 19.0.0's composer line while a question waits: sending the draft would skip it.
	"omp.composer.skip",
	// Jobs sheet, status-line and usage dashboard roles already present in omp 19.0.x.
	"omp.jobs.command", "omp.jobs.facts", "omp.jobs.label", "omp.jobs.master", "omp.jobs.nooutput", "omp.jobs.out", "omp.jobs.output", "omp.jobs.split",
	"omp.status.usage", "omp.usage.amount", "omp.usage.section.meta",
	// omp 19.1.0-19.1.1 additions: status tree, compaction HUD, and the jobs step and source sheet.
	"omp.status.tree", "omp.hud.compaction",
	"omp.jobs.about", "omp.jobs.follow", "omp.jobs.source", "omp.jobs.sources", "omp.jobs.stream",
	// omp 19.2.0 additions: form fields, dock covering, cleanse verdict/lane, composer parts, status/welcome/screen, and agents tray.
	"omp.field", "omp.dock.covering", "omp.cleanse.verdict", "omp.cleanse.lane",
	"omp.composer.mode", "omp.composer.crumb", "omp.composer.agent", "omp.composer.exit", "omp.composer.rate", "omp.composer.dictation",
	"omp.status.panel", "omp.status.hook", "omp.welcome.block", "omp.app.screen",
	"omp.tray", "omp.tray.card", "omp.tray.name", "omp.tray.meta", "omp.tray.line", "omp.tray.time",
	"omp.tray.done", "omp.tray.done.item", "omp.tray.done.more", "omp.tray.peek", "omp.tray.peek.head", "omp.tray.peek.meta", "omp.tray.peek.task",
	"omp.tray.tail", "omp.tray.ev", "omp.tray.ev.tool", "omp.tray.ev.text",
	// omp 19.2.1 additions: native prefs search input.
	"omp.prefs.search",
]);
export function isKnownRole(role?: string): boolean {
	return !role || knownRoles.has(role) || role.startsWith(`${TSP_ROLES.planToc}.`) || isReplicatedRole(role) || isHookDialog(role) || hookPartPrefixes.some(prefix => role === prefix || role.startsWith(`${prefix}.`));
}
