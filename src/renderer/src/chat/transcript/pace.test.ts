import { describe, expect, it } from "vitest";
import { DRAIN_MS, Playout, type PlayoutBlock, PRIME_MS, revealedPrefix, synchronizedStream } from "./pace";

const FRAME = 1000 / 60;

/** One update from omp: at `at` ms, the message's blocks have these lengths. */
interface Update {
	at: number;
	blocks: PlayoutBlock[];
}

interface Frame {
	at: number;
	shown: number;
	received: number;
}

/** Runs 60 fps frames over `updates`, with omp's `message_end` at `doneAt`, until the reveal finishes. */
function simulate(updates: readonly Update[], doneAt: number, limit = 60_000): Frame[] {
	const first = updates[0];
	if (!first) throw new Error("no updates");
	const playout = new Playout(first.blocks, false);
	const frames: Frame[] = [];
	let next = 0;
	for (let now = first.at; now < limit; now += FRAME) {
		while (next < updates.length && (updates[next]?.at ?? Number.POSITIVE_INFINITY) <= now) {
			playout.receive(updates[next]?.blocks ?? [], updates[next]?.at ?? now, false);
			next++;
		}
		if (now >= doneAt) playout.receive(updates.at(-1)?.blocks ?? [], doneAt, true);
		playout.step(now);
		frames.push({ at: now, shown: playout.shown, received: playout.received });
		if (playout.finished) break;
	}
	return frames;
}

/** Burst sizes and gaps measured from `omp -p --mode json` with claude-opus-5-5, repeated with their jitter. */
const SIZES = [151, 135, 188, 138, 133, 114, 143, 188, 141, 129, 160, 152, 117, 146, 139];
const GAPS = [609, 626, 629, 618, 683, 576, 623, 658, 641, 612, 927, 604, 637, 615];

/** Text bursts as single-block updates, starting at `start`. Returns the updates and when each burst landed. */
function textBursts(start: number, sizes = SIZES, gaps = GAPS, before: PlayoutBlock[] = []): { updates: Update[]; arrivals: { at: number; total: number }[] } {
	const updates: Update[] = [];
	const arrivals: { at: number; total: number }[] = [];
	let at = start;
	let total = 0;
	for (const [index, size] of sizes.entries()) {
		total += size;
		updates.push({ at, blocks: [...before, { length: total, timed: true }] });
		arrivals.push({ at, total });
		at += gaps[index % gaps.length] ?? 630;
	}
	return { updates, arrivals };
}

/** Longest time the shown text stays unchanged while text is waiting to show, from `after` on. */
function longestStall(frames: readonly Frame[], after: number): number {
	let longest = 0;
	let since = Number.NaN;
	for (const [index, frame] of frames.entries()) {
		const previous = frames[index - 1];
		if (frame.at < after || !previous) continue;
		const waiting = previous.received - previous.shown >= 1;
		if (Math.floor(frame.shown) !== Math.floor(previous.shown) || !waiting) since = Number.NaN;
		else {
			if (Number.isNaN(since)) since = previous.at;
			longest = Math.max(longest, frame.at - since);
		}
	}
	return longest;
}

/** When the reveal first shows at least `chars` characters. */
function shownAt(frames: readonly Frame[], chars: number): number {
	return frames.find(frame => frame.shown >= chars)?.at ?? Number.POSITIVE_INFINITY;
}

