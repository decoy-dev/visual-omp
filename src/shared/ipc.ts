/**
 * The single IPC contract between Electron main and the renderer.
 *
 * `IpcInvokeMap` lists request/response channels (`ipcRenderer.invoke` → `ipcMain.handle`).
 * `IpcEventMap` lists push channels (main → renderer). Channel names are `<area>:<action>`.
 *
 * Feature areas extend the maps by declaration merging from `src/shared/contracts/<area>.ts`
 * (`declare module "../ipc" { interface IpcInvokeMap { "git:status": {...} } }`) and register the
 * handlers in `src/main/features/<area>.ts`, which exports `register(): void` and is discovered
 * automatically by `src/main/handlers.ts`. Core app/omp/session/host channels live here.
 */

export type Platform = "darwin" | "win32" | "linux";

export interface OmpStatus {
	found: boolean;
	/** Absolute path of the omp executable that will be used. */
	path: string | null;
	version: string | null;
	supported: boolean;
	minVersion: string;
	/** Human-readable reason when `found` or `supported` is false. */
	problem: string | null;
	/** Official install command for this platform. */
	installCommand: string;
}

export interface ProjectSummary {
	/** Absolute project directory (the session `cwd`). */
	path: string;
	name: string;
	sessionCount: number;
	/** Epoch ms of the newest session activity. */
	lastActivity: number;
	exists: boolean;
}

export interface SessionSummary {
	id: string;
	/** Absolute path of the session `.jsonl` file. */
	file: string;
	cwd: string;
	title: string | null;
	/** Epoch ms. */
	createdAt: number;
	/** Epoch ms (file mtime). */
	updatedAt: number;
	parentSession: string | null;
	/** First user message text, trimmed, for previews. */
	preview: string | null;
	/** Hidden from the main list; shown under "Archived". */
	archived: boolean;
}

/**
 * Whether an omp process outside this app has a saved session open (src/main/omp/elsewhere.ts).
 * `unknown`: an observation failed or cannot be made for this file. `unsupported`: no detection
 * on this platform (Windows). Neither ever means the file is free to write.
 */
export type SessionOwnership = "elsewhere" | "free" | "unknown" | "unsupported";

/** Health and ownership of a session file the app follows for a read-only tab. */
export interface FollowState {
	file: string;
	/** The last read succeeded. False keeps the last good transcript but stops live updates. */
	readable: boolean;
	/** Why the last read failed (an errno code or message). */
	error: string | null;
	/** `free` only after two checks in a row found no other writer. */
	ownership: SessionOwnership;
}

/** Live TUI focus snapshot from omp's `OMP_TUI_DEBUG` socket. */
export interface TuiFocus {
	/** Open overlays (full-screen menus, Plan Review, pickers). */
	overlays: number;
	/** Component kind that holds keyboard focus (the main editor when idle). */
	focused: string | null;
	altScreen: boolean;
	/** Component kinds at the root of each open overlay. */
	overlayKinds: string[];
}

export type HostPhase = "starting" | "connecting" | "live" | "restarting" | "exited";

export interface HostState {
	hostId: string;
	cwd: string;
	phase: HostPhase;
	/** Collab control link for the renderer guest client; null until resolved. */
	link: string | null;
	/** Increments every time omp opens a new collab room (restart, new, resume, branch). */
	generation: number;
	sessionId: string | null;
	sessionFile: string | null;
	pid: number | null;
	exitCode: number | null;
	error: string | null;
	/** null when the TUI debug socket is unavailable. */
	tui: TuiFocus | null;
	/** Current PTY size (the terminal sheet resizes it while open and restores it after). */
	cols: number;
	rows: number;
}

export interface HostStartOptions {
	cwd: string;
	/** Resume this session file instead of starting fresh. */
	resumeFile?: string;
	/** Extra omp launch flags (e.g. ["--plan-yolo"]). */
	extraArgs?: string[];
	cols?: number;
	rows?: number;
}

export interface TerminalStartOptions {
	cwd: string;
	/** Run this command line instead of an interactive login shell. */
	command?: string;
	cols?: number;
	rows?: number;
}

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface DirEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
}

export type ThemePreference = "light" | "dark" | "system";

export interface AppPreferences {
	theme: ThemePreference;
	/** Percent, 90–130. */
	textScale: number;
	reducedMotion: "system" | "on" | "off";
	transcriptMode: "normal" | "thinking" | "verbose";
	/** Explicit omp executable path; null = auto-detect. */
	ompPath: string | null;
	tourCompleted: boolean;
	pinnedProjects: string[];
	pinnedSessions: string[];
	archivedSessions: string[];
	/** Extra project folders the user opened that have no sessions yet. */
	extraProjects: string[];
	notifications: boolean;
	/** Enable omp's speech-to-text in each chat's hidden omp (per-process overlay, never the global config). */
	voiceInput: boolean;
}

