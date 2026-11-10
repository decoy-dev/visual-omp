// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolRenderProps } from "../types";
import { grepRenderer, tokenizeGrepPattern } from "./grep";

function view(props: Partial<ToolRenderProps> = {}, summary = false): HTMLElement {
	const container = document.createElement("div");
	container.innerHTML = renderToStaticMarkup(createElement(summary ? grepRenderer.Summary : grepRenderer.Body!, {
		name: "grep",
		args: { pattern: "needle", path: "src/file.ts" },
		...props,
	}));
	return container;
}

function result(details: unknown, text = "1:needle", isError = false): ToolRenderProps["result"] {
	return { content: [{ type: "text", text }], details, isError };
}

function badges(container: HTMLElement): string[] {
	return [...container.querySelectorAll(".tv-badge")].map(badge => badge.textContent ?? "");
}

describe("grep pattern tokenization", () => {
	it("styles classes, groups, quantifiers, anchors, escapes and alternation", () => {
		expect(tokenizeGrepPattern(String.raw`^(foo|[a-z]+)\d{2,4}$`)).toEqual([
			{ role: "operator", text: "^" },
			{ role: "type", text: "(" },
			{ role: "text", text: "foo" },
			{ role: "operator", text: "|" },
			{ role: "string", text: "[a-z]" },
			{ role: "number", text: "+" },
			{ role: "type", text: ")" },
			{ role: "keyword", text: String.raw`\d` },
			{ role: "number", text: "{2,4}" },
			{ role: "operator", text: "$" },
		]);
	});

	it.each(["[abc", "[^a-z", String.raw`[a\]b`, "(", "(foo", "(?:foo|bar", "(?", "(?<=foo", "abc\\"])("tolerates a streamed incomplete pattern: %s", pattern => {
		const tokens = tokenizeGrepPattern(pattern);
		expect(tokens?.map(token => token.text).join("")).toBe(pattern);
		expect(view({ args: { pattern }, running: true }, true).querySelector(".tv-pattern")?.textContent).toBe(`/${pattern}/`);
	});

	it("keeps escaped brackets outside classes and escaped closing brackets inside", () => {
		expect(tokenizeGrepPattern(String.raw`\[x\]`)).toEqual([
			{ role: "keyword", text: String.raw`\[` },
			{ role: "text", text: "x" },
			{ role: "keyword", text: String.raw`\]` },
		]);
		expect(tokenizeGrepPattern(String.raw`[a\]b]+`)).toEqual([
			{ role: "string", text: String.raw`[a\]b]` },
			{ role: "number", text: "+" },
		]);
	});

	it("recognizes group prefixes without treating their question mark as a quantifier", () => {
		for (const prefix of ["(?:", "(?=", "(?!", "(?<=", "(?<!"]) {
			expect(tokenizeGrepPattern(`${prefix}foo)`)).toEqual([
				{ role: "type", text: prefix }, { role: "text", text: "foo" }, { role: "type", text: ")" },
			]);
		}
	});

	it("leaves malformed or incomplete brace quantifiers literal", () => {
		for (const pattern of ["a{", "a{2", "a{2,", "a{,2}", "a{word}"]) {
			expect(tokenizeGrepPattern(pattern)).toEqual([{ role: "text", text: pattern }]);
		}
		expect(tokenizeGrepPattern("a{2}b{3,}.*?")).toEqual([
			{ role: "text", text: "a" }, { role: "number", text: "{2}" },
			{ role: "text", text: "b" }, { role: "number", text: "{3,}" },
			{ role: "operator", text: "." }, { role: "number", text: "*?" },
		]);
	});

	it("coalesces literal runs and handles empty and invalid arguments", () => {
		expect(tokenizeGrepPattern("literal text")).toEqual([{ role: "text", text: "literal text" }]);
		expect(tokenizeGrepPattern("")).toEqual([]);
		expect(view({ args: { pattern: "" } }, true).querySelector(".tv-pattern")?.textContent).toBe("//");
		expect(view({ args: { pattern: 42 } }, true).textContent).toContain("[invalid pattern]");
	});

	it("bounds highlighting length and keeps a very long expression intact as plain text", () => {
		expect(tokenizeGrepPattern("x".repeat(1024))).toEqual([{ role: "text", text: "x".repeat(1024) }]);
		const pattern = "[x]+".repeat(4096);
		expect(tokenizeGrepPattern(pattern)).toBeNull();
		const shown = view({ args: { pattern } }, true).querySelector(".tv-pattern");
		expect(shown?.textContent).toBe(`/${pattern}/`);
		expect(shown?.children).toHaveLength(0);
	});

	it("uses the existing syntax roles in both headers and escapes untrusted pattern text", () => {
		for (const summary of [true, false]) {
			const shown = view({ args: { pattern: "^(<script>|[abc]+)$" } }, summary);
			expect(shown.querySelector(".tv-pattern")?.textContent).toBe("/^(<script>|[abc]+)$/");
			expect(shown.innerHTML).toContain("text-(--syn-type)");
			expect(shown.innerHTML).toContain("text-(--syn-string)");
			expect(shown.querySelector("script")).toBeNull();
		}
	});
});

