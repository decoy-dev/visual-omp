/**
 * Live previews of visual outputs (docs/LIVE-PREVIEW.md): the `vomp-preview:` protocol's grants, the in-memory documents
 * of files omp is still writing, and the preview watcher that reports visual files changing on disk while a turn runs.
 */

/** The custom scheme preview documents and assets load from. Registered as standard and secure, so its host is lowercased. */
export const PREVIEW_SCHEME = "vomp-preview";

export interface PreviewGrantRequest {
	/** Absolute path of the file being previewed. It may not exist yet while omp is still writing it. */
	path: string;
	/** The chat's folder. It becomes the asset root when the subject is inside it and the folder is not broad. */
	root: string | null;
	/**
	 * Absolute paths omp's tool calls in the same turn wrote or named. They are granted individually when no asset root
	 * applies (the subject's folders are broad), and never widen a grant that has an asset root.
	 */
	related: string[];
	/** Grant only this file, without a folder or related assets (saved media and attachments). */
	fileOnly?: boolean;
}

export interface PreviewGrant {
	/** Lowercase hex; the URL host. */
	token: string;
	/** The subject's document address, `vomp-preview://<token>/<path from the asset root>`, without a query. */
	url: string;
	/** False when only the subject and `related` files load because every candidate root is broad. */
	assetRoot: boolean;
}

/** What a preview document may do; main enforces it, the renderer mirrors it. */
export interface PreviewPolicy { scripts: boolean; network: boolean }

/** Whether main prepared the exact document bytes served for this revision under the grant's read limits. */
export type PreviewPrepared = { ok: true; policy: PreviewPolicy; /** Immutable live-PDF revision, owned by the subject's grant. */ pdf?: PreviewGrant; /** App-injected script-free change target. */ anchor?: string; /** Main-only test gate, never a page permission. */ isolationTest?: true } | { ok: false; reason: "missing" | "tooLarge" | "notFile" | "revoked" };

export type PreviewBinary =
	| { ok: true; bytes: Uint8Array<ArrayBuffer>; size: number; mtimeMs: number }
	| { ok: false; reason: "missing" | "tooLarge" | "notFile" | "revoked" | "incomplete" | "unsafe" };

export type PreviewSlides =
	| { ok: true; pdfPath: string; revision: number }
	| { ok: false; reason: "noLibreOffice" | "unsafe" | "timeout" | "failed" | "tooLarge" | "revoked" | "converterUnavailable" };

export interface PreviewOfficeTools { libreOffice: boolean }

/** A numbered frame output declared by a recognized render command. Matches files directly inside `folder`. */
export interface PreviewSequencePattern {
	folder: string;
	prefix: string;
	/** Exact number of digits, or any positive number of digits when null. */
	digits: number | null;
	suffix: string;
}

export interface PreviewWatchRequest {
	/** The chat's folder. Watched recursively unless it is broad (root, its direct children, home or temporary folders). */
	folder: string;
	/** Absolute files and folders running calls named. Broad folders among them are never watched recursively. */
	named: string[];
	/** Declared frame outputs. Main coalesces only these patterns and watches their folders without recursion. */
	sequences: PreviewSequencePattern[];
	/** Recognized video outputs of currently running render calls; these alone may poll without an idle bound. */
	rendering?: string[];
}

/** A visual file that changed on disk and then stayed unchanged long enough to read. */
export interface PreviewChange {
	watchId: string;
	/** Absolute path as the watcher saw it. */
	path: string;
	size: number;
	mtimeMs: number;
	/** The declared pattern and matching regular files currently present in its folder. */
	sequence?: { pattern: PreviewSequencePattern; count: number };
}

/** A navigation a preview page started, which main cancelled. */
export interface PreviewBlockedNavigation {
	token: string;
	url: string;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Create a token for one preview subject. */
		"preview:grant": { args: [request: PreviewGrantRequest]; result: PreviewGrant };
		/** Serve `text` as the subject's document until `preview:saved`. Older revisions are ignored. */
		"preview:live": { args: [token: string, revision: number, text: string]; result: void };
		/** Serve the subject's document from disk from now on. */
		"preview:saved": { args: [token: string]; result: void };
		/** Snapshot HTML or check a PDF's header; live PDFs also require a completed EOF marker. */
		"preview:prepare": { args: [token: string, revision: number, completePdf?: boolean]; result: PreviewPrepared };
		/** Read only an Office subject's validated ZIP snapshot, under its original grant. */
		"preview:readBinary": { args: [token: string]; result: PreviewBinary };
		"preview:officeTools": { args: []; result: PreviewOfficeTools };
		/** Convert the validated PPTX snapshot, with one newest-wins conversion queue. */
		"preview:slides": { args: [token: string, revision: number]; result: PreviewSlides };
		/** Revoke a token; later requests for it fail. Unknown tokens are ignored. */
		"preview:revoke": { args: [token: string]; result: void };
		/** Start watching for a turn; returns the watch id `preview:changed` events carry. */
		"preview:watch": { args: [request: PreviewWatchRequest]; result: string };
		/** Replace the named paths and declared frame outputs of a running watch. */
		"preview:watchNamed": { args: [watchId: string, named: string[], sequences: PreviewSequencePattern[], rendering?: string[]]; result: void };
		/** Stop a watch after one final debounced read. Unknown ids are ignored. */
		"preview:unwatch": { args: [watchId: string]; result: void };
	}
	interface IpcEventMap {
		"preview:changed": PreviewChange;
		"preview:blockedNavigation": PreviewBlockedNavigation;
	}
}
