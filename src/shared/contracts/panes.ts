/**
 * Right-dock pane services: file viewer reads (text / image / binary detection with a size cap),
 * Outputs pane reads (images, PDFs, thumbnails, files made by commands) and opening, and the chat's
 * plan file lookup.
 */

/** What the Files viewer can show for a path. */
export type PaneFileContent =
	| { kind: "text"; text: string; size: number }
	/** `dataUrl` is a `data:<mime>;base64,…` URL, safe for `<img src>` under the app CSP. */
	| { kind: "image"; dataUrl: string; size: number }
	| { kind: "binary"; size: number }
	| { kind: "tooLarge"; size: number; limit: number };

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
		/** Read a file for the viewer: text up to 2 MB, images up to 8 MB as a data URL. */
		"panes:readFile": { args: [path: string]; result: PaneFileContent };
		/**
		 * An image from omp's blob store (`blob:sha256:<hash>` in saved sessions) as a data URL, up to
		 * 8 MB. Null when the blob is missing, too large or not an image; non-hash ids are rejected.
		 */
		"panes:readBlob": { args: [hash: string]; result: string | null };
		/** A PDF's bytes for the in-pane viewer, read through one handle: a regular file up to 64 MB starting with `%PDF-`. */
		"panes:readPdf": { args: [path: string]; result: Uint8Array<ArrayBuffer> };
		/**
		 * The operating system's thumbnail of an image or a PDF's first page as a PNG data URL (at most 480px), when the
		 * OS provides one. Validated like `panes:openOutput`; null when the file is refused or the OS makes none.
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
		 * Open an image or PDF in the system's default app. Main resolves symlinks and requires a regular file whose
		 * leading bytes match its extension: a raster extension (PNG, JPEG, GIF, WebP, AVIF, BMP, ICO) with the leading
		 * bytes of any of those formats, or `.pdf` with `%PDF-`. SVG is never opened.
		 */
		"panes:openOutput": { args: [path: string]; result: void };
		/**
		 * The newest `*plan*.md` in `<sessionFile minus .jsonl>/local/` (where omp keeps the plan
		 * for plan mode); null when there is none.
		 */
		"panes:planFile": { args: [sessionFile: string]; result: PanePlanFile | null };
	}
}
