// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { webSearchRenderer } from "./web-search";

function body(details: unknown, text = "Search answered successfully"): HTMLElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(createElement(webSearchRenderer.Body!, { name: "web_search", args: { query: "release notes" }, result: { content: [{ type: "text", text }], details } }));
	return container;
}

const response = { provider: "keenable", sources: [{ title: "omp release notes", url: "https://example.com/releases" }] };

describe("web search provider failures", () => {
	it("lists failed provider, reason and status in omp order without hiding the answer or sources", () => {
		const view = body({ response, failures: [
			{ provider: "zai", label: "Z.ai", reason: "Rate limit exceeded", status: 429 },
			{ provider: "exa", label: "Exa", reason: "Connection closed" },
			{ provider: "brave", label: "Brave", reason: "Service unavailable", status: 503 },
		] });
		expect(view.textContent).toContain("Search answered successfully");
		expect(view.querySelector("a")?.getAttribute("href")).toBe("https://example.com/releases");
		expect([...view.querySelectorAll(".tv-badge--warn")].map(badge => badge.textContent)).toEqual(["zai", "exa", "brave"]);
		expect(view.textContent).toContain("Failed (HTTP 429): Rate limit exceeded");
		expect(view.textContent).toContain("Failed: Connection closed");
		expect(view.textContent).toContain("Failed (HTTP 503): Service unavailable");
	});

	it("retains all-provider failures and omp's original explanation", () => {
		const view = body({ error: "All providers failed", failures: [{ provider: "brave", reason: "Unauthorized", status: 401 }] }, "Error: All providers failed");
		expect(view.textContent).toContain("Error: All providers failed");
		expect(view.textContent).toContain("brave");
		expect(view.textContent).toContain("HTTP 401");
	});

	it("keeps older successful and failed result shapes", () => {
		expect(body({ response }).textContent).toContain("omp release notes");
		expect(body({ error: "Provider unavailable" }, "").textContent).toContain("Provider unavailable");
		expect(body(undefined).textContent).toContain("Search answered successfully");
	});

	it.each([null, {}, "failure", [null, [], {}, { provider: 3, reason: false, status: "429" }]])("ignores malformed failure records: %j", failures => {
		const view = body({ response, failures });
		expect(view.textContent).toContain("Search answered successfully");
		expect(view.querySelectorAll(".tv-badge--warn")).toHaveLength(0);
	});

	it("escapes provider errors as text", () => {
		const view = body({ failures: [{ provider: "<script>", reason: '<img src=x onerror="alert(1)">', status: 500 }] });
		expect(view.querySelector("script, img")).toBeNull();
		expect(view.textContent).toContain('<img src=x onerror="alert(1)">');
	});
});
