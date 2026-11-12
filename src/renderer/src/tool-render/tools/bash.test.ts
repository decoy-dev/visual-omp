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
		expect(html).toContain("Background cancelled");
		expect(html).not.toContain("tv-badge--ok");
		expect(html).not.toContain("tv-badge--err");
	});
});

/** Shape from omp 18.16's MinimizedMeta and bash tool result builder. */
const minimizedDetails = {
	meta: { minimized: { filter: "git", inputBytes: 123290, outputBytes: 3277, artifactId: "bash-original-42" } },
};

function renderDetails(details: unknown, text = "3 files changed"): string {
	return renderToStaticMarkup(createElement(bashRenderer.Body!, {
		name: "bash",
		args: { command: "git diff", timeout: 300 },
		result: { content: [{ type: "text", text }], details },
		running: false,
	}));
}

describe("bash minimized output metadata", () => {
	it("shows the filter and byte sizes as readable metadata after the output", () => {
		const html = renderDetails({ ...minimizedDetails, wallTimeMs: 1450 });
		const note = "omp&#x27;s git filter changed this output from 120.4 KB to 3.2 KB.";
		expect(html).toContain(note);
		expect(html.indexOf(note)).toBeGreaterThan(html.indexOf("3 files changed"));
		expect(html.indexOf(note)).toBeLessThan(html.indexOf("Duration 1.4s"));
	});

	it("handles chain filters and a rewrite to empty output", () => {
		const html = renderDetails({
			meta: { minimized: { filter: "chain", inputBytes: 1048576, outputBytes: 0, artifactId: "42" } },
		}, "");
		expect(html).toContain("omp&#x27;s chain filter changed this output from 1.0 MB to 0 B.");
	});

	it("escapes unfamiliar filter labels and ignores unrelated artifact metadata", () => {
		const html = renderDetails({
			meta: { minimized: { filter: " custom<script> ", inputBytes: 500, outputBytes: 50, artifactId: { bad: true } } },
		});
		expect(html).toContain("omp&#x27;s custom&lt;script&gt; filter changed this output from 500 B to 50 B.");
		expect(html).not.toContain("<script>");
	});

	it.each([
		undefined, {}, { meta: null }, { meta: [] }, { minimized: minimizedDetails.meta.minimized },
		{ meta: { minimized: null } }, { meta: { minimized: [] } }, { meta: { minimized: "git" } },
		{ meta: { truncation: { artifactId: "42", totalBytes: 123290, outputBytes: 3277 } } },
	])("leaves older and malformed details unchanged (%j)", details => {
		const html = renderDetails(details, "Full output\n[raw output: artifact://42]");
		expect(html).toContain("Full output");
		expect(html).toContain("Artifact 42");
		expect(html).not.toContain("filter changed this output");
	});

	it.each([
		{ filter: 42 }, { filter: "   " }, { filter: "git\nfake" },
		{ inputBytes: "123290" }, { inputBytes: -1 }, { inputBytes: 1.5 },
		{ inputBytes: Number.MAX_SAFE_INTEGER + 1 },
		{ outputBytes: "3277" }, { outputBytes: undefined }, { outputBytes: -1 }, { outputBytes: 0.5 },
		{ outputBytes: Number.MAX_SAFE_INTEGER + 1 },
	])("omits invalid rewrite metadata (%j)", invalid => {
		const html = renderDetails({ meta: { minimized: { ...minimizedDetails.meta.minimized, ...invalid } } });
		expect(html).toContain("3 files changed");
		expect(html).not.toContain("filter changed this output");
	});

	it.each([
		{ inputBytes: 123290, outputBytes: 123290, sizes: "120.4 KB to 120.4 KB" },
		{ inputBytes: 123290, outputBytes: 124314, sizes: "120.4 KB to 121.4 KB" },
		{ inputBytes: 0, outputBytes: 5, sizes: "0 B to 5 B" },
	])("shows a recorded rewrite regardless of byte savings (%j)", ({ inputBytes, outputBytes, sizes }) => {
		const html = renderDetails({ meta: { minimized: { ...minimizedDetails.meta.minimized, inputBytes, outputBytes } } });
		expect(html).toContain(`omp&#x27;s git filter changed this output from ${sizes}.`);
	});

	it("keeps a raw-output artifact reference as text without inventing a viewer link", () => {
		const html = renderDetails(minimizedDetails, "3 files changed\n[raw output: artifact://bash-original-42]");
		expect(html).toContain("omp&#x27;s git filter changed this output");
		expect(html).toContain("Artifact bash-original-42");
		expect(html).not.toContain("data-context-tool-path");
		expect(html).not.toContain("<a");
		expect(html).not.toContain("<button");
	});
});
