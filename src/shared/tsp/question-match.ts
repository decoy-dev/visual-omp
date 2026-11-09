import type { CollabQuestion, CollabQuestionState } from "./question-match.schema";
import type { TspNode, TspText } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { askFormPresentation, isHookNode, TSP_ROLES, type AskFormPresentation } from "./roles";
import { walkNodes } from "./view-state";

export type { CollabQuestion, CollabQuestionState } from "./question-match.schema";
export interface QuestionScope { hostId: string; generation: number; epoch: number }
export interface HookQuestion {
	surfaceId: string; nodeId: string; title: string; kind: "select" | "editor" | "local" | "form";
	options?: { label: string; description?: string }[];
	field?: string;
	formView?: AskFormPresentation["view"];
	formNavigation?: AskFormPresentation["navigation"];
	formFields?: { title: string; kind: "choice" | "text"; other: boolean; options?: string[] }[];
}
export interface QuestionMatch {
	surfaceId: string; nodeId: string;
	status: "matched" | "ambiguous" | "unmatched" | "unavailable" | "settling" | "answering";
	reqId?: number;
	/** Diagnostic observation times from main's single monotonic clock. Never input authority. */
	nodeFirstSeenMs?: number;
	requestFirstSeenMs?: number;
}
const text = (value: string): string => value.trim().replace(/\s+/g, " ");
const sameScope = (a: QuestionScope, b: QuestionScope): boolean => a.hostId === b.hostId && a.generation === b.generation && a.epoch === b.epoch;
function questionText(value: TspText | undefined): string {
	return typeof value === "string" ? value : value?.map(span => span.t).join("") ?? "";
}

/** Labels and controls can sit below layout wrappers within a section. */
function formFields(body: TspNode): NonNullable<HookQuestion["formFields"]> {
	const fields: NonNullable<HookQuestion["formFields"]> = [];
	const visit = (container: TspNode, heading: string, previous = ""): void => {
		if (container.p?.hidden) return;
		if (container.k === "section" && container.p?.role === TSP_ROLES.askSection) heading = questionText(container.p.head);
		let preceding = previous;
		for (const block of container.c ?? []) {
			if (block.p?.hidden) continue;
			if (block.k === "text" && (block.p?.role === TSP_ROLES.askText || block.p?.role === TSP_ROLES.askHeading)) preceding = questionText(block.p.spans);
			else if (block.p?.role === TSP_ROLES.askField) {
				const parts = [...walkNodes(block)];
				const label = parts.find(part => part.k === "text" && part.p?.role === TSP_ROLES.askLabel);
				const options = parts.flatMap(part => part.k === "item" && (part.p?.role === TSP_ROLES.askOption || part.p?.role === TSP_ROLES.askCheck) && !part.p.disabled ? [part.id.endsWith("/other") ? "Other (type your own)" : questionText(part.p.label)] : []);
				fields.push({
					title: questionText(label?.k === "text" ? label.p?.spans : undefined).replace(/ \*$/, "") || preceding || heading,
					kind: parts.some(part => part.k === "list" && part.p?.role === TSP_ROLES.askOptions) ? "choice" : "text",
					other: parts.some(part => part.k === "item" && (part.p?.role === TSP_ROLES.askOption || part.p?.role === TSP_ROLES.askCheck) && part.id.endsWith("/other") && !part.p.disabled),
					...(options.length ? { options } : {}),
				});
				preceding = "";
			} else {
				visit(block, heading, preceding);
				preceding = "";
			}
		}
	};
	visit(body, "");
	return fields;
}

