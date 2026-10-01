/**
 * The markup of file links in replies (DESIGN §4.6): an inline chip for a name inside a sentence, a file row for a
 * paragraph or list item that holds only the name. Links are built in a DOM pass over the reply's HTML, so the type
 * icons are rendered once from the Phosphor components into SVG strings and cloned into each link.
 */
import type { FileRef } from "@shared/contracts/fileRefs";
import { type Icon, ArrowUpRight, File, FileCode, FileImage, FilePdf, FileText, FileZip, Folder } from "@phosphor-icons/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { OPENABLE_EXT } from "../../features/panes/derive";
import { fileRefOf, textRefs } from "./fileRefs";

/** Links, code blocks, math and links already made hold no references. */
const SKIP = "a, pre, math, .katex, .tr-file";

export interface Occurrence {
	/** The text node holding the reference, or the inline `code` element that is all reference. */
	node: Text | Element;
	start: number;
	end: number;
	ref: string;
}

/** The references in rendered reply HTML, in document order. */
export function occurrences(root: DocumentFragment): Occurrence[] {
	const found: Occurrence[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node as Text;
		const parent = text.parentElement;
		if (!parent || parent.closest(SKIP)) continue;
		const code = parent.closest("code");
		if (code) {
			const ref = code.childNodes.length === 1 ? fileRefOf(text.data, true) : null;
			if (ref) found.push({ node: code, start: 0, end: 0, ref });
			continue;
		}
		for (const match of textRefs(text.data)) found.push({ node: text, ...match });
	}
	return found;
}

export function parse(html: string): DocumentFragment {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content;
}

// ── icons ───────────────────────────────────────────────────────────────────────────────────────

type IconKind = "pdf" | "image" | "code" | "text" | "archive" | "folder" | "file" | "open";

const ICONS: Record<IconKind, Icon> = {
	pdf: FilePdf,
	image: FileImage,
	code: FileCode,
	text: FileText,
	archive: FileZip,
	folder: Folder,
	file: File,
	open: ArrowUpRight,
};

const KIND_BY_EXTENSION: [RegExp, IconKind][] = [
	[/^pdf$/, "pdf"],
	[/^(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic)$/, "image"],
	[/^(md|markdown|mdx|txt|text|csv|tsv|log|rtf)$/, "text"],
	[/^(zip|tar|gz|tgz|bz2|xz|zst|7z|rar)$/, "archive"],
	[
		/^(html?|css|scss|sass|less|json|jsonc|jsonl|ya?ml|toml|xml|ini|env|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|vue|svelte|lua|dart|ex|exs|zig)$/,
		"code",
	],
];

function kindOf(ref: FileRef): IconKind {
	if (ref.kind === "folder") return "folder";
	const extension = /\.([^./\\]+)$/.exec(ref.path)?.[1]?.toLowerCase() ?? "";
	return KIND_BY_EXTENSION.find(([pattern]) => pattern.test(extension))?.[1] ?? "file";
}

/**
 * The Phosphor icons as SVG markup, rendered once at module load into a detached root. Links are built while a
 * reply renders, where React cannot flush another root, so this runs before any render.
 */
const ICON_MARKUP: Record<IconKind, string> = (() => {
	const holder = document.createElement("div");
	const root = createRoot(holder);
	const kinds = Object.keys(ICONS) as IconKind[];
	flushSync(() =>
		root.render(
			<>
				{kinds.map(name => {
					const Glyph = ICONS[name];
					return <Glyph key={name} aria-hidden weight="regular" />;
				})}
			</>,
		),
	);
	const rendered = [...holder.children].map(child => child.outerHTML);
	root.unmount();
	return Object.fromEntries(kinds.map((name, index) => [name, rendered[index] ?? ""])) as Record<IconKind, string>;
})();

function icon(kind: IconKind, className: string): Element {
	const svg = parse(ICON_MARKUP[kind]).firstElementChild ?? document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", className);
	svg.setAttribute("focusable", "false");
	return svg;
}

// ── links ───────────────────────────────────────────────────────────────────────────────────────

function span(className: string, ...children: (Node | string)[]): HTMLSpanElement {
	const element = document.createElement("span");
	element.className = className;
	element.append(...children);
	return element;
}

function linkElement(ref: FileRef, className: string): HTMLSpanElement {
	const link = span(`tr-file ${className}`);
	link.setAttribute("role", "link");
	link.setAttribute("tabindex", "0");
	link.dataset.filePath = ref.path;
	link.title = ref.path;
	return link;
}

/** The folder holding `path`, with the home folder as `~`. */
function parentLabel(path: string, home: string | null): string {
	const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const folder = cut > 0 ? path.slice(0, cut) : path.slice(0, cut + 1) || path;
	if (home && (folder === home || folder.startsWith(`${home}/`) || folder.startsWith(`${home}\\`))) return `~${folder.slice(home.length)}`;
	return folder;
}

function baseName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The occurrence as the reply wrote it, line citation included. */
function writtenText(occurrence: Occurrence): string {
	return occurrence.node instanceof Text ? occurrence.node.data.slice(occurrence.start, occurrence.end) : (occurrence.node.textContent ?? "");
}

/** Whether `block` holds nothing but the occurrence, apart from whitespace and trailing punctuation. */
function holdsOnly(block: Element, occurrence: Occurrence): boolean {
	for (const element of block.querySelectorAll("*")) if (!element.contains(occurrence.node)) return false;
	const own = writtenText(occurrence);
	const text = block.textContent ?? "";
	const at = text.indexOf(own);
	return at >= 0 && text.slice(0, at).trim() === "" && /^[\s.,;:!?)]*$/.test(text.slice(at + own.length));
}

