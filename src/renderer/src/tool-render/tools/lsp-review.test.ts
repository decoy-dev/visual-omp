// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ToolView } from "../ToolView";
import { lspRenderer } from "./lsp";
import { webSearchRenderer } from "./web-search";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: { container: HTMLElement; root: Root }[] = [];
async function mount(element: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ container, root });
	await act(async () => root.render(element));
	return container;
}
afterEach(async () => {
	for (const { container, root } of mounted.splice(0)) {
		await act(async () => root.unmount());
		container.remove();
	}
});
const result = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
function staticBody(text: string): HTMLElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(createElement(lspRenderer.Body!, { name: "lsp", args: { action: "diagnostics" }, result: result(text) }));
	return container;
}

describe("reviewed LSP and provider result safety", () => {
	it("retains unconfirmed Markdown headings after recognized status lines", () => {
		const view = staticBody("OK\n# Unexpected response\n## Extra information");
		expect(view.textContent).toContain("# Unexpected response\n## Extra information");
		expect(view.textContent).not.toContain("No issues");
		expect(view.textContent).not.toContain("file");
	});

	it("only consumes headings that own grouped diagnostics", () => {
		const view = staticBody("# Unexpected response\n# src/\n## a.ts\n  2:3 [error] Broken\n# Other information");
		expect(view.textContent).toContain("# Unexpected response");
		expect(view.textContent).toContain("# Other information");
		expect(view.textContent).toContain("1 file");
		expect(view.querySelector("[data-context-path]")?.getAttribute("data-context-path")).toBe("src/a.ts");
	});

	it("keeps huge summary-only output accessible without an argument-limit failure", () => {
		const view = staticBody(Array.from({ length: 150_000 }, () => "1 error(s):").join("\n"));
		expect(view.textContent).toContain("1 error(s):");
		expect(view.textContent).toContain("Show 149988 more lines");
		expect(view.textContent).not.toContain("No issues");
	});

	it("pages each diagnostic notice collection without losing later notices", async () => {
		const lines = Array.from({ length: 25 }, (_, i) => [
			`✗ failed-${i}.ts: all language servers failed (${i === 24 ? "late-failure" : "typescript, biome"})`,
			`⚠ unverified-${i}.ts: no diagnostics report yet from ${i === 24 ? "late-unverified" : "biome"}`,
			`⚠ partial-${i}.ts: some servers failed (${i === 24 ? "late-partial" : "eslint"})`,
		].join("\n")).join("\n");
		const view = await mount(createElement(lspRenderer.Body!, { name: "lsp", args: { action: "diagnostics" }, result: result(lines) }));
		expect(view.querySelectorAll(".tv-note")).toHaveLength(72);
		expect(view.textContent).toContain("25 files with server failures");
		expect(view.textContent).not.toContain("late-failure");
		const buttons = [...view.querySelectorAll("button")];
		expect(buttons).toHaveLength(3);
		for (const button of buttons) await act(async () => button.click());
		expect(view.querySelectorAll(".tv-note")).toHaveLength(75);
		for (const text of ["late-failure", "late-unverified", "late-partial"]) expect(view.textContent).toContain(text);
	});

	it("bounds source lines and source text before tokenization and reveals both", async () => {
		const text = `Found 1 definition(s):\n  src/a.ts:1:1\n${Array.from({ length: 10 }, (_, i) => `    ${i + 1}: ${i === 0 ? "x".repeat(2200) + "hidden-code-end" : `line-${i}`}`).join("\n")}`;
		const view = await mount(createElement(lspRenderer.Body!, { name: "lsp", args: { action: "definition" }, result: result(text) }));
		expect(view.querySelector("pre")!.textContent!.length).toBeLessThan(2200);
		expect(view.textContent).not.toContain("hidden-code-end");
		expect(view.textContent).not.toContain("line-9");
		await act(async () => [...view.querySelectorAll("button")].find(button => button.textContent === "Show more source text")!.click());
		expect(view.textContent).toContain("hidden-code-end");
		await act(async () => [...view.querySelectorAll("button")].find(button => button.textContent === "Show 2 more source lines")!.click());
		expect(view.textContent).toContain("line-9");
	});

	it("pages provider failures while keeping successful output and provider order", async () => {
		const failures = Array.from({ length: 25 }, (_, i) => ({ provider: `provider-${i}`, reason: `reason-${i}`, status: 429 }));
		const view = await mount(createElement(webSearchRenderer.Body!, { name: "web_search", args: {}, result: result("Successful answer", { failures }) }));
		expect(view.querySelectorAll(".tv-row")).toHaveLength(24);
		expect(view.textContent).toContain("Successful answer");
		expect(view.textContent).not.toContain("provider-24");
		await act(async () => view.querySelector<HTMLButtonElement>("button")!.click());
		expect([...view.querySelectorAll(".tv-badge--warn")].map(node => node.textContent)).toEqual(failures.map(failure => failure.provider));
	});

	it("makes source and diagnostic bidi controls visible while retaining exact path targets", () => {
		const path = "src/evil\u202Ename.ts";
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(lspRenderer.Body!, { name: "lsp", args: { action: "definition" }, result: result(`Found 1 definition(s):\n  ${path}:1:1\n    1: const safe = '\u2066spoof\u2069';`) }));
		expect(container.querySelector("[data-context-path]")?.getAttribute("data-context-path")).toBe(path);
		expect(container.textContent).toContain("evil\\u202Ename.ts");
		expect(container.textContent).toContain("\\u2066spoof\\u2069");
		expect(container.textContent).not.toMatch(/[\u202E\u2066\u2069]/);
		expect(container.querySelector(".tv-path bdi")?.getAttribute("dir")).toBe("ltr");
		const diagnostic = staticBody("a.ts:1:1 [error] failure \u202Ehidden");
		expect(diagnostic.textContent).toContain("failure \\u202Ehidden");
	});

	it("makes provider identifiers and failure reasons visible and isolated", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(createElement(webSearchRenderer.Body!, { name: "web_search", args: {}, result: result("Answer", { failures: [{ provider: "exa\u202Eevil", reason: "denied\u2066spoof\u2069", status: 403 }] }) }));
		expect(container.textContent).toContain("exa\\u202Eevil");
		expect(container.textContent).toContain("denied\\u2066spoof\\u2069");
		expect(container.textContent).not.toMatch(/[\u202E\u2066\u2069]/);
		expect(container.querySelectorAll('.tv-row bdi[dir="ltr"]')).toHaveLength(2);
	});

	it("shows bidi controls in fallback server and provider error text", () => {
		const container = document.createElement("div");
		const text = "Error: \u202Ehidden\u202C";
		for (const renderer of [lspRenderer, webSearchRenderer]) {
			container.innerHTML = renderToStaticMarkup(createElement(renderer.Body!, { name: "tool", args: {}, result: result(text, { success: false }) }));
			expect(container.textContent).toContain("Error: \\u202Ehidden\\u202C");
			expect(container.textContent).not.toContain("\u202E");
		}
	});

	it("marks a failed LSP request as failed in the header while respecting running state", () => {
		const container = document.createElement("div");
		const props = { name: "lsp", args: { action: "hover" }, result: result("Server failed", { action: "hover", success: false }) };
		container.innerHTML = renderToStaticMarkup(createElement(ToolView, { ...props, defaultOpen: true }));
		expect(container.querySelector(".tv-status--err")?.textContent).toBe("Failed");
		expect(container.querySelector(".tv-status--ok")).toBeNull();
		expect(container.textContent).toContain("Request failed");
		container.innerHTML = renderToStaticMarkup(createElement(ToolView, { ...props, running: true }));
		expect(container.querySelector(".tv-status--run")?.textContent).toBe("Running");
		container.innerHTML = renderToStaticMarkup(createElement(ToolView, { ...props, name: "other" }));
		expect(container.querySelector(".tv-status--ok")?.textContent).toBe("Done");
	});
});
