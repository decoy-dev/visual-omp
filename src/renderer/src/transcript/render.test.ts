import { describe, expect, it, vi } from "vitest";
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
	rawImage: '<img src="/var/folders/.../omp-sshots-15d47b138a1e10b6.webp" alt="The previous white picker..." width="45%">',
	rawImagePair: '<img src="/tmp/first.png" alt="First"><img src="/tmp/second.png" alt="Second">',
	rawIframe: '<iframe src="https://example.com/preview" title="Preview"></iframe>',
	rawInlineIframe: 'Text <iframe src="https://example.com/inline" title="Inline report"></iframe> after.',
	blockquote: "> quoted line\nlazy continuation\n> > nested\n\n> second quote\n\nAfter",
	crlf: "Line one\r\nLine two\r\n\r\n- a\r\n- b\r\n\r\n```\r\ncode\r\n```\r\n",
	callouts: "> [!NOTE]\n> Read **this** first.\n\n> [!tip] Faster path\n> Use the cache.\n\n> [!WARNING]\n>\n> Second paragraph.\n\n> Plain quote [!NOTE]",
	numericTable: "| Model | Tokens | Cost |\n| --- | --- | --- |\n| opus | 1,204 | $3.50 |\n| kimi | `98k` | |\n\nAfter.",
	tasks: "- [ ] open\n- [x] done\n- plain\n\n1. [x] ordered\n\n- [ ] loose\n\n  with more",
	svgFigure: '```svg\n<svg viewBox="0 0 80 40"><rect width="80" height="40" fill="var(--accent)"/></svg>\n```',
	mermaidFigure: "```mermaid\nflowchart LR\nA[Start] --> B[Done]\n```",
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