export interface IpcInvokeMap {
	"app:info": { args: []; result: { version: string; platform: Platform; arch: string; homeDir: string } };
	"app:prefs:get": { args: []; result: AppPreferences };
	"app:prefs:set": { args: [patch: Partial<AppPreferences>]; result: AppPreferences };
	"app:openExternal": { args: [url: string]; result: void };
	"app:showItem": { args: [path: string]; result: void };
	"app:pickFolder": { args: [title?: string]; result: string | null };
	"app:notify": { args: [title: string, body: string]; result: void };
	"app:confirmQuit": { args: [allow: boolean]; result: void };

	"omp:status": { args: [refresh?: boolean]; result: OmpStatus };
	"omp:cli": { args: [argv: string[], cwd?: string]; result: CliResult };

	"sessions:projects": { args: []; result: ProjectSummary[] };
	"sessions:list": { args: [cwd: string]; result: SessionSummary[] };
	"sessions:read": { args: [file: string]; result: string };
	/** Session file for a session id (new sessions get their file after the first message). */
	"sessions:find": { args: [sessionId: string]; result: string | null };
	/** Move a saved session (and its artifacts folder) to the OS trash. */
	"sessions:trash": { args: [file: string]; result: void };
	/** Whether another omp process has this session file open (it then opens read-only). Checked fresh each call. */
	"sessions:ownership": { args: [file: string]; result: SessionOwnership };
	/**
	 * Watch these session files (the read-only tabs): push what omp appends as `sessions:tail` and
	 * health/ownership changes as `sessions:followState`. Replaces the whole followed set.
	 */
	"sessions:follow": { args: [files: string[]]; result: void };

	"host:start": { args: [options: HostStartOptions]; result: HostState };
	"host:stop": { args: [hostId: string]; result: void };
	"host:write": { args: [hostId: string, data: string]; result: void };
	/** Type `text` into the TUI and submit it. `followUp` queues it until omp yields instead of steering. */
	"host:submit": { args: [hostId: string, text: string, mode?: "steer" | "followUp"]; result: void };
	/** Press a key sequence in the TUI through omp's input pipeline (e.g. "escape", "down down enter"). */
	"host:keys": { args: [hostId: string, keys: string]; result: void };
	/** Painted TUI screen lines (plain text). */
	"host:screen": { args: [hostId: string]; result: string[] };
	"host:resize": { args: [hostId: string, cols: number, rows: number]; result: void };
	/** Serialized terminal state for attaching an xterm view mid-session. */
	"host:buffer": { args: [hostId: string]; result: string };
	"host:list": { args: []; result: HostState[] };

	"term:start": { args: [options: TerminalStartOptions]; result: string };
	"term:write": { args: [termId: string, data: string]; result: void };
	"term:resize": { args: [termId: string, cols: number, rows: number]; result: void };
	"term:kill": { args: [termId: string]; result: void };

	"fs:list": { args: [dir: string]; result: DirEntry[] };
	"fs:read": { args: [file: string]; result: string };
	"fs:write": { args: [file: string, content: string]; result: void };
	"fs:exists": { args: [path: string]; result: boolean };
	"fs:files": { args: [cwd: string]; result: string[] };
}

export interface IpcEventMap {
	"host:state": HostState;
	"host:data": { hostId: string; data: string };
	"term:data": { termId: string; data: string };
	"term:exit": { termId: string; code: number };
	"sessions:changed": { cwd: string | null };
	/**
	 * New complete JSONL lines of a followed session file. `reset` means `text` is the whole file
	 * (first read, truncation or replacement); otherwise it continues the previous text.
	 */
	"sessions:tail": { file: string; text: string; reset: boolean };
	/** A followed file's health or ownership changed (first sent after main's first ownership check). */
	"sessions:followState": FollowState;
	"app:prefs": AppPreferences;
	/** Main asks the renderer whether quitting is OK (work in progress?). */
	"app:quitRequested": { reason: "quit" | "close" };
	/** Menu/accelerator actions routed to the renderer command system. */
	"app:command": { id: string };
}

export type InvokeChannel = keyof IpcInvokeMap;
export type EventChannel = keyof IpcEventMap;

export interface VompBridge {
	invoke<C extends InvokeChannel>(channel: C, ...args: IpcInvokeMap[C]["args"]): Promise<IpcInvokeMap[C]["result"]>;
	on<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void;
	/** Absolute path of a dropped/pasted File object (Electron webUtils). */
	pathForFile(file: File): string;
	platform: Platform;
}
