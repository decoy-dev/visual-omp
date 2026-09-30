import { Columns2, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getCommand } from "../registry/commands";
import { confirmTabClose } from "../registry/guards";
import { type ChatTab, controllerFor, useApp } from "../state/app";
import { cn, IconButton, PulseDot, StatusDot } from "../ui";
import { chatStatus, chatTitle, useSessionView } from "./hooks";

async function closeTab(tabId: string): Promise<void> {
	if (controllerFor(tabId)?.getSnapshot().working && !(await confirmTabClose(tabId))) return;
	await useApp.getState().closeTab(tabId);
}

function Tab({ tab, active }: { tab: ChatTab; active: boolean }): ReactNode {
	const { t } = useTranslation("shell");
	const view = useSessionView(controllerFor(tab.id));
	const status = chatStatus(view);
	const title = chatTitle(view, tab.title) ?? t("tabs.newChatTitle");
	return (
		<div
			role="tab"
			aria-selected={active}
			className={cn(
				"group relative flex h-7 min-w-[120px] max-w-[200px] items-center gap-2 rounded-t-md px-2.5 text-md",
				active ? "bg-panel font-medium text-fg after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent" : "text-fg-muted hover:bg-hover hover:text-fg",
			)}
		>
			{status === "working" ? (
				<PulseDot label={t("sidebar.status.working")} />
			) : (
				<StatusDot status={status === "needsInput" ? "warn" : status === "live" ? "ok" : "idle"} label={t(`sidebar.status.${status}`)} />
			)}
			<button
				type="button"
				className="min-w-0 flex-1 truncate text-left outline-none after:absolute after:inset-0 focus-visible:after:rounded-t-md focus-visible:after:outline-2 focus-visible:after:outline-ring"
				onClick={() => useApp.getState().activateTab(tab.id)}
				onAuxClick={event => {
					if (event.button === 1) void closeTab(tab.id);
				}}
			>
				{title}
			</button>
			<IconButton
				className="relative opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
				label={t("tabs.close", { title })}
				icon={<X />}
				size="sm"
				onClick={() => void closeTab(tab.id)}
			/>
		</div>
	);
}

/** Open chats (DESIGN §3.3). */
export function TabStrip(): ReactNode {
	const { t } = useTranslation("shell");
	const tabs = useApp(state => state.tabs);
	const activeTabId = useApp(state => state.activeTabId);
	const splitTabId = useApp(state => state.splitTabId);
	const view = useApp(state => state.view);
	if (tabs.length === 0) return null;
	return (
		<div className="flex h-(--tabstrip-h) shrink-0 items-end gap-1 border-b border-border bg-bg px-2">
			<div role="tablist" aria-label={t("tabs.label")} className="flex min-w-0 flex-1 items-end gap-1 overflow-hidden">
				{tabs.map(tab => (
					<Tab key={tab.id} tab={tab} active={view === "chat" && (tab.id === activeTabId || tab.id === splitTabId)} />
				))}
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
			</div>
			{tabs.length > 1 && (
				<IconButton
					className="mb-0.5"
					label={splitTabId ? t("tabs.unsplit") : t("tabs.split")}
					shortcut="⌘\"
					icon={<Columns2 />}
					size="sm"
					pressed={splitTabId !== null}
					onClick={() => useApp.getState().toggleSplit()}
				/>
			)}
		</div>
	);
}
