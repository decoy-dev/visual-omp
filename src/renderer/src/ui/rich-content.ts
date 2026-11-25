import { useContext, useLayoutEffect, type RefObject } from "react";
import { i18n } from "../i18n";
import { FileRefContext } from "../chat/transcript/fileRefScope";
import type { PaneFileContent } from "@shared/contracts/panes";
import { isSupportedImagePath } from "@shared/imageTypes";
import { figurePalette, sanitizeSvg, svgAccessibility, svgImage } from "./diagram-source";
import { closePartialSvg } from "./charts/vendor/omp/svg-source";
import { handleRemoteImage } from "./remote-images";
import { MermaidResourceError } from "./mermaid-policy";
import "./rich-content.css";

const TOKEN_WHITESPACE = /\s/u;

/** Classify decoded DOM text so entity spellings and inline formatting do not change token lengths. */
function markTableTokens(root: HTMLElement): void {
	for (const token of root.querySelectorAll("th code, td code, th a, td a")) {
		const walker = document.createTreeWalker(token, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
		let length = 0;
		let long = false;
		for (let node = walker.nextNode(); node && !long; node = walker.nextNode()) {
			if (node.nodeType === Node.ELEMENT_NODE && node.nodeName === "BR") length = 0;
			if (node.nodeType !== Node.TEXT_NODE) continue;
			for (const character of node.nodeValue ?? "") {
				if (TOKEN_WHITESPACE.test(character)) length = 0;
				else if (++length > 32) { long = true; break; }
			}
		}
		token.toggleAttribute("data-wrap-long", long);
	}
}
let homeDirectory: Promise<string | null> | null = null;
const LOCAL_IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml);base64,/i;
const IMAGE_DIMENSION = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|%|vw|vh|ch|em)$/i;

function readHomeDirectory(): Promise<string | null> {
	homeDirectory ??= window.vomp.invoke("app:info").then(info => info.homeDir).catch(() => null);
	return homeDirectory;
}

