import type { BtwTopic, BtwTopicRef, BtwTurn } from "../contracts/btw";
import type { TspNode, TspText } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { TSP_ACTIONS, TSP_BTW_STATUS, TSP_ROLES } from "./roles";
import { openOverlay } from "./view-state";
const btwRoles: Readonly<Record<string, true>> = Object.fromEntries([...Object.entries(TSP_ROLES).filter(([key]) => key.startsWith("btw")).map(([, role]) => role), "omp.actions", "omp.btn"].map(role => [role, true]));
export const BTW_SEND_BLOCKED_REASON = "Put away the side question to send a message.";

const text = (value: TspText | undefined): string => typeof value === "string" ? value : value?.filter(span => !span.s?.split(" ").includes("hide")).map(span => span.t).join("") ?? "";
const descendants = (node: TspNode): TspNode[] => node.p?.hidden ? [] : [node, ...(node.c?.flatMap(descendants) ?? [])];
const byRole = (node: TspNode, role: string): TspNode | undefined => descendants(node).find(child => child.p?.role === role);
const nodeText = (node: TspNode): string => node.k === "text" ? text(node.p?.text ?? node.p?.spans) : node.k === "md" ? node.p?.text ?? "" : "";
export interface BtwProjection {
	surfaceId: string;
	nodeId: string;
	selectedId: string | null;
	/** Focused helper histories are separate from the main session's sidecars. */
	focused: boolean;
	list: { nodeId: string; ids: string[] } | null;
	topics: { id: string; itemId: string; title: string }[];
	turns: BtwTurn[];
	/** Exact enabled action target, read afresh before every write. */
	actions: Record<string, string>;
	field: { nodeId: string; text: string } | null;
	supported: boolean;
	notice: string | null;
}

/** The overlay is a view document. Localized display times never become invented timestamps. */
export function projectBtw(surfaces: readonly TspSurfaceSnapshot[]): BtwProjection | null {
	const overlay = openOverlay(surfaces, true);
	if (!overlay || overlay.node.p?.role !== TSP_ROLES.btwHistory) return null;
	const root = overlay.node;
	const list = descendants(root).find((node): node is Extract<TspNode, { k: "list" }> => node.k === "list" && (node.p?.role === TSP_ROLES.btwList || node.p?.role === TSP_ROLES.btwListIdle));
	const topics = list?.c?.filter((node): node is Extract<TspNode, { k: "item" }> => node.k === "item" && !node.p?.hidden).map(node => ({ id: node.id.slice(list.id.length + 1), itemId: node.id, title: text(node.p?.label) })) ?? [];
	const actions: Record<string, string> = {};
	for (const node of descendants(root)) {
		const action = node.p?.actions;
		if (action && !Array.isArray(action) && action.click && !(node.p && "disabled" in node.p && node.p.disabled) && !(node.k === "button" && node.p?.busy)) actions[action.click] = node.id;
	}
	const supported = descendants(root).every(node => (!node.p?.role || Object.hasOwn(btwRoles, node.p.role)) && (!node.p?.actions || !Array.isArray(node.p.actions) && (!node.p.actions.click || Object.hasOwn(BTW_ACTION_NAMES, node.p.actions.click))));
	const notice = byRole(root, TSP_ROLES.btwNotice);
	const composer = byRole(root, TSP_ROLES.btwComposer);
	const field = composer && descendants(composer).find((node): node is Extract<TspNode, { k: "input" | "editor" }> => (node.k === "input" || node.k === "editor") && !node.p?.readonly);
	const turns = descendants(root).filter(node => node.p?.role === TSP_ROLES.btwTurn).map((node): BtwTurn => {
		const question = byRole(node, TSP_ROLES.btwQuestion) ?? byRole(node, TSP_ROLES.btwFollowup);
		const answer = byRole(node, TSP_ROLES.btwAnswer);
		const meta = byRole(node, TSP_ROLES.btwMeta);
		const error = byRole(node, TSP_ROLES.btwError);
		const statusText = meta ? nodeText(meta) : "";
		const status = error || statusText.includes(TSP_BTW_STATUS.error) ? "error"
			: statusText.includes(TSP_BTW_STATUS.cancelled) ? "cancelled"
			: statusText.includes(TSP_BTW_STATUS.interrupted) ? "interrupted"
			: statusText.includes(TSP_BTW_STATUS.running) || !!answer && descendants(answer).some(child => child.k === "md" && child.p?.stream) ? "running" : "complete";
		const inject = answer && byRole(answer, TSP_ROLES.btwInject);
		const injectText = inject?.c?.slice(0, -1).map(nodeText).join("\n");
		const answerText = (part: TspNode): string => {
			if (part.p?.role === TSP_ROLES.btwInject) return `<inject>\n${injectText ?? ""}\n</inject>`;
			if (part.k === "md") return part.p?.text ?? "";
			return part.c?.map(answerText).filter(Boolean).join("\n\n") ?? "";
		};
		return { question: question ? nodeText(question) : "", answer: answer ? answerText(answer) : "", status, createdAt: 0,
			...(error ? { error: nodeText(error) } : {}), ...(inject && injectText !== undefined ? { inject: { text: injectText, sent: inject.p?.tone === "success" } } : {}) };
	});
	const focused = surfaces.some(surface => !surface.closed && !surface.suspended && descendants(surface.document).some(node => node.p?.role === TSP_ROLES.composerFocus));
	return { surfaceId: overlay.surface.open.id, nodeId: root.id, focused, selectedId: list?.p?.selected ? list.p.selected.slice(list.id.length + 1) : null,
		list: list ? { nodeId: list.id, ids: topics.map(topic => topic.id) } : null, topics, turns, actions,
		field: field ? { nodeId: field.id, text: field.p?.text ?? "" } : null, supported, notice: notice ? nodeText(notice) : null };
}

