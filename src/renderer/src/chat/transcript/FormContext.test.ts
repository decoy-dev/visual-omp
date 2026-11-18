// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskFormContextBlock } from "../../tool-render/tools/askForm";
import { FormContext } from "./FormContext";

const originalVomp = window.vomp;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = null;
	host?.remove();
	host = null;
	if (originalVomp === undefined) Reflect.deleteProperty(window, "vomp");
	else Object.defineProperty(window, "vomp", { configurable: true, value: originalVomp });
});

const blocks: AskFormContextBlock[] = [
	{ type: "paragraph", runs: [
		{ type: "text", text: "Read " },
		{ type: "strong", children: [{ type: "text", text: "the proposal" }] },
		{ type: "text", text: " with " },
		{ type: "em", children: [{ type: "text", text: "care" }] },
		{ type: "text", text: " and " },
		{ type: "code", children: [{ type: "text", text: "mode" }] },
		{ type: "text", text: " at " },
		{ type: "link", href: "https://example.test/guide/", children: [{ type: "text", text: "the guide" }] },
	] },
	{ type: "list", ordered: true, items: [[{ type: "text", text: "First proposal" }], [{ type: "text", text: "Second proposal" }]] },
];

describe("FormContext", () => {
	it("renders formatted prose and compact semantic lists with wrapping styles", () => {
		const html = renderToStaticMarkup(createElement(FormContext, { blocks }));
		const container = document.createElement("div");
		container.innerHTML = html;
		expect(container.querySelector("[data-form-context]")).not.toBeNull();
		expect(container.querySelector("p strong")?.textContent).toBe("the proposal");
		expect(container.querySelector("p em")?.textContent).toBe("care");
		expect(container.querySelector("p code")?.textContent).toBe("mode");
		expect(container.querySelector('a[href="https://example.test/guide/"]')?.textContent).toBe("the guide");
		expect(container.querySelector("ol")?.textContent).toBe("First proposalSecond proposal");
		expect(container.querySelector("[data-form-context]")?.className).toContain("[overflow-wrap:anywhere]");
		expect(container.querySelector("ol")?.className).toContain("list-outside");
		expect(container.querySelector("ol")?.className).toContain("marker:text-fg-muted");
		expect(container.querySelector(".tv-card")).toBeNull();
	});

	it("renders bullets for unordered context lists", () => {
		const html = renderToStaticMarkup(createElement(FormContext, { blocks: [
			{ type: "list", ordered: false, items: [[{ type: "text", text: "First proposal" }]] },
		] }));
		const container = document.createElement("div");
		container.innerHTML = html;
		expect(container.querySelector("ul")?.className).toContain("list-disc");
		expect(container.querySelector("ul")?.className).toContain("marker:text-fg-muted");
	});

	it("omits context text already shown as the question", () => {
		const question = "Read the proposal with care and mode at the guide";
		const html = renderToStaticMarkup(createElement(FormContext, { blocks, question }));
		const container = document.createElement("div");
		container.innerHTML = html;
		expect(container.querySelector("p")).toBeNull();
		expect(container.querySelector("ol")).not.toBeNull();
		expect(container.textContent).not.toContain(question);
	});

	it("opens approved links through the transcript external-link action without navigating", async () => {
		const invoke = vi.fn(async () => undefined);
		Object.defineProperty(window, "vomp", { configurable: true, value: { invoke } });
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		await act(async () => root!.render(createElement(FormContext, { blocks })));
		const anchor = host.querySelector("a")!;
		const click = new MouseEvent("click", { bubbles: true, cancelable: true });
		anchor.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(invoke).toHaveBeenCalledWith("app:openExternal", "https://example.test/guide/");
	});
});
