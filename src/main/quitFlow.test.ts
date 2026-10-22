import { describe, expect, it } from "vitest";
import { quitAction } from "./quitFlow";

const state = { approved: false, hasWindow: true, ompRunning: true, reopening: false };

describe("quitAction", () => {
	it("asks the open window, and lets an approved quit go ahead", () => {
		expect(quitAction(state)).toBe("ask");
		expect(quitAction({ ...state, approved: true })).toBe("proceed");
		expect(quitAction({ ...state, approved: true, hasWindow: false })).toBe("proceed");
		expect(quitAction({ ...state, approved: true, reopening: true })).toBe("proceed");
	});

	it("reopens a closed macOS window to ask while omp runs, and holds a second quit while it loads", () => {
		expect(quitAction({ ...state, hasWindow: false })).toBe("reopen");
		// createWindow() sets the window at once, so while it loads both flags are set: the loaded window asks.
		expect(quitAction({ ...state, hasWindow: true, reopening: true })).toBe("hold");
	});

	it("quits without a window when no omp runs, since nothing would be interrupted", () => {
		expect(quitAction({ ...state, hasWindow: false, ompRunning: false })).toBe("proceed");
	});
});
