import type { WindowHealthIncident } from "@shared/contracts/window-health";

const MIB = 1024 * 1024;
/** How often main sends a heartbeat and samples the relay backlog. */
export const HEARTBEAT_MS = 2_000;
/** A heartbeat unanswered this long means the window is slow. */
export const NO_ANSWER_MS = 10_000;
/** Three answers in a row slower than this also mean the window is slow. */
export const SLOW_ANSWER_MS = 2_000;
const SLOW_ANSWERS = 3;
/** A heartbeat unanswered this long gets a native dialog, since the window may not be able to show anything. */
export const FROZEN_MS = 30_000;
/** A chat whose window connection keeps more than this waiting for this long has delayed updates. */
export const BEHIND_BYTES = 4 * MIB;
export const BEHIND_MS = 15_000;
/** Two resyncs of one chat within this window count as repeated. */
export const RESYNC_WINDOW_MS = 60_000;
const RESYNCS = 2;
/** A slowdown ends after this long with quick answers, little waiting and no new resync. */
export const CALM_MS = 10_000;
const CALM_ANSWER_MS = 500;
const CALM_BYTES = MIB;
/** After the person acts on a warning, a new one waits this long. */
export const COOLDOWN_MS = 60_000;
/** After the window is shown again or loads a new page, its answers are not judged for this long. */
export const GRACE_MS = 10_000;

/**
 * Decides when the window is falling behind, from main's heartbeats and the relay backlog toward the window. The past
 * slowdowns were updates the window could not keep up with (whole screen documents in 0.7.5, an unbounded relay queue
 * in 0.7.8), not a disk cache, so this watches answers and waiting bytes rather than memory or CPU. Times are passed in.
 */
export class WindowHealth {
	/** Whether the page in the window answers heartbeats yet; nothing is sent or judged until it does. */
	#ready = false;
	#sentAt: number | null = null;
	#slowAnswers = 0;
	#lastAnswerMs: number | null = null;
	readonly #behindSince = new Map<string, number>();
	readonly #resyncs = new Map<string, number[]>();
	/** The latest resync a warning already reported; older pairs never start a new one. */
	#reportedResyncAt = -Infinity;
	#graceUntil = 0;
	#cooldownUntil = 0;
	#calmSince: number | null = null;
	#incident: WindowHealthIncident | null = null;
	#nextId = 1;
	#frozenReported = false;

	get incident(): WindowHealthIncident | null {
		return this.#incident;
	}

	/** Whether to send a heartbeat now: once the page is ready, with one outstanding at most. */
	get heartbeatDue(): boolean {
		return this.#ready && this.#sentAt === null;
	}

	/** A page started loading or the renderer was lost: the slowdown ends and nothing is judged until `pageReady`. */
	pageLoading(now: number): void {
		this.reset(now);
		this.#ready = false;
	}

	/** The page answers heartbeats now; judging starts after the grace. The cooldown carries over. */
	pageReady(now: number): void {
		this.reset(now);
		this.#ready = true;
	}

	heartbeatSent(now: number): void {
		this.#sentAt = now;
	}

