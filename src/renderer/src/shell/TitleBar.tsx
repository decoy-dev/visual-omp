import { CaretDown, SidebarSimple } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { controllerFor, focusedTabId, useApp } from "../state/app";
import { cn, IconButton, PresenceSwap, Wordmark } from "../ui";
import { chatTitle, useSessionView } from "./hooks";

/** Frameless window bar (DESIGN §3.1): opaque, draggable, breadcrumb centered. The breadcrumb crossfades when the chat changes. */
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
	const [version, setVersion] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		void window.vomp.invoke("app:info").then(info => {
			if (live) setVersion(info.version);
		});
		return () => {
			live = false;
		};
	}, []);

	return (
		// Three columns: the side columns share the free space equally, so the breadcrumb stays centered, but the
		// lockup column never shrinks below its content, so a long breadcrumb shortens instead of covering it.
		<header
			className={cn(
				"glass drag-region relative z-(--z-titlebar) grid h-(--titlebar-h) shrink-0 items-center gap-2 border-b border-border px-[12px]",
				isMac ? "grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(0,1fr)]" : "grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(138px,1fr)]",
			)}
		>
			<div className={cn("flex items-center gap-2", isMac && "pl-[80px]")}>
				{!sidebarOpen && (
					<IconButton
						className="no-drag"
						label={t("titlebar.showSidebar")}
						shortcut="⌘B"
						icon={<SidebarSimple />}
						size="sm"
						onClick={() => useApp.getState().toggleSidebar()}
					/>
				)}
				<Wordmark withMark size="sm" />
				{version && <span className="font-mono text-xs text-fg-faint">{t("titlebar.version", { version })}</span>}
			</div>
			<div className="flex min-w-0 justify-center">
				{project && (
					<button
						type="button"
						className="no-drag relative flex min-w-0 max-w-full items-center gap-1 rounded-md px-2 py-1 text-md text-fg-muted hover:bg-hover hover:text-fg"
						aria-label={t("titlebar.switchChat")}
						onClick={() => useApp.getState().setPaletteOpen(true)}
					>
						<PresenceSwap swapKey={`${project.path}\n${title ?? ""}`} mode="popLayout" className="flex min-w-0 items-center gap-1">
							<span className="truncate">{project.name}</span>
							{title && (
								<>
									<span className="text-fg-faint">/</span>
									<span className="truncate text-fg">{title}</span>
								</>
							)}
						</PresenceSwap>
						<CaretDown className="size-3.5 shrink-0" />
					</button>
				)}
			</div>
			<div />
		</header>
	);
}
