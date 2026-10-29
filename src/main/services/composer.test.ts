import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverCommands, parseCommandFile } from "./composer";


describe("commands", () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	it("reads description and argument hint, falling back to the first line", () => {
		expect(parseCommandFile("---\ndescription: Fix an issue\nargument-hint: <number>\n---\nFix issue $1")).toEqual({
			description: "Fix an issue",
			argumentHint: "<number>",
		});
		expect(parseCommandFile("\n\nReview the diff carefully\nmore")).toEqual({
			description: "Review the diff carefully",
			argumentHint: null,
		});
	});


	it("lets project commands shadow user ones and names nested claude commands dir:name", async () => {
		dir = mkdtempSync(join(tmpdir(), "vomp-commands-"));
		const project = join(dir, "project");
		const agent = join(dir, "agent");
		mkdirSync(join(project, ".omp", "commands"), { recursive: true });
		mkdirSync(join(project, ".claude", "commands", "git"), { recursive: true });
		mkdirSync(join(agent, "commands"), { recursive: true });
		writeFileSync(join(project, ".omp", "commands", "review.md"), "Project review");
		writeFileSync(join(project, ".claude", "commands", "git", "pr.md"), "Open a PR");
		writeFileSync(join(agent, "commands", "review.md"), "User review");
		writeFileSync(join(agent, "commands", "standup.md"), "Write standup");
		const commands = await discoverCommands(project, agent);
		expect(commands.map(command => [command.name, command.scope, command.description])).toEqual([
			["git:pr", "project", "Open a PR"],
			["review", "project", "Project review"],
			["standup", "user", "Write standup"],
		]);
	});
});

