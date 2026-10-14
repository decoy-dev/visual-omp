import { MagnifyingGlass, SidebarSimple } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useApp } from "../state/app";
import { cn, IconButton, Kbd, Wordmark } from "../ui";

/** Frameless window bar (DESIGN §3.1): opaque and draggable, with the lockup on the left and "Search commands" centered. */
export function TitleBar(): ReactNode {
	const { t } = useTranslation("shell");
	const isMac = window.vomp.platform === "darwin";
	const sidebarOpen = useApp(state => state.sidebarOpen);
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
		// Three columns: the side columns share the free space equally, so the search button stays centered, but the
		// lockup column never shrinks below its content, so a narrow window shortens the button instead of covering it.
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
						shortcut={isMac ? "⌘B" : "Ctrl+B"}
						icon={<SidebarSimple />}
						size="sm"
						onClick={() => useApp.getState().toggleSidebar()}
					/>
				)}
				<Wordmark withMark size="sm" />
				{version && <span className="font-mono text-xs text-fg-faint">{t("titlebar.version", { version })}</span>}
			</div>
			<div className="flex min-w-0 justify-center">
				<button
					type="button"
					aria-haspopup="dialog"
					aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
					className="no-drag flex h-7 w-72 min-w-0 max-w-full items-center gap-2 rounded-md border border-border bg-inset px-2 text-md text-fg-muted outline-none hover:border-border-strong hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
					onClick={() => useApp.getState().setPaletteOpen(true)}
				>
					<MagnifyingGlass aria-hidden className="size-3.5 shrink-0 text-fg-faint" />
					<span className="min-w-0 flex-1 truncate text-left">{t("titlebar.searchCommands")}</span>
					<Kbd aria-hidden>{isMac ? "⌘K" : "Ctrl+K"}</Kbd>
				</button>
			</div>
			<div />
		</header>
	);
}
