// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { htmlChangeOffset, markHtmlChange } from "./preview-html-follow";

describe("script-free HTML change anchors", () => {
	it("targets appended content rather than the top of the page", () => {
		const before = '<body><section id="hero"><h1>Title</h1></section>';
		const after = before + '<section id="details"><h2>New section</h2></section></body>';
		expect(htmlChangeOffset(before, after)).toBe(after.indexOf('<section id="details"'));
	});
	it("targets a changed element inside an existing section", () => {
		const before = "<body><section><h2>Old title</h2><p>Body</p></section></body>";
		const after = before.replace("Old title", "Revised title");
		expect(htmlChangeOffset(before, after)).toBe(after.indexOf("<h2>"));
	});
	it("keeps incomplete tags out of marker insertion", () => {
		const before = "<body><h1>Title</h1>";
		const after = before + '<section title="unfinished';
		expect(htmlChangeOffset(before, after)).toBe(after.indexOf("<h1>"));
	});
	it("keeps an appended incomplete tag at the last completed descendant instead of its open container", () => {
		const before = "<main><p>First</p><p>Last</p>";
		const after = before + '<section title="unfinished';
		expect(htmlChangeOffset(before, after)).toBe(after.indexOf("<p>Last"));
	});
	it("keeps successive append-only continuations of the same unfinished tag at the last completed descendant", () => {
		const prefix = "<main><p>First</p><p>Last</p>";
		const revisions = [prefix, `${prefix}<section title="un`, `${prefix}<section title="unfinished`, `${prefix}<section title="unfinished heading" class="part`, `${prefix}<section title="unfinished heading" class="partial`];
		for (let index = 1; index < revisions.length; index++) {
			expect(htmlChangeOffset(revisions[index - 1]!, revisions[index]!)).toBe(prefix.indexOf("<p>Last"));
			const marked = markHtmlChange(revisions[index - 1]!, revisions[index]!, `vomp-abc-${index}`);
			expect(marked.body).toContain(`<p data-vomp-abc-${index}="" id="vomp-abc-${index}">Last</p>`);
		}
		const complete = revisions.at(-1)! + '">New section</section>';
		expect(htmlChangeOffset(revisions.at(-1)!, complete)).toBe(complete.indexOf("<section"));
	});
	it("does not parse comments, quoted attribute brackets or raw text as elements", () => {
		const before = '<head><style>.x:before{content:"<section>"}</style></head><body><!-- <article> --><p title="a > b">First</p>';
		const after = before + '<script>const x = "<aside>";</script><section>Next</section>';
		expect(htmlChangeOffset(before, after)).toBe(after.indexOf("<section>Next"));
	});
	it("targets a whole table for changes inside rows", () => {
		const before = "<body><table><tbody><tr><td>Old</td></tr></tbody></table></body>";
		const after = before.replace("Old", "New");
		expect(htmlChangeOffset(before, after)).toBe(after.indexOf("<table>"));
	});
	it("places highlight CSS before an unfinished streamed tail and preserves the doctype", () => {
		const source = '<!doctype html><body><p>Content</p><a title="unfinished';
		const marked = markHtmlChange(null, source, "vomp-abc-3").body;
		expect(marked.startsWith("<!doctype html><style>")).toBe(true);
		expect(marked.endsWith('<a title="unfinished')).toBe(true);
	});
	it("leaves an unchanged revision byte-for-byte intact", () => {
		expect(markHtmlChange("<h1>A</h1>", "<h1>A</h1>", "vomp-abc-2")).toEqual({ body: "<h1>A</h1>" });
	});
	it("anchors existing author ids without rewriting them or using them in CSS", () => {
		const source = '<body><section id="page"><h1>Hello</h1></section></body>';
		const result = markHtmlChange(null, source, "vomp-abc-1");
		expect(result.anchor).toBe("page");
		expect(result.body).toContain('id="page"');
		expect(result.body).not.toContain('id="vomp-abc-1"');
		expect(result.body).toContain("[data-vomp-abc-1]");
		expect(result.body).toContain("prefers-reduced-motion");
		expect(result.body).not.toContain("<script");
		expect(() => markHtmlChange(null, source, 'bad" onclick="x')).toThrow();
	});
	it.each(['id="a&amp;b&#32;c"', "ID='a&amp;b&#32;c'", 'title="id=wrong" id=a&amp;b&#32;c'])("decodes an author fragment from %s", attribute => {
		expect(markHtmlChange(null, `<p ${attribute}>Text</p>`, "vomp-abc-1").anchor).toBe("a&b c");
	});
	it("anchors a control's container so following does not focus the control and pause itself", () => {
		const before = '<p id="container"><a href="https://example.invalid">Old</a></p>';
		const source = before.replace("Old", "New");
		const marked = markHtmlChange(before, source, "vomp-abc-6");
		expect(marked.anchor).toBe("container");
		expect(marked.body).toContain('<a href="https://example.invalid">New</a>');
	});
	it.each(["flex", "grid"])("preserves %s items, gaps and sibling positions", display => {
		const before = `<!doctype html><body><main style="display:${display};gap:24px"><p>First</p><p>Old</p><p>Third</p></main></body>`;
		const source = before.replace("Old", "New");
		const marked = markHtmlChange(before, source, "vomp-abc-4");
		const parsed = new DOMParser().parseFromString(marked.body, "text/html");
		const main = parsed.querySelector("main")!;
		expect(main.children).toHaveLength(3);
		expect([...main.children].map(child => child.tagName)).toEqual(["P", "P", "P"]);
		expect(main.querySelector(":nth-child(2)")?.textContent).toBe("New");
		expect(main.querySelector(":first-child")?.textContent).toBe("First");
		expect(main.getAttribute("style")).toBe(`display:${display};gap:24px`);
		expect(parsed.getElementById(marked.anchor!)).toBe(main.children[1]);
	});
	it("preserves inline text flow without inserting siblings or line breaks", () => {
		const before = "<p>Before <em>old</em> after <strong>end</strong>.</p>";
		const source = before.replace("old", "new");
		const result = markHtmlChange(before, source, "vomp-abc-5");
		const parsed = new DOMParser().parseFromString(result.body, "text/html");
		const paragraph = parsed.querySelector("p")!;
		expect(paragraph.textContent).toBe("Before new after end.");
		expect([...paragraph.children].map(child => child.tagName)).toEqual(["EM", "STRONG"]);
		expect(paragraph.childNodes).toHaveLength(5);
		expect(parsed.getElementById(result.anchor!)).toBe(paragraph.children[0]);
	});
});
