import { CaretDown, Columns, Plus, X } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCommand } from "../registry/commands";
import { confirmTabClose } from "../registry/guards";
import { type ChatTab, controllerFor, useApp } from "../state/app";
import { cn, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, spring } from "../ui";
import { ChatStatusMark } from "./ChatStatusMark";
import { chatStatus, chatTitle, moveTabFocus, useSessionView } from "./hooks";

/** Id of the chat area element, the tabpanel every chat tab controls (rendered by Shell). */
export const CHAT_PANEL_ID = "chat-panel";
/** Element id of a chat tab, so the chat panel can name the tab that labels it. */
export const chatTabId = (tabId: string) => `chat-tab-${tabId}`;

/** Tab width floor and gap (DESIGN §3.3), and the room kept for the "N more" button when tabs overflow. */
const TAB_MIN = 120;
const TAB_GAP = 4;
const MORE_WIDTH = 88;

async function closeTab(tabId: string): Promise<void> {
	if (controllerFor(tabId)?.getSnapshot().working && !(await confirmTabClose(tabId))) return;
	await useApp.getState().closeTab(tabId);
}

interface TabProps {
	tab: ChatTab;
	/** Which selection indicator this tab carries: the focused chat, the split partner, or none. */
	selection: "active" | "split" | null;
	/** Per-strip layoutId prefix so the indicator slides between tabs. */
	scope: string;
	/** Roving tab stop: only one tab (and its close button) is in the Tab order. */
	tabStop: boolean;
	onFocus(): void;
	/** Supplied by AnimatePresence mode="popLayout" so a leaving tab is lifted out of the flow and frees its width. */
	ref?: Ref<HTMLDivElement>;
}

function Tab({ tab, selection, scope, tabStop, onFocus, ref }: TabProps): ReactNode {
	const { t } = useTranslation("shell");
	const view = useSessionView(controllerFor(tab.id));
	const status = chatStatus(view);
	const title = chatTitle(view, tab.title) ?? t("tabs.newChatTitle");
	const active = selection !== null;
	return (
		<motion.div
			ref={ref}
			role="presentation"
			layout="position"
			initial={{ opacity: 0, y: 6 }}
			animate={{ opacity: 1, y: 0 }}
			exit={{ opacity: 0, y: 6 }}
			transition={spring.snappy}
			className={cn(
				"group relative isolate flex h-7 min-w-[120px] max-w-[200px] items-center gap-2 rounded-t-md px-2.5 text-md",
				active ? "font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
			)}
		>
			{selection && (
				<motion.span
					aria-hidden
					layoutId={`${scope}-${selection}`}
					transition={spring.snappy}
					className="absolute inset-0 -z-10 rounded-t-md bg-panel after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
				/>
			)}
			<ChatStatusMark status={status} label={t(`sidebar.status.${status}`)} />
			<button
				type="button"
				role="tab"
				id={chatTabId(tab.id)}
				aria-selected={active}
				aria-controls={active ? CHAT_PANEL_ID : undefined}
				tabIndex={tabStop ? 0 : -1}
				className="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 focus-visible:after:rounded-t-md focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-ring"
				onFocus={onFocus}
				onClick={() => useApp.getState().activateTab(tab.id)}
				onKeyDown={event => {
					if (moveTabFocus(event)) return;
					if (event.key === "Delete") {
						event.preventDefault();
						void closeTab(tab.id);
					}
				}}
				onAuxClick={event => {
					if (event.button === 1) void closeTab(tab.id);
				}}
			>
				{title}
			</button>
			<IconButton
				className="relative opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-within:opacity-100"
				label={t("tabs.close", { title })}
				icon={<X />}
				size="sm"
				tabIndex={tabStop ? 0 : -1}
				onClick={() => void closeTab(tab.id)}
			/>
		</motion.div>
	);
}

/** Menu row for a tab that does not fit in the strip. */
function HiddenTab({ tab }: { tab: ChatTab }): ReactNode {
	const { t } = useTranslation("shell");
	const view = useSessionView(controllerFor(tab.id));
	const status = chatStatus(view);
	return (
		<MenuItem icon={<ChatStatusMark status={status} label={t(`sidebar.status.${status}`)} />} onSelect={() => useApp.getState().activateTab(tab.id)}>
			<span className="block max-w-64 truncate">{chatTitle(view, tab.title) ?? t("tabs.newChatTitle")}</span>
		</MenuItem>
	);
}

