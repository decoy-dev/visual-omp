import type { SlashCommandInfo } from "@shared/contracts/composer";
import { describe, expect, it } from "vitest";
import { builtinCommandsFor, mergeSlashCommands, OMP_BUILTIN_COMMANDS } from "./omp-builtin-commands";

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
	it("lists each builtin once", () => {
		const names = OMP_BUILTIN_COMMANDS.map(entry => entry.name);
		expect(new Set(names).size).toBe(names.length);
		expect(OMP_BUILTIN_COMMANDS.flatMap(entry => entry.aliases).sort()).toEqual(["force:", "models", "plugin", "providers", "q", "rewind", "status", "subagents", "worktree"]);
	});

	it("does not suggest the retired Smithery subcommands", () => {
		// Smithery shut down its API on 2026-10-31 and omp 18.18.9 removed these commands.
		const mcp = OMP_BUILTIN_COMMANDS.find(entry => entry.name === "mcp")?.subcommands.map(sub => sub.name) ?? [];
		expect(mcp.filter(name => name.startsWith("smithery-"))).toEqual([]);
	});

	it("includes the new terminal commands and keeps commands older omp still accepts", () => {
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "local")).toMatchObject({
			description: "Open a session local:// file in $EDITOR (picker when no name given)", hint: "[name]",
		});
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "forget-approvals")).toBeDefined();
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "context")?.description).toBe("Browse context usage and detailed content");
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "hub")?.aliases).toContain("subagents");
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "seance")).toBeDefined();
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "unpin")).toBeDefined();
	});
	it("offers each command only to the omp versions that have it", () => {
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "commit")).toMatchObject({ description: "Commit only the changes this agent and its subagents made", hint: "[instructions]" });
		const offered = (name: string, version: string | null) => builtinCommandsFor(version).some(entry => entry.name === name);
		// omp 18.17.0 added /unpin and omp 18.20.1 added /commit; omp 18.20.3 removed /seance.
		expect([offered("unpin", "18.16.9"), offered("unpin", "18.17.0")]).toEqual([false, true]);
		expect([offered("commit", "18.15.0"), offered("commit", "18.20.0"), offered("commit", "18.20.1")]).toEqual([false, false, true]);
		expect([offered("seance", "18.15.0"), offered("seance", "18.20.2"), offered("seance", "18.20.3"), offered("seance", "18.22.0")]).toEqual([true, true, false, false]);
		// A version omp did not report keeps the whole catalog.
		expect(builtinCommandsFor(null)).toEqual(OMP_BUILTIN_COMMANDS);
		expect(builtinCommandsFor("18.22.0")).toHaveLength(OMP_BUILTIN_COMMANDS.length - 1);
	});
	it("offers 18.15 Ultrafast service and retains the upstream jobs and compact syntax", () => {
		const fast = OMP_BUILTIN_COMMANDS.find(entry => entry.name === "fast")!;
		expect(fast.hint).toBe("[on|ultra|off|status]");
		expect(fast.subcommands.find(entry => entry.name === "ultra")?.description).toBe("Enable Ultrafast (OpenAI API, or Codex and relay models that offer it)");
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "jobs")).toMatchObject({ description: "Show async background jobs status", hint: "[full|kill <id>|kill all]" });
		expect(OMP_BUILTIN_COMMANDS.find(entry => entry.name === "compact")).toMatchObject({ description: "Manually compact the session context", hint: "[soft|remote|snapcompact] [focus]" });
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
