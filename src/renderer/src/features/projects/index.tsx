/**
 * Projects feature: the project overview, the folder chooser and in-app folder browser ("Start a
 * chat in…"), the new-project wizard, the project instructions and project settings pages,
 * importing Claude Code / Codex chats, and the Share dialog with live invites.
 */
import { DownloadSimple, FileText, FolderOpen, FolderPlus, Folders, GitBranch, ShareNetwork, SlidersHorizontal } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { registerCommand } from "@/registry/commands";
import { chatSlots, pages, type PaneProps, screens, sheets, statusItems } from "@/registry/slots";
import { useSessionView } from "@/shell/hooks";
import { useApp } from "@/state/app";
import { openProjectInstructions, openProjectSettings } from "@/state/navigation";
import { cn, Tooltip } from "@/ui";
import { focusRing } from "@/ui/styles";
import { chooseFolder, openFolder } from "./actions";
import { FolderChip } from "./folders/FolderChip";
import { FolderChooser } from "./folders/FolderChooser";
import { HomeScreen } from "./HomeScreen";
import { ImportDialog } from "./ImportDialog";
import { InstructionsPage } from "./InstructionsPage";
import { NewProjectWizard } from "./NewProjectWizard";
import { ProjectSettingsPage } from "./ProjectSettingsPage";
import { ShareDialog } from "./ShareDialog";
import { useShares } from "./share-store";

const MAC = window.vomp.platform === "darwin";

screens.register({ id: "home", component: HomeScreen });
sheets.register({ id: "project-new", component: NewProjectWizard });
pages.register({ id: "project-instructions", component: InstructionsPage });
pages.register({ id: "project-settings", component: ProjectSettingsPage });
sheets.register({ id: "project-import", component: ImportDialog });
sheets.register({ id: "share", component: ShareDialog });
sheets.register({ id: "folder-chooser", component: FolderChooser });

chatSlots.register({ id: "projects.folder", placement: "composerTools", order: 10, component: FolderChip });

/** Status-bar item while the focused chat is shared live (DESIGN §4.20); opens the Invite tab. */
function SharedStatus({ session }: PaneProps): ReactNode {
	const { t } = useTranslation("projects");
	const view = useSessionView(session);
	const hostId = view?.host?.hostId;
	const share = useShares(state => (hostId ? state.byHost[hostId] : undefined));
	if (!session || !share || share.phase === "stopped") return null;
	const live = share.phase === "live";
	return (
		<Tooltip content={t("share.chipHint", { count: share.remoteGuests })}>
			<button
				type="button"
				className={cn(
					"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-xs text-fg-muted transition-colors duration-(--dur-fast) hover:bg-hover hover:text-fg",
					focusRing,
				)}
				onClick={() => useApp.getState().openSheet("share", { tabId: session.tabId, tab: "invite" })}
			>
				<span aria-hidden className={cn("size-1.5 rounded-full", live ? "bg-accent" : "bg-warn")} />
				{live ? t("share.chip") : t(`share.invite.phase.${share.phase}`)}
			</button>
		</Tooltip>
	);
}

statusItems.register({ id: "projects.shared", side: "left", order: 40, component: SharedStatus });

registerCommand({
	id: "project.new",
	title: "projects:commands.new.title",
	hint: "projects:commands.new.hint",
	keywords: "projects:commands.new.keywords",
	group: "actions",
	icon: FolderPlus,
	shortcut: MAC ? "⇧⌘N" : "Ctrl+Shift+N",
	run: () => useApp.getState().openSheet("project-new"),
});

registerCommand({
	id: "project.open",
	title: "projects:commands.open.title",
	hint: "projects:commands.open.hint",
	keywords: "projects:commands.open.keywords",
	group: "actions",
	icon: FolderOpen,
	shortcut: MAC ? "⌘O" : "Ctrl+O",
	run: () => openFolder(),
});

registerCommand({
	id: "chat.startIn",
	title: "projects:commands.startIn.title",
	hint: "projects:commands.startIn.hint",
	keywords: "projects:commands.startIn.keywords",
	group: "chat",
	icon: Folders,
	run: () => chooseFolder(),
});

registerCommand({
	id: "project.newFolder",
	title: "projects:commands.newFolder.title",
	hint: "projects:commands.newFolder.hint",
	keywords: "projects:commands.newFolder.keywords",
	group: "actions",
	icon: FolderPlus,
	run: () => useApp.getState().openSheet("project-new", { kind: "empty" }),
});

registerCommand({
	id: "project.clone",
	title: "projects:commands.clone.title",
	hint: "projects:commands.clone.hint",
	keywords: "projects:commands.clone.keywords",
	group: "actions",
	icon: GitBranch,
	run: () => useApp.getState().openSheet("project-new", { kind: "clone" }),
});

registerCommand({
	id: "project.instructions",
	title: "projects:commands.instructions.title",
	hint: "projects:commands.instructions.hint",
	keywords: "projects:commands.instructions.keywords",
	group: "manage",
	icon: FileText,
	when: ({ projectPath }) => projectPath !== null,
	run: ({ projectPath }) => {
		if (projectPath) openProjectInstructions(projectPath);
	},
});

registerCommand({
	id: "project.settings",
	title: "projects:commands.settings.title",
	hint: "projects:commands.settings.hint",
	keywords: "projects:commands.settings.keywords",
	group: "settings",
	icon: SlidersHorizontal,
	when: ({ projectPath }) => projectPath !== null,
	run: ({ projectPath }) => {
		if (projectPath) openProjectSettings(projectPath);
	},
});

registerCommand({
	id: "project.import",
	title: "projects:commands.import.title",
	hint: "projects:commands.import.hint",
	keywords: "projects:commands.import.keywords",
	group: "actions",
	icon: DownloadSimple,
	run: ({ projectPath }) => useApp.getState().openSheet("project-import", { projectPath }),
});

registerCommand({
	id: "chat.share",
	title: "projects:commands.share.title",
	hint: "projects:commands.share.hint",
	keywords: "projects:commands.share.keywords",
	slash: "/share",
	group: "chat",
	icon: ShareNetwork,
	header: 120,
	when: ({ session }) => session !== null,
	run: ({ session }) => useApp.getState().openSheet("share", { tabId: session?.tabId ?? null }),
});
