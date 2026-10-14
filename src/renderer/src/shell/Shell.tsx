import { FolderOpen, Plus } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatArea } from "../chat/ChatArea";
import { useComposerDrafts } from "../chat/composer/drafts";
import { getCommand } from "../registry/commands";
import { type SheetPresence, SheetPresenceContext } from "../registry/sheetPresence";
import { pages, screens, sheets } from "../registry/slots";
import { DOCK_INSET, dockTooNarrow, focusedTabId, MAIN_ID, type OpenPage, useApp, useWindowWidth } from "../state/app";
import { Button, cn, duration, EmptyState, Mark, PresenceSwap, spring } from "../ui";
import { LeaveConfirm } from "./LeaveConfirm";
import { Dock } from "./Dock";
import { ResizeHandle } from "./ResizeHandle";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
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

/** A full page (Settings, Usage & limits, Help, project screens). Takes the page as a prop so an exiting page keeps rendering itself. */
function PageView({ page }: { page: OpenPage }): ReactNode {
	const list = pages.use();
	const spec = list.find(entry => entry.id === page.id);
	if (!spec) return null;
	const Component = spec.component;
	// Page props are defined by each feature; the opener passes the matching shape.
	return <Component props={page.props as never} seq={page.seq} close={() => useApp.getState().closePage()} />;
}

/** Side columns slide in from their own edge when toggled and fade out when hidden. */
function sideEnter(edge: -1 | 1) {
	return {
		initial: { opacity: 0, x: 12 * edge },
		animate: { opacity: 1, x: 0, transition: { x: spring.gentle, opacity: { duration: duration.base } } },
		exit: { opacity: 0, transition: { duration: duration.fast } },
	} as const;
}

/** Something keyboard focus can land on and see: in the document, not inside an inert region, and laid out. */
function focusable(element: Element | null): element is HTMLElement {
	return element instanceof HTMLElement && element.isConnected && !element.closest("[inert]") && element.getClientRects().length > 0;
}

/**
 * Focus for the expanded side panel, which replaces the chat at narrow widths. On entry, "Back to chat" takes focus
 * when the panel was just opened or a pane chosen, or when focus was in the chat (now inert) or the side panel that
 * gave way; a window resize leaves focus that is still usable elsewhere (sidebar, status bar) alone. On exit, focus
 * returns to what had it before entry, else the focused chat's composer, else the main area.
 */
