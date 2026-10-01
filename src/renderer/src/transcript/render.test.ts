import { describe, expect, it } from "vitest";
import { MarkdownBlocks, renderMarkdown } from "./render";

const corpus: Record<string, string> = {
	prose: "Plain **bold**, _em_, `code` and ~~gone~~.\nA soft break follows.\n\nSecond paragraph with a bare link https://example.com and an emoji 🦀.",
	headings: "# Title\n\nSetext heading\n==============\n\n## Sub\ntext right under it\n\n---\n\n#### Small",
	lists:
		"- one\n- two\n  - nested **a**\n  - nested b\n- three\n\n1. first\n2. second\n\n   continued in a loose item\n3. third\n\n- [ ] task\n- [x] done\n\nAfter the list.",
	fences:
		"Before\n\n```ts\nconst a = 1;\n\n\nconst b = 2; // two blank lines above\n```\n\n~~~\nplain fence\n~~~\n\n    indented code\n    block\n\nAfter",
	unterminatedFence: "Intro\n\n```python\ndef f():\n\n    return 1",
	paragraphMerges: "A paragraph\n    indented, so it continues the paragraph\n[ref]: https://example.com/merged\nstill the paragraph\n\n[ref]\n\n[ref]: https://example.com/real",
	table: "| Name | Value |\n| :--- | ---: |\n| a | `1` |\n| b | **2** |\n\nText after the table.",
	math: "Inline $x^2 + y^2$ and \\(a+b\\).\n\n$$\n\\frac{1}{2}\n$$\n\nAttached $$\\sum_i i$$ display.\n\n\\[\nE = mc^2\n\n\\]\n\nPrice is $5 and $6.",
	mathAcrossBlocks: "Lead in\n\n$$\n\\begin{aligned}\n\na &= 1\n\n- b &= 2\n\n# c\n\n\\end{aligned}\n$$\n\nAfter the display block.",
	referenceLinks:
		'See [the docs][docs] and [inline](https://example.com "Title").\n\nAlso [docs] again.\n\n[docs]: https://example.com/docs\n[docs]: https://example.com/second\n\nUnsafe [bad](javascript:alert(1)).',
	rawHtml: '<div class="x">block html</div>\n\nInline <b>bold</b> and <span>dropped</span> and <script>alert(1)</script>.\n\n&lt;already escaped&gt; &amp; &#x41;',
	blockquote: "> quoted line\nlazy continuation\n> > nested\n\n> second quote\n\nAfter",
	crlf: "Line one\r\nLine two\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n",
};

const joined = (blocks: MarkdownBlocks, text: string) =>
	blocks
		.render(text)
		.map(block => block.html)
		.join("");

describe("MarkdownBlocks", () => {
	it.each(Object.entries(corpus))("joins to the full parse for %s", (_name, text) => {
		expect(joined(new MarkdownBlocks(), text)).toBe(renderMarkdown(text));
	});

	it.each(Object.entries(corpus))("matches the full parse at every prefix of %s as it streams", (_name, text) => {
		const blocks = new MarkdownBlocks();
		for (let end = 0; end <= text.length; end++) {
			const prefix = text.slice(0, end);
			expect(joined(blocks, prefix)).toBe(renderMarkdown(prefix));
		}
	});

	it("matches the full parse for a long reply streamed in uneven chunks", () => {
		const text = Object.values(corpus).join("\n\n");
		const blocks = new MarkdownBlocks();
		for (let end = 0, step = 1; end < text.length; end += step, step = (step % 37) + 3) {
			const prefix = text.slice(0, end);
			expect(joined(blocks, prefix)).toBe(renderMarkdown(prefix));
		}
		expect(joined(blocks, text)).toBe(renderMarkdown(text));
	});

	it("matches the full parse after the text is replaced instead of extended", () => {
		const blocks = new MarkdownBlocks();
		blocks.render("# One\n\n- a\n- b\n\nfirst reply");
		const next = "Second reply with [a][x]\n\n[x]: https://example.com";
		expect(joined(blocks, next)).toBe(renderMarkdown(next));
	});

	it("keeps the keys of finished blocks while the last block grows", () => {
		const blocks = new MarkdownBlocks();
		const before = blocks.render("# Title\n\n- a\n- b\n\nGrowing para");
		const after = blocks.render("# Title\n\n- a\n- b\n\nGrowing paragraph text");
		expect(after.slice(0, -1).map(block => block.key)).toEqual(before.slice(0, -1).map(block => block.key));
		expect(after.at(-1)?.key).not.toBe(before.at(-1)?.key);
	});
});
