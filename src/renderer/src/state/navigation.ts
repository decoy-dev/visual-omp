/**
 * Destinations every feature can open. Pages render in the main area (`useApp.openPage`); the
 * features that own them register the page (`pages`) and Settings sections (`settingsSections`).
 */
import type { SettingScope } from "@shared/contracts/config";
import { useTranslation } from "react-i18next";
import type { PageBack } from "@/ui";
import { useApp } from "./app";

/** Back link for a page: "Back to chat" or "Back to project", depending on what the page replaced. */
export function usePageBack(close: () => void): PageBack {
	const { t } = useTranslation("shell");
	const returnTo = useApp(state => state.pageReturn);
	return { label: t(returnTo === "chat" ? "page.backToChat" : "page.backToProject"), onBack: close };
}

/** Settings sections, in rail order within their groups (see `settingsSections`). */
export const SETTINGS_SECTIONS = [
	"general",
	"appearance",
	"alerts",
	"shortcuts",
	"models",
	"permissions",
	"providers",
	"helpers",
	"mcp",
	"skills",
	"memory",
	"advanced",
	"about",
] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number];

/**
 * Deep link into Settings. Every field is applied each time Settings opens or is re-linked while open
 * (`PageProps.seq`): `section` defaults to "general"; `projectPath` is fixed when the link is made (the
 * focused project at that moment) and does not follow later focus changes; `scope` defaults to
 * "global" and falls back to "global" when there is no project; `sectionProps` goes to the section.
 */
export interface SettingsPageProps {
	section: SettingsSectionId;
	projectPath: string | null;
	scope: SettingScope;
	/** For the section, such as which tab of Skills & plugins to show. */
	sectionProps?: unknown;
}

export function openSettings(section: SettingsSectionId = "general", options: Partial<Omit<SettingsPageProps, "section">> = {}): void {
	const projectPath = options.projectPath !== undefined ? options.projectPath : useApp.getState().activeProject;
	const scope = projectPath ? (options.scope ?? "global") : "global";
	useApp.getState().openPage("settings", { section, projectPath, scope, sectionProps: options.sectionProps } satisfies SettingsPageProps);
}

export interface UsagePageProps {
	projectPath?: string | null;
}

export function openUsage(options: UsagePageProps = {}): void {
	useApp.getState().openPage("usage", { projectPath: options.projectPath ?? useApp.getState().activeProject } satisfies UsagePageProps);
}

export function openHelp(): void {
	useApp.getState().openPage("help", {});
}

export interface ProjectPageProps {
	projectPath: string;
}

export interface ProjectInstructionsPageProps extends ProjectPageProps {
	/** Open on the instructions file or on the rules list. */
	tab?: "instructions" | "rules";
}

/** The project's settings (model, permissions, tools, helpers, skills for this folder). */
export function openProjectSettings(projectPath: string): void {
	useApp.getState().openPage("project-settings", { projectPath } satisfies ProjectPageProps);
}

export function openProjectInstructions(projectPath: string, tab?: ProjectInstructionsPageProps["tab"]): void {
	useApp.getState().openPage("project-instructions", { projectPath, tab } satisfies ProjectInstructionsPageProps);
}
