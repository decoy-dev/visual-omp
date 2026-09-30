import { ChevronDown, PanelLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { controllerFor, focusedTabId, useApp } from "../state/app";
import { cn, IconButton, Wordmark } from "../ui";
import { chatTitle, useSessionView } from "./hooks";

/** Frameless window bar (DESIGN §3.1): glass, draggable, breadcrumb centered. */
export function TitleBar(): ReactNode {
	const { t } = useTranslation("shell");
	const isMac = window.vomp.platform === "darwin";
	const sidebarOpen = useApp(state => state.sidebarOpen);
	const projects = useApp(state => state.projects);
	const activeProject = useApp(state => state.activeProject);
	const tabId = useApp(focusedTabId);
	const tab = useApp(state => state.tabs.find(entry => entry.id === tabId) ?? null);
	const view = useSessionView(controllerFor(tabId));
	const project = projects.find(entry => entry.path === activeProject);
	const title = tab ? (chatTitle(view, tab.title) ?? t("tabs.newChatTitle")) : null;

	return (
		<header
			className={cn(
				"glass drag-region relative z-(--z-titlebar) flex h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-border",
				isMac ? "pl-[92px]" : "pl-3",
				isMac ? "pr-3" : "pr-[150px]",
			)}
		>
			{!sidebarOpen && (
				<IconButton
					className="no-drag"
					label={t("titlebar.showSidebar")}
					shortcut="⌘B"
					icon={<PanelLeft />}
					size="sm"
					onClick={() => useApp.getState().toggleSidebar()}
				/>
			)}
			<Wordmark withMark size="sm" />
			<div className="pointer-events-none absolute inset-x-0 flex justify-center">
				{project && (
					<button
						type="button"
						className="no-drag pointer-events-auto flex max-w-[40vw] items-center gap-1 rounded-md px-2 py-1 text-md text-fg-muted hover:bg-hover hover:text-fg"
						aria-label={t("titlebar.switchChat")}
						onClick={() => useApp.getState().setPaletteOpen(true)}
					>
						<span className="truncate">{project.name}</span>
						{title && (
							<>
								<span className="text-fg-faint">/</span>
								<span className="truncate text-fg">{title}</span>
							</>
						)}
						<ChevronDown className="size-3.5 shrink-0" />
					</button>
				)}
			</div>
		</header>
	);
}
