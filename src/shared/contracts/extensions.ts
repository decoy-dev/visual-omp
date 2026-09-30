/**
 * Extras for the extensions feature (MCP, skills, memory, usage sheets) that the per-area services
 * don't cover:
 *
 * - `extensions:spend` — per-day and per-chat cost/token totals computed directly from omp's session
 *   transcripts. `omp stats --json` only reports the last 24 hours and its database is filled only
 *   when `omp stats` runs, so the dashboard's week view, chat table and the status-bar "today" cost
 *   read the transcripts themselves (every assistant message and `model_usage` entry carries omp's
 *   own `usage.cost`). Subagent transcripts (`<session>/<Agent>.jsonl`) count toward their chat.
 * - `extensions:saveText` — "Save as…" dialog for exports (usage CSV, a memory as Markdown).
 * - `extensions:statsDashboard` — opens omp's own stats web dashboard (`omp stats`), starting it
 *   when it is not already running.
 */

/** One local calendar day. */
export interface SpendDay {
	/** Local date, `YYYY-MM-DD`. */
	date: string;
	/** Local midnight, epoch ms. */
	start: number;
	/** USD, omp's API-equivalent estimate. */
	cost: number;
	/** input + output + cache read + cache write. */
	tokens: number;
	/** Model calls. */
	requests: number;
}

/** One top-level chat (session file) with activity in the range. */
export interface SpendChat {
	/** Session id from the transcript header. */
	id: string;
	/** Absolute path of the top-level session `.jsonl`. */
	file: string;
	cwd: string;
	title: string | null;
	/** Model with the most calls in range (`provider/model`). */
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	requests: number;
	/** Sum of the model calls' own durations (ms) — time omp spent generating. */
	durationMs: number;
	/** Epoch ms of the first and last model call in range. */
	firstAt: number;
	lastAt: number;
	/** Session created (header timestamp), epoch ms. */
	createdAt: number;
}

export interface SpendSummary {
	/** Epoch ms. */
	generatedAt: number;
	/** Oldest first; always `days` entries ending with today. */
	days: SpendDay[];
	/** Most expensive first. */
	chats: SpendChat[];
	totals: { cost: number; tokens: number; requests: number; chats: number };
	/** Files that could not be read (permission errors, vanished mid-scan). */
	skippedFiles: number;
}

export interface SaveTextOptions {
	title: string;
	/** File name suggested in the dialog (placed in Downloads). */
	defaultName: string;
	content: string;
	filters?: { name: string; extensions: string[] }[];
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Cost/token totals for the last `days` local calendar days including today (default 7, max 90).
		 * Unchanged transcripts are served from an in-memory cache, so repeated calls are cheap.
		 */
		"extensions:spend": { args: [days?: number]; result: SpendSummary };
		/** Ask where to save `content` and write it; resolves with the path, or null when cancelled. */
		"extensions:saveText": { args: [options: SaveTextOptions]; result: string | null };
		/** Open omp's stats dashboard in the browser, starting `omp stats` if needed; resolves with its URL. */
		"extensions:statsDashboard": { args: []; result: string };
	}
}
