import { describe, expect, it } from "vitest";
import { inlineMarkdownText } from "./inline-markdown";

// Expected values follow omp 18.18.8 `renderInlineMarkdown` (pi-tui components/markdown.ts) with ANSI styling removed.
describe("inline Markdown text", () => {
	it.each([
		["💾 Your agent wants to save `task.agentModelOverrides` to your config.", "💾 Your agent wants to save task.agentModelOverrides to your config."],
		["Keep **bold**, *italic* and [the plan](https://example.com) text", "Keep bold, italic and the plan text"],
		["Code keeps `a_b*c` and `~/config` literal", "Code keeps a_b*c and ~/config literal"],
		["Open ~/config", "Open ~/config"],
		["Identifiers like snake_case_name stay whole", "Identifiers like snake_case_name stay whole"],
		["Escaped \\*stars\\* and &amp; &#x41; &nbsp;entities", "Escaped *stars* and & A  entities"],
	])("renders %s", (source, shown) => {
		expect(inlineMarkdownText(source)).toBe(shown);
	});

	// omp renders these through its own HTML, math and strikethrough rules, so only the literal comparison applies.
	it.each(["Use A<br>B", "Inline <b>tags</b>", "Costs $5 and $10", "Solve \\(x\\)", "Keep ~~old~~ text", "# Heading", "- item", "![image](a.png)"])("declines %s", source => {
		expect(inlineMarkdownText(source)).toBeNull();
	});
});
