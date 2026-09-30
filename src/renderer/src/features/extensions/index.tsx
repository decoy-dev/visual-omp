/**
 * Extensions: MCP servers, skills & plugins, memory, and usage & limits — each a sheet opened by a
 * `manage.*` command — plus the status-bar "today" cost.
 */
import { BookOpenText, Brain, Gauge, PlugsConnected } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { sheets, statusItems } from "@/registry/slots";
import { useApp } from "@/state/app";
import { MemorySheet } from "./memory/MemorySheet";
import { McpSheet } from "./mcp/McpSheet";
import { SkillsSheet } from "./skills/SkillsSheet";
import { UsageSheet } from "./usage/UsageSheet";
import { UsageStatus } from "./usage/UsageStatus";

sheets.register({ id: "mcp", component: McpSheet });
sheets.register({ id: "skills", component: SkillsSheet });
sheets.register({ id: "memory", component: MemorySheet });
sheets.register({ id: "usage", component: UsageSheet });

const COMMANDS = [
	{ id: "manage.mcp", sheet: "mcp", key: "mcp", icon: PlugsConnected, slash: "/mcp" },
	{ id: "manage.skills", sheet: "skills", key: "skills", icon: BookOpenText, slash: undefined },
	{ id: "manage.memory", sheet: "memory", key: "memory", icon: Brain, slash: "/memory" },
	{ id: "manage.usage", sheet: "usage", key: "usage", icon: Gauge, slash: "/usage" },
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

statusItems.register({ id: "usage-today", side: "right", order: 20, component: UsageStatus });
