// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { friendlySummary, resolveToolCall } from "./friendly";

const error = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const form = (fields: string) => `<form>${fields}</form>`;
const choice = (name: string) => `<fieldset><legend>${name}</legend><label><input type="radio" name="${name}" value="a"> A</label><label><input type="radio" name="${name}" value="b"> B</label></fieldset>`;
const summaryKey = (html: string, text: string) => friendlySummary(resolveToolCall({ name: "ask", args: { html }, result: error(text), running: false })).key;

describe("cancelled ask rows", () => {
	it("say the form was cancelled when a form with several questions was cancelled or its turn stopped", () => {
		const html = form(choice("channel") + choice("depth"));
		expect(summaryKey(html, "Ask tool was cancelled by the user")).toBe("ask.formCancelled");
		expect(summaryKey(html, "Ask input was cancelled")).toBe("ask.formCancelled");
	});

	it("keep the skipped wording for a one-question form", () => {
		expect(summaryKey(form(choice("channel")), "Ask tool was cancelled by the user")).toBe("ask.error");
	});

	it("keep the error wording when a form failed for another reason", () => {
		expect(summaryKey(form(choice("channel") + choice("depth")), "Ask tool requires interactive mode")).toBe("ask.error");
	});
});