	heartbeatAnswered(now: number): void {
		if (this.#sentAt === null) return;
		const answerMs = now - this.#sentAt;
		this.#sentAt = null;
		this.#lastAnswerMs = answerMs;
		this.#slowAnswers = answerMs > SLOW_ANSWER_MS ? this.#slowAnswers + 1 : 0;
	}

	/** A chat's window connection was dropped for falling behind and resyncs. */
	resync(chatId: string, now: number): void {
		this.#resyncs.set(chatId, [...(this.#resyncs.get(chatId) ?? []).filter(at => now - at < RESYNC_WINDOW_MS), now]);
		this.#calmSince = null;
	}

	/** Forget what was observed, for sleep, a hidden window or a new page in it; the current slowdown ends. */
	reset(now: number): void {
		this.#sentAt = null;
		this.#slowAnswers = 0;
		this.#lastAnswerMs = null;
		this.#behindSince.clear();
		this.#resyncs.clear();
		this.#reportedResyncAt = -Infinity;
		this.#calmSince = null;
		this.#graceUntil = now + GRACE_MS;
		this.#incident = null;
		this.#frozenReported = false;
	}

	/**
	 * The person acted on the warning: the current slowdown ends, and a new one waits for the cooldown even if the window
	 * is still slow. Returns true when a slowdown ended.
	 */
	acted(now: number): boolean {
		this.#cooldownUntil = now + COOLDOWN_MS;
		this.#calmSince = null;
		if (!this.#incident) return false;
		this.#incident = null;
		return true;
	}

	/**
	 * Judge the window with the bytes now waiting for each chat (chats with none may be left out). Returns true when the
	 * slowdown began, changed or ended.
	 */
	sample(now: number, backlogs: ReadonlyMap<string, number>): boolean {
		if (!this.#ready) return false;
		for (const chatId of [...this.#behindSince.keys()]) if ((backlogs.get(chatId) ?? 0) <= BEHIND_BYTES) this.#behindSince.delete(chatId);
		for (const [chatId, bytes] of backlogs) if (bytes > BEHIND_BYTES && !this.#behindSince.has(chatId)) this.#behindSince.set(chatId, now);
		for (const [chatId, times] of this.#resyncs) {
			const recent = times.filter(at => now - at < RESYNC_WINDOW_MS);
			if (recent.length > 0) this.#resyncs.set(chatId, recent);
			else this.#resyncs.delete(chatId);
		}
		const judged = now >= this.#graceUntil;
		const slow = judged && ((this.#sentAt !== null && now - this.#sentAt >= NO_ANSWER_MS) || this.#slowAnswers >= SLOW_ANSWERS);
		const delayed = [...this.#behindSince].filter(([, since]) => now - since >= BEHIND_MS).map(([chatId]) => chatId).sort();
		// A repeated resync starts or extends a warning once; recovery then waits on the heartbeat and backlog.
		const fresh = [...this.#resyncs].filter(([, times]) => times.length >= RESYNCS && times.at(-1)! > this.#reportedResyncAt);
		const qualifies = slow || delayed.length > 0 || fresh.length > 0;
		if (qualifies && (this.#incident || now >= this.#cooldownUntil)) {
			this.#calmSince = null;
			if (fresh.length > 0) this.#reportedResyncAt = Math.max(...fresh.map(([, times]) => times.at(-1)!));
			const current = this.#incident;
			const resyncing = fresh.length > 0 ? [...new Set([...(current?.resyncing ?? []), ...fresh.map(([chatId]) => chatId)])].sort() : current?.resyncing ?? [];
			if (current && current.slow === slow && same(current.delayed, delayed) && same(current.resyncing, resyncing)) return false;
			this.#incident = { id: current?.id ?? this.#nextId++, slow, delayed, resyncing };
			if (!current) this.#frozenReported = false;
			return true;
		}
		if (!this.#incident) return false;
		const calm = (this.#sentAt === null || now - this.#sentAt < CALM_ANSWER_MS)
			&& (this.#lastAnswerMs === null || this.#lastAnswerMs < CALM_ANSWER_MS)
			&& [...backlogs.values()].every(bytes => bytes < CALM_BYTES);
		if (!calm) {
			this.#calmSince = null;
			return false;
		}
		this.#calmSince ??= now;
		if (now - this.#calmSince < CALM_MS) return false;
		this.#incident = null;
		this.#calmSince = null;
		return true;
	}

	/** True once per slowdown, when the window has not answered a heartbeat for `FROZEN_MS`. */
	frozen(now: number): boolean {
		if (this.#frozenReported || !this.#incident || this.#sentAt === null || now - this.#sentAt < FROZEN_MS) return false;
		this.#frozenReported = true;
		return true;
	}
}

function same(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
