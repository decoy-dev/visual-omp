/**
 * Files entering the composer (drag-drop, paste, the ＋ menu). Images omp can attach become chips;
 * every other file becomes an `@path` mention, which omp reads when the message arrives.
 */
import { useEffect, useState } from "react";
import { useComposerDrafts } from "./drafts";
import { ATTACHABLE_IMAGE } from "./send";

const MIME_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

function baseName(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

/** `@path` for a file: project-relative inside the project, absolute otherwise or with no project (Home). */
export function mentionFor(path: string, projectPath: string | null): string {
	if (!projectPath) return `@${path}`;
	const root = projectPath.replace(/[\\/]+$/, "");
	const inside = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
	return `@${inside ? path.slice(root.length + 1) : path}`;
}

/**
 * Route absolute paths: attachable images → chips, the rest → mentions at the caret. With `projectPath` null the
 * mentions stay absolute, for a draft whose project can still change (Home).
 */
export function attachPaths(tabId: string, projectPath: string | null, paths: readonly string[]): void {
	const store = useComposerDrafts.getState();
	const images = paths.filter(path => ATTACHABLE_IMAGE.test(path));
	const others = paths.filter(path => !ATTACHABLE_IMAGE.test(path));
	if (images.length > 0) store.addAttachments(tabId, images.map(path => ({ path, name: baseName(path) })));
	if (others.length > 0) store.insert(tabId, `${others.map(path => mentionFor(path, projectPath)).join(" ")} `);
	else store.focus(tabId);
}

/**
 * Attach dropped or pasted `File`s. Files from disk carry a path; clipboard bitmaps (screenshots)
 * don't, so supported images are saved to a temp file first. Resolves the number of files taken.
 */
export async function attachFiles(tabId: string, projectPath: string | null, files: readonly File[]): Promise<number> {
	const paths: string[] = [];
	for (const file of files) {
		const path = window.vomp.pathForFile(file);
		if (path) {
			paths.push(path);
			continue;
		}
		const extension = MIME_EXTENSIONS[file.type];
		if (!extension) continue;
		const bytes = new Uint8Array(await file.arrayBuffer());
		paths.push(await window.vomp.invoke("composer:saveTemp", bytes, extension));
	}
	if (paths.length > 0) attachPaths(tabId, projectPath, paths);
	return paths.length;
}

const thumbnails = new Map<string, Promise<string | null>>();

/** Cached small preview of an image file (data URL), null while loading or when unreadable. */
export function useThumbnail(path: string): string | null {
	const [url, setUrl] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		let pending = thumbnails.get(path);
		if (!pending) {
			pending = window.vomp.invoke("composer:thumbnail", path).catch(() => null);
			thumbnails.set(path, pending);
		}
		void pending.then(value => {
			if (!cancelled) setUrl(value);
		});
		return () => {
			cancelled = true;
		};
	}, [path]);
	return url;
}
