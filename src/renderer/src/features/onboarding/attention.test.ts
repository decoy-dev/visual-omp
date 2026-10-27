import { describe, expect, it } from "vitest";
import { type ChatVisibility, overlayLabel, reconcileUnseen, recordUnseen, restoreUnseen, shorten, shownChatIds, type UnseenChats } from "./attention";

const background: ChatVisibility = { focused: false, openChatIds: ["a", "b"], shownChatIds: ["a"] };
const focused: ChatVisibility = { ...background, focused: true };

describe("unseen chat results", () => {
	it("does not count a finish while the chat is shown and focused", () => {
		expect(recordUnseen({}, "a", "finished", focused)).toEqual({});
	});

	it("counts a finish while another chat is shown", () => {
		expect(recordUnseen({}, "b", "finished", focused)).toEqual({ b: "finished" });
	});

	it("counts a finish in a shown chat while unfocused or minimized", () => {
		expect(recordUnseen({}, "a", "finished", background)).toEqual({ a: "finished" });
	});

	it("counts each chat once and updates the reason when it asks for an answer", () => {
		const first = recordUnseen({}, "a", "finished", background);
		expect(recordUnseen(first, "a", "finished", background)).toBe(first);
		const asking = recordUnseen(first, "a", "needsInput", background);
		expect(asking).toEqual({ a: "needsInput" });
		expect(recordUnseen(asking, "b", "needsInput", background)).toEqual({ a: "needsInput", b: "needsInput" });
	});

	it("opening a chat clears only that chat", () => {
		const chats: UnseenChats = { a: "finished", b: "needsInput" };
		expect(reconcileUnseen(chats, focused)).toEqual({ b: "needsInput" });
		expect(reconcileUnseen(chats, background)).toBe(chats);
	});

	it("focus alone clears nothing when no chat is shown", () => {
		const chats: UnseenChats = { a: "finished", b: "needsInput" };
		expect(reconcileUnseen(chats, { ...focused, shownChatIds: [] })).toBe(chats);
	});

	it("both split halves count as shown", () => {
		const split = { ...focused, shownChatIds: shownChatIds("chat", "a", "b") };
		expect(recordUnseen({}, "b", "finished", split)).toEqual({});
		expect(reconcileUnseen({ a: "finished", b: "needsInput" }, split)).toEqual({});
	});

	it.each(["home", "page", "project"])("keeps results unseen while %s covers the chats", view => {
		const context = { ...focused, shownChatIds: shownChatIds(view, "a", "b") };
		expect(recordUnseen({}, "a", "finished", context)).toEqual({ a: "finished" });
	});

	it("keeps results unseen while the expanded side panel covers the chats", () => {
		expect(shownChatIds("chat", "a", "b", true)).toEqual([]);
	});

	it("drops closed chats and ignores their late events", () => {
		const context = { ...background, openChatIds: ["b"] };
		expect(reconcileUnseen({ a: "finished", b: "needsInput" }, context)).toEqual({ b: "needsInput" });
		expect(recordUnseen({}, "a", "finished", context)).toEqual({});
	});

	it("validates saved reasons and retains only restored tabs", () => {
		expect(restoreUnseen({ a: "finished", b: "needsInput", closed: "finished", damaged: true }, ["a", "b", "damaged"])).toEqual({
			a: "finished", b: "needsInput",
		});
		expect(restoreUnseen(null, ["a"])).toEqual({});
		expect(restoreUnseen(["finished"], ["0"])).toEqual({});
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
