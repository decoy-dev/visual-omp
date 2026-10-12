import { describe, expect, it } from "vitest";
import { overlayLabel, shorten, UnseenChats } from "./attention";

const background = { focused: false, enabled: true };

describe("UnseenChats", () => {
	it("counts a chat once however often it finishes or asks", () => {
		const unseen = new UnseenChats();
		expect(unseen.record("a", background)).toBe("new");
		expect(unseen.record("a", background)).toBe("repeat");
		expect(unseen.record("a", background)).toBe("repeat");
		expect(unseen.count).toBe(1);
	});

	it("counts each chat that finished or needs an answer", () => {
		const unseen = new UnseenChats();
		unseen.record("finished", background);
		unseen.record("needs-input", background);
		expect(unseen.count).toBe(2);
	});

	it("ignores events while the window has focus", () => {
		const unseen = new UnseenChats();
		expect(unseen.record("a", { focused: true, enabled: true })).toBe("ignored");
		expect(unseen.count).toBe(0);
	});

	it("does nothing while the switch is off", () => {
		const unseen = new UnseenChats();
		expect(unseen.record("a", { focused: false, enabled: false })).toBe("ignored");
		expect(unseen.count).toBe(0);
	});

	it("forgets every chat on focus, so the next event alerts again", () => {
		const unseen = new UnseenChats();
		unseen.record("a", background);
		unseen.record("b", background);
		expect(unseen.clear()).toBe(true);
		expect(unseen.count).toBe(0);
		expect(unseen.clear()).toBe(false);
		expect(unseen.record("a", background)).toBe("new");
	});
});

describe("overlayLabel", () => {
	it("shows the count up to nine, then 9+", () => {
		expect(overlayLabel(1)).toBe("1");
		expect(overlayLabel(9)).toBe("9");
		expect(overlayLabel(10)).toBe("9+");
		expect(overlayLabel(120)).toBe("9+");
	});
});

describe("shorten", () => {
	it("keeps text that fits and cuts longer text to the limit with an ellipsis", () => {
		expect(shorten("Fix checkout", 12)).toBe("Fix checkout");
		expect(shorten("Fix checkout", 8)).toBe("Fix che…");
		expect(shorten("Fix checkout", 8)).toHaveLength(8);
	});

	it("does not split a surrogate pair", () => {
		const cut = shorten("ab😀cd", 4);
		expect(cut).toBe("ab…");
		expect(cut.length).toBeLessThanOrEqual(4);
	});
});
