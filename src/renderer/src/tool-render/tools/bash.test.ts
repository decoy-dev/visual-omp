import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bashRenderer } from "./bash";

describe("bash async status", () => {
	it("shows a cancelled job with a neutral badge", () => {
		const html = renderToStaticMarkup(createElement(bashRenderer.Body!, {
			name: "bash", args: { command: "make", async: true },
			result: { content: [], details: { async: { state: "cancelled", jobId: "bg_1" } } },
			running: false,
		}));
		expect(html).toContain("async cancelled");
		expect(html).not.toContain("tv-badge--ok");
		expect(html).not.toContain("tv-badge--err");
	});
});
