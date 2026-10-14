/**
 * Context & tools in Settings: Connected tools (MCP servers), Skills & plugins and Memory, each also
 * opened by a `manage.*` command. Usage & limits registers itself from `./usage`.
 */
import { BookOpenText, Brain, PlugsConnected } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { settingsSections } from "@/registry/slots";
import { openSettings } from "@/state/navigation";
import { MemorySection } from "./memory/MemorySection";
import { McpSection } from "./mcp/McpSection";
import { SkillsSection } from "./skills/SkillsSection";
import "./usage";

settingsSections.register({ id: "mcp", group: "context", order: 10, title: "extensions:mcp.title", icon: PlugsConnected, scoped: true, component: McpSection });
settingsSections.register({ id: "skills", group: "context", order: 20, title: "extensions:skills.title", icon: BookOpenText, component: SkillsSection });
settingsSections.register({ id: "memory", group: "context", order: 30, title: "extensions:memory.title", icon: Brain, component: MemorySection });

const COMMANDS = [
	{ id: "manage.mcp", section: "mcp", icon: PlugsConnected, slash: "/mcp" },
	{ id: "manage.skills", section: "skills", icon: BookOpenText, slash: undefined },
	{ id: "manage.memory", section: "memory", icon: Brain, slash: "/memory" },
] as const;

for (const command of COMMANDS) {
	registerCommand({
		id: command.id,
		title: `extensions:commands.${command.section}.title`,
		hint: `extensions:commands.${command.section}.hint`,
		keywords: `extensions:commands.${command.section}.keywords`,
		slash: command.slash,
		group: "manage",
		icon: command.icon,
		run: ({ projectPath }) => openSettings(command.section, { projectPath }),
	});
}
