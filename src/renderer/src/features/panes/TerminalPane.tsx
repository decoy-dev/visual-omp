/**
 * Terminal pane (DESIGN §3.7): xterm.js tabs of plain project shells, distinct from the omp
 * terminal sheet. `+` opens another shell; links open in the browser; colors follow `--term-*`.
 */
import { Plus, TerminalWindow } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import { lazyView } from "../../registry/lazy";
import type { PaneProps } from "../../registry/slots";
import { Button, EmptyState, IconButton, PresenceSwap, StatusDot, toast } from "../../ui";
import { folderName } from "../projects/format";
import { TabStrip } from "./common";
import { newShell, type TerminalTab, useTerminals } from "./terminal";

/** xterm.js loads with the first terminal shown; until then the tab shows the terminal's empty surface. */
const XTermView = lazyView(
	() => import("./TerminalView").then(m => m.XTermView),
	() => <div className="flex min-h-0 flex-1 flex-col bg-(--term-bg)" />,
);

export function TerminalPane({ session, projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const tabs = useTerminals(state => state.tabs);
	const active = useTerminals(state => state.active);
	const activeTab = tabs.find(tab => tab.termId === active) ?? tabs[0] ?? null;

	const open = () => {
		if (!projectPath) return;
		newShell(projectPath, session?.tabId).catch((error: unknown) =>
			toast({ tone: "err", message: t("terminal.startFailed"), description: error instanceof Error ? error.message : String(error) }),
		);
	};

	const empty = (
		<EmptyState
			icon={<TerminalWindow />}
			title={t("terminal.emptyTitle")}
			body={t("terminal.empty")}
			actions={
				<Button size="sm" variant="primary" icon={<Plus />} disabled={!projectPath} onClick={open}>
					{t("terminal.newShell")}
				</Button>
			}
		/>
	);

	const label = (tab: TerminalTab) => {
		const folder = folderName(tab.cwd);
		const base = tab.command ?? t("terminal.shellLabel", { n: tab.seq });
		return tab.cwd === projectPath ? base : `${base} · ${folder}`;
	};

	// The tab strip stays the presence owner while its last tab leaves: it fades out, then the empty state fades in.
	return (
		<PresenceSwap swapKey={tabs.length === 0 ? "empty" : "tabs"} className="flex min-h-0 flex-1 flex-col">
			{tabs.length === 0 ? (
				empty
			) : (
				<div className="flex min-h-0 flex-1 flex-col">
					<TabStrip
						label={t("terminal.tabs")}
						tabs={tabs.map(tab => ({
							id: tab.termId,
							label: label(tab),
							title: `${tab.command ?? t("terminal.shell")} · ${tab.cwd}`,
							icon:
								tab.exitCode === null ? (
									tab.command ? <StatusDot status="live" label={t("terminal.running")} /> : <TerminalWindow aria-hidden />
								) : (
									<StatusDot glyph status={tab.exitCode === 0 ? "ok" : "err"} label={t("terminal.finished")} />
								),
						}))}
						active={activeTab?.termId ?? null}
						onSelect={id => useTerminals.getState().activate(id)}
						onClose={id => useTerminals.getState().close(id)}
						closeLabel={tab => t("terminal.closeTab", { name: tab.label })}
						trailing={
							<IconButton
								className="m-0.5"
								size="sm"
								label={t("terminal.newShell")}
								icon={<Plus />}
								disabled={!projectPath}
								onClick={open}
							/>
						}
					/>
					{activeTab && (
						<PresenceSwap swapKey={activeTab.termId} className="flex min-h-0 flex-1 flex-col">
							<XTermView tab={activeTab} />
						</PresenceSwap>
					)}
				</div>
			)}
		</PresenceSwap>
	);
}

/** Tab badge: ● while a command started from the app is still running. */
export function TerminalBadge() {
	const { t } = useTranslation("panes");
	const running = useTerminals(state => state.tabs.some(tab => tab.command !== null && tab.exitCode === null));
	return running ? <StatusDot status="live" label={t("terminal.running")} /> : null;
}
