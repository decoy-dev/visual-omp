const SVG_NS = "http://www.w3.org/2000/svg";
const TAGS = new Set("svg g a defs title desc symbol use path rect circle ellipse line polyline polygon text tspan textPath marker clipPath mask linearGradient radialGradient stop pattern style".toLowerCase().split(" "));
const ATTRS = new Set("id class viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset opacity color font-family font-size font-weight font-style text-anchor dominant-baseline alignment-baseline dx dy rotate lengthAdjust textLength preserveAspectRatio marker-start marker-mid marker-end markerWidth markerHeight markerUnits refX refY orient clip-path clip-rule mask gradientUnits gradientTransform offset stop-color stop-opacity patternUnits patternContentUnits patternTransform spreadMethod role aria-label aria-labelledby aria-describedby aria-description focusable style href".toLowerCase().split(" "));
const CSS_PROPERTIES = new Set("font-family font-size font-weight font-style color fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin opacity text-anchor dominant-baseline display visibility background-color line-height letter-spacing white-space text-decoration".split(" "));

/** SVG figures use omp's token vocabulary, resolved from the containing app surface. */
export const FIGURE_TOKENS: Readonly<Record<string, string>> = {
	fg: "--fg", muted: "--fg-muted", border: "--border", surface: "--selected", accent: "--accent",
	success: "--ok", warning: "--warn", error: "--err", c1: "--accent", c2: "--syn-function",
	c3: "--syn-number", c4: "--syn-type", c5: "--syn-string", c6: "--syn-operator",
};

export function figurePalette(element: Element): Record<string, string> {
	const style = getComputedStyle(element);
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 1;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	return Object.fromEntries(Object.entries(FIGURE_TOKENS).map(([name, token]) => {
		const color = style.getPropertyValue(token).trim();
		// Mermaid's color parser does not accept OKLCH. Canvas resolves the app's tokens to sRGB.
		if (!context) return [name, color];
		context.clearRect(0, 0, 1, 1);
		context.fillStyle = color;
		context.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
		return [name, `rgba(${r}, ${g}, ${b}, ${a / 255})`];
	}));
}

/** Reject CSS escapes, imports and every non-local URL, including font and image fetches. */
function safeCss(value: string): boolean {
	return !/[\\@<>]/.test(value) && !/url\(\s*(?!["']?#[\w:.-]+["']?\s*\))/i.test(value);
}

function staticDeclarations(source: string): string {
	return source.split(";").filter(declaration => {
		const colon = declaration.indexOf(":");
		return colon > 0 && CSS_PROPERTIES.has(declaration.slice(0, colon).trim().toLowerCase()) && safeCss(declaration.slice(colon + 1));
	}).join(";");
}

/** Parse styles with the browser's CSS parser. Imports, keyframes and animation declarations never survive. */
function staticStylesheet(source: string): string {
	if (typeof CSSStyleSheet === "undefined") return "";
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(source);
	return Array.from(sheet.cssRules).flatMap(rule => {
		if (rule.type !== 1) return [];
		const styleRule = rule as CSSStyleRule;
		const declarations = staticDeclarations(styleRule.style.cssText);
		return declarations ? [`${styleRule.selectorText}{${declarations}}`] : [];
	}).join("");
}

/** Static, self-contained SVG only. The returned document is displayed in an isolated image context. */
export function sanitizeSvg(source: string, palette: Readonly<Record<string, string>>): string | null {
	if (source.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) return null;
	const doc = new DOMParser().parseFromString(source, "image/svg+xml");
	const root = doc.documentElement;
	if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
	const fg = palette.fg || "currentColor";
	const resolve = (value: string) => value.replace(/var\(\s*--([\w-]+)\s*(?:,[^()]*)?\)/g, (_match, name: string) => palette[name] || fg);
	let count = 0;
	const clean = (element: Element): void => {
		for (const child of Array.from(element.childNodes)) {
			if (child.nodeType === 1) {
				const node = child as Element;
				if (++count > 10_000 || !TAGS.has(node.localName.toLowerCase()) || (node.namespaceURI && node.namespaceURI !== SVG_NS)) element.removeChild(child);
				else clean(node);
			} else if (child.nodeType !== 3 && child.nodeType !== 4) element.removeChild(child);
		}
		for (const attr of Array.from(element.attributes)) {
			const name = attr.localName.toLowerCase();
			const value = attr.value;
			const plainText = name === "id" || name === "class" || name.startsWith("aria-");
			if (!ATTRS.has(name) || (name === "href" && !/^#[\w:.-]+$/.test(value)) || (!plainText && !safeCss(value))) element.removeAttributeNode(attr);
			else element.setAttribute(attr.name, plainText ? value : resolve(name === "style" ? staticDeclarations(value) : value));
		}
		if (element.localName === "style") {
			const css = staticStylesheet(element.textContent || "");
			if (!css) element.parentNode?.removeChild(element);
			else element.textContent = resolve(css);
		}
	};
	clean(root);
	root.setAttribute("xmlns", SVG_NS);
	root.setAttribute("color", fg);
	root.setAttribute("font-family", "Geist, sans-serif");
	if (!root.hasAttribute("viewBox")) {
		const width = Number.parseFloat(root.getAttribute("width") || "");
		const height = Number.parseFloat(root.getAttribute("height") || "");
		if (width > 0 && height > 0 && Number.isFinite(width + height)) root.setAttribute("viewBox", `0 0 ${width} ${height}`);
	}
	const box = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
	if (box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) {
		// viewBox units are natural CSS pixels, with the same 4096px edge cap as omp's renderer.
		const scale = Math.min(1, 4096 / box[2], 4096 / box[3]);
		root.setAttribute("width", String(box[2] * scale));
		root.setAttribute("height", String(box[3] * scale));
	}
	return new XMLSerializer().serializeToString(root);
}

/** Read only the sanitized document's authored accessibility metadata for its outer image. */
export function svgAccessibility(svg: string): { name: string; description: string } {
	const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
	const root = doc.documentElement;
	const normalize = (text: string | null | undefined) => (text || "").replace(/\s+/g, " ").trim();
	const referenced = (attribute: string) => normalize((root.getAttribute(attribute) || "").split(/\s+/).map(id => doc.getElementById(id)?.textContent || "").join(" "));
	const directText = (name: string) => normalize(Array.from(root.children).find(child => child.localName === name)?.textContent);
	return {
		name: referenced("aria-labelledby") || normalize(root.getAttribute("aria-label")) || directText("title"),
		description: referenced("aria-describedby") || normalize(root.getAttribute("aria-description")) || directText("desc"),
	};
}

export function svgImage(svg: string): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
