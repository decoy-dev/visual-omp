/** Pure helpers for the Helpers (agents) hub: running detection and chat prompts. */
import type { AgentWritableScope } from "@shared/contracts/agents";
import type { GuestSnapshot } from "@/collab/lib/client";

/** A live chat for running-now detection. */
export interface LiveChat {
	title: string;
	guest: GuestSnapshot | null;
}

/**
 * Agent name → titles of the chats where a subagent of that type is running right now. Progress
 * frames carry the live status; lifecycle frames cover subagents that started but have not reported
 * progress yet.
 */
export function runningAgentChats(chats: readonly LiveChat[]): Map<string, string[]> {
	const running = new Map<string, string[]>();
	for (const chat of chats) {
		if (!chat.guest) continue;
		const names = new Set<string>();
		const reported = new Set<string>();
		for (const payload of chat.guest.progress.values()) {
			reported.add(payload.progress.id);
			if (payload.progress.status === "running" || payload.progress.status === "pending") names.add(payload.progress.agent);
		}
		for (const event of chat.guest.lifecycle.values()) {
			if (event.status === "started" && !reported.has(event.id)) names.add(event.agent);
		}
		for (const name of names) {
			const titles = running.get(name);
			if (titles) titles.push(chat.title);
			else running.set(name, [chat.title]);
		}
	}
	return running;
}

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