describe("Playout", () => {
	it("reveals bursty text continuously at the incoming rate with a bounded delay", () => {
		const { updates, arrivals } = textBursts(0);
		const last = arrivals.at(-1);
		if (!last) throw new Error("no bursts");
		const doneAt = last.at + 40;
		const frames = simulate(updates, doneAt);

		// Nothing shows during priming, then the text never sits still while some is waiting.
		expect(shownAt(frames, 1)).toBeGreaterThanOrEqual(PRIME_MS);
		expect(longestStall(frames, PRIME_MS + 100)).toBeLessThanOrEqual(50);

		// Each second after the buffer settles reveals within 20% of what omp delivers per second.
		const incoming = (last.total - (arrivals[0]?.total ?? 0)) / (last.at - (arrivals[0]?.at ?? 0));
		for (let start = 2000; start + 1000 <= last.at; start += 1000) {
			const revealed = (frames.find(frame => frame.at >= start + 1000)?.shown ?? 0) - (frames.find(frame => frame.at >= start)?.shown ?? 0);
			expect(Math.abs(revealed / 1000 - incoming) / incoming).toBeLessThanOrEqual(0.2);
		}

		// Every character shows within 1.5s of arriving.
		for (const arrival of arrivals) expect(shownAt(frames, arrival.total) - arrival.at).toBeLessThanOrEqual(1500);

		// After message_end the rest drains within about 0.6s, without slowing down at the end.
		const end = frames.at(-1);
		expect(end?.shown).toBe(last.total);
		expect((end?.at ?? 0) - doneAt).toBeLessThanOrEqual(DRAIN_MS + 50);
		const tail = frames.filter(frame => frame.at >= doneAt);
		const steps = tail.slice(1).map((frame, index) => frame.shown - (tail[index]?.shown ?? 0));
		for (let index = 1; index < steps.length - 1; index++) expect(steps[index] ?? 0).toBeGreaterThanOrEqual((steps[index - 1] ?? 0) * 0.9);
	});

	it("stops during a long pause and resumes without a jump in speed", () => {
		const first = textBursts(0, SIZES.slice(0, 7), GAPS);
		const resumeAt = (first.arrivals.at(-1)?.at ?? 0) + 4800;
		const second = textBursts(resumeAt, SIZES.slice(7), GAPS);
		const offset = first.arrivals.at(-1)?.total ?? 0;
		const updates = [...first.updates, ...second.updates.map(update => ({ at: update.at, blocks: [{ length: (update.blocks[0]?.length ?? 0) + offset, timed: true }] }))];
		const frames = simulate(updates, (second.arrivals.at(-1)?.at ?? 0) + 40);

		// During the pause the reveal catches up and then holds still.
		const paused = frames.filter(frame => frame.at > resumeAt - 1500 && frame.at < resumeAt);
		expect(paused.at(-1)?.shown).toBe(offset);
		// After the pause it starts again after priming, never stalls, and never lurches.
		expect(shownAt(frames, offset + 1)).toBeGreaterThanOrEqual(resumeAt + PRIME_MS);
		expect(longestStall(frames, resumeAt + PRIME_MS + 100)).toBeLessThanOrEqual(50);
		const resumed = frames.filter(frame => frame.at >= resumeAt && frame.at < resumeAt + 3000);
		for (const [index, frame] of resumed.entries()) {
			const previous = resumed[index - 1];
			if (previous) expect(frame.shown - previous.shown).toBeLessThanOrEqual(12);
		}
	});

	it("gives a collapsed thinking block no time, so the reply starts as soon as without it", () => {
		const plain = simulate(textBursts(3000).updates, 20_000);
		const thinking = Array.from({ length: 5 }, (_, index) => ({ at: index * 600, blocks: [{ length: (index + 1) * 150, timed: false }] }));
		const withThinking = simulate([...thinking, ...textBursts(3000, SIZES, GAPS, [{ length: 750, timed: false }]).updates], 20_000);
		expect(Math.abs(shownAt(withThinking, 1) - shownAt(plain, 1))).toBeLessThanOrEqual(FRAME);
	});

	it("shows text present at a synchronization in full and paces only what arrives after", () => {
		const playout = new Playout([{ length: 4000, timed: true }], true);
		playout.step(0);
		expect(playout.shown).toBe(4000);
		playout.receive([{ length: 4140, timed: true }], 10, false);
		playout.step(10 + FRAME);
		expect(playout.shown).toBe(4000);
	});

	it("starts a reply that arrives in a live chat from nothing", () => {
		const playout = new Playout([{ length: 140, timed: true }], false);
		playout.receive([{ length: 140, timed: true }], 0, false);
		playout.step(0);
		expect(playout.shown).toBe(0);
		expect(playout.visible(0)).toBe(0);
	});
});

describe("synchronizedStream", () => {
	it("treats a stream first seen while the mirror connects or reconnects as synchronizing", () => {
		expect(synchronizedStream("live", null)).toBe(true);
		expect(synchronizedStream("live", "connecting")).toBe(true);
		expect(synchronizedStream("reconnecting", "live")).toBe(true);
		expect(synchronizedStream("live", "reconnecting")).toBe(true);
		expect(synchronizedStream("live", "live")).toBe(false);
	});
});

describe("revealedPrefix", () => {
	it("never ends between the halves of a surrogate pair", () => {
		const text = "ab🦀cd";
		expect(revealedPrefix(text, 3)).toBe("ab🦀");
		expect(revealedPrefix(text, 2.9)).toBe("ab");
		expect(revealedPrefix(text, 99)).toBe(text);
	});
});
