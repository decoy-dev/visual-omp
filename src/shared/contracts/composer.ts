/**
 * Composer helpers: files for attachments (pick, save pasted images, thumbnails) and the custom
 * slash commands omp would load for a project.
 *
 * Images reach omp the way a terminal delivers them: a bracketed paste made only of absolute image
 * paths makes omp's editor attach those files (png/jpg/gif/webp). The renderer requests
 * `composer:paste`, which uses the serialized host paste operation before submitting the message.
 * Clipboard images are first saved to disk here.
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

/** Where omp got a slash command (omp's `get_available_commands` source names). */
export type SlashCommandSource = "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";

/** One slash command omp accepts in a project, for the composer's slash menu. */
export interface SlashCommandInfo {
	/** Invocation name without the slash, e.g. "mcp", "skill:pdf", "review". */
	name: string;
	aliases: string[];
	description: string | null;
	/** Argument hint omp shows after the name, e.g. "[prompt]". */
	hint: string | null;
	subcommands: { name: string; description: string | null; usage: string | null }[];
	source: SlashCommandSource;
}

export interface SlashCommandListing {
	commands: SlashCommandInfo[];
	/**
	 * omp answered. False when it couldn't be asked: `commands` then holds only the builtins, without
	 * the project's skills, custom, extension, MCP prompt and file commands.
	 */
	complete: boolean;
}


/** Draft-only microphone capture. Text never submits itself to a chat. */
export interface DictationUpdate {
	captureId: string;
	state: "starting" | "recording" | "transcribing" | "ended";
	text: string;
	error?: string;
}

/** Exact editor access is carried by the trusted extension, never reconstructed from screen rows. */
export interface EditorDraftRequest {
	operation: "peek" | "take";
	sessionId: string;
	expected?: string;
}
export interface EditorDraftResult {
	text: string | null;
	cleared: boolean;
	error?: string;
}
export interface PredictionTakeRequest {
	hostId: string;
	generation: number;
	tabId: string;
	nativeDraft: string;
	expectedGhost: string;
}
/** Main retains an exact capture until a renderer explicitly inserts or dismisses it. */
export interface PredictionCapture {
	id: string;
	hostId: string;
	generation: number;
	tabId: string;
	folder: string;
	text: string | null;
	blocked: boolean;
	error: string | null;
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
		"composer:voiceStart": { args: [cwd: string, captureId: string]; result: void };
		"composer:voiceStop": { args: [captureId: string]; result: void };
		/** Mounted composers share a folder's child; releasing the last owner closes it. */
		"composer:retainPredictions": { args: [cwd: string, owner: string]; result: void };
		"composer:releasePredictions": { args: [cwd: string, owner: string]; result: void };
		/** Ask the hosted TUI's effective SDK discovery whether this invocation runs a side question. */
		"composer:isSideCommand": { args: [hostId: string, name: string]; result: boolean };
		/** Local word completion, respecting omp's spelling.autocomplete setting. No provider request. */
		"composer:predictWord": { args: [cwd: string, text: string, cursor: number]; result: string | null };
		"composer:predictFeedback": { args: [cwd: string, text: string, cursor: number, suggestion: string, accepted: boolean]; result: void };
		"composer:tuiPrediction": { args: [hostId: string]; result: string | null };
		"composer:takePrediction": { args: [request: PredictionTakeRequest]; result: PredictionCapture | null };
		"composer:predictionCaptures": { args: []; result: PredictionCapture[] };
		"composer:retryPrediction": { args: [id: string]; result: PredictionCapture | null };
		"composer:ackPrediction": { args: [id: string]; result: void };
		/**
		 * Every slash command omp accepts in `cwd`: omp's `get_available_commands` over a short-lived RPC
		 * process, plus the builtins that exist only in omp's terminal UI. When omp can't be asked, the
		 * builtins with `complete: false`. omp's answer is kept per folder until skills, plugins, MCP
		 * servers, providers or config change; `fresh` asks omp again (after a typed `/mcp` or `/skills`).
		 */
		"composer:slashCommands": { args: [cwd: string, fresh?: boolean]; result: SlashCommandListing };
	}
	interface IpcEventMap {
		"composer:dictation": DictationUpdate;
		"composer:predictionCaptures": PredictionCapture[];
	}
}
