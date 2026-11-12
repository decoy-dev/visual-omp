import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { browserRenderer } from "./browser";

function body(args: Record<string, unknown>, details?: Record<string, unknown>): string {
	const result = details ? { content: [{ type: "text", text: "ok" }], details } : undefined;
	return renderToStaticMarkup(createElement(browserRenderer.Body!, { name: "browser", args, result }));
}

describe("browser app argument", () => {
	it("reads omp 18.19.0's string app and top-level target", () => {
		expect(body({ action: "open", app: "http://127.0.0.1:9222/", target: "Docs" })).toContain("connected http://127.0.0.1:9222/");
		expect(body({ action: "open", app: "/opt/browsers/chrome", argv: ["--incognito"] })).toContain("spawned /opt/browsers/chrome");
		expect(body({ action: "open", app: "http://127.0.0.1:9222/", target: "Docs" })).toContain("target Docs");
	});
	it("shows the browser omp used for a keyword, and the keyword before the result arrives", () => {
		expect(body({ action: "open", app: "own" }, { action: "open", browser: "webkit" })).toContain(">webkit<");
		expect(body({ action: "open", app: "relay" })).toContain(">relay<");
	});
	it("keeps the app object of omp before 18.19.0", () => {
		const html = body({ action: "open", app: { cdp_url: "http://127.0.0.1:9333", target: "Inbox" } });
		expect(html).toContain("connected http://127.0.0.1:9333");
		expect(html).toContain("target Inbox");
	});
});
