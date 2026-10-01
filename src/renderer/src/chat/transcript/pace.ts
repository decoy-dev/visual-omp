import { useEffect, useRef, useState } from "react";
import { useMotionReduced } from "../../ui/motion";

/**
 * Paced reveal for a streaming reply (DESIGN §4.6). omp's collab host sends `message_update` in
 * bursts, each carrying the whole message so far, so text shown as it arrives jumps a burst at a
 * time. The reveal shows each arrival in full within {@link LAG_MS} of receiving it, spread
 * evenly over the frames in between, so a burst types out and a steady stream reads as one flow.
 */
export const LAG_MS = 250;
/** The slowest reveal, so a few characters do not trickle out over the whole lag window. */
const MIN_CHARS_PER_MS = 0.12;

export interface Arrival {
	/** `performance.now()` when the text arrived. */
	at: number;
	/** Length of the text at that moment. */
	length: number;
}

/**
 * How many characters show after a frame that ended at `now`, `elapsed` ms after the previous one.
 * The rate is the slowest one that still shows every arrival by its deadline, and an arrival whose
 * deadline has passed (a dropped frame, a hidden window) shows at once.
 */
export function revealStep(shown: number, arrivals: readonly Arrival[], now: number, elapsed: number): number {
	let rate = MIN_CHARS_PER_MS;
	let due = shown;
	let received = shown;
	for (const arrival of arrivals) {
		received = Math.max(received, arrival.length);
		if (arrival.length <= shown) continue;
		const left = arrival.at + LAG_MS - now;
		if (left <= 0) due = Math.max(due, arrival.length);
		else rate = Math.max(rate, (arrival.length - shown) / left);
	}
	return Math.min(received, Math.max(due, shown + rate * Math.max(0, elapsed)));
}

/** Length of the common prefix of `a` and `b`, up to `limit`. */
function sharedLength(a: string, b: string, limit: number): number {
	let index = 0;
	while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
	return index;
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

/** Text already present when a paced block mounts, accounting for its initial synchronization. */
export function initialPacedText(text: string, paced: boolean, fromStart: boolean): string {
	return paced && fromStart ? "" : text;
}

interface Pace {
	/** Characters shown, fractional between frames. */
	shown: number;
	/** The text the reveal is working toward. */
	text: string;
	arrivals: Arrival[];
	/** The pending `requestAnimationFrame` handle, 0 while the reveal has caught up. */
	frame: number;
}

/**
 * The part of `text` to show. While `live` (the block is the one streaming), it trails the
 * received text as {@link revealStep} paces it; otherwise, and under reduced motion, it is all of
 * `text`. `fromStart` decides where a block that mounts live begins: from nothing when it arrived
 * while the chat was open, or in full when the chat opened mid-reply. Text that replaces rather
 * than extends the previous text restarts the reveal where the two diverge.
 */
export function usePacedText(text: string, live: boolean, fromStart: boolean): string {
	const reduced = useMotionReduced();
	const paced = live && !reduced;
	const pace = useRef<Pace | null>(null);
	if (pace.current === null) {
		const initial = initialPacedText(text, paced, fromStart);
		pace.current = { shown: initial.length, text: initial, arrivals: [], frame: 0 };
	}
	const [, setFrame] = useState(0);

	useEffect(
		() => () => {
			const state = pace.current;
			if (!state) return;
			cancelAnimationFrame(state.frame);
			state.frame = 0;
		},
		[],
	);

	useEffect(() => {
		const state = pace.current;
		if (!state) return;
		if (!paced) {
			cancelAnimationFrame(state.frame);
			state.frame = 0;
			state.shown = text.length;
			state.text = text;
			state.arrivals = [];
			return;
		}
		if (!text.startsWith(state.text)) {
			state.shown = sharedLength(state.text, text, Math.min(state.shown, text.length));
			state.arrivals = [];
		}
		state.text = text;
		if (state.shown >= text.length) {
			state.shown = text.length;
			return;
		}
		let last = performance.now();
		state.arrivals.push({ at: last, length: text.length });
		// One loop runs until the reveal catches up; later arrivals only join its schedule.
		if (state.frame !== 0) return;
		state.frame = requestAnimationFrame(function step(now) {
			const before = Math.floor(state.shown);
			state.shown = revealStep(state.shown, state.arrivals, now, now - last);
			last = now;
			state.arrivals = state.arrivals.filter(arrival => arrival.length > state.shown);
			if (Math.floor(state.shown) !== before) setFrame(count => count + 1);
			state.frame = state.shown < state.text.length ? requestAnimationFrame(step) : 0;
		});
	}, [text, paced]);

	if (!paced) return text;
	const state = pace.current;
	const shown = text.startsWith(state.text) ? state.shown : sharedLength(state.text, text, Math.min(state.shown, text.length));
	return revealedPrefix(text, shown);
}
