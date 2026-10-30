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

import type { TspHostSnapshot, TspRendererEvent } from "./tsp-host";

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
	/** Windows would not start the omp executable (a security policy is one possible cause); `problem` quotes what Windows reported. */
	refused: boolean;
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
	/** omp's predecessor id, present only for a continuation rather than a deliberate fork. */
	continuationOf?: string | null;
	/** Superseded copies folded into this conversation. */
	previousSessionFiles?: string[];
	previousSessionIds?: string[];
	/** Stored by omp in session-pins.json. */
	pinned?: boolean;
	/** First user message text, trimmed, for previews. */
	preview: string | null;
	/** Hidden from the main list; shown under "Archived". */
	archived: boolean;
}

/** Submitted text from omp's per-session prompt history, in chronological order. */
export interface PromptHistoryItem {
	text: string;
	timestamp: number;
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

export interface ProgramStatus {
	state: "idle" | "working" | "blocked" | "done" | "error";
	kind?: "permission" | "question";
	msg?: string;
}

export interface HostNotice {
	id: string;
	kind: "startup" | "recap";
	text: string;
	timestamp: number;
}

export interface HostState {
	hostId: string;
	cwd: string;
	phase: HostPhase;
	/** Launch-only developer transport. Absent for classic hosts and terminal-follow views. */
	transport?: "classic" | "tsp";
	/** Semantic startup failed; the existing chat restart action remains available. */
	tspFailed?: boolean;
	tspAvailability?: { available: boolean; reason: string | null };
	/** Collab control link for the renderer guest client; null until resolved. */
	link: string | null;
	/** Increments every time omp opens a new collab room (restart, new, resume, branch). */
	generation: number;
	sessionId: string | null;
	sessionFile: string | null;
	pid: number | null;
	exitCode: number | null;
	/** Bounded startup diagnostic, before omp connected or accepted input; never a live terminal dump. */
	exitReason?: string | null;
	/** A startup diagnostic reported that the requested resume file does not exist. */
	resumeFileMissing?: boolean;
	/** A nonzero exit without this launch's durable session_exit marker. */
	restoreAvailable?: boolean;
	/** omp's OSC 7501 root record; null when disabled or cleared. */
	programStatus?: ProgramStatus | null;
	/** Startup warnings and journaled idle recaps, outside model context. */
	notices?: readonly HostNotice[];
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
	/** Continue interrupted work using omp --restore rather than an ordinary resume. */
	restore?: boolean;
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

/** Colors a project's folder can take in the sidebar, the macOS Finder tag set (DESIGN §3.2, `--folder-*` tokens). */
export const PROJECT_COLORS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export interface SidebarSort {
	by: "recent" | "name" | "created";
	groupByProject: boolean;
}

export const DEFAULT_SIDEBAR_SORT: SidebarSort = { by: "recent", groupByProject: true };

export interface AppPreferences {
	theme: ThemePreference;
	/** Percent, 90–130. */
	textScale: number;
	reducedMotion: "system" | "on" | "off";
	transcriptMode: "normal" | "thinking" | "verbose";
	/** Normal view shows the thought omp is writing open while it streams, then folds it once omp moves on. */
	liveThinking: boolean;
	/** Explicit omp executable path; null = auto-detect. */
	ompPath: string | null;
	/** Native first-run setup is complete; profiles created before setup count as complete. */
	setupCompleted: boolean;
	tourCompleted: boolean;
	pinnedProjects: string[];
	/** Projects section ordering; Current chats retains its own open order. */
	sidebarSort: SidebarSort;
	archivedSessions: string[];
	/** Extra project folders the user opened that have no sessions yet. */
	extraProjects: string[];
	/** Folder color per project path; a project without an entry keeps the plain folder. */
	projectColors: Record<string, ProjectColor>;
	notifications: boolean;
	/** Enable omp's speech-to-text in each chat's hidden omp (per-process overlay, never the global config). */
	voiceInput: boolean;
}

/** Unopened chat results, including other chats in a focused window (DESIGN §4.22). */
export interface AttentionState {
	/** Unseen chats. 0 clears the Dock badge, the taskbar overlay and the taskbar flashing. */
	count: number;
	/** A chat became unseen in the background: request a bounce or flash, subject to the alerts preference. */
	alert: boolean;
	/** Windows taskbar overlay: a PNG data URL and its accessible description. Null removes it. */
	overlay: { image: string; description: string } | null;
}

/** Longest strings `app:notify` accepts (main rejects longer ones; the renderer shortens titles and bodies to fit). */
export const NOTIFY_LIMITS = { title: 256, body: 1024, chatId: 128 } as const;

export interface IpcInvokeMap {
	"app:info": { args: []; result: { version: string; platform: Platform; arch: string; homeDir: string; defaultChatFolder: string } };
	"app:prefs:get": { args: []; result: AppPreferences };
	"app:prefs:set": { args: [patch: Partial<AppPreferences>]; result: AppPreferences };
	"app:openExternal": { args: [url: string]; result: void };
	"app:showItem": { args: [path: string]; result: void };
	/** Open a local regular file, confirming non-previewable files before invoking its associated application. */
	"app:openFile": { args: [path: string]; result: void };
	/** Renderer-rasterized PNG data only; no network requests are made by main. */
	"app:copyImage": { args: [dataUrl: string]; result: void };
	"app:saveImage": { args: [options: { dataUrl: string; name: string; title: string }]; result: string | null };
	"app:pickFolder": { args: [title?: string]; result: string | null };
	/** Native notification for the chat `chatId` (a tab id); clicking it focuses the window and sends `app:openChat`. */
	"app:notify": { args: [title: string, body: string, chatId?: string]; result: void };
	"app:attention": { args: [state: AttentionState]; result: void };
	"app:confirmQuit": { args: [allow: boolean]; result: void };

