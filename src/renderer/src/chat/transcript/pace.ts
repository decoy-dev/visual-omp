import { createContext, useContext, useEffect, useLayoutEffect, useState } from "react";
import { useMotionReduced } from "../../ui/motion";

/**
 * Playout buffer for a streaming reply (DESIGN §4.6). omp's collab host sends `message_update`
 * in bursts, each carrying the whole message so far (a measured run of omp 18.4.9 with
 * claude-opus-5-5 delivered roughly 140 characters every 630ms). Showing each burst as it arrives
 * makes the text jump; revealing each burst on its own deadline makes it type out and then sit
 * still until the next one. So the reveal trails what omp has sent by a target buffer sized to how
 * omp delivers it, and a rate controller steers the speed toward keeping that buffer, so the text
 * keeps moving between bursts.
 *
 * One timeline runs through a message's blocks in order. Visible text and open thinking take time
 * to reveal; a collapsed thinking block, a redacted one and a tool call take none, so hidden
 * thinking never delays the reply, and a tool call appears when the reveal reaches it.
 */

/** Incoming rate (characters per ms) assumed until two bursts have been measured. */
export const DEFAULT_RATE = 0.23;
/** Buffer (ms of incoming text) kept between what omp sent and what shows, until gaps are measured. */
export const DEFAULT_BUFFER_MS = 800;
const MIN_BUFFER_MS = 400;
const MAX_BUFFER_MS = 1500;
/** The buffer covers the 90th percentile gap between bursts with this much headroom. */
const BUFFER_PER_GAP = 1.25;
/** How long the buffer takes to follow a change in how omp delivers text. */
const BUFFER_SMOOTHING_MS = 2000;
/** Wait before revealing text that starts after a pause, so the first bursts build the buffer. */
export const PRIME_MS = 250;
/** Arrivals closer than this are one burst. */
const BURST_MERGE_MS = 30;
/** A gap longer than this (a tool runs, the model pauses) starts a new measurement window. */
const WINDOW_RESET_MS = 2000;
const WINDOW_BURSTS = 6;
const WINDOW_MS = 4000;
/** How strongly the speed corrects toward the target buffer, and how far it may stray. */
const GAIN = 0.5;
const MIN_RATE_FACTOR = 0.3;
const MAX_RATE_FACTOR = 3;
/** Time constant of the speed's low-pass, so the reveal never changes speed abruptly. */
const RATE_SMOOTHING_MS = 250;
const DRAIN_SMOOTHING_MS = 120;
/** A frame gap longer than this counts as this long for smoothing (progress still uses the real gap). */
const MAX_SMOOTHING_DT = 50;
/** After the reply ends, what is left shows within this long. */
export const DRAIN_MS = 600;
const DRAIN_FLOOR_MS = 50;
/** The slowest reveal, so a tiny remainder never trickles out. */
const MIN_RATE = 0.03;

export interface PlayoutBlock {
	/** Characters received in the block so far. */
	length: number;
	/** The block takes time to reveal (visible text, open thinking). Other blocks show at once when reached. */
	timed: boolean;
}

interface Burst {
	at: number;
	chars: number;
}