function useExpandedDockFocus(expanded: boolean): (back: HTMLElement) => void {
	const lastFocus = useRef<HTMLElement | null>(null);
	const opener = useRef<HTMLElement | null>(null);
	const askedAt = useRef(Number.NEGATIVE_INFINITY);
	const wasExpanded = useRef(expanded);

	useEffect(() => {
		const track = (event: FocusEvent) => {
			if (event.target instanceof HTMLElement && !event.target.closest("[data-dock-expanded]")) lastFocus.current = event.target;
		};
		document.addEventListener("focusin", track);
		const off = useApp.subscribe((state, previous) => {
			const asked = (state.dockOpen && !previous.dockOpen) || (!state.chatOverDock && previous.chatOverDock) || state.dockPane !== previous.dockPane;
			if (asked) askedAt.current = performance.now();
		});
		return () => {
			document.removeEventListener("focusin", track);
			off();
		};
	}, []);

	useEffect(() => {
		if (expanded === wasExpanded.current) return;
		wasExpanded.current = expanded;
		if (expanded) {
			opener.current = lastFocus.current;
			return;
		}
		const previous = opener.current;
		opener.current = null;
		// After the chat is visible and interactive again; the panel may still be playing its exit.
		const frame = requestAnimationFrame(() => {
			const active = document.activeElement;
			if (focusable(active) && active !== document.body && !active.closest("[data-dock-expanded]")) return;
			if (focusable(previous)) previous.focus();
			else {
				const tabId = focusedTabId(useApp.getState());
				if (tabId) useComposerDrafts.getState().focus(tabId);
				else document.getElementById(MAIN_ID)?.focus();
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [expanded]);

	return useCallback((back: HTMLElement) => {
		const active = document.activeElement;
		const lost = !focusable(active) || active === document.body || active.closest(`#${MAIN_ID}, [data-tour="dock"]`) !== null;
		if (lost || performance.now() - askedAt.current < 1000) back.focus();
	}, []);
}

/**
 * Window layout (DESIGN §3): the ink chrome (sidebar band, full height, and the status bar) wraps the main sheet
 * (title bar · chats/home/page | side panel). The sheet's left corners round off against the sidebar and square up
 * when the sidebar hides; the side panel floats as its own sheet on an 8px strip of canvas.
 */
export function Shell(): ReactNode {
	const { t } = useTranslation("shell");
	const sidebarOpen = useApp(state => state.sidebarOpen);
	const sidebarWidth = useApp(state => state.sidebarWidth);
	const dockOpen = useApp(state => state.dockOpen);
	const dockWidth = useApp(state => state.dockWidth);
	const view = useApp(state => state.view);
	const hasTabs = useApp(state => state.tabs.length > 0);
	const page = useApp(state => (state.view === "page" ? state.page : null));
	const pageReturn = useApp(state => state.pageReturn);
	const windowWidth = useWindowWidth();
	const tooNarrow = useApp(state => dockTooNarrow(state, windowWidth));
	const chatOverDock = useApp(state => state.chatOverDock);
	const showDock = dockOpen && !page && !tooNarrow;
	// Too narrow for the chat and the panel side by side: the panel takes the main area, with "Back to chat",
	// until the user goes back to the chat (the panel then waits for a wider window).
	const dockExpanded = tooNarrow && !chatOverDock;
	const onDockEnter = useExpandedDockFocus(dockExpanded);
	const showChat = view === "chat" && hasTabs && !dockExpanded;
	// The chat stays mounted (hidden and inert) under a page it opened, so Back finds it as it was:
	// scroll position, expanded history and split width are component state.
	const chatMounted = hasTabs && (view === "chat" || (view === "page" && pageReturn === "chat"));

	return (
		<div className="flex h-full flex-col bg-chrome text-fg">
			<div className="flex min-h-0 flex-1">
				<AnimatePresence initial={false}>
					{sidebarOpen && (
						<motion.div key="sidebar" data-region="chrome" className="flex shrink-0 bg-chrome text-fg" {...sideEnter(-1)}>
							<Sidebar width={sidebarWidth} />
							<ResizeHandle label={t("resizeSidebar")} value={sidebarWidth} min={200} max={320} direction={1} onChange={width => useApp.getState().setSidebarWidth(width)} />
						</motion.div>
					)}
				</AnimatePresence>
				<div
					data-surface="sheet"
					className={cn(
						"flex min-w-0 flex-1 flex-col overflow-clip border-l bg-sheet",
						"transition-[border-radius,border-color] duration-(--dur-slow) ease-(--ease-out-quart)",
						sidebarOpen ? "rounded-l-lg border-chrome-line" : "rounded-l-none border-transparent",
					)}
				>
					<TitleBar />
					<div className="flex min-h-0 flex-1">
						<main id={MAIN_ID} tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
							<div className="relative flex min-h-0 flex-1">
								{chatMounted && (
									<div
										inert={!showChat}
										className={cn("absolute inset-0 flex transition-opacity duration-(--dur-base)", showChat ? "opacity-100" : "invisible opacity-0")}
									>
										<ChatArea />
									</div>
								)}
								<PresenceSwap
									swapKey={page ? `page:${page.id}` : dockExpanded ? "dock" : showChat ? "chat" : "home"}
									variant="rise"
									className={cn("relative flex min-h-0 min-w-0 flex-1", showChat && "pointer-events-none")}
								>
									{page ? <PageView page={page} /> : dockExpanded ? <Dock width={dockWidth} expanded onEnter={onDockEnter} /> : showChat ? null : <HomeView />}
								</PresenceSwap>
							</div>
						</main>
						<AnimatePresence initial={false}>
							{/* The side panel belongs to the chat and project views; full pages take the whole main area. */}
							{showDock && (
								<motion.div key="dock" data-surface="canvas" className="flex shrink-0 bg-bg" {...sideEnter(1)}>
									<ResizeHandle label={t("dock.resize")} value={dockWidth} min={320} max={640} direction={-1} onChange={width => useApp.getState().setDockWidth(width)} />
									<div className="flex" style={{ padding: DOCK_INSET }}>
										<Dock width={dockWidth} />
									</div>
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				</div>
			</div>
			<StatusBar />
			<SheetHost />
			<LeaveConfirm />
		</div>
	);
}