/** Session-local ids may repeat in a focused helper's history. */
export function btwTopicKey(topic: BtwTopicRef): string {
	return JSON.stringify([topic.scope ?? null, topic.id]);
}
export function sameBtwTopic(left: BtwTopicRef | null | undefined, right: BtwTopicRef | null | undefined): boolean {
	return !!left && !!right && left.id === right.id && left.scope === right.scope;
}

/** The document carries no owning session id. Ambiguous records never establish a scope. */
export function resolveBtwTopic(projection: Pick<BtwProjection, "selectedId" | "turns"> & { focused?: boolean }, persisted: readonly BtwTopic[]): BtwTopicRef | null {
	const first = projection.turns[0];
	if (!first) return null;
	const candidates = persisted.filter(topic => (projection.focused === undefined || (topic.scope !== undefined) === projection.focused)
		&& (!projection.selectedId || topic.id === projection.selectedId)
		&& (topic.turns[0]?.question === first.question || topic.title === first.question)
		&& projection.turns.every((live, index) => !topic.turns[index] || index === 0 || topic.turns[index]?.question === live.question));
	if (candidates.length === 1 && (projection.selectedId || projection.focused !== true)) {
		const topic = candidates[0]!;
		return { id: topic.id, ...(topic.scope === undefined ? {} : { scope: topic.scope }) };
	}
	// A recorded answer can distinguish identical questions and ids in different scopes.
	const answered = candidates.filter(topic => projection.turns.some(turn => !!turn.answer)
		&& projection.turns.every((turn, index) => !turn.answer || !!topic.turns[index]?.answer
			&& (turn.status === "running" ? topic.turns[index]!.answer.startsWith(turn.answer) : topic.turns[index]!.answer === turn.answer)));
	if (answered.length !== 1) return null;
	const topic = answered[0]!;
	return { id: topic.id, ...(topic.scope === undefined ? {} : { scope: topic.scope }) };
}

