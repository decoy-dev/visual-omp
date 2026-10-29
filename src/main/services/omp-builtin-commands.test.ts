import type { SlashCommandInfo } from "@shared/contracts/composer";
import { describe, expect, it } from "vitest";
import { mergeSlashCommands, OMP_BUILTIN_COMMANDS } from "./omp-builtin-commands";

const command = (name: string, source: SlashCommandInfo["source"], extra: Partial<SlashCommandInfo> = {}): SlashCommandInfo => ({
	name,
	aliases: [],
	description: null,
	hint: null,
	subcommands: [],
	source,
	...extra,
});

describe("OMP_BUILTIN_COMMANDS", () => {
	it("lists omp 18.14's 88 builtins and 9 aliases once each", () => {
		const names = OMP_BUILTIN_COMMANDS.map(entry => entry.name);
		expect(new Set(names).size).toBe(88);
		expect(OMP_BUILTIN_COMMANDS.flatMap(entry => entry.aliases).sort()).toEqual(["force:", "models", "plugin", "providers", "q", "rewind", "status", "subagents", "worktree"]);
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "mcp")?.subcommands.map(sub => sub.name)).toContain("smithery-search");
	});

	it("includes the new terminal commands and keeps commands older omp still accepts", () => {
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "local")).toMatchObject({
			description: "Open a session local:// file in $EDITOR (picker when no name given)", hint: "[name]",
		});
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "forget-approvals")).toBeDefined();
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "context")?.description).toBe("Browse context usage and detailed content");
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "hub")?.aliases).toContain("subagents");
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "seance")).toBeDefined();
	});
});

describe("mergeSlashCommands", () => {
	const builtins = [
		command("settings", "builtin", { description: "Open settings menu" }),
		command("model", "builtin", { aliases: ["models"], description: "Open the model hub", subcommands: [] }),
	];

	it("keeps the static builtins omp's RPC leaves out, in catalog order", () => {
		const merged = mergeSlashCommands(builtins, [command("model", "builtin", { aliases: ["models"] })]);
		expect(merged.map(entry => entry.name)).toEqual(["settings", "model"]);
	});

	it("keeps the terminal UI entry for a builtin omp also lists with its ACP text and syntax", () => {
		const fromOmp = command("model", "builtin", {
			aliases: ["models"],
			description: "Show current model selection",
			hint: "[selector]",
			subcommands: [{ name: "x", description: null, usage: null }],
		});
		const model = mergeSlashCommands(builtins, [fromOmp]).find(entry => entry.name === "model");
		expect(model).toEqual(builtins[1]);
	});

	it("adds builtins a newer omp lists after the known ones, then dynamic commands in omp's order", () => {
		const merged = mergeSlashCommands(builtins, [command("skill:pdf", "skill"), command("newthing", "builtin"), command("review", "custom")]);
		expect(merged.map(entry => `${entry.source}:${entry.name}`)).toEqual(["builtin:settings", "builtin:model", "builtin:newthing", "skill:skill:pdf", "custom:review"]);
	});

	it("drops dynamic commands that a builtin name or alias would shadow", () => {
		const merged = mergeSlashCommands(builtins, [command("settings", "file"), command("models", "custom"), command("init", "file"), command("init", "custom")]);
		expect(merged.map(entry => `${entry.source}:${entry.name}`)).toEqual(["builtin:settings", "builtin:model", "file:init"]);
	});

	it("returns the static catalog when omp lists nothing", () => {
		expect(mergeSlashCommands(builtins, [])).toEqual(builtins);
	});
});
