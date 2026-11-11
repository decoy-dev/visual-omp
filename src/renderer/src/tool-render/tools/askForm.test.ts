// @vitest-environment happy-dom
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseAskForm, isAskFormRequest } from "./askForm";
import { askRenderer } from "./ask";
import { isAskRequest, parseAskQuestions } from "../../chat/transcript/askSeries";
import evidence from "../../../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";

const entries = evidence.sessions[0]!.text.trim().split("\n").map(line => JSON.parse(line));
const call = entries.flatMap(entry => entry.message?.content ?? []).find(part => part.type === "toolCall");
const result = entries.find(entry => entry.message?.role === "toolResult").message;
const html = call.arguments.html as string;

describe("HTML ask transcript", () => {
	it("extracts recorded legends, option defaults, labels and text without interpreting markup", () => {
		const form = parseAskForm(html);
		expect(form.legends).toEqual(["Release choices"]);
		expect(form.fields.map(field => [field.name, field.question])).toEqual([["channel", "Choose the release settings."], ["checks", "Release choices"], ["note", "Release note"]]);
		expect(form.fields[0]?.options).toEqual([{ label: "Stable", selected: true }, { label: "Preview", selected: false }]);
		expect(form.fields[1]?.multi).toBe(true);
		expect(form.fields[2]?.value).toBe("Keep compatibility");
	});
	it("handles selects, detached and ARIA labels, textareas and pictures in an inert template", () => {
		const form = parseAskForm('<script>throw Error("executed")</script><form><legend>Options &amp; notes</legend><label for="size">Size</label><select name="size" id="size"><option>Small</option><option selected>Large</option></select><textarea name="note" aria-label="Notes">hello &amp; goodbye</textarea><input name="secret" type="hidden" value="hidden"><img src="https://example.invalid/no-request" alt="Plan picture"><svg aria-label="Plan diagram"><text>ignored markup</text></svg><button>Submit</button></form>');
		expect(form.fields).toHaveLength(2);
		expect(form.fields[0]).toMatchObject({ question: "Size", options: [{ selected: false }, { selected: true }] });
		expect(form.fields[1]).toMatchObject({ question: "Notes", value: "hello & goodbye" });
		expect(form.images).toEqual(["Plan picture", "Plan diagram"]);
		expect(document.querySelector("img")).toBeNull();
	});
	// Upstream parse.ts keeps all choice options; data.ts fieldQuestions chooses caption,
	// section title, a lone option, then name. Guest rows omit disabled choices afterward.
	it("uses upstream contextual choice questions and counts disabled options for Other", () => {
		const form = parseAskForm('<form><p>Which size?</p><select name="size"><option>Small</option><option>Large</option></select><fieldset><legend>Region</legend><select name="region"><option>West</option><option>East</option></select></fieldset><label><input type="radio" name="channel" value="stable">Stable</label><label><input type="radio" name="channel" value="preview" disabled>Preview</label></form>');
		expect(form.fields.map(field => field.question)).toEqual(["Which size?", "Region", "channel"]);
		expect(form.fields[2]?.other).toBe(true);
		expect(isAskFormRequest('<form><label><input type="radio" name="channel">Stable</label><label><input type="radio" name="channel" disabled>Preview</label></form>', { kind: "select", title: "channel", options: ["Stable", "Other (type your own)"] })).toBe(true);
		expect(isAskFormRequest('<form><label><input type="radio" name="c">Stable</label><label><input type="radio" name="c" disabled>Other option</label></form>', { kind: "editor", title: "c" })).toBe(false);
		expect(isAskFormRequest('<form><select name="empty"></select></form>', { kind: "editor", title: "empty" })).toBe(false);
	});
	it("renders pending fields and recorded question-answer pairs, empty answers and timeouts", () => {
		const pending = renderToStaticMarkup(createElement(askRenderer.Body!, { name: "ask", args: call.arguments }));
		expect(pending).toContain("Choose the release settings.");
		expect(pending).toContain("preselected");
		expect(pending).not.toContain("<form");
		const answered = renderToStaticMarkup(createElement(askRenderer.Body!, { name: "ask", args: call.arguments, result }));
		expect(answered).toContain("Other: Canary");
		expect(answered).toContain("Types, Tests, Other: Accessibility");
		expect(answered).not.toContain("Keep compatibility");
		const empty = renderToStaticMarkup(createElement(askRenderer.Body!, { name: "ask", args: {}, result: { content: [], details: { answers: [{ name: "empty", question: "Anything else?", answer: "" }], timedOut: true } } }));
		expect(empty).toContain("(no answer)");
		expect(empty).toContain("after the timeout");
	});
	it("renders inline code in HTML-form questions and choices", () => {
		const args = { html: "<form><label for=\"config\">Save `task.agentModelOverrides`?</label><select name=\"config\" id=\"config\"><option>Use `config.yml`</option></select></form>" };
		expect(parseAskForm(args.html).fields[0]?.question).toBe("Save `task.agentModelOverrides`?");
		const html = renderToStaticMarkup(createElement(askRenderer.Body!, { name: "ask", args }));
		const container = document.createElement("div");
		container.innerHTML = html;
		expect([...container.querySelectorAll(".tv-row")].map(row => row.textContent)).toEqual(["Save task.agentModelOverrides?", "●Use config.yml preselected"]);
		expect([...container.querySelectorAll(".tv-row")].map(row => row.querySelector("code")?.textContent ?? "no-code")).toEqual(["task.agentModelOverrides", "config.yml"]);
		expect([...container.querySelectorAll("code")].map(code => code.textContent)).toEqual(["task.agentModelOverrides", "config.yml"]);
	});
	it("renders option notes only under the answer with the same name and question", () => {
		const answers = [
			{ name: "channel", question: "Release channel", answer: "Stable" },
			{ name: "channel", question: "Support channel", answer: "Email" },
			{ name: "support", question: "Release channel", answer: "Preview" },
		];
		const notes = [
			{ name: "channel", question: "Release channel", option: "Stable", value: "stable", text: "Keep compatibility" },
			{ name: "channel", question: "Release channel", option: "Preview", value: "preview", text: "Compare #aabbcc" },
			{ name: "channel", question: "Unrelated question", option: "Stable", value: "stable", text: "Unmatched question" },
			{ name: "unknown", question: "Release channel", option: "Stable", value: "stable", text: "Unmatched name" },
		];
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(askRenderer.Body!, { name: "ask", args: {}, result: { content: [], details: { answers, notes } } }));
		const rows = container.querySelectorAll(".tv-list");
		expect(rows).toHaveLength(3);
		expect(rows[0]?.textContent).toContain("✎ Stable: Keep compatibility");
		expect(rows[0]?.textContent).toContain("✎ Preview: Compare #aabbcc");
		expect(rows[0]?.querySelector(".vomp-color-swatch")).not.toBeNull();
		for (const row of [rows[1], rows[2]]) expect(row?.textContent).not.toContain("✎");
		expect(container.textContent).not.toContain("Unmatched");
	});
	it("keeps results without notes unchanged and ignores malformed note entries", () => {
		const answers = [{ name: "channel", question: "Release channel", answer: "Stable" }];
		const render = (details: Record<string, unknown>) => renderToStaticMarkup(createElement(askRenderer.Body!, { name: "ask", args: {}, result: { content: [], details } }));
		const original = render({ answers });
		expect(original).toContain("Release channel");
		expect(original).toContain("Stable");
		expect(original).not.toContain("✎");
		for (const notes of [undefined, null, {}, "invalid", []]) expect(render({ answers, notes })).toBe(original);
		const valid = { name: "channel", question: "Release channel", option: "Stable", value: "stable", text: "Malformed note" };
		const malformed: unknown[] = [null, "invalid", [], {}];
		for (const key of Object.keys(valid)) {
			malformed.push({ ...valid, [key]: 42 }, { ...valid, [key]: undefined });
		}
		expect(render({ answers, notes: malformed })).toBe(original);
	});
	it("attributes every recorded request to its live form without starting legacy replay", () => {
		const source = { activeTools: new Map([[call.id, { toolCallId: call.id, toolName: "ask", args: call.arguments }]]), entries: [], stream: null, working: true };
		for (const stage of evidence.stages) if (stage.request) {
			expect(isAskFormRequest(html, stage.request as CollabUiRequest), stage.stage).toBe(true);
			expect(isAskRequest(source, stage.request as CollabUiRequest), stage.stage).toBe(true);
		}
		expect(parseAskQuestions(call.arguments)).toBeNull();
		expect(isAskFormRequest(html, { kind: "select", title: "Release choices", options: ["Approve", "Deny"] })).toBe(false);
	});
});
