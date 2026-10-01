import { FolderOpen, Plus } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatArea } from "../chat/ChatArea";
import { getCommand } from "../registry/commands";
import { type SheetPresence, SheetPresenceContext } from "../registry/sheetPresence";
import { screens, sheets } from "../registry/slots";
import { useApp } from "../state/app";
import { Button, duration, EmptyState, Mark, PresenceSwap, spring } from "../ui";
import { Dock } from "./Dock";
import { ResizeHandle } from "./ResizeHandle";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { CHAT_PANEL_ID, chatTabId, TabStrip } from "./TabStrip";
import { TitleBar } from "./TitleBar";

/** Longest a sheet that plays an exit may take to report it before the host drops it anyway. */
const SHEET_EXIT_MAX_MS = 1000;

/**
 * Renders the open sheet. A closed sheet that uses `useSheetPresence` stays mounted with `open` false until it
 * reports its exit finished (see registry/sheetPresence.ts); any other sheet unmounts as soon as it closes.
 */
function SheetHost(): ReactNode {
	const sheet = useApp(state => state.sheet);
	const list = sheets.use();
	// The sheet on screen: the open one, or the last one while it plays its exit.
	const [shown, setShown] = useState(sheet);
	// What had focus before the sheet opened. Sheets open without a Radix trigger, so the host returns focus itself.
	const opener = useRef<HTMLElement | null>(null);
	if (sheet && sheet !== shown) {
		if (!shown) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setShown(sheet);
	}
	const current = sheet ?? shown;
	const open = sheet !== null;
	const id = current?.id ?? null;
	const claimedBy = useRef<string | null>(null);

	useEffect(() => {
		if (open || !id) return;
		if (claimedBy.current !== id) {
			setShown(null);
			return;
		}
		const timer = setTimeout(() => setShown(null), SHEET_EXIT_MAX_MS);
		return () => clearTimeout(timer);
	}, [open, id]);

	const presence = useMemo<SheetPresence>(
		() => ({
			open,
			// Reopening during the exit keeps the sheet; only a sheet that stayed closed is dropped.
			exited: () => {
				if (useApp.getState().sheet) return;
				setShown(null);
				if (opener.current?.isConnected) opener.current.focus();
				opener.current = null;
			},
			claim: () => {
				claimedBy.current = id;
			},
		}),
		[open, id],
	);

	if (!current) return null;
	const spec = list.find(entry => entry.id === current.id);
	if (!spec) return null;
	const Component = spec.component;
	// Sheet props are defined by each feature; the opener passes the matching shape.
	return (
		<SheetPresenceContext.Provider value={presence}>
			<Component key={current.id} props={current.props as never} close={() => useApp.getState().closeSheet()} />
		</SheetPresenceContext.Provider>
	);
}

function HomeView(): ReactNode {
	const { t } = useTranslation("shell");
	const projectPath = useApp(state => state.activeProject);
	const home = screens.use().find(screen => screen.id === "home");
	if (home) return <home.component projectPath={projectPath} />;
	return (
		<EmptyState
			className="m-auto"
			art={<Mark size={48} />}
			title={t("home.noProject")}
			actions={
				<>
					<Button icon={<FolderOpen />} onClick={() => void getCommand("project.open")?.run({ session: null, projectPath })}>
						{t("home.openFolder")}
					</Button>
					<Button variant="primary" icon={<Plus />} onClick={() => void getCommand("project.new")?.run({ session: null, projectPath })}>
						{t("home.newProject")}
					</Button>
				</>
			}
		/>
	);
}

/** Side columns slide in from their own edge when toggled and fade out when hidden. */
function sideEnter(edge: -1 | 1) {
	return {
		initial: { opacity: 0, x: 12 * edge },
		animate: { opacity: 1, x: 0, transition: { x: spring.gentle, opacity: { duration: duration.base } } },
		exit: { opacity: 0, transition: { duration: duration.fast } },
	} as const;
}

/** Window layout (DESIGN §3): title bar · sidebar | tabs + chats/home | dock · status bar. */
export function Shell(): ReactNode {
	const { t } = useTranslation("shell");
	const sidebarOpen = useApp(state => state.sidebarOpen);
	const sidebarWidth = useApp(state => state.sidebarWidth);
	const dockOpen = useApp(state => state.dockOpen);
	const dockWidth = useApp(state => state.dockWidth);
	const view = useApp(state => state.view);
	const hasTabs = useApp(state => state.tabs.length > 0);
	const showChat = view === "chat" && hasTabs;
	const activeTabId = useApp(state => state.activeTabId);

	return (
		<div className="flex h-full flex-col bg-bg text-fg">
			<TitleBar />
			<div className="flex min-h-0 flex-1">
				<AnimatePresence initial={false}>
					{sidebarOpen && (
						<motion.div key="sidebar" className="flex shrink-0" {...sideEnter(-1)}>
							<Sidebar width={sidebarWidth} />
							<ResizeHandle label={t("resizeSidebar")} value={sidebarWidth} min={200} max={320} direction={1} onChange={width => useApp.getState().setSidebarWidth(width)} />
						</motion.div>
					)}
				</AnimatePresence>
				<main className="flex min-w-0 flex-1 flex-col">
					<TabStrip />
					{/* While a chat shows, this is the tabpanel for the selected chat tab. */}
					<div
						id={showChat ? CHAT_PANEL_ID : undefined}
						role={showChat ? "tabpanel" : undefined}
						aria-labelledby={showChat && activeTabId ? chatTabId(activeTabId) : undefined}
						className="flex min-h-0 flex-1"
					>
						<PresenceSwap swapKey={showChat ? "chat" : "home"} variant="rise" className="flex min-h-0 min-w-0 flex-1">
							{showChat ? <ChatArea /> : <HomeView />}
						</PresenceSwap>
					</div>
				</main>
				<AnimatePresence initial={false}>
					{dockOpen && (
						<motion.div key="dock" className="flex shrink-0" {...sideEnter(1)}>
							<ResizeHandle label={t("dock.resize")} value={dockWidth} min={320} max={640} direction={-1} onChange={width => useApp.getState().setDockWidth(width)} />
							<Dock width={dockWidth} />
						</motion.div>
					)}
				</AnimatePresence>
			</div>
			<StatusBar />
			<SheetHost />
		</div>
	);
}
