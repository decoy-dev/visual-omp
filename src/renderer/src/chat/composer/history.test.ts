import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import { historyAtCaret, historyMode, historyOnVisualBoundary, promptHistory, PromptHistoryCursor } from "./history";

const user = (text: string, timestamp: number): SessionEntry => ({
	type: "message", id: String(timestamp), parentId: null, timestamp: new Date(timestamp).toISOString(),
	message: { role: "user", content: text, timestamp },
});
const draft = (text = "", start = text.length, end = start) => ({ text, start, end });

describe("prompt history sources", () => {
	it("uses the bubble's exact text and ignores images, synthetic prompts and replies", () => {
		const image = { type: "image" as const, data: "abc", mimeType: "image/png" };
		const entry = user("", 10);
		if (entry.type === "message" && entry.message.role === "user") entry.message.content = [{ type: "text", text: " first " }, image, { type: "text", text: "second" }];
		const synthetic = user("injected", 20);
		if (synthetic.type === "message" && synthetic.message.role === "user") synthetic.message.synthetic = true;
		expect(promptHistory([entry, synthetic], [], [], null)).toEqual([" first \nsecond"]);
	});

	it("merges transcript, sent lines and stored history without duplicate echoes", () => {
		const entries = [user("first", 2000), user("second", 5000)];
		const sent = [{ text: "first", timestamp: 1500 }, { text: "/help", timestamp: 3000 }, { text: "second", timestamp: 4500 }];
		const stored = [{ text: "first", timestamp: 1000 }, { text: "/help", timestamp: 3000 }, { text: "second", timestamp: 4000 }];
		expect(promptHistory(entries, sent, stored, null)).toEqual(["first", "/help", "second"]);
	});

	it("does not treat omp replaying old prompts into its database as new sends", () => {
		const entries = [user("first", 2000), user("second", 5000), user("first", 7000)];
		const stored = [{ text: "first", timestamp: 9000 }, { text: "second", timestamp: 9001 }, { text: "first", timestamp: 9002 }];
		expect(promptHistory(entries, [], stored, null)).toEqual(["first", "second", "first"]);
	});

	it("deduplicates consecutive sends only, retaining later repetitions", () => {
		expect(promptHistory([user("one", 1), user("one", 2), user("two", 3), user("one", 4)], [], [], null)).toEqual(["one", "two", "one"]);
	});

	it("keeps a new send when an identical old transcript message already exists", () => {
		expect(promptHistory([user("one", 1000), user("two", 2000)], [{ text: "one", timestamp: 5000 }], [], null)).toEqual(["one", "two", "one"]);
	});

	it("filters modes, retaining excluded prefixes and literal dollar words", () => {
		const sent = ["hello", "!ls", "!!pwd", "$ print(1)", "$$ print(2)", "$HOME", "/help"].map((text, timestamp) => ({ text, timestamp }));
		expect(promptHistory([], sent, [], null)).toEqual(["hello", "$HOME", "/help"]);
		expect(promptHistory([], sent, [], "shell")).toEqual(["ls", "!!pwd"]);
		expect(promptHistory([], sent, [], "python")).toEqual(["print(1)", "$$ print(2)"]);
		expect(historyMode("$HOME")).toBeNull();
	});
});

describe("prompt history navigation", () => {
	it("recalls newest first, stops at bounds, and restores exact draft and caret", () => {
		const cursor = new PromptHistoryCursor();
		const original = draft("  unfinished\nsecond line  ", 4);
		const newest = cursor.navigate("older", original, ["old", "new"], null)!;
		expect(newest).toEqual(draft("new", 0));
		const oldest = cursor.navigate("older", newest, [], null)!;
		expect(oldest).toEqual(draft("old", 0));
		expect(cursor.navigate("older", oldest, [], null)).toBeNull();
		const newer = cursor.navigate("newer", oldest, [], null)!;
		expect(newer).toEqual(draft("new"));
		expect(cursor.navigate("newer", newer, [], null)).toEqual(original);
		expect(cursor.browsing).toBe(false);
		expect(cursor.navigate("newer", original, ["old"], null)).toBeNull();
	});

	it("leaves middle lines and selected text to the native editor", () => {
		const text = "first\nmiddle\nlast";
		expect(historyAtCaret("older", draft(text, 3))).toBe(true);
		expect(historyAtCaret("older", draft(text, 7))).toBe(false);
		expect(historyAtCaret("newer", draft(text, 7))).toBe(false);
		expect(historyAtCaret("newer", draft(text, 14))).toBe(true);
		expect(historyAtCaret("older", draft(text, 0, 3))).toBe(false);
		expect(historyAtCaret("older", draft())).toBe(true);
	});

	it("uses measured visual lines for wrapped text and falls back when no mirror can be measured", () => {
		const text = "a long draft wrapped onto three visual lines";
		const mirror = {
			ownerDocument: {
				createTreeWalker: () => ({ nextNode: () => ({ textContent: text }) }),
				createRange: () => {
					let offset = 0;
					return {
						setStart: (_node: unknown, at: number) => { offset = at; },
						collapse: () => {},
						getBoundingClientRect: () => ({ top: Math.floor(offset / 15) * 24, height: 24 }),
					};
				},
			},
		} as unknown as HTMLElement;
		expect(historyOnVisualBoundary("older", draft(text, 5), mirror)).toBe(true);
		expect(historyOnVisualBoundary("older", draft(text, 20), mirror)).toBe(false);
		expect(historyOnVisualBoundary("newer", draft(text, 20), mirror)).toBe(false);
		expect(historyOnVisualBoundary("newer", draft(text, 35), mirror)).toBe(true);
		expect(historyOnVisualBoundary("older", draft(text, 20), null)).toBe(true);
		expect(historyOnVisualBoundary("older", draft("first\nsecond", 8), null)).toBe(false);
	});

	it("editing a recall ends browsing and becomes the next draft", () => {
		const cursor = new PromptHistoryCursor();
		cursor.navigate("older", draft("original"), ["old"], null);
		cursor.sync("edited", null);
		expect(cursor.restore()).toBeNull();
		cursor.navigate("older", draft("edited"), ["old"], null);
		expect(cursor.restore()).toEqual(draft("edited"));
	});

	it("Escape restores once, mode changes end browsing, and composers remain separate", () => {
		const left = new PromptHistoryCursor();
		const right = new PromptHistoryCursor();
		left.navigate("older", draft("left"), ["old"], null);
		right.navigate("older", draft("right"), ["pwd"], "shell");
		expect(left.restore()).toEqual(draft("left"));
		expect(left.restore()).toBeNull();
		right.sync("pwd", "python");
		expect(right.browsing).toBe(false);
	});

	it("uses a stable browsing list while more messages arrive", () => {
		const cursor = new PromptHistoryCursor();
		const recalled = cursor.navigate("older", draft("draft"), ["first", "second"], null)!;
		expect(cursor.navigate("older", recalled, ["first", "second", "third"], null)?.text).toBe("first");
	});
});