export interface LinkText {
	/** The row's accessible name: the file name and its folder. */
	row(name: string, folder: string): string;
	home: string | null;
}

/**
 * `html` with each resolved occurrence linked (`refs` aligned with its occurrences): a block holding only one becomes
 * a file row, any other becomes an inline chip. The original string when none resolved.
 */
export function linkHtml(html: string, refs: readonly (FileRef | null)[], text: LinkText): string {
	const root = parse(html);
	const found = occurrences(root).flatMap((occurrence, index) => {
		const resolved = refs[index];
		return resolved ? [{ occurrence, resolved }] : [];
	});
	if (found.length === 0) return html;
	const perBlock = new Map<Element, number>();
	const blockOf = (occurrence: Occurrence) => (occurrence.node instanceof Text ? occurrence.node.parentElement : occurrence.node)?.closest("p, li") ?? null;
	for (const { occurrence } of found) {
		const block = blockOf(occurrence);
		if (block) perBlock.set(block, (perBlock.get(block) ?? 0) + 1);
	}
	const rows = new Set<Element>();
	// Last first, so splitting a text node keeps the offsets of earlier references in it.
	for (const { occurrence, resolved } of found.reverse()) {
		const kind = kindOf(resolved);
		const block = blockOf(occurrence);
		if (block && perBlock.get(block) === 1 && holdsOnly(block, occurrence)) {
			// The file's name with the reply's line, column or range citation (`app.ts:50-100`), which the lookup drops.
			const written = writtenText(occurrence);
			const name = baseName(resolved.path) + (written.startsWith(occurrence.ref) ? written.slice(occurrence.ref.length) : "");
			const folder = parentLabel(resolved.path, text.home);
			const tile = span("tr-file-tile", icon(kind, "tr-file-icon"));
			if (OPENABLE_EXT.test(resolved.path)) tile.dataset.thumb = resolved.path;
			const row = linkElement(resolved, "tr-file-row");
			row.setAttribute("aria-label", text.row(name, folder));
			row.append(tile, span("tr-file-text", span("tr-file-name", name), span("tr-file-folder", folder)), icon("open", "tr-file-go"));
			block.replaceChildren(row);
			rows.add(block);
			continue;
		}
		let target: Node = occurrence.node;
		if (occurrence.node instanceof Text) {
			target = occurrence.node.splitText(occurrence.start);
			(target as Text).splitText(occurrence.end - occurrence.start);
		}
		const chip = linkElement(resolved, "tr-file-chip");
		target.parentNode?.replaceChild(chip, target);
		// A code span's reference becomes a chip in place of the code pill.
		const name = span("tr-file-name", ...(target instanceof Element ? [...target.childNodes] : [target]));
		chip.append(icon(kind, "tr-file-icon"), name);
	}
	// A list of nothing but file rows drops its bullets and stacks the rows.
	for (const list of new Set([...rows].map(block => block.closest("ul, ol")))) {
		if (!list) continue;
		const items = [...list.children];
		const isRow = (item: Element) => rows.has(item) || (item.children.length === 1 && rows.has(item.children[0] as Element) && item.textContent?.trim() === item.children[0]?.textContent?.trim());
		if (items.every(item => item.tagName === "LI" && isRow(item))) list.classList.add("tr-file-list");
	}
	const holder = document.createElement("div");
	holder.append(root);
	return holder.innerHTML;
}

// ── thumbnails ──────────────────────────────────────────────────────────────────────────────────

const THUMB_CACHE_LIMIT = 120;

interface Thumb {
	/** undefined while loading. */
	value: string | null | undefined;
	promise: Promise<string | null>;
}

/** Row thumbnails by path for the session (the most recent paths), through `panes:thumbnail`. */
const thumbs = new Map<string, Thumb>();

function thumbnail(path: string): Thumb {
	let entry = thumbs.get(path);
	if (!entry) {
		const created: Thumb = { value: undefined, promise: Promise.resolve(null) };
		created.promise = window.vomp
			.invoke("panes:thumbnail", path)
			.catch(() => null)
			.then(value => (created.value = value));
		entry = created;
		thumbs.set(path, entry);
		for (const old of thumbs.keys()) {
			if (thumbs.size <= THUMB_CACHE_LIMIT) break;
			thumbs.delete(old);
		}
	}
	return entry;
}

function showThumb(tile: HTMLElement, src: string | null | undefined): void {
	if (!src || !tile.isConnected || tile.querySelector("img")) return;
	const image = document.createElement("img");
	image.className = "tr-file-thumb";
	image.alt = "";
	image.decoding = "async";
	image.addEventListener("error", () => image.remove());
	image.src = src;
	tile.append(image);
}

/**
 * Fills the thumbnail tiles of file rows under `root`: a known thumbnail at once, others once the tile scrolls near
 * view. The type icon stays where the operating system makes none. Returns the cleanup.
 */
export function fillThumbnails(root: HTMLElement): () => void {
	const tiles = [...root.querySelectorAll<HTMLElement>(".tr-file-tile[data-thumb]")];
	if (tiles.length === 0) return () => {};
	const observer = new IntersectionObserver(
		items => {
			for (const item of items) {
				if (!item.isIntersecting) continue;
				observer.unobserve(item.target);
				const tile = item.target as HTMLElement;
				void thumbnail(tile.dataset.thumb ?? "").promise.then(src => showThumb(tile, src));
			}
		},
		{ rootMargin: "200px" },
	);
	for (const tile of tiles) {
		const known = thumbs.get(tile.dataset.thumb ?? "")?.value;
		if (known !== undefined) showThumb(tile, known);
		else observer.observe(tile);
	}
	return () => observer.disconnect();
}
