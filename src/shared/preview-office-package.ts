import { zipSync, strToU8 } from "fflate";
import { DOMParser, XMLSerializer, type Element as XmlElement } from "@xmldom/xmldom";
import { OFFICE_LIMITS } from "./preview-office-zip";
import { safeOfficeLink } from "./preview-office-link";
import { inflateOffice } from "./preview-office-inflate";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const PRESENTATION = "http://schemas.openxmlformats.org/presentationml/2006/main";
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const MARKUP_COMPAT = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XLINK = "http://www.w3.org/1999/xlink";

const SAFE_SVG_FRAGMENT = /^#[A-Za-z_][\w:.-]*$/;
const SAFE_SVG_RASTER_DATA = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;
const FORBIDDEN_SVG_ELEMENTS = new Set(["script", "foreignobject", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "handler"]);
const SVG_IMAGE_ELEMENTS = new Set(["image", "feimage"]);

function filterCssUrls(css: string): string {
	return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi, (_match, dq?: string, sq?: string, bare?: string) => {
		const target = (dq ?? sq ?? bare ?? "").trim();
		return SAFE_SVG_FRAGMENT.test(target) ? `url(${target})` : "";
	});
}

function sanitizeSvgCss(css: string): string {
	let cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (;;) {
		const next = filterCssUrls(cleaned)
			.replace(/@import\b[^;]*(?:;|$)/gi, "")
			.replace(/expression\s*\([^)]*\)/gi, "")
			.replace(/-moz-binding\b[^;]*(?:;|$)/gi, "")
			.replace(/behavior\s*:[^;]*(?:;|$)/gi, "")
			.replace(/<\/\s*style/gi, "");
		if (next === cleaned) break;
		cleaned = next;
	}
	return cleaned.trim();
}

function isSafeSvgHref(value: string, allowRasterData: boolean): boolean {
	const trimmed = value.trim();
	if (SAFE_SVG_FRAGMENT.test(trimmed)) return true;
	return allowRasterData && SAFE_SVG_RASTER_DATA.test(trimmed);
}

function sanitizeOfficeSvg(bytes: Uint8Array, serializer: XMLSerializer): Uint8Array {
	const xml = parseXml(bytes);
	for (const element of Array.from(xml.getElementsByTagName("*"))) {
		if (!element.parentNode) continue;
		const tag = (element.localName ?? element.tagName).toLowerCase();
		if (FORBIDDEN_SVG_ELEMENTS.has(tag)) {
			element.parentNode.removeChild(element);
			continue;
		}
		if (tag === "style") {
			element.textContent = sanitizeSvgCss(element.textContent ?? "");
		}
		const allowRasterData = SVG_IMAGE_ELEMENTS.has(tag);
		let hasHref = false;
		for (const attr of Array.from(element.attributes)) {
			const local = (attr.localName ?? attr.name).toLowerCase();
			if (local.startsWith("on")) {
				element.removeAttributeNode(attr);
				continue;
			}
			if (local === "style") {
				const clean = sanitizeSvgCss(attr.value);
				if (clean) attr.value = clean;
				else element.removeAttributeNode(attr);
				continue;
			}
			if (local === "href" || local === "src" || (local === "href" && attr.namespaceURI === XLINK)) {
				if (isSafeSvgHref(attr.value, allowRasterData)) hasHref = true;
				else element.removeAttributeNode(attr);
				continue;
			}
			if (/url\s*\(/i.test(attr.value)) {
				const clean = filterCssUrls(attr.value).trim();
				if (clean) attr.value = clean;
				else element.removeAttributeNode(attr);
			}
		}
		if (allowRasterData && !hasHref) {
			element.parentNode.removeChild(element);
		}
	}
	return strToU8(serializer.serializeToString(xml));
}

function directChildByLocal(parent: XmlElement, namespaceUri: string, localName: string): XmlElement | null {
	for (let child = parent.firstChild; child; child = child.nextSibling) {
		if (child.nodeType !== 1) continue;
		const element = child as XmlElement;
		if (element.namespaceURI === namespaceUri && element.localName === localName) return element;
	}
	return null;
}

function stripPptxActiveElement(element: XmlElement): void {
	let altContent: XmlElement | null = null;
	for (let cur = element.parentNode; cur && cur.nodeType === 1; cur = cur.parentNode) {
		const el = cur as XmlElement;
		if (el.namespaceURI === MARKUP_COMPAT && el.localName === "Choice") {
			const parent = el.parentNode;
			if (parent && parent.nodeType === 1 && (parent as XmlElement).namespaceURI === MARKUP_COMPAT && (parent as XmlElement).localName === "AlternateContent") {
				altContent = parent as XmlElement;
			}
			break;
		}
	}
	if (altContent?.parentNode) {
		const fallback = directChildByLocal(altContent, MARKUP_COMPAT, "Fallback");
		if (fallback) {
			while (fallback.firstChild) altContent.parentNode.insertBefore(fallback.firstChild, altContent);
		}
		altContent.parentNode.removeChild(altContent);
		return;
	}
	const fallbackPic = element.getElementsByTagNameNS(PRESENTATION, "pic").item(0);
	if (fallbackPic && element.parentNode) {
		element.parentNode.insertBefore(fallbackPic, element);
	}
	element.parentNode?.removeChild(element);
}

/** No DTD or external entities are accepted. Namespace-aware parsing handles prefix and entity variations. */
function parseXml(bytes: Uint8Array) {
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new Error("unsafe"); }
	const encoding = /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])(.*?)\1/i.exec(text)?.[2];
	if (text.includes("\0") || (encoding && !/^utf-?8$/i.test(encoding)) || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("unsafe");
	return new DOMParser({ onError: () => { throw new Error("unsafe"); } }).parseFromString(text, "application/xml");
}

