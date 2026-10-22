import { describe, expect, it } from "vitest";
import { anchorRow, tailStart, WINDOW, WINDOW_STEP, windowOnScroll } from "./window";

describe("tailStart", () => {
	it("draws the whole chat until it outgrows a window and a step", () => {
		expect(tailStart(0)).toBe(0);
		expect(tailStart(WINDOW)).toBe(0);
		expect(tailStart(WINDOW + WINDOW_STEP - 1)).toBe(0);
		expect(tailStart(WINDOW + WINDOW_STEP)).toBe(WINDOW_STEP);
	});

	it("keeps the start while a turn adds entries, then moves it on by a whole step", () => {
		// A sent message lands with the entries omp saved before it: the window's first rows stay put.
		expect(tailStart(306)).toBe(tailStart(300));
		const starts = new Set<number>();
		for (let count = 400; count < 400 + WINDOW_STEP * 3; count++) starts.add(tailStart(count));
		expect([...starts]).toEqual([280, 320, 360]);
	});

	it("never draws fewer than a window or more than a window and a step", () => {
		for (let count = WINDOW; count < 2000; count++) {
			const drawn = count - tailStart(count);
			expect(drawn).toBeGreaterThanOrEqual(WINDOW);
			expect(drawn).toBeLessThan(WINDOW + WINDOW_STEP);
			expect(tailStart(count + 1)).toBeGreaterThanOrEqual(tailStart(count));
		}
	});
});

describe("windowOnScroll", () => {
	const still = { release: false, hold: false, earlier: false };

	it("does nothing to a short window that is at the bottom and near the top at once", () => {
		// The window used to drop back to the tail here and load the previous window on the next scroll event, forever.
		for (const held of [false, true]) expect(windowOnScroll({ wasPinned: true, pinned: true, held, nearTop: true })).toEqual(still);
	});

	it("releases a held window when the reader comes back to the end", () => {
		expect(windowOnScroll({ wasPinned: false, pinned: true, held: true, nearTop: true })).toEqual({ ...still, release: true });
		expect(windowOnScroll({ wasPinned: false, pinned: true, held: false, nearTop: false })).toEqual(still);
	});

	it("keeps a window the reader loaded while the view stays pinned", () => {
		// "Show earlier messages" in a chat that fits on screen: the view is still at the bottom afterwards.
		expect(windowOnScroll({ wasPinned: true, pinned: true, held: true, nearTop: false })).toEqual(still);
	});

	it("holds the window once the reader scrolls up, and loads earlier entries near the top", () => {
		expect(windowOnScroll({ wasPinned: true, pinned: false, held: false, nearTop: false })).toEqual({ ...still, hold: true });
		expect(windowOnScroll({ wasPinned: false, pinned: false, held: false, nearTop: true })).toEqual({ ...still, hold: true, earlier: true });
		expect(windowOnScroll({ wasPinned: false, pinned: false, held: true, nearTop: true })).toEqual({ ...still, earlier: true });
	});
});

describe("anchorRow", () => {
	const row = (top: number, height: number) => ({ top, bottom: top + height });

	it("keeps the lowest row that starts inside the view", () => {
		const rows = [row(-200, 150), row(-40, 120), row(90, 200), row(300, 100), row(500, 300), row(900, 50)];
		expect(anchorRow(rows, 0, 684)).toBe(4);
	});

	it("passes over empty rows", () => {
		const rows = [row(-40, 120), row(100, 60), row(400, 0)];
		expect(anchorRow(rows, 0, 684)).toBe(1);
	});

	it("falls back to the row across the top of the view", () => {
		const rows = [row(-300, 200), row(-100, 1200), row(1100, 40)];
		expect(anchorRow(rows, 0, 684)).toBe(1);
	});

	it("finds nothing when no drawn row is in view", () => {
		expect(anchorRow([row(-300, 200), row(800, 100)], 0, 684)).toBe(-1);
		expect(anchorRow([], 0, 684)).toBe(-1);
	});
});
