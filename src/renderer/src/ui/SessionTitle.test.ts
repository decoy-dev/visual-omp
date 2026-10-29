import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionTitle } from "./SessionTitle";

const render = (title: string) => renderToStaticMarkup(createElement(SessionTitle, { title }));

describe("session title presentation", () => {
	it("renders an emoji, a code chip and separate title text", () => {
		const html = render("👩🏽‍💻 FIX: Repair parser");
		expect(html).toContain("👩🏽‍💻");
		expect(html).toContain('class="truncate">FIX</span>');
		expect(html).toContain('class="min-w-0 truncate">Repair parser</span>');
		expect(html).toContain('title="👩🏽‍💻 FIX: Repair parser"');
	});

	it.each(["\uE000", "\uF8FF", "\u{F0000}", "\u{100000}"])("removes terminal-only icons but keeps their code chip: %s", icon => {
		const html = render(`${icon} NF: Repair \u{F0001}parser`);
		expect(html).not.toMatch(/\p{Co}/u);
		expect(html).toContain('class="truncate">NF</span>');
		expect(html).toContain('title="NF: Repair parser"');
		expect(html).toContain('class="min-w-0 truncate">Repair parser</span>');
	});

	it("keeps plain or malformed card titles as one text label", () => {
		for (const title of ["Fix: the parser", "🧪 lower: Repair parser"]) {
			const html = render(title);
			expect(html).toContain(`>${title}</span>`);
			expect(html).not.toContain("font-mono");
		}
	});

	it("escapes title text and strips private-use glyphs in plain labels too", () => {
		const html = render("<script>\uF013unsafe</script>");
		expect(html).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).not.toMatch(/\p{Co}/u);
	});
});