/** Only live, current-generation surfaces may supply input targets. Unknown hooks stay local/read-only. */
export function hookQuestions(surfaces: readonly (TspSurfaceSnapshot & { documentGeneration?: number | null })[], generation: number): HookQuestion[] {
	const result: HookQuestion[] = [];
	for (const surface of surfaces) {
		if (surface.closed || surface.suspended || (surface.documentGeneration !== undefined && surface.documentGeneration !== generation)) continue;
		for (const node of walkNodes(surface.document)) {
			const form = askFormPresentation(node);
			if (form) {
				result.push({
					surfaceId: surface.open.id, nodeId: node.id, kind: "form", title: "",
					formView: form.view,
					...(form.navigation ? { formNavigation: form.navigation } : {}),
					formFields: form.body ? formFields(form.body) : [],
				});
				continue;
			}
			if (!isHookNode(node)) continue;
			const children = [...walkNodes(node)];
			const picker = children.find(child => child.k === "picker" || child.k === "list");
			const field = children.find(child => child.k === "editor" || child.k === "input");
			const kind = node.k === "picker" || node.p?.role === TSP_ROLES.hookSelect || node.p?.role === TSP_ROLES.hookConfirm ? "select" : node.p?.role === TSP_ROLES.hookEditor ? "editor" : "local";
			const items = picker?.k === "picker" ? picker.p?.items : children.filter(child => child.k === "item").map(child => child.p!);
			const titleNode = children.find(child => child.p?.role?.endsWith(".title") || child.p?.role?.endsWith(".eyebrow"));
			const title = node.k === "overlay" ? questionText(node.p?.head) : node.k === "picker" ? node.p?.title ?? "" : "";
			result.push({ surfaceId: surface.open.id, nodeId: node.id, kind, title: title || (titleNode?.k === "text" ? questionText(titleNode.p?.spans) : ""), options: items?.map(item => ({ label: questionText(item.label), ...(item.detail ? { description: questionText(item.detail) } : {}) })), field: field?.p?.text });
		}
	}
	return result;
}

function compatible(dialog: HookQuestion, request: CollabQuestion): boolean {
	if (dialog.kind === "form") return dialog.formFields?.some(field => {
		if (!text(field.title) || text(field.title) !== text(request.title)) return false;
		if (request.kind === "editor") return field.kind === "text" || field.other;
		const options = request.options.map(option => text(typeof option === "string" ? option : option.label));
		if (options.at(-1) === "Next →") options.pop();
		return field.options?.length === options.length && field.options.every((option, index) => text(option) === options[index]);
	}) === true;
	if (dialog.kind !== request.kind || !text(dialog.title) || text(dialog.title) !== text(request.title)) return false;
	if (request.kind === "editor") return dialog.field === undefined || dialog.field === (request.prefill ?? "");
	if (!dialog.options || dialog.options.length !== request.options.length) return false;
	return dialog.options.every((option, index) => {
		const raw = request.options[index]!;
		const other = typeof raw === "string" ? { label: raw } : raw;
		return text(option.label) === text(other.label) && (!option.description || !other.description || text(option.description) === text(other.description));
	});
}

/** Mutual uniqueness, never first-match-wins. Any pending collab request blocks uncertain local answers. */
export function matchQuestions(scope: QuestionScope, state: CollabQuestionState | null, dialogs: readonly HookQuestion[]): QuestionMatch[] {
	const current = state && sameScope(scope, state) && state.connected;
	const candidates = dialogs.map(dialog => current ? state.requests.filter(request => compatible(dialog, request)) : []);
	return dialogs.map((dialog, index) => {
		const matches = candidates[index]!;
		if (!current) return { ...dialog, status: "unavailable" };
		if (state.requests.length === 0) return { ...dialog, status: dialogs.filter(other => other.surfaceId === dialog.surfaceId && other.nodeId === dialog.nodeId).length === 1 ? "unmatched" : "ambiguous" };
		const request = matches[0];
		if (matches.length === 1 && candidates.filter(list => list.some(candidate => candidate.reqId === request!.reqId)).length === 1) return { ...dialog, status: "matched", reqId: request!.reqId };
		return { ...dialog, status: "ambiguous" };
	});
}