/** How many tabs fit in `width`: all of them, or as many as leave room for the "N more" button. */
function tabCapacity(count: number, width: number): number {
	if (count * TAB_MIN + (count - 1) * TAB_GAP <= width) return count;
	return Math.max(1, Math.floor((width - MORE_WIDTH) / (TAB_MIN + TAB_GAP)));
}

/** The first `capacity` tabs, swapping in the focused chat and its split partner when they fall past the cut. */
function visibleTabs(tabs: ChatTab[], capacity: number, keep: (string | null)[]): ChatTab[] {
	if (capacity >= tabs.length) return tabs;
	const shown = tabs.slice(0, capacity);
	const pinned = new Set(keep.filter((id): id is string => id !== null && tabs.some(tab => tab.id === id)));
	for (const id of pinned) {
		if (shown.some(tab => tab.id === id)) continue;
		const slot = shown.findLastIndex(tab => !pinned.has(tab.id));
		if (slot < 0) break;
		shown[slot] = tabs.find(tab => tab.id === id) as ChatTab;
	}
	return tabs.filter(tab => shown.includes(tab));
}

/**
 * Open chats (DESIGN §3.3). A WAI-ARIA tablist with manual activation: arrows, Home and End move focus, Enter or
 * Space opens the chat, Delete closes it. Tabs that do not fit collapse into a "N more" menu. Tabs rise in, fall away
 * on close and slide into place; the selection slides between them.
 */
export function TabStrip(): ReactNode {
	const { t } = useTranslation("shell");
	const scope = useId();
	const tabs = useApp(state => state.tabs);
	const activeTabId = useApp(state => state.activeTabId);
	const splitTabId = useApp(state => state.splitTabId);
	const view = useApp(state => state.view);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const room = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(Number.POSITIVE_INFINITY);

	const hasTabs = tabs.length > 0;
	useLayoutEffect(() => {
		const element = room.current;
		if (!element) return;
		setWidth(element.getBoundingClientRect().width);
		const observer = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, [hasTabs]);

	if (!hasTabs) return null;
	const shown = visibleTabs(tabs, tabCapacity(tabs.length, width), [activeTabId, splitTabId]);
	const hidden = tabs.filter(tab => !shown.includes(tab));
	const stopId = shown.some(tab => tab.id === focusedId) ? focusedId : shown.some(tab => tab.id === activeTabId) ? activeTabId : shown[0]?.id;

	return (
		<div className="flex h-(--tabstrip-h) shrink-0 items-end gap-1 border-b border-border bg-bg px-2">
			<div ref={room} className="flex min-w-0 flex-1 items-end gap-1">
				<div
					role="tablist"
					aria-label={t("tabs.label")}
					aria-multiselectable={splitTabId !== null && view === "chat" ? true : undefined}
					className="relative flex min-w-0 items-end gap-1"
				>
					<AnimatePresence initial={false} mode="popLayout">
						{shown.map(tab => (
							<Tab
								key={tab.id}
								tab={tab}
								scope={scope}
								tabStop={tab.id === stopId}
								onFocus={() => setFocusedId(tab.id)}
								selection={view !== "chat" ? null : tab.id === activeTabId ? "active" : tab.id === splitTabId ? "split" : null}
							/>
						))}
					</AnimatePresence>
				</div>
				{hidden.length > 0 && (
					<Menu>
						<MenuTrigger asChild>
							<button
								type="button"
								aria-label={t("tabs.moreLabel", { count: hidden.length })}
								className="mb-0.5 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-md text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:bg-selected"
							>
								{t("tabs.more", { count: hidden.length })}
								<CaretDown aria-hidden className="size-3.5" />
							</button>
						</MenuTrigger>
						<MenuContent align="start">
							{hidden.map(tab => (
								<HiddenTab key={tab.id} tab={tab} />
							))}
						</MenuContent>
					</Menu>
				)}
			</div>
			<IconButton
				className="mb-0.5"
				label={t("tabs.newChat")}
				shortcut="⌘N"
				icon={<Plus />}
				size="sm"
				onClick={() => {
					if (!useApp.getState().newChat()) void getCommand("project.new")?.run({ session: null, projectPath: null });
				}}
			/>
			{tabs.length > 1 && (
				<IconButton
					className="mb-0.5"
					label={splitTabId ? t("tabs.unsplit") : t("tabs.split")}
					shortcut="⌘\"
					icon={<Columns />}
					size="sm"
					pressed={splitTabId !== null}
					onClick={() => useApp.getState().toggleSplit()}
				/>
			)}
		</div>
	);
}
