import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFileName, applyAgentDraft, parseAgentMarkdown, serializeAgent } from "./parse";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

function fieldsOf(content: string) {
	const result = parseAgentMarkdown(content);
	if (!result.ok) throw new Error(result.error);
	return result;
}

describe("parseAgentMarkdown", () => {
	it("reads `omp agents unpack` output for scout", () => {
		const { fields, systemPrompt, warnings } = fieldsOf(fixture("scout.md"));
		expect(fields.name).toBe("scout");
		expect(fields.tools).toEqual(["read", "find", "grep", "glob", "web_search", "yield"]);
		expect(fields.model).toEqual(["@smol"]);
		expect(fields.thinkingLevel).toBe("medium");
		expect(fields.output).toMatchObject({ properties: { summary: { type: "string" } } });
		expect(systemPrompt.startsWith("---")).toBe(false);
		expect(systemPrompt).toContain("MUST operate as read-only");
		expect(warnings).toEqual([]);
	});

	it("reads task's quoted spawns wildcard and auto thinking", () => {
		const { fields } = fieldsOf(fixture("task.md"));
		expect(fields.spawns).toBe("*");
		expect(fields.thinkingLevel).toBe("auto");
		expect(fields.tools).toBeUndefined();
	});

	it("accepts hand-written kebab-case keys, CSV lists and tool aliases", () => {
		const { fields } = fieldsOf(
			[
				"---",
				"name: advisor",
				"description: Second opinion",
				"model: openai/gpt-5:high, @smol",
				"tools: Read, search, task, my_mcp_tool",
				"read-summarize: false",
				"thinking: HIGHEST",
				"autoload-skills: pdf, docx",
				'prewalk: "@smol"',
				"advisor: 'true'",
				"---",
				"Body",
			].join("\n"),
		);
		expect(fields.model).toEqual(["openai/gpt-5:high", "@smol"]);
		expect(fields.tools).toEqual(["read", "grep", "task", "my_mcp_tool", "yield"]);
		// tools include `task` and no explicit spawns: omp infers "*"
		expect(fields.spawns).toBe("*");
		expect(fields.readSummarize).toBe(false);
		expect(fields.thinkingLevel).toBeUndefined();
		expect(fields.autoloadSkills).toEqual(["pdf", "docx"]);
		expect(fields.prewalk).toBe("@smol");
		expect(fields.advisor).toBe(true);
	});

	it("warns about unknown thinking levels instead of rejecting", () => {
		const result = parseAgentMarkdown("---\nname: a\ndescription: b\nthinking-level: turbo\n---\nx");
		expect(result.ok).toBe(true);
		expect(result.warnings.join(" ")).toContain("turbo");
	});

	it("rejects missing description and reserved names", () => {
		expect(parseAgentMarkdown("---\nname: a\n---\nbody")).toMatchObject({ ok: false });
		expect(parseAgentMarkdown("---\nname: Main\ndescription: x\n---\nbody")).toMatchObject({ ok: false });
		expect(parseAgentMarkdown("just a body")).toMatchObject({ ok: false });
	});

	it("repairs unquoted colons and falls back to key/value lines on broken YAML", () => {
		const repaired = fieldsOf("---\nname: a\ndescription: Does X: then Y\n---\nb");
		expect(repaired.fields.description).toBe("Does X: then Y");
		expect(repaired.warnings).toEqual([]);

		const broken = parseAgentMarkdown("---\nname: a\ndescription: fine\ntools: [read\n---\nb");
		expect(broken.ok).toBe(true);
		expect(broken.warnings[0]).toContain("not valid YAML");
		if (broken.ok) expect(broken.fields.tools).toEqual(["[read", "yield"]);
	});

	it("handles CRLF files and strips HTML comments like omp", () => {
		const { fields, systemPrompt } = fieldsOf("<!-- note -->---\r\nname: a\r\ndescription: b\r\n---\r\nHello <!-- hidden -->world\r\n");
		expect(fields.name).toBe("a");
		expect(systemPrompt).toBe("Hello world");
	});
});

describe("serializeAgent / applyAgentDraft", () => {
	it("round-trips a created agent", () => {
		const content = serializeAgent({
			name: "Docs Writer",
			description: "Writes docs: concise",
			systemPrompt: "You write docs.\n",
			tools: ["read", "write"],
			model: ["@smol"],
			thinkingLevel: "low",
			readSummarize: false,
			blocking: null,
		});
		expect(content).toContain("tools: [ read, write ]");
		expect(content).toContain("thinking-level: low");
		expect(content).not.toContain("blocking");
		const { fields, systemPrompt } = fieldsOf(content);
		expect(fields).toMatchObject({
			name: "Docs Writer",
			description: "Writes docs: concise",
			tools: ["read", "write", "yield"],
			thinkingLevel: "low",
			readSummarize: false,
		});
		expect(systemPrompt).toBe("You write docs.");
	});

	it("edits in place, keeping comments, unknown keys and the existing key spelling", () => {
		const original = [
			"---",
			"# owned by platform team",
			"name: helper",
			"description: Helps",
			"thinkingLevel: high # tuned",
			"x-team: platform",
			"blocking: true",
			"---",
			"",
			"Original prompt.",
			"",
		].join("\n");
		const next = applyAgentDraft(original, { description: "Helps more", thinkingLevel: "low", blocking: null });
		expect(next).toContain("# owned by platform team");
		expect(next).toContain("x-team: platform");
		expect(next).toContain("thinkingLevel: low");
		expect(next).not.toContain("thinking-level");
		expect(next).not.toContain("blocking");
		expect(next).toContain("Original prompt.");
		expect(fieldsOf(next).fields).toMatchObject({ description: "Helps more", thinkingLevel: "low" });

		const reprompted = applyAgentDraft(next, { systemPrompt: "New prompt." });
		expect(fieldsOf(reprompted).systemPrompt).toBe("New prompt.");
		expect(reprompted).toContain("x-team: platform");
	});

	it("drops alias spellings when replacing a field", () => {
		const next = applyAgentDraft("---\nname: a\ndescription: b\nthinking: high\n---\nx", { thinkingLevel: "max" });
		expect(next).toContain("thinking: max");
		expect(fieldsOf(next).fields.thinkingLevel).toBe("max");
	});

	it("adds frontmatter to a file without one", () => {
		const next = applyAgentDraft("Just instructions.\n", { name: "a", description: "b" });
		expect(fieldsOf(next)).toMatchObject({ fields: { name: "a" }, systemPrompt: "Just instructions." });
	});
});

describe("agentFileName", () => {
	it("makes path-safe names", () => {
		expect(agentFileName("Docs Writer")).toBe("Docs-Writer.md");
		expect(agentFileName("../../etc/passwd")).toBe("etc-passwd.md");
		expect(agentFileName("security-reviewer")).toBe("security-reviewer.md");
		expect(agentFileName("  ")).toBe("agent.md");
	});
});
