import { describe, expect, it } from "vitest";
import { INSTRUCTION_CANDIDATES, activeInstruction, parseRuleMarkdown, projectNameProblem, renderRuleMarkdown } from "./project";

describe("projectNameProblem", () => {
	it("accepts ordinary names including spaces and unicode", () => {
		expect(projectNameProblem("my app")).toBeNull();
		expect(projectNameProblem("  café-2  ")).toBeNull();
		expect(projectNameProblem(".dotfiles")).toBeNull();
	});

	it.each([
		["", "empty"],
		["   ", "empty"],
		["a/b", "invalidChars"],
		["a:b", "invalidChars"],
		["what?", "invalidChars"],
		["..", "reserved"],
		["CON", "reserved"],
		["nul.txt", "reserved"],
		["com1", "reserved"],
		["name.", "trailingDotOrSpace"],
		["x".repeat(256), "tooLong"],
	])("rejects %j as %s", (name, problem) => {
		expect(projectNameProblem(name)).toBe(problem);
	});

	it("does not treat names that merely start with a device name as reserved", () => {
		expect(projectNameProblem("console")).toBeNull();
	});
});

describe("activeInstruction", () => {
	const withContent = (contents: Record<string, string>) =>
		INSTRUCTION_CANDIDATES.map(candidate => ({ ...candidate, content: contents[candidate.relPath] ?? null }));

	it("follows omp priority: native beats claude beats standalone files", () => {
		expect(activeInstruction(withContent({ "AGENTS.md": "a", ".claude/CLAUDE.md": "c" }), "repo")).toBe(".claude/CLAUDE.md");
		expect(activeInstruction(withContent({ "AGENTS.md": "a", ".omp/AGENTS.md": "n" }), "repo")).toBe(".omp/AGENTS.md");
		expect(activeInstruction(withContent({ "AGENTS.md": "a", "CLAUDE.md": "c" }), "repo")).toBe("AGENTS.md");
	});

	it("skips blank files and never picks the sticky RULES.md", () => {
		expect(activeInstruction(withContent({ ".omp/AGENTS.md": "  \n", "CLAUDE.md": "c" }), "repo")).toBe("CLAUDE.md");
		expect(activeInstruction(withContent({ ".omp/RULES.md": "rule" }), "repo")).toBeNull();
	});

	it("ignores standalone files in a dot-named project folder", () => {
		expect(activeInstruction(withContent({ "AGENTS.md": "a" }), ".config")).toBeNull();
	});
});

describe("parseRuleMarkdown", () => {
	it("reads omp rule frontmatter", () => {
		const parsed = parseRuleMarkdown("---\ndescription: TS style\nglobs: [\"**/*.ts\"]\nalwaysApply: true\n---\n\nUse tabs.\n");
		expect(parsed).toMatchObject({
			description: "TS style",
			globs: ["**/*.ts"],
			alwaysApply: true,
			enabled: true,
			body: "Use tabs.",
			frontmatterError: null,
		});
	});

	it("falls back line by line on invalid YAML, like omp (Cursor-style unquoted globs)", () => {
		const parsed = parseRuleMarkdown("---\ndescription: Styles\nglobs: *.css\n---\nBody");
		expect(parsed.frontmatterError).not.toBeNull();
		expect(parsed.description).toBe("Styles");
		expect(parsed.globs).toEqual(["*.css"]);
		expect(parsed.body).toBe("Body");
	});

	it("treats a file without frontmatter as body only", () => {
		expect(parseRuleMarkdown("Just text").body).toBe("Just text");
	});

	it("honours enabled: false", () => {
		expect(parseRuleMarkdown("---\nenabled: false\n---\nx").enabled).toBe(false);
	});
});

describe("renderRuleMarkdown", () => {
	it("writes a minimal new rule", () => {
		expect(renderRuleMarkdown(null, { name: "style", body: "Use tabs." })).toBe("Use tabs.\n");
		expect(renderRuleMarkdown(null, { name: "style", description: "Style", globs: ["*.ts"], body: "Use tabs." })).toBe(
			"---\ndescription: Style\nglobs:\n  - \"*.ts\"\n---\n\nUse tabs.\n",
		);
	});

	it("keeps comments, unknown keys and untouched fields of an existing rule", () => {
		const existing = "---\n# owned by platform team\ndescription: Old\nscope: [\"tool:edit(*.ts)\"]\nglobs: [\"*.ts\"]\n---\nOld body\n";
		const next = renderRuleMarkdown(existing, { name: "style", description: "New", alwaysApply: true, body: "New body" });
		expect(next).toContain("# owned by platform team");
		expect(next).toContain('scope: [ "tool:edit(*.ts)" ]');
		expect(next).toContain('globs: [ "*.ts" ]');
		expect(next).toContain("alwaysApply: true");
		const reparsed = parseRuleMarkdown(next);
		expect(reparsed).toMatchObject({ description: "New", globs: ["*.ts"], alwaysApply: true, body: "New body" });
	});

	it("removes cleared fields", () => {
		const existing = "---\ndescription: Old\nglobs: [\"*.ts\"]\nalwaysApply: true\n---\nBody\n";
		expect(renderRuleMarkdown(existing, { name: "r", description: null, globs: [], alwaysApply: false, body: "Body" })).toBe(
			"Body\n",
		);
	});
});
