/**
 * File and folder names in omp's replies (DESIGN §4.6): main checks which of them exist so the
 * transcript can link only those.
 */

export interface FileRefRequest {
	/** References in message order, as the reply wrote them: absolute, `~/`, or relative. */
	refs: string[];
	/** Folders for relative references, beginning with the chat folder. */
	bases: string[];
	/** Bounded folders derived from earlier absolute tool paths; checked after reply folders, chat bases and Outputs. */
	toolBases?: string[];
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
		 * Where each reference points, aligned with `refs` (up to 100 refs, eight total folder bases and 100 known files).
		 * Main resolves symlinks and stats without reading content. Relative exact names check reply directories, chat
		 * bases and matching turn Outputs first, then try bounded tool bases from earlier calls. Absolute and home-relative
		 * references resolve directly. Abbreviations retain their bounded, nonrecursive first-eligible-folder lookup,
		 * excluding hidden entries and symlinks.
		 */
		"fs:resolveRefs": { args: [request: FileRefRequest]; result: (FileRef | null)[] };
	}
}
