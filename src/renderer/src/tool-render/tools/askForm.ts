export type AskFormInlineRun =
	| { type: "text"; text: string }
	| { type: "strong" | "em" | "code"; children: AskFormInlineRun[] }
	| { type: "link"; href: string; children: AskFormInlineRun[] };

export type AskFormContextBlock =
	| { type: "paragraph"; runs: AskFormInlineRun[] }
	| { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: AskFormInlineRun[] }
	| { type: "list"; ordered: boolean; items: AskFormInlineRun[][] };

export interface AskFormOption {
	label: string;
	selected: boolean;
	disabled?: boolean;
	description?: string;
	/** Full label text sent by omp, retained for matching when the display label is split. */
	requestLabel?: string;
}

export interface AskFormField {
	name: string;
	kind: "choice" | "text";
	question: string;
	multi: boolean;
	options: AskFormOption[];
	context: AskFormContextBlock[];
	value?: string;
	other?: boolean;
}
export interface AskForm { legends: string[]; fields: AskFormField[]; images: string[] }

export interface AskFormRequest {
	kind: "select" | "editor";
	title: string;
	options?: readonly (string | { label: string })[];
}

interface LocatedContextBlock {
	block: AskFormContextBlock;
	anchor: Node;
	fieldset: Element | null;
}

const unsafeContextElements: Record<string, true> = {
	script: true, style: true, iframe: true, object: true, embed: true, template: true, noscript: true, img: true, svg: true,
};
const controls: Record<string, true> = { input: true, select: true, textarea: true, button: true };
const contextBlockTags: Record<string, true> = { p: true, ul: true, ol: true };
const ompLabelSkippedElements: Record<string, true> = {
	button: true, head: true, iframe: true, input: true, link: true, meta: true, noscript: true, script: true, select: true,
	style: true, svg: true, template: true, textarea: true, title: true,
};
const ompLabelSpacedElements: Record<string, true> = {
	address: true, article: true, aside: true, blockquote: true, dd: true, details: true, div: true, dl: true, dt: true,
	figure: true, figcaption: true, footer: true, header: true, li: true, main: true, nav: true, p: true, section: true,
	summary: true,
};

function contextHref(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

function appendText(runs: AskFormInlineRun[], text: string): void {
	const normalized = text.replace(/\s+/g, " ");
	if (!normalized) return;
	const previous = runs.at(-1);
	if (previous?.type === "text") previous.text += normalized;
	else runs.push({ type: "text", text: normalized });
}

function trimRunEdges(runs: AskFormInlineRun[], start: boolean): void {
	const run = start ? runs[0] : runs.at(-1);
	if (!run) return;
	if (run.type === "text") {
		run.text = start ? run.text.replace(/^\s+/, "") : run.text.replace(/\s+$/, "");
		if (!run.text) runs.splice(start ? 0 : runs.length - 1, 1);
		return;
	}
	trimRunEdges(run.children, start);
	if (!run.children.length) runs.splice(start ? 0 : runs.length - 1, 1);
}

function inlineRuns(nodes: readonly Node[]): AskFormInlineRun[] {
	const runs: AskFormInlineRun[] = [];
	const visit = (node: Node): AskFormInlineRun[] => {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.nodeValue ?? "";
			return text ? [{ type: "text", text: text.replace(/\s+/g, " ") }] : [];
		}
		if (!(node instanceof Element)) return [];
		const tag = node.localName;
		if (Object.hasOwn(unsafeContextElements, tag) || Object.hasOwn(controls, tag) || tag === "legend" || tag === "label") return [];
		if (tag === "br") return [{ type: "text", text: " " }];
		const children = [...node.childNodes].flatMap(visit);
		if (tag === "strong" || tag === "b") return children.length ? [{ type: "strong", children }] : [];
		if (tag === "em" || tag === "i") return children.length ? [{ type: "em", children }] : [];
		if (tag === "code") return children.length ? [{ type: "code", children }] : [];
		if (tag === "a") {
			const href = contextHref(node.getAttribute("href"));
			return href && children.length ? [{ type: "link", href, children }] : children;
		}
		return children;
	};
	for (const node of nodes) {
		for (const run of visit(node)) {
			if (run.type === "text") appendText(runs, run.text);
			else runs.push(run);
		}
	}
	trimRunEdges(runs, true);
	trimRunEdges(runs, false);
	return runs;
}

