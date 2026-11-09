/**
 * File and folder names in omp's replies (DESIGN §4.6): main checks which of them exist so the
 * transcript can link only those.
 */

export interface FileRefRequest {
	/** References in message order, as the reply wrote them: absolute, `~/`, or relative. */
	refs: string[];
	/** Folders a relative reference is tried in alongside folders named in the message: absolute, `~` or `~/`. */
	bases: string[];
	/** Existing Outputs candidates from this reply's turn, bounded to 100 absolute or home-relative paths. */
	files?: string[];
}

export interface FileRef {
	/** Absolute path with symlinks resolved. */
	path: string;
	kind: "file" | "folder";
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Where each reference points, aligned with `refs` (up to 100 refs, 8 bases and 100 known files per request).
		 * Main resolves symlinks and stats without reading content. Relative exact names resolve only when all
		 * eligible named folders, bases and matching turn Outputs identify one canonical file or folder.
		 * A reply's directory references are checked first, including directories named after the file.
		 * Absolute and home-relative references resolve directly. Abbreviations retain their bounded,
		 * nonrecursive first-eligible-folder lookup, excluding hidden entries and symlinks.
		 */
		"fs:resolveRefs": { args: [request: FileRefRequest]; result: (FileRef | null)[] };
	}
}
