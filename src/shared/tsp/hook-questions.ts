/**
 * Questions omp's native dialogs ask, read from TSP surfaces. Main and the renderer both extract them; only main matches
 * them against collab requests (`question-match.ts`), which keeps the Markdown parser out of the renderer's startup chunk.
 */
import type { TspNode, TspText } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { askFormPresentation, isHookNode, TSP_ROLES, type AskFormPresentation } from "./roles";
import { walkNodes } from "./view-state";

export interface HookQuestion {
	surfaceId: string; nodeId: string; title: string; kind: "select" | "editor" | "local" | "form";
	options?: { label: string; description?: string }[];
	field?: string;
	formView?: AskFormPresentation["view"];
	formNavigation?: AskFormPresentation["navigation"];
	formFields?: { title: string; kind: "choice" | "text"; other: boolean; options?: string[] }[];
}

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
			const title = node.k === "overlay" || node.k === "card" ? questionText(node.p?.head) : node.k === "picker" ? node.p?.title ?? "" : "";
			// Selectors split the original question between their heading and detail.
			const detailNode = kind === "select" ? node.c?.find(child => child.k === "text" && child.id === `${node.id}.detail`) : undefined;
			const detail = node.k === "picker" ? questionText(node.p?.subtitle) : detailNode?.k === "text" ? questionText(detailNode.p?.spans) || detailNode.p?.text || "" : "";
			const fullTitle = [title || (titleNode?.k === "text" ? questionText(titleNode.p?.spans) : ""), detail].filter(Boolean).join("\n");
			result.push({ surfaceId: surface.open.id, nodeId: node.id, kind, title: fullTitle, options: items?.map(item => ({ label: questionText(item.label), ...(item.detail ? { description: questionText(item.detail) } : {}) })), field: field?.p?.text });
		}
	}
	return result;
}
