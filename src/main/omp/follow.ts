/**
 * Live view of session files another omp process is writing (the app's read-only tabs): watch
 * each file, broadcast its tail, and report its health and ownership as `sessions:followState`.
 *
 * Ownership here is information for the renderer, never permission: a file reported `free`
 * stays followed and read-only until the user asks to continue and the renderer re-checks it.
 */
import { type FSWatcher, unwatchFile, watch, watchFile } from "node:fs";
import type { FollowState, SessionOwnership } from "@shared/ipc";
import { broadcast } from "../ipc";
import { sessionOwnership } from "./elsewhere";
import { SessionTail } from "./tail";

/** fs.watch events within this window coalesce into one read. */
const READ_DELAY_MS = 120;
/** Stat interval when fs.watch cannot watch the file. */
const POLL_MS = 500;
/** How often followed files are re-read (a missed watch event or lost access) and ownership is checked. */
const CHECK_MS = 3000;
/** Consecutive `free` observations before a file is reported free (breadcrumb/ps/lsof races). */
const FREE_CHECKS = 2;

function errorCode(error: unknown): string {
	if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
	return error instanceof Error ? error.message : String(error);
}

/** Watches one followed file and broadcasts its tail and state. */
class Follower {
	readonly tail: SessionTail;
	#state: FollowState;
	/** No state is broadcast before the first ownership check, so the renderer never sees a guess. */
	#checked = false;
	#sent: FollowState | null = null;
	#freeChecks = 0;
	#watcher: FSWatcher | null = null;
	#polling = false;
	#timer: NodeJS.Timeout | undefined;
	#reads: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(file: string) {
		this.tail = new SessionTail(file);
		this.#state = { file, readable: true, error: null, ownership: "unknown" };
		this.#watch();
		void this.flush();
	}

	/** Read and broadcast whatever is new; reads run one at a time in order. */
	flush(): Promise<void> {
		this.#reads = this.#reads.then(async () => {
			if (this.#closed) return;
			try {
				const update = await this.tail.read();
				if (this.#closed) return;
				if (update) broadcast("sessions:tail", { file: this.tail.file, ...update });
				this.#update({ readable: true, error: null });
			} catch (error) {
				if (!this.#closed) this.#update({ readable: false, error: errorCode(error) });
			}
		});
		return this.#reads;
	}

	/** Record one ownership observation. `free` is reported only after {@link FREE_CHECKS} in a row. */
	async observe(ownership: SessionOwnership): Promise<void> {
		this.#freeChecks = ownership === "free" ? this.#freeChecks + 1 : 0;
		// An unconfirmed `free` changes nothing: the last confirmed answer (or the renderer's own) stands.
		if (ownership === "free" && this.#freeChecks < FREE_CHECKS) return;
		this.#checked = true;
		if (ownership !== "free") {
			this.#update({ ownership });
			return;
		}
		// Deliver the other window's last entries before saying it let go of the file.
		await this.flush();
		if (!this.#closed) this.#update({ ownership: "free" });
	}

	close(): void {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#watcher?.close();
		this.#watcher = null;
		if (this.#polling) unwatchFile(this.tail.file);
	}

	#update(patch: Partial<FollowState>): void {
		this.#state = { ...this.#state, ...patch };
		if (!this.#checked) return;
		const sent = this.#sent;
		if (sent && sent.readable === this.#state.readable && sent.error === this.#state.error && sent.ownership === this.#state.ownership) return;
		this.#sent = this.#state;
		broadcast("sessions:followState", this.#state);
	}

	#watch(): void {
		if (this.#closed || this.#polling) return;
		try {
			this.#watcher = watch(this.tail.file, { persistent: false }, event => {
				// A rename means the path now points at another inode (atomic replace) or nothing: watch again.
				if (event === "rename") this.#rewatch();
				this.#schedule();
			});
			this.#watcher.on("error", () => this.#rewatch());
		} catch {
			// Missing or unwatchable: poll the path, which also notices the file coming back.
			this.#polling = true;
			watchFile(this.tail.file, { interval: POLL_MS, persistent: false }, () => this.#schedule());
		}
	}

	#rewatch(): void {
		this.#watcher?.close();
		this.#watcher = null;
		this.#watch();
	}

	#schedule(): void {
		if (this.#timer || this.#closed) return;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flush();
		}, READ_DELAY_MS);
	}
}

const followers = new Map<string, Follower>();
let checkTimer: NodeJS.Timeout | undefined;
let checking = false;

/** Follow exactly these session files (the renderer's read-only tabs); others stop. `[]` stops all. */
export function followSessions(files: readonly string[]): void {
	const wanted = new Set(files.filter(file => file.endsWith(".jsonl")));
	for (const [file, follower] of followers) {
		if (wanted.has(file)) continue;
		follower.close();
		followers.delete(file);
	}
	let added = false;
	for (const file of wanted) {
		if (followers.has(file)) continue;
		followers.set(file, new Follower(file));
		added = true;
	}
	if (followers.size === 0) {
		clearInterval(checkTimer);
		checkTimer = undefined;
		return;
	}
	checkTimer ??= setInterval(() => void check(), CHECK_MS);
	checkTimer.unref();
	if (added) void check();
}

/** Re-read every followed file and observe its ownership once. */
async function check(): Promise<void> {
	if (checking) return;
	checking = true;
	try {
		const current = [...followers.values()];
		await Promise.all(current.map(follower => follower.flush()));
		const ownership = await sessionOwnership(current.map(follower => follower.tail.file));
		await Promise.all(
			current
				.filter(follower => followers.get(follower.tail.file) === follower)
				.map(follower => follower.observe(ownership.get(follower.tail.file) ?? "unknown")),
		);
	} catch {
		for (const follower of followers.values()) await follower.observe("unknown");
	} finally {
		checking = false;
	}
}