function absoluteReplyPath(source: string, base: string | null, home: string | null): string | null {
	let value = source.trim();
	if (!value || value.length > 1024 || value.includes("\0")) return null;
	if (value === "~" || value.startsWith("~/") || (window.vomp.platform === "win32" && value.startsWith("~\\"))) {
		if (!home) return null;
		value = home + value.slice(1);
	}
	const windows = window.vomp.platform === "win32";
	if (windows) value = value.replaceAll("\\", "/");
	const drive = /^[A-Za-z]:\//.exec(value)?.[0] ?? null;
	if (windows && value.startsWith("//")) return null;
	if (!drive && !value.startsWith("/")) {
		if (!base) return null;
		const folder = windows ? base.replaceAll("\\", "/") : base;
		value = `${folder.replace(/\/+$/, "")}/${value}`;
	}
	if (windows && !/^[A-Za-z]:\//.test(value)) return null;
	const root = /^[A-Za-z]:\//.exec(value)?.[0] ?? "/";
	const parts: string[] = [];
	for (const part of value.slice(root.length).split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return root + parts.join("/");
}

async function resolveReplyPath(source: string, base: string | null): Promise<string | null> {
	const home = source === "~" || source.startsWith("~/") || (window.vomp.platform === "win32" && source.startsWith("~\\")) ? await readHomeDirectory() : null;
	return absoluteReplyPath(source, base, home);
}

function setFileLinkPath(link: HTMLAnchorElement, path: string, base?: string | null): void {
	link.dataset.filePath = path;
	link.setAttribute("href", "#");
	if (base !== undefined) link.dataset.localFileBase = base ?? "";
}

function hydrateLocalFileLinks(root: HTMLElement, base: string | null): void {
	for (const link of root.querySelectorAll<HTMLAnchorElement>("[data-local-file-src]")) {
		const source = link.dataset.localFileSrc;
		if (!source) continue;
		const key = JSON.stringify([source, base ?? ""]);
		if (link.dataset.localFileKey === key) continue;
		link.dataset.localFileKey = key;
		delete link.dataset.filePath;
		link.removeAttribute("href");
		void resolveReplyPath(source, base).then(path => {
			if (path && root.contains(link) && link.dataset.localFileKey === key) setFileLinkPath(link, path, base);
		});
	}
}

function applyImageSize(image: HTMLImageElement, slot: HTMLElement): void {
	const width = slot.dataset.imageWidth;
	const height = slot.dataset.imageHeight;
	image.style.maxWidth = "100%";
	if (width && IMAGE_DIMENSION.test(width)) image.style.width = width;
	if (height && IMAGE_DIMENSION.test(height)) image.style.height = height;
	if (width && !height) image.style.height = "auto";
	if (height && !width) image.style.width = "auto";
}

function showLocalImageFallback(slot: HTMLElement, source: string, path: string, base: string | null): void {
	slot.replaceChildren();
	const alt = slot.dataset.imageAlt ?? "";
	if (alt) {
		const text = document.createElement("span");
		text.dataset.imageFallback = "";
		text.textContent = alt;
		slot.append(text);
	}
	const link = document.createElement("a");
	const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	link.className = "vomp-local-image-file";
	link.dataset.localFileSrc = source;
	link.dataset.localImageFile = "";
	link.dataset.localFileKey = JSON.stringify([source, base ?? ""]);
	link.setAttribute("aria-label", i18n.t("chat:visual.openImageFile", { name }));
	link.setAttribute("role", "link");
	link.tabIndex = 0;
	link.textContent = i18n.t("chat:visual.imageFileLink");
	setFileLinkPath(link, path, base);
	slot.append(link);
	slot.dataset.localImageState = "failed";
}

async function loadLocalImage(root: HTMLElement, slot: HTMLElement, source: string, base: string | null, key: string): Promise<void> {
	const path = await resolveReplyPath(source, base);
	if (!path || !root.contains(slot) || slot.dataset.localImageKey !== key) {
		if (root.contains(slot) && slot.dataset.localImageKey === key) slot.dataset.localImageState = "failed";
		return;
	}
	const fallbackLink = slot.querySelector<HTMLAnchorElement>("[data-local-image-file]");
	if (fallbackLink) setFileLinkPath(fallbackLink, path, base);
	if (!isSupportedImagePath(path)) {
		showLocalImageFallback(slot, source, path, base);
		return;
	}
	let content: PaneFileContent;
	try {
		content = await window.vomp.invoke("panes:readFile", path);
	} catch {
		if (root.contains(slot) && slot.dataset.localImageKey === key) showLocalImageFallback(slot, source, path, base);
		return;
	}
	if (!root.contains(slot) || slot.dataset.localImageKey !== key) return;
	if (content.kind !== "image" || !LOCAL_IMAGE_DATA_URL.test(content.dataUrl)) {
		showLocalImageFallback(slot, source, path, base);
		return;
	}
	const image = document.createElement("img");
	image.alt = slot.dataset.imageAlt ?? "";
	if (slot.dataset.imageTitle) image.title = slot.dataset.imageTitle;
	applyImageSize(image, slot);
	image.onload = () => {
		if (root.contains(slot) && slot.dataset.localImageKey === key) slot.dataset.localImageState = "loaded";
	};
	image.onerror = () => {
		if (root.contains(slot) && slot.dataset.localImageKey === key) showLocalImageFallback(slot, source, path, base);
	};
	const link = document.createElement("a");
	const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
	link.className = "vomp-local-image-file";
	link.dataset.localFileSrc = source;
	link.dataset.localImageFile = "";
	link.dataset.localFileKey = JSON.stringify([source, base ?? ""]);
	link.dataset.imageLink = "";
	link.setAttribute("aria-label", i18n.t("chat:visual.openImageFile", { name }));
	link.setAttribute("role", "link");
	link.tabIndex = 0;
	setFileLinkPath(link, path, base);
	link.append(image);
	slot.replaceChildren(link);
	image.src = content.dataUrl;
}

function hydrateLocalImages(root: HTMLElement, base: string | null): void {
	for (const slot of root.querySelectorAll<HTMLElement>("[data-local-image-src]")) {
		const source = slot.dataset.localImageSrc;
		if (!source) continue;
		const key = JSON.stringify([source, base ?? ""]);
		if (slot.dataset.localImageKey === key && slot.dataset.localImageState) continue;
		slot.dataset.localImageKey = key;
		slot.dataset.localImageState = "loading";
		void loadLocalImage(root, slot, source, base, key).catch(() => {
			if (root.contains(slot) && slot.dataset.localImageKey === key) {
				const link = slot.querySelector<HTMLAnchorElement>("[data-local-image-file]");
				const path = link?.dataset.filePath;
				if (path) showLocalImageFallback(slot, source, path, base);
				else slot.dataset.localImageState = "failed";
			}
		});
	}
}

/** Hydrate app-owned Markdown presentation and generated figures. Original text remains unchanged. */
export function hydrateRichContent(root: HTMLElement, streaming = false, base: string | null = null): () => void {
	markTableTokens(root);
	let live = true;
	const remoteImageUrls: string[] = [];
	const loadImage = (event: MouseEvent) => handleRemoteImage(event, root, url => {
		if (live) remoteImageUrls.push(url);
		else URL.revokeObjectURL(url);
	});
	root.addEventListener("click", loadImage);
	hydrateLocalFileLinks(root, base);
	hydrateLocalImages(root, base);
	const update = () => {
		const palette = figurePalette(root);
		for (const slot of root.querySelectorAll<HTMLElement>("[data-diagram]")) {
			const source = slot.querySelector("pre code")?.textContent || "";
			const imageSlot = slot.querySelector<HTMLElement>("[data-diagram-image]");
			if (!imageSlot) continue;
			const language = slot.dataset.diagram;
			const partial = streaming && slot.hasAttribute("data-fence-open");
			if (partial && language === "mermaid") continue;
			const revision = `${source}\0${JSON.stringify(palette)}`;
			if (slot.dataset.revision === revision) continue;
			slot.dataset.revision = revision;
			slot.dataset.pending = "";
			const draw = async () => {
				try {
					// Keep Mermaid and its layout engines outside the initial renderer chunk.
					const svg = language === "mermaid" ? await (await import("./mermaid-render")).renderMermaid(source, palette) : partial ? closePartialSvg(source) : source;
					if (svg === null) { delete slot.dataset.pending; return; }
					if (!live || !root.contains(slot) || slot.dataset.revision !== revision) return;
					const clean = sanitizeSvg(svg, palette);
					if (!clean) throw new Error("Invalid SVG");
					const image = document.createElement("img");
					const accessibility = svgAccessibility(clean);
					image.alt = accessibility.name || slot.dataset.label || i18n.t(language === "mermaid" ? "chat:visual.mermaid" : "chat:visual.svg");
					if (accessibility.description) image.setAttribute("aria-description", accessibility.description);
					imageSlot.tabIndex = 0;
					imageSlot.setAttribute("role", "region");
					imageSlot.setAttribute("aria-label", image.alt);
					image.src = svgImage(clean);
					image.onerror = () => {
						if (live && root.contains(slot)) fail();
					};
					imageSlot.replaceChildren(image);
					slot.dataset.drawn = "";
					delete slot.dataset.pending;
					const details = slot.querySelector("details");
					if (details) details.open = false;
				} catch (error) {
					if (live && root.contains(slot) && slot.dataset.revision === revision) fail(error instanceof MermaidResourceError ? i18n.t("chat:visual.resourceDiagram") : undefined);
				}
			};
			const fail = (message = i18n.t("chat:visual.failed")) => {
				delete slot.dataset.drawn;
				delete slot.dataset.pending;
				imageSlot.textContent = message;
				const details = slot.querySelector("details");
				if (details) details.open = true;
			};
			void draw();
		}
		for (const slot of root.querySelectorAll<HTMLElement>("[data-table-chart]")) {
			// Match omp: a table at the end of a streaming reply may receive more rows.
			if (slot.dataset.drawn !== undefined || (streaming && slot === root.lastElementChild)) continue;
			slot.dataset.drawn = "";
			slot.dataset.pending = "";
			// Exact omp chart planning and drawing load only when a table is displayed.
			void import("./charts/table-chart").then(({ tableChart }) => {
				if (!live || !root.contains(slot)) return;
				const data = JSON.parse(slot.dataset.tableChart || "null") as { header: string[]; rows: string[][] };
				const svg = tableChart(data.header, data.rows);
				if (svg) slot.innerHTML = svg;
				delete slot.dataset.pending;
			}).catch(() => { if (live) delete slot.dataset.drawn; });
		}
	};
	update();
	const observer = new MutationObserver(update);
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette", "class", "style"] });
	return () => {
		live = false;
		observer.disconnect();
		root.removeEventListener("click", loadImage);
		for (const url of remoteImageUrls.splice(0)) URL.revokeObjectURL(url);
		for (const slot of root.querySelectorAll<HTMLElement>("[data-pending]")) {
			delete slot.dataset.pending;
			delete slot.dataset.revision;
			delete slot.dataset.drawn;
		}
	};
}

export function useRichContent(ref: RefObject<HTMLElement | null>, html: string): void {
	const scope = useContext(FileRefContext);
	const base = scope?.bases[0] ?? null;
	useLayoutEffect(() => ref.current ? hydrateRichContent(ref.current, false, base) : undefined, [ref, html, base]);
}