function plainText(nodes: readonly Node[]): string {
	return nodes.map(node => node.textContent ?? "").join("").replace(/\s+/g, " ").trim();
}

/** Mirrors omp's label text normalization, including line breaks inserted by br. */
function optionRequestLabelText(label: Element): string {
	let text = "";
	const visit = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			text += node.nodeValue ?? "";
			return;
		}
		if (!(node instanceof Element)) return;
		const tag = node.localName;
		if (Object.hasOwn(ompLabelSkippedElements, tag)) return;
		if (tag === "br") {
			text += "\n";
			return;
		}
		if (tag === "img") {
			text += node.getAttribute("alt") ?? "";
			return;
		}
		if (Object.hasOwn(ompLabelSpacedElements, tag) || /^h[1-6]$/.test(tag)) text += " ";
		for (const child of node.childNodes) visit(child);
	};
	for (const child of label.childNodes) visit(child);
	return text.replace(/[^\S\n]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}

function splitOptionLabel(label: Element, control: Element, raw: string, requestLabel: string): { label: string; description?: string; requestLabel?: string } {
	const siblings = [...label.childNodes];
	const controlIndex = siblings.indexOf(control);
	if (controlIndex < 0) return { label: raw };
	const afterControl = siblings.slice(controlIndex + 1);
	let boundary = -1;
	let skipBoundary = false;
	for (let index = 0; index < afterControl.length; index++) {
		const node = afterControl[index];
		if (!(node instanceof Element)) continue;
		if (node.localName === "br") {
			boundary = index;
			skipBoundary = true;
			break;
		}
		if (["small", "p", "div"].includes(node.localName)) {
			boundary = index;
			break;
		}
	}
	if (boundary < 0) {
		const last = afterControl.at(-1);
		if (last instanceof Element && last.localName === "span") {
			const text = plainText([last]);
			if (/^\s*[:：]\s*/.test(text)) {
				const base = plainText(afterControl.slice(0, -1));
				const description = text.replace(/^\s*[:：]\s*/, "").trim();
				return base && description ? { label: base, description, requestLabel } : { label: raw };
			}
		}
		return { label: raw };
	}
	const before = plainText(afterControl.slice(0, boundary));
	const description = plainText(afterControl.slice(boundary + Number(skipBoundary)));
	return before && description ? { label: before, description, requestLabel } : { label: raw };
}

function collectContext(root: Node): LocatedContextBlock[] {
	const located: LocatedContextBlock[] = [];
	const add = (block: AskFormContextBlock, anchor: Node, fieldset: Element | null) => located.push({ block, anchor, fieldset });
	const walk = (parent: Node, fieldset: Element | null) => {
		let pending: Node[] = [];
		const flush = () => {
			if (!pending.length) return;
			const runs = inlineRuns(pending);
			if (runs.length) add({ type: "paragraph", runs }, pending[0]!, fieldset);
			pending = [];
		};
		for (const child of [...parent.childNodes]) {
			if (child.nodeType === Node.TEXT_NODE) {
				pending.push(child);
				continue;
			}
			if (!(child instanceof Element)) continue;
			const tag = child.localName;
			if (tag === "legend") {
				flush();
				const runs = inlineRuns([...child.childNodes]);
				if (runs.length) add({ type: "heading", level: 2, runs }, child, fieldset);
				continue;
			}
			if (Object.hasOwn(unsafeContextElements, tag) || Object.hasOwn(controls, tag) || tag === "label") {
				flush();
				continue;
			}
			if (tag === "fieldset") {
				flush();
				walk(child, child);
				continue;
			}
			if (Object.hasOwn(contextBlockTags, tag)) {
				flush();
				if (tag === "p") {
					const runs = inlineRuns([child]);
					if (runs.length) add({ type: "paragraph", runs }, child, fieldset);
				} else {
					const items = [...child.children].filter(item => item.localName === "li")
						.map(item => inlineRuns([item])).filter(runs => runs.length);
					if (items.length) add({ type: "list", ordered: tag === "ol", items }, child, fieldset);
				}
				continue;
			}
			if (/^h[1-6]$/.test(tag)) {
				flush();
				const runs = inlineRuns([child]);
				if (runs.length) add({ type: "heading", level: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6, runs }, child, fieldset);
				continue;
			}
			if (tag === "br") {
				pending.push(child);
				continue;
			}
			if (["div", "section", "article", "main", "header", "footer", "blockquote", "hr"].includes(tag)) {
				flush();
				walk(child, fieldset);
				continue;
			}
			pending.push(child);
		}
		flush();
	};
	walk(root, null);
	return located;
}

