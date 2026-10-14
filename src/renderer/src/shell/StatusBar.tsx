import { ArrowCounterClockwise, Copy, DownloadSimple, TerminalWindow } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { OMP_UPDATE_SHEET, useOmpUpdateStatus, useUpdates } from "../features/onboarding/updates";
import { statusItems } from "../registry/slots";
import { focusedController, focusedTabId, useApp } from "../state/app";
import { openSettings } from "../state/navigation";
import { Menu, MenuContent, MenuItem, MenuTrigger, PresenceSwap, StatusDot, toast } from "../ui";
import { useSessionView } from "./hooks";

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
					{t("status.openTerminal")}
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

/**
 * 28px status bar (DESIGN §3.8). Left: git items; right: plan usage and other feature items, the app update notice,
 * omp status. Features add items through `statusItems`. The bar is a size container and collapses in order instead
 * of clipping: below 52rem the update notice and omp status drop their text (glyph, tooltip and accessible name stay);
 * below 40rem only the first item of each side stays (branch on the left, plan usage on the right), and the rest
 * remain reachable from the sidebar and the git menu.
 */
export function StatusBar(): ReactNode {
	const { t } = useTranslation("shell");
	const items = statusItems.use();
	const projectPath = useApp(state => state.activeProject);
	useApp(focusedTabId);
	const session = focusedController();
	const [left, right] = (["left", "right"] as const).map(name =>
		items
			.filter(item => item.side === name)
			.map((item, index) => (
				// The wrapper owns the display switch, so an item's own display classes cannot override it.
				<span key={item.id} className={index === 0 ? "contents" : "hidden @min-[40rem]/status:contents"}>
					<item.component session={session} projectPath={projectPath} />
				</span>
			)),
	);
	return (
		<footer aria-label={t("status.label")} data-tour="statusbar" className="@container/status shrink-0 border-t border-border bg-panel">
			<div className="flex h-(--statusbar-h) items-center gap-4 overflow-hidden whitespace-nowrap px-3 font-mono text-xs text-fg-muted">
				<div className="flex min-w-0 items-center gap-4">{left}</div>
				<div className="flex-1" />
				<div className="flex min-w-0 shrink-0 items-center gap-4">
					{right}
					<AppUpdateItem />
					<OmpItem />
				</div>
			</div>
		</footer>
	);
}
