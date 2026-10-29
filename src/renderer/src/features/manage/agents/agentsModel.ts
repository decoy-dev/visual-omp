/** Pure helpers for the Helpers section: chat prompts and copy names. */
import type { AgentCreateDraft, AgentEntry, AgentWritableScope } from "@shared/contracts/agents";

/**
 * Chat prompt for "Create with AI". omp's own /agents hub generates the definition with a hidden
 * one-shot session (agents-hub-deps.ts `generateAgent`) that no CLI or protocol exposes, so the app
 * asks omp in a normal chat to write the same file shape: `<dir>/<identifier>.md` with `name` and a
 * one-sentence `description` frontmatter and a second-person system prompt as the body.
 */
export function createWithAiPrompt(description: string, dir: string, scope: AgentWritableScope): string {
	const where = scope === "project" ? "this project only" : "all my projects";
	return [
		`Create a new omp helper agent (a task subagent definition) for ${where}.`,
		"",
		"What it should do:",
		description.trim(),
		"",
		"Requirements:",
		`- Write exactly one new Markdown file in \`${dir}\` named \`<identifier>.md\`. Create the folder if it is missing. Do not overwrite an existing file and do not change anything else.`,
		"- The identifier uses lowercase letters, numbers and hyphens: 2-4 words that say what the helper does. Avoid generic words such as helper or assistant.",
		"- Start the file with YAML frontmatter containing `name: <identifier>` and `description:`, set to one plain sentence starting with \"Use this agent when…\".",
		"- Add a `tools:` list only if the helper clearly needs fewer tools than usual (for example a read-only reviewer).",
		"- After the frontmatter, write the helper's full instructions in second person (\"You are…\", \"You will…\"): its expertise, how it works step by step, how it checks its own work, when to ask for clarification, and what its final answer looks like.",
		"",
		"When you are done, tell me the helper's name and summarize what it does in one or two sentences.",
	].join("\n");
}

/** Name for a duplicate: `reviewer` → `reviewer-copy`, then `reviewer-copy-2`, … */
export function copyName(name: string, taken: ReadonlySet<string>): string {
	const base = `${name}-copy`;
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Copy definition fields without losing explicit tools or the structured result contract. */
export function duplicateAgentDraft(agent: AgentEntry, name: string): AgentCreateDraft {
	return {
		name,
		description: agent.description,
		systemPrompt: agent.systemPrompt,
		tools: agent.tools,
		spawns: agent.spawns,
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
		output: agent.output,
		structured: agent.structured,
		blocking: agent.blocking,
		autoloadSkills: agent.autoloadSkills,
		readSummarize: agent.readSummarize,
		prewalk: agent.prewalk,
		advisor: agent.advisor,
	};
}