/** Read text and control facts from an inert template. Never attach model HTML to the page. */
export function parseAskForm(html: string): AskForm {
	const template = document.createElement("template");
	template.innerHTML = html;
	const root = template.content.querySelector("form") ?? template.content;
	for (const node of root.querySelectorAll("script,style,iframe,object,embed,template,noscript")) node.remove();
	const plain = (node: Element | null): string => {
		if (!node) return "";
		const copy = node.cloneNode(true) as Element;
		for (const media of copy.querySelectorAll("img,svg")) media.replaceWith(media.getAttribute("alt") ?? media.getAttribute("aria-label") ?? "");
		for (const control of copy.querySelectorAll("input,select,textarea")) control.remove();
		return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
	};
	const labelNode = (node: Element): Element | null => {
		const id = node.getAttribute("id");
		const byFor = id ? [...root.querySelectorAll("label[for]")].find(label => label.getAttribute("for") === id) : undefined;
		return byFor ?? node.closest("label");
	};
	const label = (node: Element): string => plain(labelNode(node)) || node.getAttribute("aria-label") || node.getAttribute("title") || "";
	const fields: AskFormField[] = [];
	const groups = new Map<string, AskFormField>();
	const fieldControls = new Map<AskFormField, Element[]>();
	const fieldsetFields = new Map<Element, AskFormField>();
	const rememberControl = (field: AskFormField, control: Element) => {
		const items = fieldControls.get(field) ?? [];
		items.push(control);
		fieldControls.set(field, items);
		const section = control.closest("fieldset");
		if (section && !fieldsetFields.has(section)) fieldsetFields.set(section, field);
	};
	for (const control of root.querySelectorAll("input,select,textarea")) {
		const name = control.getAttribute("name") ?? "";
		const type = (control.getAttribute("type") ?? "text").toLowerCase();
		if (!name || ["hidden", "button", "file", "image", "reset", "submit"].includes(type)) continue;
		const section = control.closest("fieldset");
		const legend = plain(section?.querySelector("legend") ?? null);
		const previous = control.closest("label")?.previousElementSibling ?? control.previousElementSibling;
		const choice = type === "radio" || type === "checkbox" || control.localName === "select";
		const question = (choice ? (control.localName === "select" ? label(control) : "") : label(control) || name.replace(/[_-]+/g, " ")) || (previous?.matches("p,h1,h2,h3,h4,h5,h6") ? plain(previous) : "") || legend;
		if (type === "radio" || type === "checkbox") {
			const key = `${type}:${name}`;
			let field = groups.get(key);
			if (!field) {
				field = { name, kind: "choice", question, multi: type === "checkbox", options: [], context: [] };
				groups.set(key, field);
				fields.push(field);
			}
			if (type === "radio" && control.hasAttribute("checked")) for (const option of field.options) option.selected = false;
			const choiceLabel = labelNode(control);
			const rawLabel = label(control) || control.getAttribute("value") || name;
			const requestLabel = choiceLabel ? optionRequestLabelText(choiceLabel) || rawLabel : rawLabel;
			const display = choiceLabel ? splitOptionLabel(choiceLabel, control, rawLabel, requestLabel) : { label: rawLabel };
			field.options.push({
				label: display.label,
				...(display.description ? { description: display.description } : {}),
				...((display.requestLabel ?? (requestLabel !== display.label ? requestLabel : undefined)) ? { requestLabel: display.requestLabel ?? requestLabel } : {}),
				selected: control.hasAttribute("checked"),
				...(control.hasAttribute("disabled") ? { disabled: true } : {}),
			});
			rememberControl(field, control);
		} else if (control.localName === "select") {
			const options = [...control.querySelectorAll("option")].map(option => ({ label: plain(option) || option.getAttribute("value") || "", selected: option.hasAttribute("selected"), ...(option.hasAttribute("disabled") ? { disabled: true } : {}) }));
			const multi = control.hasAttribute("multiple");
			if (!multi && !options.some(option => option.selected)) {
				const first = options.find(option => !option.disabled);
				if (first) first.selected = true;
			}
			const field: AskFormField = { name, kind: "choice", question, multi, options, context: [] };
			fields.push(field);
			rememberControl(field, control);
		} else {
			const field: AskFormField = { name, kind: "text", question, multi: false, options: [], context: [], value: control.localName === "textarea" ? control.textContent ?? "" : control.getAttribute("value") ?? "" };
			fields.push(field);
			rememberControl(field, control);
		}
	}
	for (const field of groups.values()) field.other = field.options.length >= 2 && !field.options.some(option => /^\s*other\b/i.test(option.requestLabel ?? option.label));
	for (const field of fields) field.question ||= (field.kind === "choice" && field.options.length === 1 ? field.options[0]!.label : "") || field.name;

	for (const entry of collectContext(root)) {
		let owner: AskFormField | undefined;
		if (entry.fieldset) owner = fieldsetFields.get(entry.fieldset);
		else owner = fields.find(field => {
			const control = fieldControls.get(field)?.[0];
			return control !== undefined && Boolean(entry.anchor.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING);
		}) ?? fields.at(-1);
		if (!owner) continue;
		if (entry.anchor instanceof Element && entry.anchor.localName === "legend" && plain(entry.anchor) === owner.question) continue;
		owner.context.push(entry.block);
	}

	return {
		legends: [...root.querySelectorAll("legend")].map(plain).filter(Boolean),
		fields,
		images: [...root.querySelectorAll("img,svg")].map(node => node.getAttribute("alt") || node.getAttribute("aria-label") || plain(node.querySelector("title"))).filter(Boolean),
	};
}

