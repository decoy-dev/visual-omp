import { ArrowCounterClockwise, Copy, DownloadSimple, TerminalWindow } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { DEFAULT_STATUS_BAR, OPTIONAL_STATUS_ITEMS } from "@shared/statusBar";
import { useTranslation } from "react-i18next";
import { OMP_UPDATE_SHEET, useOmpUpdateStatus, useUpdates } from "../features/onboarding/updates";
import { lazyView } from "../registry/lazy";
import { statusItems } from "../registry/slots";
import { focusedController, focusedTabId, useApp } from "../state/app";
import { openSettings } from "../state/navigation";
import { Menu, MenuContent, MenuItem, MenuTrigger, PresenceSwap, StatusDot, toast } from "../ui";
import { AppMetricsItem } from "./AppMetricsItem";
import { useSessionView } from "./hooks";
import { statusItemLocked, visibleStatusItems } from "./statusbar/layout";

const StatusBarMenu = lazyView(() => import("./statusbar/StatusBarMenu").then(m => m.StatusBarMenu));
const ChatStatusItem = lazyView(() => import("./statusbar/ChatStatusItems").then(m => m.ChatStatusItem));

statusItems.register({ id: "app.update", title: "settings:status.items.update", side: "right", order: 20, locked: true, component: AppUpdateItem });
statusItems.register({ id: "omp.status", title: "settings:status.items.omp", side: "right", order: 30, locked: true, component: OmpItem });
statusItems.register({ id: "app.cpu", title: "settings:status.items.cpu", side: "right", order: 40, compact: true, component: () => <AppMetricsItem metric="cpu" /> });
statusItems.register({ id: "app.memory", title: "settings:status.items.memory", side: "right", order: 50, compact: true, component: () => <AppMetricsItem metric="memory" /> });
for (const [index, id] of OPTIONAL_STATUS_ITEMS.entries()) statusItems.register({
	id, title: `settings:status.items.${id.slice(5)}`, side: "left", order: 50 + index * 10,
	component: props => <ChatStatusItem {...props} kind={id} />,
});

/** Shown while a newer visual-omp is published; opens Settings → About, where the update runs. */
function AppUpdateItem(): ReactNode {
	const { t } = useTranslation("onboarding");
	const version = useUpdates(state => (state.app?.updateAvailable ? state.app.latestVersion : null));
	if (!version) return null;
	return (
		<button
			type="button"
			className="flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-accent hover:bg-hover"
			aria-label={t("update.statusBar.appLabel", { version })}
			title={t("update.statusBar.appLabel", { version })}
			onClick={() => openSettings("about")}
		>
			<DownloadSimple aria-hidden weight="bold" className="size-3.5" />
			<span aria-hidden className="hidden @min-[52rem]/status:inline">
				{t("update.statusBar.app", { version })}
			</span>
		</button>
	);
}

/**
 * omp status for the focused chat, with a diagnostics menu. A saved chat shows a hollow mark: omp is installed but
 * not running for it. Each state has its own glyph, so it reads without color.
 */
