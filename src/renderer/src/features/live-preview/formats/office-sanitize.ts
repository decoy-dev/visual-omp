import { safeOfficeLink } from "@shared/preview-office-link";

const ELEMENTS = ["div", "section", "article", "header", "footer", "main", "p", "span", "a", "br", "hr", "b", "strong", "i", "em", "u", "s", "sub", "sup", "small", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "colgroup", "col", "ul", "ol", "li", "img", "label"];
const ATTRIBUTES = ["class", "id", "title", "alt", "width", "height", "colspan", "rowspan", "scope", "dir", "start", "value", "style", "href", "src"];
const RASTER = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z\d+/=\s]+$/i;

/** Generated CSS never retains escapes, imports or a non-data resource reference. */
export function sanitizeOfficeCss(css: string): string {
	// docx-preview terminates list-marker strings with an escaped tab. Normalize only that
	// whitespace escape; every other escape still refuses the entire generated stylesheet.
	css = css.replace(/\\9(?=["'])/g, " ");
	if (/[\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(css)) return "";
	return css.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/@import\b[^;{}]*(?:;|$)/gi, "")
		.replace(/(?:url\(\s*(["']?)(.*?)\1\s*\))/gi, (whole, _quote: string, target: string) =>
			/^data:(?:image\/(?:png|jpe?g|gif|webp|bmp)|font\/[a-z\d.+-]+|application\/(?:vnd\.ms-opentype|x-font-ttf|font-woff));base64,[a-z\d+/=\s]+$/i.test(target) ? whole : "none")
		.replace(/[^{};]*(?:image-set\s*\(|expression\s*\(|-moz-binding|behavior\s*:|https?:|javascript:)[^{};]*(?:;|(?=})|$)/gi, "");
}

/** Defense in depth after renderAsync, before the detached document is ever attached. */
export function sanitizeOfficeDom(body: HTMLElement, styles: HTMLElement, links: Record<string, string> = {}): void {
	for (const root of [body, styles]) for (const element of Array.from(root.querySelectorAll("*"))) {
		const name = element.localName;
		if (element.namespaceURI !== "http://www.w3.org/1999/xhtml" || (!ELEMENTS.includes(name) && !(name === "style" && root === styles))) {
			element.remove(); continue;
		}
		if (name === "style") {
			element.textContent = sanitizeOfficeCss(element.textContent ?? "");
			for (const attribute of Array.from(element.attributes)) element.removeAttribute(attribute.name);
			continue;
		}
		for (const attribute of Array.from(element.attributes)) {
			const key = attribute.name.toLowerCase();
			if (!ATTRIBUTES.includes(key) || key.startsWith("on")) { element.removeAttribute(attribute.name); continue; }
			if (key === "style") element.setAttribute("style", sanitizeOfficeCss(attribute.value));
			if (key === "href") {
				const anchor = attribute.value.startsWith("#") ? attribute.value.slice(1) : null;
				const value = anchor !== null && Object.hasOwn(links, anchor) ? links[anchor]! : attribute.value;
				if (name !== "a" || !safeOfficeLink(value)) element.removeAttribute("href");
				else element.setAttribute("href", value);
			}
			if (key === "src" && (name !== "img" || !RASTER.test(attribute.value))) element.removeAttribute("src");
		}
	}
}
