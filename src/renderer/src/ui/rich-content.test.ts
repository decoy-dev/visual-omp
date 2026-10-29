// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "../transcript/render";
import { hydrateRichContent } from "./rich-content";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); document.body.replaceChildren(); });
const table = "| Model | Tokens |\n| --- | ---: |\n| Alpha | 10 |\n| Beta | 20 |\n| Gamma | 50 |\n| Delta | 80 |";
function mount(source: string, streaming = false): HTMLElement {
	const root = document.createElement("div");
	root.style.setProperty("--fg", "rgb(10, 20, 30)");
	root.innerHTML = renderMarkdown(source);
	document.body.append(root);
	cleanups.push(hydrateRichContent(root, streaming));
	return root;
}

describe("rich Markdown rendering", () => {
	it("renders SVG as an isolated image while retaining accessible source", () => {
		const root = mount('```svg\n<svg viewBox="0 0 400 100"><text fill="currentColor">Request</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("SVG figure");
		expect(root.querySelector("img")?.src).toMatch(/^data:image\/svg\+xml/);
		expect(root.querySelector("details")?.open).toBe(false);
		expect(root.querySelector("pre code")?.textContent).toContain("Request");
	});

	it("exposes SVG titles and descriptions on the outer image and names its scroll region", () => {
		const root = mount('```svg\n<svg viewBox="0 0 1000 100"><title>Request pipeline</title><desc>A request becomes a completed result.</desc><text>Request</text></svg>\n```');
		const image = root.querySelector("img")!;
		expect(image.alt).toBe("Request pipeline");
		expect(image.getAttribute("aria-description")).toBe("A request becomes a completed result.");
		expect(root.querySelector("[data-diagram-image]")?.getAttribute("aria-label")).toBe("Request pipeline");
		expect(root.querySelector<HTMLElement>("[data-diagram-image]")?.tabIndex).toBe(0);
	});

	it("exposes Mermaid's generated accessibility references on the outer image", () => {
		const root = mount('```svg\n<svg viewBox="0 0 640 100" aria-labelledby="chart-title" aria-describedby="chart-description"><title id="chart-title">Release workflow</title><desc id="chart-description">Validate the change before publishing.</desc><text>Validate</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("Release workflow");
		expect(root.querySelector("img")?.getAttribute("aria-description")).toBe("Validate the change before publishing.");
	});

	it("uses an explicit SVG aria-label before its title", () => {
		const root = mount('```svg\n<svg viewBox="0 0 640 100" aria-label="Selected flow"><title>General flow</title><text>Flow</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("Selected flow");
	});

	it("preserves punctuation in authored accessibility text without applying CSS token replacement", () => {
		const root = mount('```svg\n<svg viewBox="0 0 640 100" aria-label="Queue &lt;5 requests @ worker" aria-description="Use var(--fg) for text."><text>Queue</text></svg>\n```');
		expect(root.querySelector("img")?.alt).toBe("Queue <5 requests @ worker");
		expect(root.querySelector("img")?.getAttribute("aria-description")).toBe("Use var(--fg) for text.");
	});

	it("shows failed SVG source instead of losing the reply", () => {
		const root = mount("```svg\nnot an SVG\n```");
		expect(root.querySelector("details")?.open).toBe(true);
		expect(root.textContent).toContain("This diagram could not be drawn.");
		expect(root.querySelector("pre code")?.textContent).toBe("not an SVG\n");
	});

	it("repairs incomplete SVG while its fence streams, without repairing a closed invalid drawing", () => {
		const partial = '```svg\n<svg viewBox="0 0 400 100"><g><text>Request';
		const root = mount(partial, true);
		expect(root.querySelector("img")).not.toBeNull();
		expect(decodeURIComponent(root.querySelector("img")!.src)).toMatch(/Request\s*<\/text><\/g><\/svg>/);
		const closed = mount(`${partial}\n\`\`\``, true);
		expect(closed.querySelector("img")).toBeNull();
		expect(closed.querySelector("details")?.open).toBe(true);
	});

	it("defers an incomplete Mermaid fence rather than rendering each partial graph", () => {
		const root = mount("```mermaid\nflowchart LR\nA -->", true);
		expect(root.querySelector("img")).toBeNull();
		expect(root.textContent).not.toContain("could not be drawn");
	});

	it("charts completed tables without replacing their data", async () => {
		const root = mount(table);
		const original = root.querySelector("table");
		await vi.waitFor(() => expect(root.querySelector(".vomp-chart svg")).not.toBeNull());
		expect(root.querySelector("table")).toBe(original);
		expect(root.querySelectorAll("tbody tr")).toHaveLength(4);
		expect(root.querySelector(".vomp-chart svg")?.getAttribute("aria-label")).toBeTruthy();
	});

	it("matches omp's top-level-only table chart scope", () => {
		const quoted = mount(table.split("\n").map(line => `> ${line}`).join("\n"));
		const nested = mount(`- Comparison\n\n${table.split("\n").map(line => `  ${line}`).join("\n")}`);
		expect(quoted.querySelector("blockquote table")).not.toBeNull();
		expect(nested.querySelector("li table")).not.toBeNull();
		expect(quoted.querySelector("[data-table-chart]")).toBeNull();
		expect(nested.querySelector("[data-table-chart]")).toBeNull();
	});

	it("waits for the last streaming table to close, then charts the same table", async () => {
		const root = mount(table, true);
		expect(root.querySelector(".vomp-chart svg")).toBeNull();
		const original = root.querySelector("table");
		root.insertAdjacentHTML("beforeend", "<p>Finished comparison.</p>");
		cleanups.push(hydrateRichContent(root, true));
		await vi.waitFor(() => expect(root.querySelector(".vomp-chart svg")).not.toBeNull());
		expect(root.querySelector("table")).toBe(original);
	});

	it("can resume a chart import after an effect is disposed mid-load", async () => {
		const root = mount(table);
		cleanups.pop()?.();
		cleanups.push(hydrateRichContent(root));
		await vi.waitFor(() => expect(root.querySelector(".vomp-chart svg")).not.toBeNull());
	});
});
