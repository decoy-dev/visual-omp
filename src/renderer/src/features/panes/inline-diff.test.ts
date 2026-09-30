import type { GitDiffLine } from "@shared/contracts/git";
import { describe, expect, it } from "vitest";
import { composeReviewMessage } from "./comments";
import { tokenizeLine, tokenizeLines } from "./highlight";
import { hunkEmphasis, wordDiff } from "./inline-diff";

const line = (kind: GitDiffLine["kind"], text: string): GitDiffLine => ({ kind, text, oldLine: 1, newLine: 1, noNewline: false });

describe("wordDiff", () => {
	it("marks only the changed word on each side", () => {
		const before = "const total = price * qty;";
		const after = "const total = price * quantity;";
		const { removed, added } = wordDiff(before, after);
		expect(removed.map(([a, b]) => before.slice(a, b))).toEqual(["qty"]);
		expect(added.map(([a, b]) => after.slice(a, b))).toEqual(["quantity"]);
	});

	it("merges adjacent changed tokens into one range", () => {
		const { added } = wordDiff("a b", "a x.y b");
		expect(added).toEqual([[2, 6]]);
	});

	it("returns no ranges for identical lines", () => {
		expect(wordDiff("same", "same")).toEqual({ removed: [], added: [] });
	});
});

describe("hunkEmphasis", () => {
	it("pairs each deletion run with the additions right after it, line by line", () => {
		const lines = [line("context", "x"), line("del", "a = 1"), line("del", "b = 2"), line("add", "a = 3"), line("context", "y"), line("add", "new")];
		const emphasis = hunkEmphasis(lines);
		expect([...emphasis.keys()].sort()).toEqual([1, 3]);
		expect(emphasis.get(1)).toEqual([[4, 5]]);
		expect(emphasis.get(3)).toEqual([[4, 5]]);
	});
});

describe("tokenizeLine", () => {
	it("colors keywords, strings, numbers, calls and comments", () => {
		const { tokens } = tokenizeLine('const x = run("a", 42); // go', "typescript");
		const roles = tokens.filter(token => token.text.trim()).map(token => [token.role, token.text.trim()]);
		expect(roles).toEqual([
			["keyword", "const"],
			["text", "x"],
			["operator", "="],
			["function", "run"],
			["punct", "("],
			["string", '"a"'],
			["punct", ","],
			["number", "42"],
			["punct", ");"],
			["comment", "// go"],
		]);
	});

	it("carries a block comment across lines", () => {
		const [first, second, third] = tokenizeLines(["/* start", "middle", "end */ let y"], "javascript");
		expect(first).toEqual([{ role: "comment", text: "/* start" }]);
		expect(second).toEqual([{ role: "comment", text: "middle" }]);
		expect(third?.[0]).toEqual({ role: "comment", text: "end */" });
		expect(third?.find(token => token.text === "let")?.role).toBe("keyword");
	});

	it("leaves unknown languages as plain text", () => {
		expect(tokenizeLine("const x", null).tokens).toEqual([{ role: "text", text: "const x" }]);
	});
});

describe("composeReviewMessage", () => {
	it("orders comments by file and line with path:line references and quoted code", () => {
		const message = composeReviewMessage([
			{ id: "2", path: "src/b.ts", line: 3, side: "new", excerpt: "  return x;", text: "Handle null" },
			{ id: "1", path: "src/a.ts", line: 10, side: "old", excerpt: "oldCall()", text: "Why remove this?\nIt was used." },
		]);
		expect(message).toBe(
			[
				"I reviewed the current changes and left 2 comments. Please address each one:",
				"",
				"1. `src/a.ts:10 (removed line)`",
				"   > oldCall()",
				"   Why remove this?",
				"   It was used.",
				"",
				"2. `src/b.ts:3`",
				"   > return x;",
				"   Handle null",
			].join("\n"),
		);
	});
});
