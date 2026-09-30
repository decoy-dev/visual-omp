/**
 * Right-dock pane services: file viewer reads (text / image / binary detection with a size cap) and
 * the chat's plan file lookup.
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

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Read a file for the viewer: text up to 2 MB, images up to 8 MB as a data URL. */
		"panes:readFile": { args: [path: string]; result: PaneFileContent };
		/**
		 * The newest `*plan*.md` in `<sessionFile minus .jsonl>/local/` (where omp keeps the plan
		 * for plan mode); null when there is none.
		 */
		"panes:planFile": { args: [sessionFile: string]; result: PanePlanFile | null };
	}
}
