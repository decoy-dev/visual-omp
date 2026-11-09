/**
 * Right-dock pane services: file metadata and bounded text prefixes for viewers, scoped image-blob grants,
 * native thumbnails, files made by commands and plan-file lookup. Bounded payload readers remain for
 * model attachment transfer, live text recovery and Office conversion snapshots.
 */

import type { PreviewGrant } from "./preview";

/** Bounded payloads for attachment transfer and live text recovery. Local media viewers use PaneFilePreview. */
export type PaneFileContent =
	| { kind: "text"; text: string; size: number }
	/** `dataUrl` is a `data:<mime>;base64,…` URL, safe for `<img src>` under the app CSP. */
	| { kind: "image"; dataUrl: string; size: number }
	| { kind: "binary"; size: number }
	| { kind: "tooLarge"; size: number; limit: number };

/** A bounded text prefix or media metadata. Media bytes travel only through a scoped protocol grant. */
export type PaneFilePreview =
	| { kind: "text"; text: string; size: number; truncated: boolean }
	| { kind: "media"; media: "image" | "pdf" | "video" | "audio"; size: number }
	| { kind: "binary"; size: number };

export interface PanePlanFile {
	/** Absolute path of the plan markdown file. */
	path: string;
	text: string;
	/** Epoch ms. */
	mtime: number;
}

/** One finished tool call to check for files it made: the paths it named and when it ran (epoch ms). */
export interface PaneMadeQuery {
	paths: string[];
	start: number;
	end: number;
}

export interface PaneMadeFile {
	/** The path as the command named it (or that folder joined with the file's place in it). */
	path: string;
	/** Epoch ms. */
	mtime: number;
	size: number;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Bounded payload reader for model attachment transfer and live text recovery; viewers use inspect and grants. */
		"panes:readFile": { args: [path: string]; result: PaneFileContent };
		/** Inspect a regular file, returning media metadata or at most the first 2 MiB of text. */
		"panes:inspect": { args: [path: string]; result: PaneFilePreview };
		/** A file-only read grant for an omp raster-image blob; null when missing or invalid. */
		"panes:readBlob": { args: [hash: string]; result: PreviewGrant | null };
		/** Bounded Office-conversion snapshot reader. Local PDF viewers use protocol grants. */
		"panes:readPdf": { args: [path: string]; result: Uint8Array<ArrayBuffer> };
		/**
		 * The operating system's thumbnail of an image or a PDF's first page as a PNG data URL (at most 480px), when the
		 * OS provides one. Only regular files with raster-image or PDF signatures qualify; null when refused or unavailable.
		 */
		"panes:thumbnail": { args: [path: string]; result: string | null };
		/**
		 * Files each tool call may have made, aligned with `queries` (up to 128 per request). Best effort: main checks the
		 * named paths and scans named folders two levels deep for PDFs and raster images modified while the call ran,
		 * with hard limits. It can include unrelated changes made at the same time (copied assets look the same as
		 * deliverables) and misses files a command never names or that lie beyond the limits.
		 */
		"panes:scanMade": { args: [queries: PaneMadeQuery[]]; result: PaneMadeFile[][] };
		/**
		 * The newest `*plan*.md` in `<sessionFile minus .jsonl>/local/` (where omp keeps the plan
		 * for plan mode); null when there is none.
		 */
		"panes:planFile": { args: [sessionFile: string]; result: PanePlanFile | null };
	}
}
