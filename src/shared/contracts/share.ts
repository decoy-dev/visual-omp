/**
 * Sharing saved sessions (encrypted link via `omp share`, standalone HTML via `omp --export`)
 * and importing Claude Code / Codex sessions.
 */

export interface ShareLinkOptions {
	/** Upload to a secret GitHub gist (needs `gh` auth / GITHUB_TOKEN) instead of the share server. */
	gist?: boolean;
}

export interface ShareLinkResult {
	/** Encrypted share link; the decryption key lives in the URL fragment. */
	url: string;
	/** Gist page when `gist` was used. */
	gistUrl: string | null;
	/** omp trimmed large content to fit the share size limit. */
	truncated: boolean;
}

export type ImportSourceId = "claude" | "codex";

/**
 * A foreign agent whose sessions omp can import.
 *
 * omp has no non-interactive import: `--from-claude` / `--from-codex` are launch flags that open
 * omp's own session picker in the TUI, then persist the chosen transcript as a new omp session
 * and continue it — switching to the imported session's project directory on its own. To import,
 * start a SessionHost with `extraArgs: launchArgs` (any `cwd`; it is only the fallback when the
 * original project folder no longer exists) and show the terminal sheet for the picker. The new
 * session file then appears in `HostState.sessionFile` and in `sessions:projects`. The flags
 * cannot be combined with `resumeFile`.
 */
export interface ImportSource {
	id: ImportSourceId;
	/** Product name for display ("Claude Code", "Codex"). */
	label: string;
	/** Data directory omp reads (`$CLAUDE_CONFIG_DIR` or `~/.claude`; `~/.codex`). */
	dataDir: string;
	/** At least one transcript file was found. */
	available: boolean;
	/** Transcript files found (omp's picker may merge or skip a few, e.g. Codex threads without a cwd). */
	sessionCount: number;
	/** Epoch ms of the newest transcript; null when none. */
	lastModified: number | null;
	/** omp launch flags for `HostStartOptions.extraArgs`. */
	launchArgs: string[];
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Upload a saved session (`.jsonl` path) as an encrypted link, honouring the user's
		 * `share.serverUrl`, `share.store` and `share.redactSecrets` settings. Rejects with omp's error.
		 */
		"share:link": { args: [sessionFile: string, options?: ShareLinkOptions]; result: ShareLinkResult };
		/**
		 * Export a saved session (including its subagent sessions) to a self-contained HTML file.
		 * Without `outputPath` a Save dialog asks where; resolves null when the user cancels.
		 * Resolves the written file path.
		 */
		"share:exportHtml": { args: [sessionFile: string, outputPath?: string]; result: string | null };
		/** Claude Code / Codex session stores and the launch flags that import from them. */
		"share:importSources": { args: []; result: ImportSource[] };
	}
}
