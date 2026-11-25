import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { ChatCompactionStore } from "../services/chat-compaction";

/** omp 19.2+ polls a changed `--config` overlay every 500 ms before its 200 ms quiet period (`CONFIG_WATCH_DEBOUNCE_MS`, omp 18.15+). */
export const OVERLAY_RELOAD_MS = 800;

/** The session id in a saved session's header record, or null when the file has none. omp may write a title record first. */
export async function resumeSessionId(file: string): Promise<string | null> {
	let handle;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 4)) {
			let record: unknown;
			try { record = JSON.parse(line); } catch { continue; }
			const entry = record && typeof record === "object" ? record as { type?: unknown; id?: unknown } : null;
			if (entry?.type === "session") return typeof entry.id === "string" ? entry.id : null;
		}
		return null;
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

/**
 * Keeps one host's config overlay on the compaction point saved for the session it runs. Every change runs in
 * order: an identity change (resume, /new, branch) writes that session's point, or none, before a later Save
 * can run, and a Save names the session it was made for so it can never land on the next one.
 */
export class ChatCompactionOverlay {
	#sessionId: string | null = null;
	#written: number | null = null;
	#writtenAt = 0;
	#queue: Promise<void> = Promise.resolve();
	/** Counts queued steps, so `ready` notices work queued while it waited. */
	#revision = 0;
	/** Set while the overlay may not match the current session, after a failed overlay write. */
	#failure: Error | null = null;

	constructor(
		private readonly store: ChatCompactionStore,
		/** Rewrites the overlay file with this point; null leaves compaction to omp's own settings. */
		private readonly write: (tokens: number | null) => Promise<void>,
		private readonly onApplied: (tokens: number | null) => void = () => {},
		/** A saved point could not be read; the session runs on omp's own settings. */
		private readonly onStoreError: (error: unknown) => void = () => {},
	) {}

	/** The point the overlay holds now. */
	get tokens(): number | null {
		return this.#written;
	}

	/** The point saved for `sessionId`, for the overlay omp starts with. */
	async initial(sessionId: string | null): Promise<number | null> {
		this.#sessionId = sessionId;
		this.#written = await this.#saved(sessionId);
		return this.#written;
	}

	/** The host now runs `sessionId`: apply its saved point, or remove the previous session's. */
	identify(sessionId: string | null): Promise<void> {
		this.#sessionId = sessionId;
		return this.#run(async () => {
			if (this.#sessionId !== sessionId) return;
			const tokens = await this.#saved(sessionId);
			if (this.#sessionId !== sessionId) return;
			await this.#apply(tokens);
		});
	}

	/** Saves `tokens` for `sessionId` and applies it; refuses once the host runs another session. */
	set(sessionId: string, tokens: number | null): Promise<void> {
		const current = (): void => {
			if (this.#sessionId !== sessionId) throw new Error("The chat changed before its compaction point could be saved.");
		};
		current();
		return this.#run(async () => {
			current();
			await this.store.set(sessionId, tokens);
			current();
			await this.#apply(tokens);
		});
	}

	/**
	 * Resolves once every queued overlay change has been written and omp's config watcher has had its poll interval
	 * plus 200 ms quiet period (up to 700 ms on omp 19.2+) and a margin to read it. The app cannot observe omp's reload itself. After a failed overlay write
	 * it rewrites the current session's point once more, and rejects while that still fails.
	 */
	async ready(): Promise<void> {
		for (;;) {
			const queue = this.#queue;
			const revision = this.#revision;
			await queue;
			if (this.#failure) await this.identify(this.#sessionId);
			const wait = this.#writtenAt + OVERLAY_RELOAD_MS - Date.now();
			if (wait > 0) await sleep(wait);
			if (queue === this.#queue && revision === this.#revision && !this.#failure) return;
		}
	}

	async #saved(sessionId: string | null): Promise<number | null> {
		if (!sessionId) return null;
		try {
			return await this.store.get(sessionId);
		} catch (error) {
			this.onStoreError(error);
			return null;
		}
	}

	async #apply(tokens: number | null): Promise<void> {
		if (tokens !== this.#written) {
			try {
				await this.write(tokens);
			} catch (error) {
				// The overlay may still hold a point for another session, so prompts wait for a successful rewrite.
				this.#failure = error instanceof Error ? error : new Error(String(error));
				throw error;
			}
			this.#written = tokens;
			this.#writtenAt = Date.now();
			this.onApplied(tokens);
		}
		this.#failure = null;
	}

	/** Runs `step` after every earlier step. */
	#run(step: () => Promise<void>): Promise<void> {
		this.#revision++;
		const run = this.#queue.then(step);
		// Keep the queue alive after a failed step; its caller still sees the error.
		this.#queue = run.catch(() => {});
		return run;
	}
}

/**
 * Runs `run` once the overlay is ready, unless the chat moved to another session, generation or semantic screen
 * while it waited (`scope` describes all three).
 */
export async function afterOverlayReady<T>(overlay: Pick<ChatCompactionOverlay, "ready">, scope: () => string, run: () => Promise<T>): Promise<T> {
	const before = scope();
	await overlay.ready();
	if (scope() !== before) throw new Error("The chat changed before its message could be sent.");
	return run();
}
