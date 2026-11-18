// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { askFormFieldForRequest, isAskFormRequest, parseAskForm, type AskFormContextBlock, type AskFormInlineRun } from "./askForm";

function textOfRuns(runs: readonly AskFormInlineRun[]): string {
	return runs.map(run => run.type === "text" ? run.text : textOfRuns(run.children)).join("");
}

function textOfBlocks(blocks: readonly AskFormContextBlock[]): string[] {
	return blocks.map(block => block.type === "list" ? block.items.map(textOfRuns).join(" | ") : textOfRuns(block.runs));
}

const contextForm = `<form>
	<p>Choose a direction for the next preview.</p>
	<h2>Proposals</h2>
	<ol>
		<li><strong>Context</strong> stays with its question.</li>
		<li>Links open <a href="https://example.test/guide">the guide</a>.</li>
	</ol>
	<fieldset><legend>Pick three proposals</legend>
		<p>Choose any three proposals for the preview.</p>
		<label><input type="checkbox" name="proposal" value="a"><strong>Proposal A</strong><br><small>Why A</small></label>
		<label><input type="checkbox" name="proposal" value="b">Proposal B <span>: why B</span></label>
		<label><input type="checkbox" name="proposal" value="c"><strong>Proposal C</strong><br><small>Why C</small></label>
	</fieldset>
	<p>Add a short note for the review.</p>
	<label for="note">Review note</label><input id="note" name="note" type="text">
	<p>This note follows the last field.</p>
</form>`;

describe("ask form context parsing", () => {
	it("attaches preceding prose and fieldset help to the next field, then trailing prose to the last field", () => {
		const form = parseAskForm(contextForm);
		const [proposals, note] = form.fields;
		expect(form.fields.map(field => field.name)).toEqual(["proposal", "note"]);
		expect(proposals?.question).toBe("Choose any three proposals for the preview.");
		expect(proposals?.context.map(block => block.type)).toEqual(["paragraph", "heading", "list", "heading", "paragraph"]);
		expect(textOfBlocks(proposals?.context ?? [])).toEqual([
			"Choose a direction for the next preview.",
			"Proposals",
			"Context stays with its question. | Links open the guide.",
			"Pick three proposals",
			"Choose any three proposals for the preview.",
		]);
		expect(note?.context.map(block => block.type)).toEqual(["paragraph", "paragraph"]);
		expect(textOfBlocks(note?.context ?? [])).toEqual([
			"Add a short note for the review.",
			"This note follows the last field.",
		]);
		const link = proposals?.context[2]?.type === "list" ? proposals.context[2].items[1]?.find(run => run.type === "link") : undefined;
		expect(link).toMatchObject({ type: "link", href: "https://example.test/guide" });
	});

	it("keeps text before a formatted span when trimming paragraph whitespace", () => {
		const form = parseAskForm('<form><p>Read <strong>this</strong> </p><input name="answer"></form>');
		const paragraph = form.fields[0]?.context[0];
		expect(paragraph?.type).toBe("paragraph");
		if (paragraph?.type !== "paragraph") return;
		expect(textOfRuns(paragraph.runs)).toBe("Read this");
		expect(paragraph.runs[0]).toMatchObject({ type: "text", text: "Read " });
		expect(paragraph.runs[1]).toMatchObject({ type: "strong", children: [{ type: "text", text: "this" }] });
	});

	it("keeps a differing legend in document order and omits it when it is the question", () => {
		const captioned = parseAskForm('<form><fieldset><legend>Pick three to build</legend><p>Choose three for this preview.</p><label><input type="checkbox" name="proposal" value="one">One</label><label><input type="checkbox" name="proposal" value="two">Two</label></fieldset></form>').fields[0]!;
		expect(captioned.question).toBe("Choose three for this preview.");
		expect(captioned.context[0]?.type).toBe("heading");
		expect(textOfBlocks(captioned.context)[0]).toBe("Pick three to build");

		const legendTitle = parseAskForm('<form><fieldset><legend>Choose a channel</legend><label><input type="radio" name="channel" value="stable">Stable</label><label><input type="radio" name="channel" value="preview">Preview</label></fieldset></form>').fields[0]!;
		expect(legendTitle.question).toBe("Choose a channel");
		expect(textOfBlocks(legendTitle.context)).toEqual([]);
	});

	it("splits label descriptions while matching the complete option text sent by omp", () => {
		const form = parseAskForm(contextForm);
		const field = form.fields[0]!;
		expect(field.options.map(({ label, description, requestLabel }) => [label, description, requestLabel])).toEqual([
			["Proposal A", "Why A", "Proposal A\nWhy A"],
			["Proposal B", "why B", "Proposal B : why B"],
			["Proposal C", "Why C", "Proposal C\nWhy C"],
		]);
		const request = {
			kind: "select" as const,
			title: "Choose any three proposals for the preview.",
			options: ["Proposal A\nWhy A", "Proposal B : why B", "Proposal C\nWhy C", "Other (type your own)", "Next →"],
		};
		expect(isAskFormRequest(contextForm, request)).toBe(true);
		expect(askFormFieldForRequest(form, request)).toBe(field);
		expect(isAskFormRequest(contextForm, { ...request, options: ["Proposal A", "Proposal B", "Proposal C", "Other (type your own)", "Next →"] })).toBe(false);
	});
	it("searches duplicate fields forward without wrapping past the cursor", () => {
		const form = parseAskForm('<form><fieldset><legend>First</legend><label for="first">Enter a note</label><input id="first" name="first"><label for="second">Enter a note</label><input id="second" name="second"></fieldset></form>');
		const request = { kind: "editor" as const, title: "Enter a note" };
		expect(askFormFieldForRequest(form, request, 0)).toBe(form.fields[0]);
		expect(askFormFieldForRequest(form, request, 1)).toBe(form.fields[1]);
		expect(askFormFieldForRequest(form, request, 2)).toBeNull();
	});

	it("drops executable, embedded and image content from context", () => {
		const form = parseAskForm(`<form>
			<p>Visible text<script>script secret</script><style>.x { color: red } style secret</style><iframe>frame secret</iframe><object>object secret</object><img alt="image secret" src="/image.png"><svg aria-label="vector secret"><text>svg secret</text></svg></p>
			<input name="answer" type="text">
		</form>`);
		const blocks = form.fields[0]?.context ?? [];
		const renderedText = textOfBlocks(blocks).join(" ");
		expect(renderedText).toBe("Visible text");
		for (const secret of ["script secret", "style secret", "frame secret", "object secret", "image secret", "vector secret", "svg secret"]) {
			expect(renderedText).not.toContain(secret);
		}
		expect(form.images).toContain("image secret");
	});

	it("keeps unsafe and relative hrefs as text while retaining approved absolute links", () => {
		const form = parseAskForm(`<form><p><a href="javascript:alert(1)">unsafe</a> <a href="/relative/path">relative</a> <a href="https://example.test/a">web</a> <a href="mailto:help@example.test">email</a></p><input name="answer"></form>`);
		const runs = form.fields[0]?.context[0]?.type === "paragraph" ? form.fields[0].context[0].runs : [];
		expect(runs.filter(run => run.type === "link").map(run => run.href)).toEqual(["https://example.test/a", "mailto:help@example.test"]);
		expect(textOfRuns(runs)).toBe("unsafe relative web email");
	});
});
