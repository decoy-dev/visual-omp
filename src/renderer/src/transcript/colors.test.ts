// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ColorText } from "./ColorText";
import { colorTextHtml, decorateColors } from "./colors";
import { MarkdownBlocks, renderMarkdown } from "./render";

const parse = (html: string) => {
	const root = document.createElement("div");
	root.innerHTML = html;
	return root;
};
const swatches = (html: string) => [...parse(html).querySelectorAll(".vomp-color-swatch")];

describe("inline color swatches", () => {
	it("decorates full hex values in prose and all hex lengths in inline code", () => {
		const source = "Use #aAbBcc, #12345678 and `#123 #abcd #FfF #1234 #112233 #11223344`.";
		const html = renderMarkdown(source);
		expect(swatches(html).map(node => node.getAttribute("title"))).toEqual(["#AABBCC", "#12345678", "#112233", "#AABBCCDD", "#FFFFFF", "#11223344", "#112233", "#11223344"]);
		expect(swatches(html).every(node => node.getAttribute("aria-hidden") === "true" && node.textContent === "")).toBe(true);
		expect(parse(html).textContent).toBe("Use #aAbBcc, #12345678 and #123 #abcd #FfF #1234 #112233 #11223344.\n");
	});

	it.each([
		"Issue #123, PR #1234, issue #abc and #abcd.",
		"#12 #12345 #1234567 #123456789 #12345g #abcdefg #abcdef_suffix #abcdef-name",
		"word#abcdef /tmp/#abcdef.svg https://example.com/#abcdef https://example.com?color=#abcdef",
		"`https://example.com/#abcdef /tmp/#aabbcc`",
		"```css\na { color: #aabbcc; }\n```",
		"~~~css\n#aabbcc\n~~~",
		"    color: #aabbcc",
		"[link](https://example.com/#aabbcc \"#aabbcc\")",
		"![#aabbcc](image.png)",
		"&#123456; &#x123456;",
		"## Heading {#abcdef}",
	])("leaves excluded text unchanged: %s", source => {
		expect(swatches(renderMarkdown(source))).toHaveLength(0);
	});

	it("decorates link labels and headings without changing destinations", () => {
		const root = parse(renderMarkdown("## Color #aabbcc\n\n[Use #123456](https://example.com/#aabbcc)"));
		expect(root.querySelector("h2 .vomp-color-swatch")).not.toBeNull();
		expect(root.querySelector("a .vomp-color-swatch")).not.toBeNull();
		expect(root.querySelector("a")?.getAttribute("href")).toBe("https://example.com/#aabbcc");
	});

	it("preserves autolink display text, including mail and www prefixes", () => {
		const root = parse(renderMarkdown("www.example.com/#aabbcc and <color@example.com>"));
		expect(root.textContent).toBe("www.example.com/#aabbcc and color@example.com\n");
		expect(root.querySelectorAll(".vomp-color-swatch")).toHaveLength(0);
	});

	it("keeps streaming and saved Markdown identical as a color arrives", () => {
		const blocks = new MarkdownBlocks();
		const source = "Use **#aabbcc**, `#1234` or #12345678.\n\n```css\n#aabbcc\n```";
		for (let end = 0; end <= source.length; end++) {
			const text = source.slice(0, end);
			expect(blocks.render(text).map(block => block.html).join("")).toBe(renderMarkdown(text));
		}
	});

	it("preserves literal question punctuation and escaped text while decorating inline code", () => {
		const text = "Use **#aabbcc** or `#123`, with <script>#11223344</script> & issue #123?";
		const root = parse(renderToStaticMarkup(createElement(ColorText, { text })));
		expect(root.textContent).toBe(text);
		expect(root.querySelector("script")).toBeNull();
		expect(root.querySelectorAll(".vomp-color-swatch")).toHaveLength(3);
	});

	it("does not decorate fenced code in plain question text", () => {
		const text = "Before #aabbcc\n```css\n#123456\n```\nAfter `#abc`";
		const html = colorTextHtml(text);
		expect(parse(html).textContent).toBe(text);
		expect(swatches(html).map(node => node.getAttribute("title"))).toEqual(["#AABBCC", "#AABBCC"]);
	});
});

it.each(["```", "~~~~"])("resumes plain-text colors after a longer %s closing fence", opener => {
	const text = `Before #aabbcc\n${opener}css\n#123456\n${opener}${opener[0]}\nAfter #112233`;
	const root = parse(colorTextHtml(text));
	expect(root.textContent).toBe(text);
	expect([...root.querySelectorAll(".vomp-color-swatch")].map(node => node.getAttribute("title"))).toEqual(["#AABBCC", "#112233"]);
});

it.each(["```", "~~~"])("keeps every line of a closed %s fence undecorated", opener => {
	const text = `Before #aabbcc\n${opener}css\nfirst line\n#112233\n#445566\n${opener}\nAfter #778899`;
	const root = parse(colorTextHtml(text));
	expect(root.textContent).toBe(text);
	expect([...root.querySelectorAll(".vomp-color-swatch")].map(node => node.getAttribute("title"))).toEqual(["#AABBCC", "#778899"]);
});

it.each([
	"```css\nfirst line\n#112233\n#445566",
	"~~~css\nfirst line\n#112233\n#445566",
	"```css\nfirst line\n```~~~\n#112233",
	"~~~css\nfirst line\n~~~```\n#112233",
	"````css\nfirst line\n```\n#112233",
])("keeps unfinished fences and mixed-character pseudo-closers undecorated: %s", text => {
	const root = parse(colorTextHtml(text));
	expect(root.textContent).toBe(text);
	expect(root.querySelectorAll(".vomp-color-swatch")).toHaveLength(0);
});

it("decorates many colors after a long unbroken prefix in bounded time", () => {
	const text = `${"x".repeat(200_000)}${" #aabbcc".repeat(2_000)}`;
	const start = performance.now();
	const html = decorateColors(text);
	expect(performance.now() - start).toBeLessThan(2_000);
	expect(html.match(/class="vomp-color-swatch"/g)).toHaveLength(2_000);
});