/** Nearest-rank percentile of `values`, which must not be empty. */
function percentile(values: readonly number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

/** The reveal state of one message, shared by its stream row and the saved entry that replaces it. */
export class Playout {
	#blocks: PlayoutBlock[] = [];
	/** Cursor: the block being revealed and how many of its characters show (fractional between frames). */
	#index = 0;
	#offset = 0;
	#bursts: Burst[] = [];
	#lastArrival = Number.NEGATIVE_INFINITY;
	#rateEstimate = DEFAULT_RATE;
	#bufferMs = DEFAULT_BUFFER_MS;
	#bufferTarget = DEFAULT_BUFFER_MS;
	#rate = DEFAULT_RATE * MIN_RATE_FACTOR;
	#holdUntil = Number.NEGATIVE_INFINITY;
	#lastStep: number | null = null;
	#doneAt: number | null = null;

	/** `showExisting`: the text present now shows in full (the chat synchronized mid-reply). Otherwise it counts as arriving at the first `receive`. */
	constructor(blocks: readonly PlayoutBlock[], showExisting: boolean) {
		this.#blocks = blocks.map(block => ({ ...block, length: showExisting ? block.length : 0 }));
		if (showExisting) this.#toEnd();
	}

	/** Characters of timed blocks received so far. */
	get received(): number {
		let total = 0;
		for (const block of this.#blocks) if (block.timed) total += block.length;
		return total;
	}

	/** Characters of timed blocks shown so far. */
	get shown(): number {
		let total = 0;
		for (let index = 0; index < this.#index; index++) {
			const block = this.#blocks[index];
			if (block?.timed) total += block.length;
		}
		if (this.#blocks[this.#index]?.timed) total += this.#offset;
		return total;
	}

	/** The reply has ended and everything shows. */
	get finished(): boolean {
		return this.#doneAt !== null && this.#atEnd();
	}

	/** Whether frames still move the reveal (text is buffered, or a block the cursor can pass waits). */
	get moving(): boolean {
		return !this.#atEnd();
	}

	/** Characters of block `index` to show: all of a passed block, part of the current one, none (-1) of later ones. */
	visible(index: number): number {
		if (index < this.#index) return Number.POSITIVE_INFINITY;
		if (index === this.#index) return this.#offset;
		return -1;
	}

	/** A key that changes whenever the visible text changes. */
	get revision(): string {
		return `${this.#index}:${Math.floor(this.#offset)}`;
	}

	/** Takes the message's blocks as of `now`; `done` once omp has finished the message. */
	receive(blocks: readonly PlayoutBlock[], now: number, done: boolean): void {
		let arrived = 0;
		for (const [index, block] of blocks.entries()) {
			const before = this.#blocks[index];
			if (block.timed) arrived += Math.max(0, block.length - (before?.length ?? 0));
		}
		const backlogBefore = this.received - this.shown;
		this.#blocks = blocks.map(block => ({ ...block }));
		if (this.#index >= this.#blocks.length) {
			this.#index = Math.max(0, this.#blocks.length - 1);
			this.#offset = this.#blocks[this.#index]?.length ?? 0;
		}
		this.#offset = Math.min(this.#offset, this.#blocks[this.#index]?.length ?? 0);
		if (arrived > 0) this.#arrive(arrived, now, backlogBefore);
		if (done && this.#doneAt === null) this.#doneAt = now;
	}

	/** Shows everything received now, as when the chat synchronizes with a reply in progress. */
	catchUp(): void {
		this.#toEnd();
		this.#bursts = [];
		this.#lastArrival = Number.NEGATIVE_INFINITY;
		this.#lastStep = null;
	}

	/** Advances the reveal to the frame at `now`. */
	step(now: number): void {
		const last = this.#lastStep;
		this.#lastStep = now;
		if (last === null) {
			this.#advance(0);
			return;
		}
		const dt = Math.max(0, now - last);
		const smoothingDt = Math.min(dt, MAX_SMOOTHING_DT);
		this.#bufferMs += (this.#bufferTarget - this.#bufferMs) * (1 - Math.exp(-smoothingDt / BUFFER_SMOOTHING_MS));
		if (now < this.#holdUntil) {
			this.#advance(0);
			return;
		}
		const backlog = this.received - this.shown;
		if (backlog <= 0) {
			this.#advance(0);
			// Idle: the next burst starts a fresh frame clock instead of counting the idle time as progress.
			if (this.#atEnd()) this.#lastStep = null;
			return;
		}
		const estimate = this.#rateEstimate;
		let target: number;
		let smoothing = RATE_SMOOTHING_MS;
		if (this.#doneAt !== null) {
			const remaining = Math.max(DRAIN_FLOOR_MS, DRAIN_MS - (now - this.#doneAt));
			target = Math.max(estimate, backlog / remaining);
			smoothing = DRAIN_SMOOTHING_MS;
		} else {
			const ratio = backlog / (estimate * this.#bufferMs);
			target = Math.min(MAX_RATE_FACTOR * estimate, Math.max(MIN_RATE_FACTOR * estimate, estimate * (1 + GAIN * (ratio - 1))));
		}
		this.#rate += (target - this.#rate) * (1 - Math.exp(-smoothingDt / smoothing));
		this.#rate = Math.max(MIN_RATE, this.#rate);
		this.#advance(this.#rate * dt);
		if (this.#atEnd()) this.#lastStep = null;
	}

	#arrive(chars: number, now: number, backlogBefore: number): void {
		const latest = this.#bursts.at(-1);
		const gap = now - this.#lastArrival;
		this.#lastArrival = now;
		if (latest && gap < BURST_MERGE_MS) {
			latest.chars += chars;
			return;
		}
		if (gap > WINDOW_RESET_MS) {
			// A pause (or the first text): measure afresh, and prime the buffer if nothing is waiting.
			this.#bursts = [];
			if (backlogBefore <= 0) {
				this.#holdUntil = now + PRIME_MS;
				this.#rate = this.#rateEstimate * MIN_RATE_FACTOR;
			}
		}
		this.#bursts.push({ at: now, chars });
		while (this.#bursts.length > WINDOW_BURSTS || (this.#bursts.length > 2 && now - (this.#bursts[0]?.at ?? now) > WINDOW_MS)) this.#bursts.shift();
		const first = this.#bursts[0];
		if (!first || this.#bursts.length < 2) return;
		let chars2 = 0;
		for (const burst of this.#bursts.slice(1)) chars2 += burst.chars;
		const span = now - first.at;
		if (span > 0) this.#rateEstimate = Math.max(MIN_RATE, chars2 / span);
		const gaps = this.#bursts.slice(1).map((burst, index) => burst.at - (this.#bursts[index]?.at ?? burst.at));
		this.#bufferTarget = Math.min(MAX_BUFFER_MS, Math.max(MIN_BUFFER_MS, BUFFER_PER_GAP * percentile(gaps, 0.9)));
	}

	/** Moves the cursor `chars` timed characters forward, passing untimed and finished blocks on the way. */
	#advance(chars: number): void {
		let left = chars;
		for (;;) {
			const block = this.#blocks[this.#index];
			if (!block) return;
			if (block.timed) {
				const take = Math.min(block.length - this.#offset, left);
				this.#offset += take;
				left -= take;
			} else this.#offset = block.length;
			// A block is finished once a later one exists, so the cursor may move on.
			if (this.#offset < block.length || this.#index >= this.#blocks.length - 1) return;
			this.#index++;
			this.#offset = 0;
		}
	}

	#atEnd(): boolean {
		const last = this.#blocks.length - 1;
		return this.#index >= last && this.#offset >= (this.#blocks[last]?.length ?? 0);
	}

	#toEnd(): void {
		this.#index = Math.max(0, this.#blocks.length - 1);
		this.#offset = this.#blocks[this.#index]?.length ?? 0;
	}
}

/** The first `length` characters of `text`, widened so a surrogate pair is never split. */
export function revealedPrefix(text: string, length: number): string {
	let end = Math.min(text.length, Math.floor(length));
	if (end >= text.length) return text;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end++;
	return text.slice(0, end);
}

/** True until the live mirror has synchronized from its previous connection phase. */
export function synchronizedStream(phase: string | null, previousPhase: string | null): boolean {
	return phase !== "live" || previousPhase !== "live";
}

/**
 * Reveal state by message (its `timestamp`, which the streamed message and its saved entry share),
 * so the saved entry that replaces the stream row continues the same reveal. Provided by the
 * transcript; without it nothing is paced.
 */
export const PlayoutRegistry = createContext<Map<number, Playout> | null>(null);

export interface PlayoutOptions {
	/** omp is still streaming this message. */
	pending: boolean;
	/** Text present when the reveal starts shows in full (the chat opened or synchronized mid-reply). */
	showExisting: boolean;
	/** The live mirror is synchronizing: everything received so far shows. */
	synchronized: boolean;
}

/**
 * The reveal for message `key`, or null when it renders in full: saved history, reduced motion,
 * or a reveal that has finished. A streaming message starts one; its saved entry picks it up.
 */
export function usePlayout(key: number, blocks: readonly PlayoutBlock[], { pending, showExisting, synchronized }: PlayoutOptions): Playout | null {
	const registry = useContext(PlayoutRegistry);
	const reduced = useMotionReduced();
	const [, rerender] = useState(0);
	let playout = registry?.get(key) ?? null;
	if (registry && reduced && playout) {
		registry.delete(key);
		playout = null;
	}
	if (registry && !reduced && !playout && pending) {
		playout = new Playout(blocks, showExisting || synchronized);
		registry.set(key, playout);
	}
	if (registry && playout?.finished) {
		registry.delete(key);
		playout = null;
	}
	const signature = blocks.map(block => `${block.length}${block.timed ? "t" : "i"}`).join(",");

	useLayoutEffect(() => {
		if (!playout) return;
		const before = playout.revision;
		playout.receive(blocks, performance.now(), !pending);
		if (synchronized) playout.catchUp();
		// Layout effects run before paint, so this render shows a caught-up or clamped cursor at once.
		if (playout.revision !== before) rerender(count => count + 1);
		// `signature` stands in for `blocks`, whose identity changes every render.
	}, [playout, signature, pending, synchronized]);

	useEffect(() => {
		if (!playout) return;
		let frame = requestAnimationFrame(function tick(now) {
			const before = playout.revision;
			playout.step(now);
			if (playout.revision !== before || playout.finished) rerender(count => count + 1);
			frame = playout.moving ? requestAnimationFrame(tick) : 0;
		});
		return () => cancelAnimationFrame(frame);
	}, [playout, signature, pending]);

	return playout;
}