describe("grep count presentation", () => {
	it("omits the redundant file count for a single searched file", () => {
		expect(badges(view({ result: result({ matchCount: 1, fileCount: 1, displayContent: "*1│needle" }) }))).toEqual(["1 match"]);
		expect(badges(view({ args: { pattern: "needle", paths: ["Makefile"] }, result: result({ matchCount: 2, fileCount: 1 }) }))).toEqual(["2 matches"]);
		expect(badges(view({ args: { pattern: "needle" }, result: result({ matchCount: 2, fileCount: 1, scopePath: "Makefile" }) }))).toEqual(["2 matches"]);
	});

	it("retains file counts for grouped results and multiple requested files", () => {
		expect(badges(view({ args: { pattern: "needle", path: "src/" }, result: result({ matchCount: 1, fileCount: 1, displayContent: "# file.ts\n*1│needle" }) }))).toEqual(["1 match", "1 file"]);
		expect(badges(view({ result: result({ matchCount: 4, fileCount: 2 }) }))).toEqual(["4 matches", "2 files"]);
		expect(badges(view({ args: { pattern: "needle", paths: ["a", "b"] }, result: result({ matchCount: 1, fileCount: 1 }) }))).toEqual(["1 match", "1 file"]);
	});

	it.each([{ matchCount: 0, fileCount: 0 }, undefined])("shows one warning count instead of a separate empty result: %j", details => {
		const shown = view({ result: result(details, "No matches found") });
		expect(badges(shown)).toEqual(["0 matches"]);
		expect(shown.querySelector(".tv-badge--warn")?.textContent).toBe("0 matches");
		expect(shown.textContent?.match(/0 matches/g)).toHaveLength(1);
		expect(shown.textContent).not.toContain("No matches found");
		expect(shown.querySelector(".tv-out")).toBeNull();
	});

	it("keeps skipped-path warnings and existing flag and truncation badges", () => {
		const shown = view({ args: { pattern: "needle", skip: 5 }, result: result({ matchCount: 0, fileCount: 0, missingPaths: ["missing/"], truncated: true }, "No matches found") });
		expect(badges(shown)).toEqual(["skip=5", "0 matches", "truncated"]);
		expect(shown.textContent).toContain("skipped missing: missing/");
	});

	it("does not turn pending, unknown or failed results into empty success", () => {
		expect(badges(view({ running: true }))).toEqual([]);
		expect(view({ result: result({}, "Legacy result") }).textContent).toContain("Legacy result");
		for (const failed of [result({ matchCount: 0, error: "Invalid pattern" }, "Invalid pattern"), result({ matchCount: 0 }, "No matches found", true)]) {
			expect(view({ result: failed }).querySelector(".tv-pre--error, .tv-pre")).not.toBeNull();
		}
		expect(view({ result: result({ error: "Invalid pattern" }, "") }).textContent).toContain("Invalid pattern");
	});
});