	"omp:status": { args: [refresh?: boolean]; result: OmpStatus };
	"omp:cli": { args: [argv: string[], cwd?: string]; result: CliResult };

	"sessions:projects": { args: []; result: ProjectSummary[] };
	"sessions:list": { args: [cwd: string]; result: SessionSummary[] };
	/** The newest `limit` saved chats across every project, archived ones left out (one walk of the sessions folder). */
	"sessions:recent": { args: [limit: number]; result: SessionSummary[] };
	"sessions:read": { args: [file: string]; result: string };
	/** Newest linked copy that contains this file's newest conversation turn. */
	"sessions:resolve": { args: [file: string]; result: string };
	"sessions:summary": { args: [file: string]; result: SessionSummary | null };
	"sessions:pin": { args: [file: string]; result: boolean };
	"sessions:rename": { args: [file: string, title: string]; result: { title: string; file: string; id: string; movedFrom: string | null } };
	/** Copy a session through an isolated RPC process without switching its live host. */
	"sessions:fork": { args: [file: string, folder: string, entryId?: string]; result: { file: string; id: string } };
	/** Up to 100 prompts from omp's history database, strictly scoped by session UUID. */
	"sessions:promptHistory": { args: [sessionId: string]; result: PromptHistoryItem[] };
	/** Session file for a session id (new sessions get their file after the first message). */
	"sessions:find": { args: [sessionId: string]; result: string | null };
	/** Move all retained continuation files and artifacts individually to the recoverable system Trash. */
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
	/** Application paste through the host's closing-aware input queue, without submitting. */
	"host:paste": { args: [hostId: string, text: string]; result: void };
	/** Type `text` into the TUI and submit it. `followUp` queues it until omp yields instead of steering. */
	"host:submit": { args: [hostId: string, text: string, mode?: "steer" | "followUp"]; result: void };
	/** Classic named keys, or semantic raw bytes guarded by collab generation and protocol epoch. */
	"host:keys": { args: [hostId: string, keys: string, generation?: number, epoch?: number]; result: void };
	/** Painted TUI screen lines (plain text). */
	"host:screen": { args: [hostId: string]; result: string[] };
	"host:resize": { args: [hostId: string, cols: number, rows: number]; result: void };
	/** Serialized terminal state for attaching an xterm view mid-session. */
	"host:buffer": { args: [hostId: string]; result: string };
	/** Complete semantic documents for an opt-in TSP host; null for classic hosts. */
	"host:tsp-snapshot": { args: [hostId: string]; result: TspHostSnapshot | null };
	/** Renderer input shares the application input lock and rejects a stale collab generation. */
	"host:tsp-event": { args: [hostId: string, generation: number, event: TspRendererEvent, epoch: number]; result: void };
	/** Semantic sheet width in mono columns. This does not depend on terminal-sheet rows. */
	"host:tsp-resize": { args: [hostId: string, cols: number]; result: void };
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
	"host:tsp-update": TspHostSnapshot;
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
	/** A notification for this chat (a tab id) was clicked; main already focused the window. */
	"app:openChat": { chatId: string };
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
