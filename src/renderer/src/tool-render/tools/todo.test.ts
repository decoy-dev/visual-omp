// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { todoRenderer } from "./todo";

function summary(args: Record<string, unknown>): string {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(createElement(todoRenderer.Summary, { name: "todo", args }));
	return container.textContent ?? "";
}

describe("todo call summary", () => {
	it("names one target task, and counts several (omp 18.20.1 and later)", () => {
		expect(summary({ op: "done", task: "Ship the fix" })).toContain("Ship the fix");
		expect(summary({ op: "done", task: ["Ship the fix"] })).toContain("Ship the fix");
		expect(summary({ op: "done", task: ["Ship the fix", "Write the notes", 3] })).toContain("2 tasks");
		// An empty target falls back to the phase, as a single-task call does.
		expect(summary({ op: "done", task: [], phase: "Verify" })).toContain("Verify");
	});
});