describe("Markdown upgrades", () => {
	const dom = (html: string) => html.replace(/\n/g, "");

	it("frames code blocks with a language label and a copy button", () => {
		const html = dom(renderMarkdown("```ts\nconst a = 1;\n```"));
		expect(html).toContain('<div class="tr-code"><div class="tr-code-head"><span class="tr-code-lang">ts</span><button type="button" class="tr-code-copy" data-copy-code');
		expect(html).toContain('<pre><code class="language-ts">const a = 1;</code></pre></div>');
	});

	it.each(["https://evil.example/pixel?q=private", "//evil.example/pixel", "http://evil.example/pixel"])("keeps remote image %s inert before consent", href => {
		const html = renderMarkdown(`![Private preview](${href})`);
		expect(html).not.toContain("<img");
		expect(html).toContain("Private preview");
		expect(html).toContain("evil.example");
		expect(html).toContain("Load image");
	});
	it("renders raw reply images in block and inline HTML with the safe attributes", () => {
		const exact = renderMarkdown(corpus.rawImage ?? "");
		expect(exact).toContain('class="vomp-local-image"');
		expect(exact).toContain("The previous white picker...");
		expect(exact).toContain('data-image-width="45%"');
		expect(exact).not.toContain("&lt;img");
		const pair = dom(renderMarkdown(corpus.rawImagePair ?? ""));
		expect(pair.match(/class="vomp-local-image"/g)).toHaveLength(2);
		const unsafe = renderMarkdown('<img src="/tmp/pixel.png" alt="Pixel" onerror="run()" style="color:red" srcset="/tmp/large.png 2x">');
		expect(unsafe).toContain('class="vomp-local-image"');
		expect(unsafe).not.toMatch(/<(?:img|span|a)\b[^>]*(?:onerror|style|srcset)=/i);
	});

	it("renders raster data URIs with safe width and height styles", () => {
		const html = renderMarkdown('<img src="data:image/png;base64,YQ==" alt="Pixel" width="45%" height="16vh">');
		expect(html).toContain('<img class="vomp-reply-image" tabindex="0" src="data:image/png;base64,YQ==" alt="Pixel" style="max-width:100%;width:45%;height:16vh">');
		expect(renderMarkdown('<img src="data:image/webp;base64,YQ==" width="12ch">')).toContain('style="max-width:100%;width:12ch;height:auto"');
	});

	it("keeps raw HTTP images behind consent and turns iframe tags into link cards", () => {
		const remote = renderMarkdown('<img src="https://images.example/picker.webp" alt="Picker">');
		expect(remote).not.toContain("<img");
		expect(remote).toContain('class="vomp-remote-image"');
		expect(remote).toContain('data-image-alt="Picker"');
		expect(remote).toContain("Load image");
		const iframe = renderMarkdown(corpus.rawIframe ?? "");
		expect(iframe).not.toContain("<iframe");
		expect(iframe).toContain('<a class="vomp-iframe-link" href="https://example.com/preview"');
		expect(iframe).toContain(">Preview</a>");
		const inlineIframe = renderMarkdown(corpus.rawInlineIframe ?? "");
		expect(inlineIframe).not.toContain("<iframe");
		expect(inlineIframe).toContain('href="https://example.com/inline"');
		expect(inlineIframe).toContain("after.");
		const local = renderMarkdown('<iframe src="reports/index.html"></iframe>');
		expect(local).toContain('class="vomp-iframe-link"');
		expect(local).toContain('data-local-file-src="reports/index.html"');
	});

	it("escapes other raw HTML and refuses active image and iframe schemes", () => {
		const html = renderMarkdown('<div onclick="run()"><b>Bold</b></div>');
		expect(html).toContain('&lt;div onclick=&quot;run()&quot;&gt;');
		expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt;");
		const unsafe = renderMarkdown('<img src="javascript:alert(1)" alt="Blocked"><iframe src="javascript:alert(1)" title="Blocked"></iframe>');
		expect(unsafe).not.toMatch(/<(?:img|iframe)\b/i);
		expect(unsafe).not.toMatch(/(?:src|href)="javascript:/i);
	});


	it("keeps trusted data and relative images while refusing active schemes", () => {
		expect(renderMarkdown("![inline](data:image/png;base64,iVBORw0KGgo=)")).toContain("<img");
		expect(renderMarkdown("![local](assets/image.png)")).toContain("<img");
		expect(renderMarkdown("![unsafe](javascript:alert%281%29)")).not.toContain("<img");
		expect(renderMarkdown("![unsafe](data:text/html;base64,PHNjcmlwdD4=)")).not.toContain("<img");
	});

	it("wraps tables in a scroll frame and right-aligns columns that hold only numbers", () => {
		const html = dom(renderMarkdown(corpus.numericTable ?? ""));
		expect(html).toMatch(/^<div class="tr-table"><table><thead><tr><th>Model<\/th><th align="right" class="tr-num">Tokens<\/th><th align="right" class="tr-num">Cost<\/th><\/tr><\/thead>/);
		expect(html).toContain('<td>opus</td><td align="right" class="tr-num">1,204</td><td align="right" class="tr-num">$3.50</td>');
		expect(html).toContain('<td align="right" class="tr-num"><code>98k</code></td><td align="right" class="tr-num"></td>');
	});

	it("keeps an explicit column alignment over the numeric default", () => {
		expect(dom(renderMarkdown("| n |\n| :-- |\n| 1 |"))).toContain('<td align="left" class="tr-num">1</td>');
	});

	it("marks task items and keeps their read-only checkbox", () => {
		const html = dom(renderMarkdown(corpus.tasks ?? ""));
		expect(html).toContain('<li class="tr-task"><input disabled="" type="checkbox"> open</li>');
		expect(html).toContain('<li class="tr-task"><input checked="" disabled="" type="checkbox"> done</li>');
		expect(html).toContain("<li>plain</li>");
	});

	it("turns GitHub alerts into tone cards and leaves other quotes alone", () => {
		const html = dom(renderMarkdown(corpus.callouts ?? ""));
		expect(html).toContain(
			'<div class="tr-callout" data-tone="note" role="note"><p class="tr-callout-title"><span class="tr-callout-icon" aria-hidden="true"></span>Note</p><p>Read <strong>this</strong> first.</p></div>',
		);
		expect(html).toContain('data-tone="tip" role="note"><p class="tr-callout-title"><span class="tr-callout-icon" aria-hidden="true"></span>Faster path</p><p>Use the cache.</p></div>');
		expect(html).toContain('data-tone="warning" role="note"><p class="tr-callout-title"><span class="tr-callout-icon" aria-hidden="true"></span>Warning</p><p>Second paragraph.</p></div>');
		expect(html).toContain("<blockquote><p>Plain quote [!NOTE]</p></blockquote>");
	});
});

describe("math while KaTeX loads", () => {
	it("shows the source in place, then typesets it under a new block key", async () => {
		// A fresh module graph: KaTeX has not loaded in it yet.
		vi.resetModules();
		const { MarkdownBlocks: Blocks } = await import("./render");
		const { loadMath, MATH_PENDING } = await import("./math");
		const text = "Lead\n\n$$\nx^2\n$$";
		const blocks = new Blocks();
		const before = blocks.render(text);
		expect(before[0]?.html).not.toContain(MATH_PENDING);
		expect(before.at(-1)?.html).toContain(`<math ${MATH_PENDING} display="block"><mtext>$$\nx^2\n$$</mtext></math>`);
		await loadMath();
		const after = blocks.render(text);
		expect(after[0]?.key).toBe(before[0]?.key);
		expect(after.at(-1)?.key).not.toBe(before.at(-1)?.key);
		expect(after.at(-1)?.html).not.toContain(MATH_PENDING);
		expect(after.at(-1)?.html).toContain("<msup>");
	});
});
