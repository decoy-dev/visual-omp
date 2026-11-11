// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { jobRenderer } from "./job";
import { waitRenderer } from "./wait";

describe.each([["job", jobRenderer], ["wait", waitRenderer]] as const)("%s job names", (name, renderer) => {
	it("leads with the purpose and keeps the command as secondary text", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(renderer.Body!, {
			name, args: {}, running: false,
			result: { content: [], details: { jobs: [{ id: "bg_1", type: "bash", status: "running", intent: "Checking the release build", label: "npm run build" }] } },
		}));
		const row = [...container.querySelectorAll(".tv-row")].find(element => element.textContent?.includes("bg_1"))!;
		expect(row.textContent).toContain("Checking the release build");
		expect(row.textContent).not.toContain("npm run build");
		const command = row.nextElementSibling!;
		expect(command.textContent).toBe("npm run build");
		expect(command.classList.contains("text-fg-faint")).toBe(true);
	});

	it.each([undefined, "", "   "])("falls back to the command when intent is %s", intent => {
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(renderer.Body!, {
			name, args: {}, running: false,
			result: { content: [], details: { jobs: [{ id: "bg_old", type: "eval", status: "completed", intent, label: "print(results)" }] } },
		}));
		const row = [...container.querySelectorAll(".tv-row")].find(element => element.textContent?.includes("bg_old"))!;
		expect(row.textContent).toContain("print(results)");
		expect(row.nextElementSibling).toBeNull();
	});
});

describe("interrupted waits", () => {
	// omp 18.18.9 tui/src/tools/wait.ts: the message arrives as its own turn after the wait.
	const interrupted = { content: [{ type: "text", text: "Wait interrupted by message." }], details: { op: "wait", jobs: [], interrupted: true } };
	const render = (component: typeof waitRenderer.Summary, result: unknown) =>
		renderToStaticMarkup(createElement(component, { name: "wait", args: {}, running: false, result: result as never }));

	it("says the wait ended for a message and shows no job snapshot", () => {
		expect(render(waitRenderer.Summary, interrupted)).toContain("interrupted by message");
		expect(render(waitRenderer.Body!, interrupted)).toBe("");
	});

	it("keeps job details for a failed interrupted result", () => {
		const failed = { ...interrupted, isError: true, details: { ...interrupted.details, jobs: [{ id: "bg_7", type: "bash", status: "running", intent: "Checking the release build", label: "npm run build" }] } };
		expect(render(waitRenderer.Summary, failed)).not.toContain("interrupted by message");
		expect(render(waitRenderer.Body!, failed)).toContain("Checking the release build");
	});
});
