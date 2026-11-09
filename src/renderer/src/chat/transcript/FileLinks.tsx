/**
 * File and folder names in omp's finished replies become links that open in the Files pane (DESIGN §4.6). Each
 * reply's references are resolved by main (`fs:resolveRefs`) in document order and cached for that chat and message
 * (`ReplyRefCache`); only names found on disk when checked are linked.
 */
import type { FileRef } from "@shared/contracts/fileRefs";
import { createContext, memo, type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownHtml } from "../../transcript/Markdown";
import { renderMarkdown } from "../../transcript/render";
import { useRichContent } from "../../ui/rich-content";
import { ReplyRefCache, type ReplyRefs } from "./fileRefs";
import { fillThumbnails, linkHtml, occurrences, parse } from "./fileLinkMarkup";

/** The chat a transcript shows and where its relative names are looked up after the folders a reply names. */
export interface FileRefScope {
	/** Identifies the chat (its tab), so replies in different chats never share results. */
	chat: string;
	/** The chat's folder. Other candidates come from this reply's directory spans and known turn files. */
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
export function useFileRefs(reply: number | string | null, texts: readonly string[], files = ""): ReplyRefs | null {
	const scope = useContext(FileRefContext);
	const [, rerender] = useReducer((count: number) => count + 1, 0);
	const key = reply !== null && scope ? `${scope.chat}\0${reply}` : null;
	const textKey = texts.join("\0");
	const baseKey = `${scope?.bases.join("\0") ?? ""}\0\0${files}`;
	useEffect(() => {
		if (!key || !scope) return;
		const source = () => ({ blocks: texts.map(text => occurrences(parse(renderMarkdown(text))).map(occurrence => occurrence.ref)), bases: scope.bases, files: files ? files.split("\0") : [] });
		const pending = cache.load(key, textKey, baseKey, source);
		if (!pending) return;
		let live = true;
		void pending.then(() => live && rerender());
		return () => {
			live = false;
		};
		// The keys stand for `texts` and `scope`.
	}, [key, textKey, baseKey]);
	return key ? cache.read(key, textKey, baseKey) : null;
}

/**
 * A finished reply's Markdown with its resolved references linked as chips and file rows; the same markup as
 * `Markdown` otherwise. Row thumbnails are filled into the rendered nodes, so they never change the HTML string.
 */
export const LinkedMarkdown = memo(function LinkedMarkdown({ text, refs }: { text: string; refs: readonly (FileRef | null)[] | undefined }): ReactNode {
	const { t } = useTranslation("chat");
	const home = useContext(FileRefContext)?.home ?? null;
	const ref = useRef<HTMLDivElement | null>(null);
	const html = useMarkdownHtml(text);
	const linked = useMemo(
		() => (refs?.some(Boolean) ? linkHtml(html, refs, { home, row: (name, folder) => t("fileRow", { name, folder }) }) : html),
		[html, refs, home, t],
	);
	useLayoutEffect(() => (ref.current ? fillThumbnails(ref.current) : undefined), [linked]);
	useRichContent(ref, linked);
	return <div ref={ref} className="tr-md" dangerouslySetInnerHTML={{ __html: linked }} />;
});

