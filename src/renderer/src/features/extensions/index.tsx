/**
 * Extensions: MCP servers, skills & plugins and memory, each opened by a `manage.*` command. Usage &
 * limits registers itself from `./usage`.
 */
import { BookOpenText, Brain, PlugsConnected } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { sheets } from "@/registry/slots";
import { useApp } from "@/state/app";
import { MemorySheet } from "./memory/MemorySheet";
import { McpSheet } from "./mcp/McpSheet";
import { SkillsSheet } from "./skills/SkillsSheet";
import "./usage";

sheets.register({ id: "mcp", component: McpSheet });
sheets.register({ id: "skills", component: SkillsSheet });
sheets.register({ id: "memory", component: MemorySheet });

const COMMANDS = [
	{ id: "manage.mcp", sheet: "mcp", key: "mcp", icon: PlugsConnected, slash: "/mcp" },
	{ id: "manage.skills", sheet: "skills", key: "skills", icon: BookOpenText, slash: undefined },
	{ id: "manage.memory", sheet: "memory", key: "memory", icon: Brain, slash: "/memory" },
] as const;

for (const command of COMMANDS) {
	registerCommand({
		id: command.id,
		title: `extensions:commands.${command.key}.title`,
		hint: `extensions:commands.${command.key}.hint`,
		keywords: `extensions:commands.${command.key}.keywords`,
		slash: command.slash,
		group: "manage",
		icon: command.icon,
		run: ({ projectPath }) => useApp.getState().openSheet(command.sheet, { projectPath }),
	});
}
