/**
 * Manage: Settings (`app.settings`, ⌘,), Model roles (`manage.roles`) and the Helpers hub
 * (`manage.agents`). Each opens a modal sheet; other features open them directly with
 * `useApp.getState().openSheet("settings" | "model-roles" | "agents", props)`.
 */
import { Gear, Plug, Robot, Stack } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { sheets } from "@/registry/slots";
import { useApp } from "@/state/app";
import { AgentsSheet } from "./agents/AgentsSheet";
import { ModelRolesSheet } from "./roles/ModelRolesSheet";
import { SettingsSheet } from "./settings/SettingsSheet";

sheets.register({ id: "settings", component: SettingsSheet });
sheets.register({ id: "model-roles", component: ModelRolesSheet });
sheets.register({ id: "agents", component: AgentsSheet });

const mac = window.vomp.platform === "darwin";

registerCommand({
	id: "app.settings",
	title: "manage:commands.settings.title",
	hint: "manage:commands.settings.hint",
	keywords: "manage:commands.settings.keywords",
	slash: "/settings",
	group: "settings",
	icon: Gear,
	shortcut: mac ? "⌘," : "Ctrl+,",
	run: ({ projectPath }) => useApp.getState().openSheet("settings", { projectPath }),
});

registerCommand({
	id: "manage.providers",
	title: "manage:commands.providers.title",
	hint: "manage:commands.providers.hint",
	keywords: "manage:commands.providers.keywords",
	slash: "/login",
	group: "manage",
	icon: Plug,
	run: ({ projectPath }) => useApp.getState().openSheet("settings", { tab: "providers", projectPath }),
});

registerCommand({
	id: "manage.roles",
	title: "manage:commands.roles.title",
	hint: "manage:commands.roles.hint",
	keywords: "manage:commands.roles.keywords",
	group: "manage",
	icon: Stack,
	run: ({ projectPath }) => useApp.getState().openSheet("model-roles", { projectPath }),
});

registerCommand({
	id: "manage.agents",
	title: "manage:commands.agents.title",
	hint: "manage:commands.agents.hint",
	keywords: "manage:commands.agents.keywords",
	slash: "/agents",
	group: "manage",
	icon: Robot,
	header: 40,
	run: ({ projectPath }) => useApp.getState().openSheet("agents", { projectPath }),
});
