/**
 * Manage: the Settings page (`settings`) with the App, Agent, Advanced and About sections, and the
 * commands that open it: Settings (`app.settings`, ⌘,), Connect a provider, Models & roles and Helpers.
 * Other features link into it with `openSettings(section, options)` (`state/navigation.ts`). The page
 * and its rail load with the app; each section loads from its own chunk (`lazySection`).
 */
import { Bell, Gear, Info, Keyboard, Palette, Plug, Robot, ShieldCheck, SlidersHorizontal, Stack, Wrench } from "@phosphor-icons/react";
import { registerCommand } from "@/registry/commands";
import { lazySection } from "@/registry/lazy";
import { pages, settingsSections } from "@/registry/slots";
import { openSettings } from "@/state/navigation";
import { SettingsPage } from "./settings/SettingsPage";

pages.register({ id: "settings", component: SettingsPage });

settingsSections.register({
	id: "general",
	group: "app",
	order: 10,
	title: "manage:settings.sections.general",
	icon: SlidersHorizontal,
	scoped: true,
	component: lazySection(() => import("./settings/GeneralSection").then(m => m.GeneralSection)),
});
settingsSections.register({
	id: "appearance",
	group: "app",
	order: 20,
	title: "manage:settings.sections.appearance",
	icon: Palette,
	component: lazySection(() => import("./settings/AppearanceSection").then(m => m.AppearanceSection)),
});
settingsSections.register({
	id: "alerts",
	group: "app",
	order: 30,
	title: "manage:settings.sections.alerts",
	icon: Bell,
	component: lazySection(() => import("./settings/AlertsSection").then(m => m.AlertsSection)),
});
settingsSections.register({
	id: "shortcuts",
	group: "app",
	order: 40,
	title: "manage:settings.sections.shortcuts",
	icon: Keyboard,
	component: lazySection(() => import("./settings/ShortcutsSection").then(m => m.ShortcutsSection)),
});
settingsSections.register({
	id: "models",
	group: "agent",
	order: 10,
	title: "manage:settings.sections.models",
	icon: Stack,
	scoped: true,
	component: lazySection(() => import("./roles/ModelsSection").then(m => m.ModelsSection)),
});
settingsSections.register({
	id: "permissions",
	group: "agent",
	order: 20,
	title: "manage:settings.sections.permissions",
	icon: ShieldCheck,
	scoped: true,
	component: lazySection(() => import("./settings/PermissionsSection").then(m => m.PermissionsSection)),
});
settingsSections.register({
	id: "providers",
	group: "agent",
	order: 30,
	title: "manage:settings.sections.providers",
	icon: Plug,
	component: lazySection(() => import("./settings/ProvidersSection").then(m => m.ProvidersSection)),
});
settingsSections.register({
	id: "helpers",
	group: "agent",
	order: 40,
	title: "manage:settings.sections.helpers",
	icon: Robot,
	component: lazySection(() => import("./agents/HelpersSection").then(m => m.HelpersSection)),
});
settingsSections.register({
	id: "advanced",
	group: "advanced",
	order: 10,
	title: "manage:settings.sections.advanced",
	icon: Wrench,
	scoped: true,
	component: lazySection(() => import("./settings/AdvancedSection").then(m => m.AdvancedSection)),
});
settingsSections.register({
	id: "about",
	group: "advanced",
	order: 20,
	title: "manage:settings.sections.about",
	icon: Info,
	component: lazySection(() => import("./settings/AboutSection").then(m => m.AboutSection)),
});

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
	run: ({ projectPath }) => openSettings("general", { projectPath }),
});

registerCommand({
	id: "manage.providers",
	title: "manage:commands.providers.title",
	hint: "manage:commands.providers.hint",
	keywords: "manage:commands.providers.keywords",
	slash: "/login",
	group: "manage",
	icon: Plug,
	run: ({ projectPath }) => openSettings("providers", { projectPath }),
});

registerCommand({
	id: "manage.roles",
	title: "manage:commands.roles.title",
	hint: "manage:commands.roles.hint",
	keywords: "manage:commands.roles.keywords",
	group: "manage",
	icon: Stack,
	run: ({ projectPath }) => openSettings("models", { projectPath }),
});

registerCommand({
	id: "manage.agents",
	title: "manage:commands.agents.title",
	hint: "manage:commands.agents.hint",
	keywords: "manage:commands.agents.keywords",
	slash: "/agents",
	group: "manage",
	icon: Robot,
	header: 410,
	run: ({ projectPath }) => openSettings("helpers", { projectPath }),
});