function OmpItem(): ReactNode {
	const { t } = useTranslation("shell");
	const { t: tUpdate } = useTranslation("onboarding");
	const omp = useApp(state => state.omp);
	const tabId = useApp(focusedTabId);
	const update = useOmpUpdateStatus();
	const controller = focusedController();
	const view = useSessionView(controller);
	const version = omp?.version ?? "";
	const [status, label, description] =
		view?.mode === "exited"
			? (["err", t("status.ompStopped"), t("status.ompStopped")] as const)
			: view?.mode === "reconnecting"
				? (["warn", t("status.ompReconnecting"), t("status.ompReconnecting")] as const)
				: view?.mode === "starting"
					? (["warn", t("status.ompStarting"), t("status.ompStarting")] as const)
					: view?.mode === "live"
						? (["ok", t("status.ompVersion", { version }), t("status.ompRunning", { version })] as const)
						: (["idle", t("status.ompVersion", { version }), view ? t("status.ompNotRunning", { version }) : t("status.ompVersion", { version })] as const);
	const copyDiagnostics = async () => {
		const info = await window.vomp.invoke("app:info");
		const text = JSON.stringify({ app: info, omp, host: view?.host ?? null, mode: view?.mode ?? null, error: view?.error ?? null }, null, 2);
		await navigator.clipboard.writeText(text);
		toast({ tone: "ok", message: t("status.copied") });
	};
	return (
		<Menu>
			<MenuTrigger asChild>
				<button
					type="button"
					className="relative flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-1.5 hover:bg-hover hover:text-fg"
					aria-label={t("status.ompMenu", { status: description })}
					title={description}
				>
					<StatusDot status={status} label={description} glyph />
					<PresenceSwap swapKey={label} mode="popLayout" className="hidden @min-[52rem]/status:block">
						<span aria-hidden>{label}</span>
					</PresenceSwap>
					{update?.updateAvailable && (
						<span className="inline-flex">
							<span aria-hidden className="size-1.5 rounded-full bg-accent" />
							<span className="sr-only">{tUpdate("update.statusBar.omp", { version: update.latestVersion ?? "" })}</span>
						</span>
					)}
				</button>
			</MenuTrigger>
			<MenuContent align="end" side="top">
				<MenuItem icon={<TerminalWindow />} shortcut="⌘J" disabled={!tabId} onSelect={() => useApp.getState().openTerminal(tabId)}>
					{t(view?.host?.transport === "tsp" ? "status.openScreen" : "status.openTerminal")}
				</MenuItem>
				<MenuItem icon={<ArrowCounterClockwise />} disabled={!controller} onSelect={() => void controller?.restart()}>
					{t("status.restart")}
				</MenuItem>
				{update?.updateAvailable && (
					<MenuItem icon={<DownloadSimple />} onSelect={() => useApp.getState().openSheet(OMP_UPDATE_SHEET)}>
						{t("status.ompUpdateAvailable", { version: update.latestVersion ?? "latest" })}
					</MenuItem>
				)}
				<MenuItem icon={<Copy />} onSelect={() => void copyDiagnostics()}>
					{t("status.copyDiagnostics")}
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

/** App-wide status layout, with recovery controls retained at every width. */
export function StatusBar(): ReactNode {
	const { t } = useTranslation("shell");
	const preference = useApp(state => state.prefs?.statusBar) ?? DEFAULT_STATUS_BAR;
	const items = visibleStatusItems(statusItems.use(), preference);
	const [menuPoint, setMenuPoint] = useState<{ x: number; y: number; origin: HTMLElement } | null>(null);
	const projectPath = useApp(state => state.activeProject);
	useApp(focusedTabId);
	const session = focusedController();
	const [left, right] = (["left", "right"] as const).map(name =>
		items.filter(item => item.side === name).map((item, index) => (
			<span key={item.id} data-status-item={item.id} className={`empty:hidden ${statusItemLocked(item) ? "flex shrink-0" : `${item.compact || index === 0 ? "flex" : "hidden @min-[40rem]/status:flex"} min-w-0 overflow-hidden`}`}>
				<item.component session={session} projectPath={projectPath} />
			</span>
		)),
	);
	return (
		<>
			<footer tabIndex={0} aria-label={t("status.label")} data-tour="statusbar" data-region="chrome" className="@container/status shrink-0 bg-chrome" onContextMenu={event => {
				event.preventDefault();
				event.stopPropagation();
				setMenuPoint({ x: event.clientX, y: event.clientY, origin: event.currentTarget });
			}} onKeyDown={event => {
				if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
				event.preventDefault();
				const box = event.currentTarget.getBoundingClientRect();
				setMenuPoint({ x: box.left + 16, y: box.top, origin: event.currentTarget });
			}}>
					<div className="flex h-(--statusbar-h) items-center gap-4 overflow-hidden whitespace-nowrap px-3 font-mono text-xs text-fg-muted">
						<div className="flex min-w-0 items-center gap-4">{left}</div>
						<div className="flex-1" />
						<div className="flex min-w-0 items-center gap-4">{right}</div>
					</div>
			</footer>
			{menuPoint && <StatusBarMenu point={menuPoint} close={() => setMenuPoint(null)} />}
		</>
	);
}
