/**
 * Projects feature: the project home dashboard, the new-project wizard, the instructions editor,
 * per-project settings, importing Claude Code / Codex chats, and the Share dialog with live invites.
 */
import { FileText, FolderOpen, FolderPlus, Import, Share2, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { registerCommand } from "@/registry/commands";
import { type ChatSlotProps, chatSlots, screens, sheets } from "@/registry/slots";
import { useSessionView } from "@/shell/hooks";
import { useApp } from "@/state/app";
import { Chip, Tooltip } from "@/ui";
import { openFolder } from "./actions";
import { HomeScreen } from "./HomeScreen";
import { ImportDialog } from "./ImportDialog";
import { InstructionsSheet } from "./InstructionsSheet";
import { NewProjectWizard } from "./NewProjectWizard";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet";
import { ShareDialog } from "./ShareDialog";
import { useShares } from "./share-store";

const MAC = window.vomp.platform === "darwin";

screens.register({ id: "home", component: HomeScreen });
sheets.register({ id: "project-new", component: NewProjectWizard });
sheets.register({ id: "project-instructions", component: InstructionsSheet });
sheets.register({ id: "project-settings", component: ProjectSettingsSheet });
sheets.register({ id: "project-import", component: ImportDialog });
sheets.register({ id: "share", component: ShareDialog });

/** Session-header chip while the chat is shared live (DESIGN §4.20); opens the Invite tab. */
function SharedChip({ session }: ChatSlotProps): ReactNode {
	const { t } = useTranslation("projects");
	const view = useSessionView(session);
	const hostId = view?.host?.hostId;
	const share = useShares(state => (hostId ? state.byHost[hostId] : undefined));
	if (!share || share.phase === "stopped") return null;
	return (
		<Tooltip content={t("share.chipHint", { count: share.remoteGuests })}>
			<button
				type="button"
				className="rounded-full outline-none focus-visible:outline-2 focus-visible:outline-ring"
				onClick={() => useApp.getState().openSheet("share", { tabId: session.tabId, tab: "invite" })}
			>
				<Chip tone={share.phase === "live" ? "accent" : "warn"} dot>
					{t("share.chip")}
				</Chip>
			</button>
		</Tooltip>
	);
}

chatSlots.register({ id: "projects.shared", placement: "headerChips", order: 80, component: SharedChip });

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
	id: "project.instructions",
	title: "projects:commands.instructions.title",
	hint: "projects:commands.instructions.hint",
	keywords: "projects:commands.instructions.keywords",
	group: "manage",
	icon: FileText,
	when: ({ projectPath }) => projectPath !== null,
	run: ({ projectPath }) => useApp.getState().openSheet("project-instructions", { projectPath }),
});

registerCommand({
	id: "project.settings",
	title: "projects:commands.settings.title",
	hint: "projects:commands.settings.hint",
	keywords: "projects:commands.settings.keywords",
	group: "settings",
	icon: SlidersHorizontal,
	when: ({ projectPath }) => projectPath !== null,
	run: ({ projectPath }) => useApp.getState().openSheet("project-settings", { projectPath }),
});

registerCommand({
	id: "project.import",
	title: "projects:commands.import.title",
	hint: "projects:commands.import.hint",
	keywords: "projects:commands.import.keywords",
	group: "actions",
	icon: Import,
	run: ({ projectPath }) => useApp.getState().openSheet("project-import", { projectPath }),
});

registerCommand({
	id: "chat.share",
	title: "projects:commands.share.title",
	hint: "projects:commands.share.hint",
	keywords: "projects:commands.share.keywords",
	slash: "/share",
	group: "chat",
	icon: Share2,
	header: 60,
	when: ({ session }) => session !== null,
	run: ({ session }) => useApp.getState().openSheet("share", { tabId: session?.tabId ?? null }),
});