function matchesAskFormField(field: AskFormField, request: AskFormRequest): boolean {
	if (request.title !== field.question && !(request.kind === "editor" && field.kind === "text" && request.title.startsWith(`${field.question} (`))) return false;
	if (request.kind === "editor") return field.kind === "text" || field.other === true;
	const taken = new Set(["Other (type your own)", "Next →"]);
	const labels = field.options.filter(option => !option.disabled).map(option => {
		const sourceLabel = option.requestLabel ?? option.label;
		let label = sourceLabel;
		for (let suffix = 2; taken.has(label); suffix++) label = `${sourceLabel} (${suffix})`;
		taken.add(label);
		return label;
	});
	if (field.other) labels.push("Other (type your own)");
	const actual = request.options?.map(option => typeof option === "string" ? option : option.label) ?? [];
	if (field.multi && actual.at(-1) === "Next →") actual.pop();
	return labels.length > 0 && labels.length === actual.length && labels.every((label, index) => label === actual[index]);
}

/** Start at the current form field and search forward so repeated questions keep their identity. */
export function askFormFieldForRequest(form: AskForm, request: AskFormRequest, fieldIndex = 0): AskFormField | null {
	for (let index = Math.max(0, fieldIndex); index < form.fields.length; index++) {
		const field = form.fields[index]!;
		if (matchesAskFormField(field, request)) return field;
	}
	return null;
}

/** Match only fields from a live form; option rows keep omp's disambiguation and sentinels. */
export function isAskFormRequest(html: string, request: AskFormRequest): boolean {
	return askFormFieldForRequest(parseAskForm(html), request) !== null;
}
