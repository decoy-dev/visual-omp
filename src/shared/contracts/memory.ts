/**
 * omp's long-term memory: which backend is active, where it stores data, and a browser over the
 * locally stored memories of every backend that keeps data on disk.
 *
 * Backends (`memory.backend` in omp's config):
 * - `off` — nothing is recalled or stored (the default).
 * - `local` — per-project folder `<memories>/--<encoded cwd>--/` holding consolidated artifacts written
 *   by omp's startup pipeline (`MEMORY.md`, `memory_summary.md`, `raw_memories.md`,
 *   `rollout_summaries/*.md`, `skills/<name>/SKILL.md`) plus `learned.md` lessons from the `learn` tool.
 * - `mnemopi` — SQLite banks: the shared bank at `mnemopi.dbPath` (default `<memories>/mnemopi/mnemopi.db`)
 *   and per-project banks at `<dir of dbPath>/banks/<bank>/mnemopi.db`.
 * - `sharpshooter` — per-project decision files `<memories>/sharpshooter/<bank>/{architecture,product,style}.md`
 *   plus queued, not yet consolidated decision deltas under `queue/<session>/*.json`.
 * - `hindsight` — remote server; nothing is stored locally, so it has no scopes or entries here.
 *
 * `<memories>` is `<agent dir>/memories` (`$XDG_STATE_HOME/omp/memories` after `omp config init-xdg`).
 * Data of inactive backends stays on disk and remains browsable.
 *
 * Deletion is offered only where it is safe outside omp: single `learned.md` lessons, mnemopi
 * working-memory rows (same cleanup as omp's `memory_edit forget`) and queued sharpshooter deltas.
 * Consolidated artifacts (MEMORY.md, decision files, episodic rows, facts) are rewritten wholesale by
 * omp's consolidation and are read-only here. omp has no CLI for `/memory clear|sync|enqueue`
 * (slash commands inside a session only), so those are not exposed.
 */

export type MemoryBackend = "off" | "local" | "mnemopi" | "sharpshooter" | "hindsight";

/** Backends that keep memories on local disk. */
export type StoredMemoryBackend = "local" | "mnemopi" | "sharpshooter";

/** Bank visibility for mnemopi (`mnemopi.scoping`) and hindsight (`hindsight.scoping`). */
export type MemoryScoping = "global" | "per-project" | "per-project-tagged";

export interface MemoryStatus {
	backend: MemoryBackend;
	/** `backend !== "off"`. */
	enabled: boolean;
	/** omp's memories root directory (may not exist yet). */
	memoriesDir: string;
	/** Where the active backend stores data: a directory, a SQLite file, a server URL; null when off. */
	location: string | null;
	locationKind: "directory" | "sqlite" | "remote" | null;
	/** `autolearn.enabled`: the `learn` tool and post-turn lesson capture are on. */
	autolearn: boolean;
	mnemopi: {
		/** Resolved shared-bank database path. */
		dbPath: string;
		/** `mnemopi.bank` base name; null = `default`. */
		bank: string | null;
		scoping: MemoryScoping;
	};
	hindsight: {
		apiUrl: string;
		bankId: string | null;
		scoping: MemoryScoping;
	};
}

/** One place memories live: a local project folder, a mnemopi bank, or a sharpshooter bank. */
export interface MemoryScope {
	/** Opaque id for `memory:list`. */
	id: string;
	backend: StoredMemoryBackend;
	/** This scope's backend is the configured `memory.backend`. */
	active: boolean;
	/** Display name: project folder name or bank name. */
	name: string;
	/** Project directory this scope belongs to, when it can be resolved; null for shared/unknown scopes. */
	cwd: string | null;
	/** mnemopi shared bank (recalled by every project under `global`/`per-project-tagged`). */
	global: boolean;
	/** Folder (local, sharpshooter) or database file (mnemopi). */
	path: string;
	/** False for `memory:forProject` results whose storage has not been created yet. */
	exists: boolean;
	entryCount: number;
	/** Epoch ms of the newest change; null when unknown/empty. */
	updatedAt: number | null;
}

/**
 * - local: `summary` (memory_summary.md, injected at session start), `memory` (MEMORY.md),
 *   `raw` (raw_memories.md), `rollout` (per-session summary), `skill` (generated SKILL.md), `lesson` (one learned.md bullet).
 * - mnemopi: `working` (recent turns / saved memories), `episodic` (consolidated), `fact` (extracted triple).
 * - sharpshooter: `decisions` (one decision file), `delta` (queued decision awaiting consolidation).
 */
export type MemoryEntryKind =
	| "summary"
	| "memory"
	| "raw"
	| "rollout"
	| "skill"
	| "lesson"
	| "working"
	| "episodic"
	| "fact"
	| "decisions"
	| "delta";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface MemoryEntrySummary {
	/** Opaque id for `memory:read` / `memory:delete`. */
	id: string;
	scopeId: string;
	backend: StoredMemoryBackend;
	kind: MemoryEntryKind;
	/** Short label (file name, skill name, memory type, decision kind). */
	title: string;
	/** Whitespace-collapsed start of the text (≤ 280 chars). */
	preview: string;
	/** Full text length in characters. */
	length: number;
	/** Epoch ms; null when the storage does not record it. */
	createdAt: number | null;
	/** Epoch ms; null when the storage does not record it. */
	updatedAt: number | null;
	/** Labels such as memory type, source, annotations (`kind:value`) or decision friction. */
	tags: string[];
	deletable: boolean;
	/** Backing file (the SQLite database for mnemopi rows). */
	path: string;
}

export interface MemoryEntry extends MemoryEntrySummary {
	/** Full text (Markdown for file-backed entries). */
	text: string;
	/** Backend-specific fields: importance, veracity, session id, source, rationale, evidence, parsed `metadata_json`, … */
	metadata: Record<string, JsonValue>;
}

export interface MemoryListOptions {
	/** Case-insensitive substring filter on the text. */
	query?: string;
	/** Default 200. */
	limit?: number;
	offset?: number;
}

export interface MemoryListResult {
	/** Newest first (file-backed documents first for local/sharpshooter). */
	entries: MemoryEntrySummary[];
	/** Matching entries before `limit`/`offset`. */
	total: number;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/** Active backend, its storage location and the backend settings that decide scoping. */
		"memory:status": { args: []; result: MemoryStatus };
		/**
		 * Every scope with stored data, for one backend or (omitted) all local backends. Project
		 * directories are resolved against the projects known from omp sessions.
		 */
		"memory:scopes": { args: [backend?: StoredMemoryBackend]; result: MemoryScope[] };
		/**
		 * The scopes the active backend reads for a project directory — e.g. the project bank plus the
		 * shared bank under mnemopi `per-project-tagged`. Includes scopes not created yet
		 * (`exists: false`); empty when the backend is `off` or `hindsight`.
		 */
		"memory:forProject": { args: [cwd: string]; result: MemoryScope[] };
		"memory:list": { args: [scopeId: string, options?: MemoryListOptions]; result: MemoryListResult };
		/** Full entry; rejects when it no longer exists. */
		"memory:read": { args: [entryId: string]; result: MemoryEntry };
		/**
		 * Delete one entry whose summary says `deletable`; rejects otherwise or when it is gone.
		 * mnemopi: running omp sessions with `mnemopi.enhancedRecall` may keep serving the deleted row
		 * from their in-memory recall cache until they restart.
		 */
		"memory:delete": { args: [entryId: string]; result: void };
	}
}
