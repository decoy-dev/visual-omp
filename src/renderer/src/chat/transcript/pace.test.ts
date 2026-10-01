import { describe, expect, it } from "vitest";
import { type Arrival, initialPacedText, LAG_MS, revealedPrefix, revealStep, synchronizedStream } from "./pace";

const FRAME = 1000 / 60;

/** Runs frames from `start` until `end`, feeding `arrivals` as their time comes, and records what shows. */
function simulate(arrivals: Arrival[], end: number): { at: number; shown: number }[] {
	const frames: { at: number; shown: number }[] = [];
	let shown = 0;
	let last = 0;
	for (let now = FRAME; now <= end; now += FRAME) {
		const received = arrivals.filter(arrival => arrival.at <= now);
		shown = revealStep(shown, received, now, now - last);
		last = now;
		frames.push({ at: now, shown });
	}
	return frames;
}

describe("revealStep", () => {
	it("types out a burst over a fraction of a second and finishes within the lag", () => {
		const frames = simulate([{ at: 0, length: 400 }], 600);
		const at = (ms: number) => frames.find(frame => frame.at >= ms)?.shown ?? 0;
		expect(at(100)).toBeGreaterThan(80);
		expect(at(100)).toBeLessThan(320);
		expect(at(LAG_MS + FRAME)).toBe(400);
	});

	it("keeps a steady stream within the lag and never moves backwards", () => {
		const arrivals = Array.from({ length: 40 }, (_, index) => ({ at: index * 70, length: (index + 1) * 35 }));
		const frames = simulate(arrivals, 3200);
		for (const [index, frame] of frames.entries()) {
			if (index > 0) expect(frame.shown).toBeGreaterThanOrEqual(frames[index - 1]?.shown ?? 0);
			const due = arrivals.filter(arrival => arrival.at + LAG_MS + FRAME <= frame.at).at(-1)?.length ?? 0;
			expect(frame.shown).toBeGreaterThanOrEqual(due);
		}
		expect(frames.at(-1)?.shown).toBe(1400);
	});

	it("shows an overdue arrival at once after a long gap between frames", () => {
		expect(revealStep(10, [{ at: 0, length: 500 }], 2000, 2000)).toBe(500);
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

describe("synchronizedStream", () => {
	it("shows the existing reply in full when saved history meets a live stream", () => {
		// The transcript had history while the room connected; its first usable guest snapshot is live.
		const reply = "An existing reply that is already long enough to span several paragraphs. ".repeat(200);
		const synchronized = synchronizedStream("live", null);
		expect(initialPacedText(reply, !synchronized, true)).toBe(reply);
		expect(synchronizedStream("live", "connecting")).toBe(true);
	});

	it("shows the existing reply in full when a room reconnects during a reply", () => {
		const reply = "An existing reply that is already long enough to span several paragraphs. ".repeat(200);
		const reconnecting = synchronizedStream("reconnecting", "live");
		expect(initialPacedText(reply, !reconnecting, true)).toBe(reply);
		const resynchronized = synchronizedStream("live", "reconnecting");
		expect(initialPacedText(reply, !resynchronized, true)).toBe(reply);
	});

	it("paces a new stream after the live mirror is already synchronized", () => {
		const synchronized = synchronizedStream("live", "live");
		expect(synchronized).toBe(false);
		expect(initialPacedText("New reply", !synchronized, true)).toBe("");
		expect(initialPacedText("New reply", false, true)).toBe("New reply");
	});
});
