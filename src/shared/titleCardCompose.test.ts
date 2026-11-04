import { describe, expect, it } from "vitest";
import { composeCardTitle, normalizeCardIcon } from "./titleCardCompose";

describe("omp title card composition", () => {
	it.each(["🧪", "👩🏽‍💻", "🏳️‍🌈", "🇺🇸", "👨‍👩‍👧‍👦"])("preserves a complete emoji sequence: %s", icon => {
		expect(normalizeCardIcon(icon)).toBe(icon);
	});
	it("normalizes presentation selectors the same way as omp", () => {
		expect(normalizeCardIcon("🗄")).toBe("🗄️");
		expect(normalizeCardIcon(" 🗄️ ")).toBe("🗄️");
		expect(normalizeCardIcon("♥")).toBe("♥️");
	});
	it.each(["", " ", "A", "1", "#️⃣", "漢", "\uE000", "\u{F0208}", "🧪🧪", "😀😀😀😀😀😀😀😀😀"])("rejects invalid icons: %s", icon => {
		expect(normalizeCardIcon(icon)).toBeUndefined();
	});
	it("rejects an RGI sequence longer than eight codepoints", () => {
		const icon = "👩🏻‍❤️‍💋‍👨🏿";
		expect(/^\p{RGI_Emoji}$/v.test(icon)).toBe(true);
		expect([...icon].length).toBeGreaterThan(8);
		expect(normalizeCardIcon(icon)).toBeUndefined();
	});
	it("composes the normalized icon, code and title", () => {
		expect(composeCardTitle("🗄", " prev1 ", " Review previews ")).toBe("🗄️ PREV1: Review previews");
		expect(composeCardTitle("🧪", "A", "Fix: the parser")).toBe("🧪 A: Fix: the parser");
		expect(composeCardTitle("🧪", "A12345", "Title")).toBe("🧪 A12345: Title");
	});
	it.each(["", "TOOLONG", "A_B", "A B", "É", "A:", "\nA\nB"])("rejects an invalid card code: %s", code => {
		expect(() => composeCardTitle("🧪", code, "Title")).toThrow();
	});
	it("refuses an invalid emoji or a title that cannot be sent as one command", () => {
		expect(() => composeCardTitle("\u{F0208}", "PREV", "Title")).toThrow();
		expect(() => composeCardTitle("🧪", "PREV", "")).toThrow();
		expect(() => composeCardTitle("🧪", "PREV", "Title\n/exit")).toThrow();
	});
});
