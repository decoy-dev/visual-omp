import { describe, expect, it } from "vitest";
import { jumpStart, pinnedAfterScroll, ScrollLedger } from "./scrollFollow";

const THRESHOLD = 48;

describe("ScrollLedger", () => {
	it("recognizes the follow's own writes, also after layout shifted them", () => {
		const ledger = new ScrollLedger();
		ledger.wrote(1000);
		expect(ledger.read(1000, 0)).toBe("known");
		ledger.wrote(1024);
		// Rows dropped above the view before the write's scroll event arrived.
		ledger.shift(-40);
		expect(ledger.read(984, 0)).toBe("known");
	});

	it("unpins for a reader's move up that is still waiting for its scroll event when a window step shifts the view", () => {
		const ledger = new ScrollLedger();
		ledger.wrote(2522);
		// The reader presses Page Up (2522 to 2372); before the scroll event, a commit drops 32px of rows above and the
		// browser's scroll anchoring moves the view to 2340.
		ledger.shift(-32);
		const move = ledger.read(2340, 182);
		expect(move).toBe("up");
		expect(pinnedAfterScroll("up", true, 182, THRESHOLD)).toBe(false);
	});

	it("treats a move that layout alone caused as known, so a pinned view stays pinned", () => {
		const ledger = new ScrollLedger();
		expect(ledger.read(1000, 0)).toBe("other");
		// A window step dropped 40px of rows above the view while new content grew 300px below it.
		ledger.shift(-40);
		expect(ledger.read(960, 300)).toBe("known");
	});

	it("keeps a reader's move up across rows loading above the view", () => {
		const ledger = new ScrollLedger();
		expect(ledger.read(200, 5000)).toBe("other");
		// The reader goes on to 168; earlier rows mount above and the view moves down 913px to keep its rows in place.
		ledger.shift(913);
		expect(ledger.read(1081, 5000)).toBe("up");
	});

	it("leaves the pin alone when layout alone moved the view in a chat whose top and bottom are both in reach", () => {
		// Scrolled up to the top of a short window, 32px above its bottom: loading earlier rows moves the view down 913px
		// to keep them in place. Pinning here would send the window back to the latest entries and load it again.
		const ledger = new ScrollLedger();
		ledger.wrote(32);
		expect(ledger.read(0, 32)).toBe("up");
		ledger.shift(913);
		expect(ledger.read(913, 32)).toBe("known");
	});

	it("unpins when the reader scrolls up while the follow is easing toward the bottom", () => {
		const ledger = new ScrollLedger();
		ledger.wrote(1000);
		expect(ledger.read(1000, 60)).toBe("known");
		ledger.wrote(1024);
		const move = ledger.read(990, 94);
		expect(move).toBe("up");
		expect(pinnedAfterScroll("up", true, 94, THRESHOLD)).toBe(false);
	});

	it("does not count a move that ends at the bottom as a move up", () => {
		const ledger = new ScrollLedger();
		expect(ledger.read(1000, 0)).toBe("other");
		// The content shrank and the browser clamped the view to the new bottom.
		expect(ledger.read(900, 0)).toBe("other");
	});
});

describe("pinnedAfterScroll", () => {
	it("keeps a pinned view pinned through a move down, however far the bottom is", () => {
		expect(pinnedAfterScroll("other", true, 300, THRESHOLD)).toBe(true);
	});

	it("pins an unpinned view only within the threshold of the bottom", () => {
		expect(pinnedAfterScroll("other", false, THRESHOLD, THRESHOLD)).toBe(true);
		expect(pinnedAfterScroll("other", false, THRESHOLD + 1, THRESHOLD)).toBe(false);
	});

	it("unpins on a move up", () => {
		expect(pinnedAfterScroll("up", true, 200, THRESHOLD)).toBe(false);
		expect(pinnedAfterScroll("up", false, 2, THRESHOLD)).toBe(false);
	});
});

describe("jumpStart", () => {
	const GLIDE = 360;

	it("writes nothing from within the glide distance, so the follow glides the whole way", () => {
		expect(jumpStart(1700, 2000, { instant: false, glide: GLIDE })).toBeNull();
		expect(jumpStart(1640, 2000, { instant: false, glide: GLIDE })).toBeNull();
	});

	it("skips to the glide distance above the bottom from farther away", () => {
		// Far up in a long chat: the view does not scroll through the 38,000px in between.
		expect(jumpStart(200, 38_400, { instant: false, glide: GLIDE })).toBe(38_040);
	});

	it("writes the bottom at once under reduced motion", () => {
		expect(jumpStart(200, 38_400, { instant: true, glide: GLIDE })).toBe(38_400);
		expect(jumpStart(1990, 2000, { instant: true, glide: GLIDE })).toBe(2000);
	});
});
