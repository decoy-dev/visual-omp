import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { evalRenderer } from "./eval";
import { yieldRenderer } from "./yield";

vi.mock("../../transcript/math", async importOriginal => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, useMathReady: () => false };
});

const cardMarkdown = {
	eval: (text: string) => renderToStaticMarkup(createElement(evalRenderer.Body!, {
		name: "eval", args: { language: "python", code: "print(report)" },
		result: { content: [], details: { cells: [{ index: 0, output: text, status: "complete", views: [{ text, view: { kind: "markdown", text } }] }] } },
	})),
	submission: (text: string) => renderToStaticMarkup(createElement(yieldRenderer.Body!, { name: "yield", args: { data: text } })),
};

describe.each(Object.entries(cardMarkdown))("%s Markdown safety", (_name, render) => {
	it.each(["https://images.example/private?token=secret", "http://images.example/private", "//images.example/private"])("requires explicit consent before requesting %s", url => {
		const html = render(`![Private report](${url})`);
		expect(html).toContain("data-remote-image=");
		expect(html).toContain("data-load-image");
		expect(html).toContain("images.example");
		expect(html).not.toMatch(/<img\b/i);
		expect(html).not.toMatch(/\bsrc=/i);
	});
	it("escapes raw HTML without creating active elements or event handlers", () => {
		const html = render('<img src="https://images.example/raw" onerror="alert(1)">\n\n<script>alert(2)</script>');
		expect(html).toContain("&lt;img");
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toMatch(/<img\b|<script\b|<iframe\b/i);
	});
	it.each(["javascript:alert%281%29", "data:text/html,hello", "file:///private/report"])("does not create a link for %s", url => {
		const html = render(`[Unsafe link](${url})`);
		expect(html).toContain("Unsafe link");
		expect(html).not.toMatch(/<a\b/i);
	});
});
