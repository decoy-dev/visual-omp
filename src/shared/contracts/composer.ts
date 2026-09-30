/**
 * Composer helpers: files for attachments (pick, save pasted images, thumbnails) and the custom
 * slash commands omp would load for a project.
 *
 * Images reach omp the way a terminal delivers them: a bracketed paste made only of absolute image
 * paths makes omp's editor attach those files (png/jpg/gif/webp). The renderer writes that paste
 * through `host:write` right before the message, so clipboard images are first saved to disk here.
 */

/** A markdown slash command omp loads (`/name args`). */
export interface CustomCommand {
	/** Invocation name without the slash; subfolders of `.claude/commands` become `dir:name`. */
	name: string;
	/** Frontmatter `description`, else the first non-empty body line (≤ 60 chars). */
	description: string;
	/** Frontmatter `argument-hint`, e.g. "<issue number>". */
	argumentHint: string | null;
	/** Where omp found it. */
	scope: "project" | "user";
	filePath: string;
}

/** Text in the hidden omp TUI's prompt editor (where omp's own dictation writes). */
export interface TuiEditorText {
	text: string;
	/** omp's count of characters; `text` may be shorter when it couldn't be read in full. */
	length: number;
	/** `text` is exactly the editor content. */
	complete: boolean;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Save pasted bytes (a clipboard image) to a private temp file; resolves its absolute path. */
		"composer:saveTemp": { args: [bytes: Uint8Array, extension: string]; result: string };
		/** Native multi-file picker starting in `cwd`; resolves the chosen absolute paths (empty when cancelled). */
		"composer:pickFiles": { args: [cwd: string]; result: string[] };
		/** Small PNG data URL preview of an image file; null when it can't be decoded. */
		"composer:thumbnail": { args: [path: string]; result: string | null };
		/**
		 * Markdown slash commands for `cwd`: `.omp/commands/*.md` (project), `<agentDir>/commands/*.md`
		 * (user) and `.claude/commands/**` (project). A project command shadows a user one of the same name.
		 */
		"composer:commands": { args: [cwd: string]; result: CustomCommand[] };
		/**
		 * Bracketed paste an image path list into the hidden omp editor, without Enter.
		 * Paths must be absolute and omp-supported image paths; follow with host:submit.
		 */
		"composer:paste": { args: [hostId: string, text: string]; result: void };
		/**
		 * Voice input drives omp's own dictation (`app.stt.toggle`, unbound by default). Binds a free
		 * function key in `<agentDir>/keybindings.yml` when none is bound (comments kept) and resolves the
		 * key token to press with `host:keys` (e.g. "f9"). omp reads keybindings at startup: when
		 * `changed`, running chats must restart before the key works.
		 */
		"composer:voiceKey": { args: []; result: { key: string; changed: boolean } };
		/** Read the prompt editor of a chat's hidden TUI (debug-socket state; painted screen for long text). */
		"composer:tuiEditorText": { args: [hostId: string]; result: TuiEditorText | null };
	}
}
