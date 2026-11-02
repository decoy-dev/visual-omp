import { describe, expect, it, vi } from "vitest";
import type { SessionController } from "../../state/session";
import { fuzzyFiles, mentionAtCaret, mentionRanges } from "./fuzzy";
import { applyMode, deliver, imageMessageBytes, tspComposerReason } from "./send";

describe("mentionAtCaret", () => {
	it("opens only for an @ at the start or after whitespace", () => {
		expect(mentionAtCaret("look at @src/ap", 15)).toEqual({ start: 8, query: "src/ap" });
		expect(mentionAtCaret("@", 1)).toEqual({ start: 0, query: "" });
		expect(mentionAtCaret("mail me@example", 15)).toBeNull();
	});

	it("closes once the caret leaves the token", () => {
		expect(mentionAtCaret("@src/app.ts done", 16)).toBeNull();
	});
});

describe("mentionRanges", () => {
	it("finds each @path token, not email addresses", () => {
		const text = "fix @a.ts and me@x.com\n@b/c.md";
		expect(mentionRanges(text).map(range => text.slice(range.start, range.end))).toEqual(["@a.ts", "@b/c.md"]);
	});
});

describe("fuzzyFiles", () => {
	const files = ["src/renderer/src/chat/composer/Composer.tsx", "docs/composition.md", "src/main/index.ts", "compose.yml"];

	it("ranks a file-name match above a path spread across folders", () => {
		expect(fuzzyFiles(files, "composer")[0]?.path).toBe("src/renderer/src/chat/composer/Composer.tsx");
		expect(fuzzyFiles(files, "index")[0]?.path).toBe("src/main/index.ts");
	});

	it("drops paths missing a query character in order", () => {
		expect(fuzzyFiles(files, "zzz")).toEqual([]);
		expect(fuzzyFiles(files, "yml").map(match => match.path)).toEqual(["compose.yml"]);
	});
});

describe("applyMode", () => {
	it("prefixes like omp's editor without doubling an existing sigil", () => {
		expect(applyMode(" ls -la ", "shell")).toBe("!ls -la");
		expect(applyMode("!!git status", "shell")).toBe("!!git status");
		expect(applyMode("print(1)", "python")).toBe("$ print(1)");
		expect(applyMode("$$ x = 2", "python")).toBe("$$ x = 2");
		// `$HOME` is prose to omp, so Python mode still needs its own sigil.
		expect(applyMode("$HOME", "python")).toBe("$ $HOME");
		expect(applyMode("hello", null)).toBe("hello");
	});
});

describe("imageMessageBytes", () => {
	it("escapes paths the way omp un-escapes them and submits after the text", () => {
		expect(imageMessageBytes(["/tmp/Screen Shot (1).png", "/a/b.jpg"], "what is this?")).toBe(
			"\x1b[200~/tmp/Screen\\ Shot\\ \\(1\\).png /a/b.jpg\x1b[201~\x1b[200~what is this?\x1b[201~\r",
		);
	});

	it("never sends an empty paste (omp reads the clipboard on one)", () => {
		expect(imageMessageBytes(["/a.png"], "")).toBe("\x1b[200~/a.png\x1b[201~\r");
	});
});

describe("approval denial delivery", () => {
	it("steers an explanation while an approval is pending, including an idle collab snapshot", async () => {
		const steer = vi.fn();
		const send = vi.fn();
		const session = { getSnapshot: () => ({ working: false, guest: { uiRequest: { reqId: 7 } } }), steer, send } as unknown as SessionController;
		await deliver(session, "Read the scripts first.", [], true);
		expect(steer).toHaveBeenCalledExactlyOnceWith("Read the scripts first.", []);
		expect(send).not.toHaveBeenCalled();
	});
});

describe("semantic composer availability", () => {
	it("uses the localized question card hint for a matched hook without changing other overlay reasons", () => {
		const questionHint = "Answer the question card before sending a message.";
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: false, reason: "main fallback", reasonCode: "matched-question" } }, questionHint)).toBe(questionHint);
		const reason = "Close the open omp menu before sending a message.";
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: false, reason } }, questionHint)).toBe(reason);
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: true, reason: null } }, questionHint)).toBeNull();
		expect(tspComposerReason({ transport: "classic" }, questionHint)).toBeNull();
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: false, reason: "rich ask", reasonCode: "ask-editor" } }, questionHint, 7)).toBeNull();
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: false, reason: "rich ask", reasonCode: "ask-editor" } }, questionHint)).toBe(questionHint);
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: false, reason: "hook", reasonCode: "matched-question", questionReqId: 7 } }, questionHint, 7)).toBeNull();
		expect(tspComposerReason({ transport: "tsp", tspAvailability: { available: false, reason: "hook", reasonCode: "matched-question", questionReqId: 8 } }, questionHint, 7)).toBe(questionHint);
	});
});
