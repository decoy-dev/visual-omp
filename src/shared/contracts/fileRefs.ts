/**
 * File and folder names in omp's replies (DESIGN §4.6): main checks which of them exist so the
 * transcript can link only those.
 */

export interface FileRefRequest {
	/** References in message order, as the reply wrote them: absolute, `~/`, or relative. */
	refs: string[];
	/** Folders a relative reference is tried in after the folders named earlier in the message: absolute, `~` or `~/`. */
	bases: string[];
}

export interface FileRef {
	/** Absolute path with symlinks resolved. */
	path: string;
	kind: "file" | "folder";
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Where each reference points, aligned with `refs` (up to 100 refs and 8 bases per request); null when it names
		 * no regular file or folder. Main resolves symlinks, stats and bounded directory listings, without reading
		 * content. An absolute or `~/` reference resolves directly. A relative one is tried in the folders that earlier
		 * references resolved to (latest first, up to 4), then in `bases` order. Exact names take precedence. Otherwise
		 * U+2026 in the last component matches visible parts in order, anchored at both ends. Only one match in the
		 * first eligible folder with matches resolves; hidden entries and symlinks are excluded from pattern matching.
		 */
		"fs:resolveRefs": { args: [request: FileRefRequest]; result: (FileRef | null)[] };
	}
}
