/**
 * File and folder names in omp's finished replies become links that open in the Files pane (DESIGN §4.6). Each
 * reply's references are resolved by main (`fs:resolveRefs`) in document order and cached for that chat and message
 * (`ReplyRefCache`); only names found on disk when checked are linked.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { FileRef } from "@shared/contracts/fileRefs";
import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useReducer } from "react";
import { chatOutputs } from "../../features/panes/derive";
import { renderMarkdown } from "../../transcript/render";
import { fileRefOf, MAX_BASES, ReplyRefCache, type ReplyRefs, textRefs } from "./fileRefs";

/** The chat a transcript shows and where its relative names are looked up after the folders a reply names. */
export interface FileRefScope {
	/** Identifies the chat (its tab), so replies in different chats never share results. */
	chat: string;
	/** The chat's folder, then folders omp wrote or edited files in. */
	bases: readonly string[];
}

export const FileRefContext = createContext<FileRefScope | null>(null);

/** Links, code blocks, math and links already made hold no references. */
const SKIP = "a, pre, math, .katex, .tr-file";

interface Occurrence {
	/** The text node holding the reference, or the inline `code` element that is all reference. */
	node: Text | Element;
	start: number;
	end: number;
	ref: string;
}

function occurrences(root: DocumentFragment): Occurrence[] {
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

function parse(html: string): DocumentFragment {
	const template = document.createElement("template");
	template.innerHTML = html;
	return template.content;
}

/** `html` with each resolved occurrence wrapped in a link (`refs` aligned with its occurrences); the original string when none resolved. */
function linkHtml(html: string, refs: readonly (FileRef | null)[]): string {
	const root = parse(html);
	const found = occurrences(root).flatMap((occurrence, index) => {
		const resolved = refs[index];
		return resolved ? [{ occurrence, resolved }] : [];
	});
	if (found.length === 0) return html;
	// Last first, so splitting a text node keeps the offsets of earlier references in it.
	for (const { occurrence, resolved } of found.reverse()) {
		let target: Node = occurrence.node;
		if (occurrence.node instanceof Text) {
			target = occurrence.node.splitText(occurrence.start);
			(target as Text).splitText(occurrence.end - occurrence.start);
		}
		const link = document.createElement("span");
		link.className = "tr-file";
		link.setAttribute("role", "link");
		link.setAttribute("tabindex", "0");
		link.dataset.filePath = resolved.path;
		link.title = resolved.path;
		target.parentNode?.replaceChild(link, target);
		link.append(target);
	}
	const holder = document.createElement("div");
	holder.append(root);
	return holder.innerHTML;
}

const cache = new ReplyRefCache(request => window.vomp.invoke("fs:resolveRefs", request));

/**
 * Where the references of a finished reply's text blocks point, by block and occurrence; null while they resolve and
 * for `reply` null (a reply still streaming). `reply` is the message's timestamp, which a streamed reply shares with
 * the saved entry that replaces it, so that entry and a remounted transcript link at once.
 */
export function useFileRefs(reply: number | null, texts: readonly string[]): ReplyRefs | null {
	const scope = useContext(FileRefContext);
	const [, rerender] = useReducer((count: number) => count + 1, 0);
	const key = reply !== null && scope ? `${scope.chat}\0${reply}` : null;
	const textKey = texts.join("\0");
	const baseKey = scope?.bases.join("\0") ?? "";
	useEffect(() => {
		if (!key || !scope) return;
		const source = () => ({ blocks: texts.map(text => occurrences(parse(renderMarkdown(text))).map(occurrence => occurrence.ref)), bases: scope.bases });
		const pending = cache.load(key, textKey, baseKey, source);
		if (!pending) return;
		let live = true;
		void pending.then(() => live && rerender());
		return () => {
			live = false;
		};
		// The keys stand for `texts` and `scope`.
	}, [key, textKey, baseKey]);
	return key ? cache.read(key, textKey) : null;
}

/** A finished reply's Markdown with its resolved references linked; the same markup as `Markdown` otherwise. */
export const LinkedMarkdown = memo(function LinkedMarkdown({ text, refs }: { text: string; refs: readonly (FileRef | null)[] | undefined }): ReactNode {
	const html = useMemo(() => renderMarkdown(text), [text]);
	const linked = useMemo(() => (refs?.some(Boolean) ? linkHtml(html, refs) : html), [html, refs]);
	return <div className="tr-md" dangerouslySetInnerHTML={{ __html: linked }} />;
});

const MAX_WRITTEN = MAX_BASES - 1;

/**
 * Folders of the files omp wrote or edited in this chat, newest first, as bases for {@link FileRefContext}. `~/`
 * paths keep the `~` for main to expand.
 */
export function writtenFolders(entries: readonly SessionEntry[], projectPath: string): string[] {
	const folders: string[] = [];
	for (const output of chatOutputs(entries, { cwd: projectPath, home: "~" })) {
		if (!output.produced || !output.path) continue;
		const cut = Math.max(output.path.lastIndexOf("/"), output.path.lastIndexOf("\\"));
		const folder = cut > 0 ? output.path.slice(0, cut) : null;
		// The file system root and drive roots (`C:`) are too broad to look names up in.
		if (folder && !folder.endsWith(":") && folder !== projectPath && !folders.includes(folder)) folders.push(folder);
		if (folders.length === MAX_WRITTEN) break;
	}
	return folders;
}
