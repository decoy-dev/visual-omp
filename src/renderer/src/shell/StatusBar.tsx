import { Copy, RotateCcw, SquareTerminal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { statusItems } from "../registry/slots";
import { focusedController, focusedTabId, useApp } from "../state/app";
import { ContextRing, Menu, MenuContent, MenuItem, MenuTrigger, StatusDot, toast } from "../ui";
import { useSessionView } from "./hooks";

function ContextItem(): ReactNode {
	const { t } = useTranslation("shell");
	useApp(focusedTabId);
	const view = useSessionView(focusedController());
	const usage = view?.guest?.state?.contextUsage;
	if (!usage) return null;
	const percent = Math.round(usage.percent);
	return (
		<span className="flex items-center gap-1.5" title={t("status.context", { percent })}>
			<ContextRing value={percent} size={14} />
			<span aria-hidden>{t("status.contextShort", { percent })}</span>
			<span className="visually-hidden">{t("status.context", { percent })}</span>
		</span>
	);
}

/** Engine chip: omp version + connection state for the focused chat, with a diagnostics menu. */
function OmpItem(): ReactNode {
	const { t } = useTranslation("shell");
	const omp = useApp(state => state.omp);
	const tabId = useApp(focusedTabId);
	const controller = focusedController();
	const view = useSessionView(controller);
	const mode = view?.mode;
	const [status, label] =
		mode === "exited"
			? (["err", t("status.ompStopped")] as const)
			: mode === "reconnecting"
				? (["warn", t("status.ompReconnecting")] as const)
				: mode === "starting"
					? (["warn", t("status.ompStarting")] as const)
					: (["ok", t("status.ompConnected", { version: omp?.version ?? "" })] as const);
	const copyDiagnostics = async () => {
		const info = await window.vomp.invoke("app:info");
		const text = JSON.stringify({ app: info, omp, host: view?.host ?? null, mode: view?.mode ?? null, error: view?.error ?? null }, null, 2);
		await navigator.clipboard.writeText(text);
		toast({ tone: "ok", message: t("status.copied") });
	};
	return (
		<Menu>
			<MenuTrigger asChild>
				<button type="button" className="flex h-6 items-center gap-1.5 rounded-sm px-1.5 hover:bg-hover hover:text-fg" aria-label={t("status.ompMenu")}>
					<StatusDot status={status} label={label} />
					<span aria-hidden>{label}</span>
				</button>
			</MenuTrigger>
			<MenuContent align="end" side="top">
				<MenuItem icon={<SquareTerminal />} shortcut="⌘J" disabled={!tabId} onSelect={() => useApp.getState().openTerminal(tabId)}>
					{t("status.openTerminal")}
				</MenuItem>
				<MenuItem icon={<RotateCcw />} disabled={!controller} onSelect={() => void controller?.restart()}>
					{t("status.restart")}
				</MenuItem>
				<MenuItem icon={<Copy />} onSelect={() => void copyDiagnostics()}>
					{t("status.copyDiagnostics")}
				</MenuItem>
			</MenuContent>
		</Menu>
	);
}

/** 28px status bar (DESIGN §3.8). Features add items through `statusItems`. */
export function StatusBar(): ReactNode {
	const { t } = useTranslation("shell");
	const items = statusItems.use();
	const projectPath = useApp(state => state.activeProject);
	useApp(focusedTabId);
	const session = focusedController();
	return (
		<footer
			aria-label={t("status.label")}
			data-tour="statusbar"
			className="flex h-(--statusbar-h) shrink-0 items-center gap-4 border-t border-border bg-panel px-3 font-mono text-xs text-fg-muted"
		>
			<div className="flex min-w-0 items-center gap-4">
				{items
					.filter(item => item.side === "left")
					.map(item => (
						<item.component key={item.id} session={session} projectPath={projectPath} />
					))}
			</div>
			<div className="flex-1" />
			<div className="flex min-w-0 items-center gap-4">
				<ContextItem />
				{items
					.filter(item => item.side === "right")
					.map(item => (
						<item.component key={item.id} session={session} projectPath={projectPath} />
					))}
				<OmpItem />
			</div>
		</footer>
	);
}
