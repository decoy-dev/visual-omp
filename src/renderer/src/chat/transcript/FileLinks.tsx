/**
 * File and folder names in omp's finished replies become links that open in the Files pane (DESIGN §4.6). Each
 * reply's references are resolved by main (`fs:resolveRefs`) in document order and cached for that chat and message
 * (`ReplyRefCache`); only names found on disk when checked are linked.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { FileRef } from "@shared/contracts/fileRefs";
import { createContext, memo, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { chatOutputs } from "../../features/panes/derive";
import { renderMarkdown } from "../../transcript/render";
import { MAX_BASES, ReplyRefCache, type ReplyRefs } from "./fileRefs";
import { fillThumbnails, linkHtml, occurrences, parse } from "./fileLinkMarkup";

/** The chat a transcript shows and where its relative names are looked up after the folders a reply names. */
export interface FileRefScope {
	/** Identifies the chat (its tab), so replies in different chats never share results. */
	chat: string;
	/** The chat's folder, then folders omp wrote or edited files in. */
	bases: readonly string[];
	/** The home folder, shown as `~` in file rows; null until known. */
	home: string | null;
}

export const FileRefContext = createContext<FileRefScope | null>(null);

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

/**
 * A finished reply's Markdown with its resolved references linked as chips and file rows; the same markup as
 * `Markdown` otherwise. Row thumbnails are filled into the rendered nodes, so they never change the HTML string.
 */
export const LinkedMarkdown = memo(function LinkedMarkdown({ text, refs }: { text: string; refs: readonly (FileRef | null)[] | undefined }): ReactNode {
	const { t } = useTranslation("chat");
	const home = useContext(FileRefContext)?.home ?? null;
	const ref = useRef<HTMLDivElement | null>(null);
	const html = useMemo(() => renderMarkdown(text), [text]);
	const linked = useMemo(
		() => (refs?.some(Boolean) ? linkHtml(html, refs, { home, row: (name, folder) => t("fileRow", { name, folder }) }) : html),
		[html, refs, home, t],
	);
	useLayoutEffect(() => (ref.current ? fillThumbnails(ref.current) : undefined), [linked]);
	return <div ref={ref} className="tr-md" dangerouslySetInnerHTML={{ __html: linked }} />;
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
