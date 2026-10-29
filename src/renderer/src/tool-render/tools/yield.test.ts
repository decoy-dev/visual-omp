import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { yieldRenderer, yieldSubmission } from "./yield";

describe("submitted helper results", () => {
	it("uses accepted normalized fields and section labels", () => {
		const result = { content: [], details: { type: ["summary", "evidence"], data: { count: 2 }, status: "success" } };
		expect(yieldSubmission({ data: '{"count":2}', type: ["old"] }, result)).toMatchObject({ labels: ["summary", "evidence"], data: { count: 2 } });
		const html = renderToStaticMarkup(createElement(yieldRenderer.Body!, { name: "yield", args: {}, result }));
		expect(html).toContain("summary");
		expect(html).toContain("evidence");
		expect(html).toContain("count: ");
		expect(html).toContain("<details");
	});
	it("keeps false, zero and null submissions", () => {
		for (const data of [false, 0, null]) expect(yieldSubmission({ data }).data).toBe(data);
	});
	it("shows the schema rejection instead of rejected result details", () => {
		const result = { content: [{ type: "text", text: "Missing required field count" }], isError: true, details: { data: { wrong: true } } };
		expect(yieldSubmission({ type: "report", data: { name: "Ada" } }, result)).toMatchObject({ labels: ["report"], data: { name: "Ada" }, error: "Missing required field count" });
	});
	it("shows the failure reported by a helper and an aborted result", () => {
		expect(yieldSubmission({ error: "Cannot access repository" }).error).toBe("Cannot access repository");
		expect(yieldSubmission({}, { content: [], details: { status: "aborted", error: "Cancelled by owner" } }).error).toBe("Cancelled by owner");
	});
});