/** Resolve an OPC relationship target within its package, without filesystem path semantics. */
function packageTarget(owner: string, target: string): string {
	if (!target || /[\\\p{Cc}\u0020?#]/u.test(target) || /%(?:2e|2f|5c|25|00|0[0-9a-f]|1[0-9a-f]|7f)/i.test(target)) throw new Error("unsafe");
	let decoded: string;
	try { decoded = decodeURIComponent(target); } catch { throw new Error("unsafe"); }
	if (/[\\\p{Cc}]/u.test(decoded) || decoded.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(decoded)) throw new Error("unsafe");
	const parts = decoded.startsWith("/") ? [] : owner.split("/").slice(0, -1);
	for (const part of decoded.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (!parts.length) throw new Error("unsafe");
			parts.pop();
		} else parts.push(part);
	}
	return parts.join("/");
}

/** Remove all external-load capabilities before docx-preview or LibreOffice parses the package. */
export function rewriteOfficePackage(bytes: Uint8Array, kind: "docx" | "pptx"): { bytes: Uint8Array<ArrayBuffer>; links: Record<string, string> } {
	const files = inflateOffice(bytes, { docx: kind === "docx" });
	const content = files["[Content_Types].xml"];
	if (!content || (kind === "docx" && (!files["word/document.xml"] || files["word/document.xml"]!.length > OFFICE_LIMITS.document))
		|| (kind === "pptx" && !files["ppt/presentation.xml"])) throw new Error("unsafe");
	const types = parseXml(content);
	if (Object.keys(files).some(name => /(^|\/)vbaproject\.bin$/i.test(name))) throw new Error("unsafe");
	for (const element of Array.from(types.getElementsByTagName("*"))) {
		if (/macroenabled|vbaproject/i.test(element.getAttribute("ContentType") ?? "")) throw new Error("unsafe");
		if (element.localName === "Override" && /oleobject|activex|(?:x?html)|rfc822/i.test(element.getAttribute("ContentType") ?? "")) {
			delete files[decodeURIComponent((element.getAttribute("PartName") ?? "").replace(/^\//, ""))];
		}
	}
	const links: Record<string, string> = Object.create(null);
	const external = new Map<string, Map<string, { target: string; image: boolean }>>();
	const serializer = new XMLSerializer();
	const xmlTypes = new Set<string>();
	const xmlExtensions = new Set<string>(["xml", "rels"]);
	const svgTypes = new Set<string>();
	const svgExtensions = new Set<string>(["svg"]);
	for (const element of Array.from(types.getElementsByTagName("*"))) {
		const contentType = element.getAttribute("ContentType") ?? "";
		if (/^image\/svg\+xml\b/i.test(contentType)) {
			if (element.localName === "Override") svgTypes.add(packageTarget("", element.getAttribute("PartName") ?? ""));
			if (element.localName === "Default") svgExtensions.add((element.getAttribute("Extension") ?? "").toLowerCase());
		}
		if (!/(?:\+xml|\/xml)$/i.test(contentType)) continue;
		if (element.localName === "Override") xmlTypes.add(packageTarget("", element.getAttribute("PartName") ?? ""));
		if (element.localName === "Default") xmlExtensions.add((element.getAttribute("Extension") ?? "").toLowerCase());
	}
	for (const name of Object.keys(files)) {
		if (/(^|\/)(activex|embeddings|afchunk\d*)(\/|\.)/i.test(name) || /\.(?:mht(?:ml)?|x?html)$/i.test(name)) { delete files[name]; continue; }
		if (!files[name] || !name.endsWith(".rels")) continue;
		const xml = parseXml(files[name]!);
		const removed = new Map<string, { target: string; image: boolean }>();
		const owner = name.replace(/(^|\/)_rels\//, "$1").replace(/\.rels$/, "");
		for (const element of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
			const target = element.getAttribute("Target") ?? "";
			const type = element.getAttribute("Type") ?? "";
			const mode = (element.getAttribute("TargetMode") ?? "Internal").trim().toLowerCase();
			if (mode !== "internal" && mode !== "external") throw new Error("unsafe");
			const outside = mode === "external" || (target.startsWith("#") && /\/hyperlink$/i.test(type));
			const active = /\/(?:oleObject|control|aFChunk|attachedTemplate)$/i.test(type);
			if (!outside && !target) throw new Error("unsafe");
			if (active && !outside && target) delete files[packageTarget(owner, target)];
			if (!outside && target) {
				const resolved = packageTarget(owner, target);
				if (!active && !files[resolved]) throw new Error("unsafe");
				// Canonical absolute package targets avoid different downstream URI/path interpretations.
				if (!active) element.setAttribute("Target", `/${resolved.split("/").map(encodeURIComponent).join("/")}`);
			}
			if (outside || active) {
				removed.set(element.getAttribute("Id") ?? "", { target, image: /\/image$/i.test(type) });
				if (kind === "pptx") { element.removeAttribute("TargetMode"); element.setAttribute("Target", ""); }
				else element.parentNode?.removeChild(element);
			}
		}
		external.set(owner, removed);
		files[name] = strToU8(serializer.serializeToString(xml));
	}
	if (kind === "docx") for (const name of Object.keys(files)) {
		if (!name.startsWith("word/") || !name.endsWith(".xml")) continue;
		const xml = parseXml(files[name]!);
		const removed = external.get(name);
		for (const element of Array.from(xml.getElementsByTagName("*"))) {
			if (!element.parentNode) continue;
			if ((element.namespaceURI === WORD && ["altChunk", "object", "control", "instrText", "fldChar"].includes(element.localName ?? ""))
				|| /(?:^|:)(?:OLEObject|ocx)$/i.test(element.tagName)) { element.parentNode.removeChild(element); continue; }
			if (element.namespaceURI === WORD && element.localName === "fldSimple") {
				while (element.firstChild) element.parentNode.insertBefore(element.firstChild, element);
				element.parentNode.removeChild(element); continue;
			}
			if (element.namespaceURI === WORD && element.localName === "hyperlink") {
				const id = element.getAttributeNS(REL, "id");
				const link = id ? removed?.get(id) : null;
				if (id) element.removeAttributeNS(REL, "id");
				if (link && safeOfficeLink(link.target)) {
					const anchor = `vomp-office-link-${Object.keys(links).length}`;
					links[anchor] = link.target;
					element.setAttributeNS(WORD, "w:anchor", anchor);
				}
			}
			const id = element.getAttributeNS(REL, "link") || element.getAttributeNS(REL, "embed") || element.getAttributeNS(REL, "id");
			if (id && removed?.get(id)?.image) {
				let image = element;
				while (image.parentNode?.nodeType === 1 && !(image.namespaceURI === WORD && ["drawing", "pict"].includes(image.localName ?? ""))) image = image.parentNode as typeof element;
				if (image.namespaceURI === WORD && ["drawing", "pict"].includes(image.localName ?? "")) {
					const placeholder = xml.createElementNS(WORD, "w:t");
					placeholder.textContent = "External image not loaded";
					image.parentNode?.replaceChild(placeholder, image);
				} else element.parentNode?.removeChild(element);
			}
		}
		files[name] = strToU8(serializer.serializeToString(xml));
	}
	if (kind === "pptx") for (const name of Object.keys(files)) {
		if (!name.startsWith("ppt/") || !name.endsWith(".xml")) continue;
		const xml = parseXml(files[name]!);
		const removed = external.get(name);
		for (const element of Array.from(xml.getElementsByTagName("*"))) {
			if (!element.parentNode) continue;
			if ((element.namespaceURI === PRESENTATION && (element.localName === "oleObj" || element.localName === "control"))
				|| /(?:^|:)(?:OLEObject|ocx)$/i.test(element.tagName)) {
				stripPptxActiveElement(element);
				continue;
			}
			if (element.localName === "externalData") {
				element.parentNode.removeChild(element);
				continue;
			}
			let strippedExternalRef = false;
			for (const relAttr of ["id", "embed", "link", "href"]) {
				const refId = element.getAttributeNS(REL, relAttr);
				if (refId && removed?.has(refId)) {
					element.removeAttributeNS(REL, relAttr);
					strippedExternalRef = true;
				}
			}
			if (!strippedExternalRef) continue;
			const local = element.localName ?? "";
			if (element.namespaceURI === DRAWING && ["hlinkClick", "hlinkHover", "hlinkMouseOver"].includes(local)) {
				element.removeAttribute("action");
				if (!element.getAttributeNS(REL, "id")) element.parentNode.removeChild(element);
				continue;
			}
			if (element.namespaceURI === DRAWING && ["audioFile", "videoFile", "quickTimeFile", "wavAudioFile"].includes(local)) {
				element.parentNode.removeChild(element);
				continue;
			}
			if ((local === "blip" || local === "svgBlip") && !element.getAttributeNS(REL, "embed") && !element.getAttributeNS(REL, "link")) {
				element.parentNode.removeChild(element);
			}
		}
		files[name] = strToU8(serializer.serializeToString(xml));
	}
	for (const name of Object.keys(files)) {
		if (!files[name]) continue;
		const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
		if (svgTypes.has(name) || svgExtensions.has(extension)) {
			files[name] = sanitizeOfficeSvg(files[name]!, serializer);
		}
	}
	// Validate every retained XML part, including custom locations identified only by content type.
	for (const name of Object.keys(files)) {
		if (!xmlTypes.has(name) && !xmlExtensions.has(name.split(".").at(-1)?.toLowerCase() ?? "")) continue;
		const xml = parseXml(files[name]!);
		if (name.endsWith(".rels")) {
			const owner = name.replace(/(^|\/)_rels\//, "$1").replace(/\.rels$/, "");
			for (const element of Array.from(xml.getElementsByTagNameNS("*", "Relationship"))) {
				const target = element.getAttribute("Target") ?? "";
				if (target && !files[packageTarget(owner, target)]) throw new Error("unsafe");
			}
		}
	}
	// Strip content-type entries for parts that were removed.
	for (const element of Array.from(types.getElementsByTagNameNS("*", "Override"))) {
		const part = (element.getAttribute("PartName") ?? "").replace(/^\//, "");
		if (!Object.hasOwn(files, part)) element.parentNode?.removeChild(element);
	}
	if (!files[kind === "docx" ? "word/document.xml" : "ppt/presentation.xml"]) throw new Error("unsafe");
	files["[Content_Types].xml"] = strToU8(serializer.serializeToString(types));
	const rewritten = zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>;
	if (rewritten.length > OFFICE_LIMITS.input) throw new Error("unsafe");
	return { bytes: rewritten, links };
}
