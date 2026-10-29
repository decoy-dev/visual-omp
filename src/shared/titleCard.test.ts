import { describe, expect, it } from "vitest";
import { sessionTitleText, splitCardTitle, stripPrivateUseGlyphs } from "./titleCard";

describe("omp title card splitting", () => {
	it("splits the exact icon, code and title form", () => {
		expect(splitCardTitle("🧪 FLAKY: Fix flaky park tests")).toEqual({ icon: "🧪", code: "FLAKY", title: "Fix flaky park tests" });
		expect(splitCardTitle("漢 Z3: Fix: the parser")).toEqual({ icon: "漢", code: "Z3", title: "Fix: the parser" });
	});

	it.each(["Fix: the parser", "Plain title", "", "FLAKY: Fix tests", "A Z3: Title", "#️⃣ KEY: Title", "🧪 lower: Title", "🧪 TOOLONG: Title", "🧪 A_B: Title", "🧪 : Title", "🧪  Z3: Title", "🧪 Z3:Title", "🧪 Z3:  Title", "🧪 Z3: ", " 🧪 Z3: Title", "🧪 Z3: First\nsecond", "😀😀😀😀😀😀😀😀😀 Z3: Title"])("leaves an invalid or plain title whole: %s", title => {
		expect(splitCardTitle(title)).toBeUndefined();
	});

	it.each(["👩🏽‍💻", "🏳️‍🌈", "🇺🇸", "🗄️", "👨‍👩‍👧‍👦", "😀😀😀😀😀😀😀😀"])("counts Unicode codepoints without breaking sequences: %s", icon => {
		expect(splitCardTitle(`${icon} Z3: Title`)).toEqual({ icon, code: "Z3", title: "Title" });
	});

	it.each(["\uE000", "\uF8FF", "\u{F0000}", "\u{FFFFD}", "\u{100000}", "\u{10FFFD}"])("recognizes private-use icons before display sanitization: %s", icon => {
		expect(splitCardTitle(`${icon} NF: Title`)).toEqual({ icon, code: "NF", title: "Title" });
		expect(sessionTitleText(`${icon} NF: Title`)).toBe("NF: Title");
	});
});

describe("terminal glyph display sanitization", () => {
	it("removes all private-use ranges anywhere in a title", () => {
		expect(stripPrivateUseGlyphs("A\uE000B\uF8FFC\u{F0000}D\u{FFFFD}E\u{100000}F\u{10FFFD}G")).toBe("ABCDEFG");
		expect(sessionTitleText("\uF013 FIX: Fix \u{F0001}parser")).toBe("FIX: Fix parser");
	});
	it("removes a private icon's presentation selector without damaging adjacent emoji", () => {
		expect(stripPrivateUseGlyphs("\uF013️ 👩🏽‍💻 🗄️")).toBe(" 👩🏽‍💻 🗄️");
	});
	it("preserves plain text, punctuation, non-private Unicode and emoji sequences", () => {
		const title = "Fix: café 漢字 👩🏽‍💻 🇺🇸 🗄️";
		expect(sessionTitleText(title)).toBe(title);
		expect(stripPrivateUseGlyphs("\uD7FF\uF900\u{EFFFF}\u{FFFFE}\u{10FFFF}")).toBe("\uD7FF\uF900\u{EFFFF}\u{FFFFE}\u{10FFFF}");
	});
	it("keeps an invalid card's text rather than guessing its pieces", () => {
		expect(sessionTitleText("\uF013 invalid: Keep the whole title")).toBe("invalid: Keep the whole title");
		expect(sessionTitleText("🧪 lower: Keep the whole title")).toBe("🧪 lower: Keep the whole title");
	});
});
