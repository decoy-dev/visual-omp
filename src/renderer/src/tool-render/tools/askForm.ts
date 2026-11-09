export interface AskFormField {
	name: string;
	kind: "choice" | "text";
	question: string;
	multi: boolean;
	options: { label: string; selected: boolean; disabled?: boolean }[];
	value?: string;
	other?: boolean;
}
export interface AskForm { legends: string[]; fields: AskFormField[]; images: string[] }

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
	const label = (node: Element): string => {
		const id = node.getAttribute("id");
		return plain(id ? [...root.querySelectorAll("label[for]")].find(label => label.getAttribute("for") === id) ?? null : null) || plain(node.closest("label")) || node.getAttribute("aria-label") || node.getAttribute("title") || "";
	};
	const fields: AskFormField[] = [];
	const groups = new Map<string, AskFormField>();
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
			if (!field) { field = { name, kind: "choice", question, multi: type === "checkbox", options: [] }; groups.set(key, field); fields.push(field); }
			if (type === "radio" && control.hasAttribute("checked")) for (const option of field.options) option.selected = false;
			field.options.push({ label: label(control) || control.getAttribute("value") || name, selected: control.hasAttribute("checked"), ...(control.hasAttribute("disabled") ? { disabled: true } : {}) });
		} else if (control.localName === "select") {
			const options = [...control.querySelectorAll("option")].map(option => ({ label: plain(option) || option.getAttribute("value") || "", selected: option.hasAttribute("selected"), ...(option.hasAttribute("disabled") ? { disabled: true } : {}) }));
			const multi = control.hasAttribute("multiple");
			if (!multi && !options.some(option => option.selected)) {
				const first = options.find(option => !option.disabled);
				if (first) first.selected = true;
			}
			fields.push({ name, kind: "choice", question, multi, options });
		} else fields.push({ name, kind: "text", question, multi: false, options: [], value: control.localName === "textarea" ? control.textContent ?? "" : control.getAttribute("value") ?? "" });
	}
	for (const field of groups.values()) field.other = field.options.length >= 2 && !field.options.some(option => /^\s*other\b/i.test(option.label));
	for (const field of fields) field.question ||= (field.kind === "choice" && field.options.length === 1 ? field.options[0]!.label : "") || field.name;
	return { legends: [...root.querySelectorAll("legend")].map(plain).filter(Boolean), fields, images: [...root.querySelectorAll("img,svg")].map(node => node.getAttribute("alt") || node.getAttribute("aria-label") || plain(node.querySelector("title"))).filter(Boolean) };
}

/** Match only fields from a live form; option rows keep omp's disambiguation and sentinels. */
export function isAskFormRequest(html: string, request: { kind: "select" | "editor"; title: string; options?: readonly (string | { label: string })[] }): boolean {
	return parseAskForm(html).fields.some(field => {
		if (request.title !== field.question && !(request.kind === "editor" && field.kind === "text" && request.title.startsWith(`${field.question} (`))) return false;
		if (request.kind === "editor") return field.kind === "text" || field.other === true;
		const taken = new Set(["Other (type your own)", "Next →"]);
		const labels = field.options.filter(option => !option.disabled).map(option => {
			let label = option.label;
			for (let suffix = 2; taken.has(label); suffix++) label = `${option.label} (${suffix})`;
			taken.add(label);
			return label;
		});
		if (field.other) labels.push("Other (type your own)");
		const actual = request.options?.map(option => typeof option === "string" ? option : option.label) ?? [];
		if (field.multi && actual.at(-1) === "Next →") actual.pop();
		return labels.length > 0 && labels.length === actual.length && labels.every((label, index) => label === actual[index]);
	});
}