/** Translate ids only after the selected record establishes this overlay's history scope. */
export function btwOverlayTopics(projection: BtwProjection, persisted: readonly BtwTopic[], selected: BtwTopicRef | null): BtwTopicRef[] {
	if (!selected) return [];
	const record = persisted.find(topic => sameBtwTopic(topic, selected));
	if (!record) return [selected];
	const topics: BtwTopicRef[] = [selected];
	for (const item of projection.topics) {
		const topic = persisted.find(topic => topic.id === item.id && topic.scope === record.scope);
		if (topic && !topics.some(ref => sameBtwTopic(ref, topic))) topics.push({ id: topic.id, ...(topic.scope === undefined ? {} : { scope: topic.scope }) });
	}
	return topics;
}

/** Disk owns durable ids and exact times. Only the matching scoped live topic receives deltas. */
export function mergeBtwTopics(persisted: readonly BtwTopic[], projection: BtwProjection | null, liveRef: BtwTopicRef, recoverRunning = false): BtwTopic[] {
	const selected = projection ? resolveBtwTopic(projection, persisted) ?? liveRef : null;
	const topics = persisted.map(topic => ({ ...topic, live: sameBtwTopic(topic, selected),
		turns: topic.turns.map(turn => recoverRunning && !sameBtwTopic(topic, selected) && turn.status === "running" ? { ...turn, status: "interrupted" as const } : turn) }));
	if (projection?.turns.length && selected) {
		const index = topics.findIndex(topic => sameBtwTopic(topic, selected));
		const file = topics[index];
		const turns = projection.turns.map((turn, i) => {
			const durable = file?.turns[i];
			if (durable && durable.status !== "running" && turn.status !== "running") return { ...durable, ...(turn.inject ? { inject: turn.inject } : {}) };
			return { ...turn, question: durable?.question ?? turn.question, createdAt: durable?.createdAt ?? 0,
				...(durable?.updatedAt !== undefined ? { updatedAt: durable.updatedAt } : {}) };
		});
		const topic = { ...file, ...selected, title: file?.title ?? projection.turns[0]!.question, turns, live: true };
		if (index >= 0) topics[index] = topic;
		else topics.unshift(topic);
	}
	return topics;
}

export const BTW_ACTION_NAMES: Readonly<Record<string, true>> = {
	[TSP_ACTIONS.close]: true, [TSP_ACTIONS.btwFollowUp]: true, [TSP_ACTIONS.btwSend]: true,
	[TSP_ACTIONS.btwDiscard]: true, [TSP_ACTIONS.btwStop]: true, [TSP_ACTIONS.btwCopy]: true, [TSP_ACTIONS.btwInject]: true,
};

/** Applies at the protocol writer as well as the native pane's driver. */
export function assertBtwEvent(surfaces: readonly TspSurfaceSnapshot[], event: { ev: string; sf: string; id?: string; act?: string; item?: string }): void {
	const overlay = projectBtw(surfaces);
	if ((event.ev === "select" || event.ev === "activate") && overlay?.surfaceId === event.sf && overlay.list?.nodeId === event.id) {
		if (overlay.field || !overlay.topics.some(topic => topic.itemId === event.item)) throw new Error("The side-question topic is no longer available.");
		return;
	}
	if (event.ev !== "action" || !event.act || !Object.hasOwn(BTW_ACTION_NAMES, event.act)) return;
	if (event.act === TSP_ACTIONS.close && (!overlay || overlay.surfaceId !== event.sf)) return;
	if (event.act === TSP_ACTIONS.close && overlay) {
		const surface = surfaces.find(item => item.open.id === event.sf);
		const root = surface && descendants(surface.document).find(item => item.id === overlay.nodeId);
		if (!root || !descendants(root).some(item => item.id === event.id)) return;
	}
	if (!overlay || overlay.surfaceId !== event.sf || overlay.actions[event.act] !== event.id) throw new Error("The side question no longer offers this action.");
}
