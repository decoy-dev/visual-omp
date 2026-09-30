/**
 * Terminal pane (DESIGN §3.7): xterm.js tabs of plain project shells, distinct from the omp
 * terminal sheet. `+` opens another shell; links open in the browser; colors follow `--term-*`.
 */
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ITheme, Terminal } from "@xterm/xterm";
import { Plus, TerminalWindow } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PaneProps } from "../../registry/slots";
import { Button, EmptyState, Expand, IconButton, PresenceSwap, StatusDot, toast } from "../../ui";
import { TabStrip } from "./common";
import { newShell, onTerminalData, type TerminalTab, terminalBuffer, useTerminals } from "./terminal";

function xtermTheme(): ITheme {
	const css = getComputedStyle(document.documentElement);
	const token = (name: string) => css.getPropertyValue(name).trim();
	return {
		background: token("--term-bg"),
		foreground: token("--term-fg"),
		cursor: token("--term-cursor"),
		cursorAccent: token("--term-bg"),
		selectionBackground: token("--term-selection"),
		// ANSI colors from the status/brand tokens so shell output matches the app.
		black: token("--fg-muted"),
		brightBlack: token("--fg-faint"),
		red: token("--err"),
		brightRed: token("--err"),
		green: token("--ok"),
		brightGreen: token("--ok"),
		yellow: token("--warn"),
		brightYellow: token("--warn"),
		blue: token("--term-blue"),
		brightBlue: token("--term-blue"),
		magenta: token("--term-magenta"),
		brightMagenta: token("--term-magenta"),
		cyan: token("--accent"),
		brightCyan: token("--accent"),
		white: token("--fg-muted"),
		brightWhite: token("--fg"),
	};
}

function XTermView({ tab }: { tab: TerminalTab }) {
	const { t } = useTranslation("panes");
	const container = useRef<HTMLDivElement>(null);
	const exitCode = tab.exitCode;

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const css = getComputedStyle(document.documentElement);
		const term = new Terminal({
			fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
			fontSize: 12.5,
			lineHeight: 1.2,
			cursorBlink: true,
			allowProposedApi: true,
			scrollback: 5000,
			theme: xtermTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(new WebLinksAddon((_event, uri) => void window.vomp.invoke("app:openExternal", uri)));
		// ⌘-shortcuts belong to the app (palette, dock toggle…), except copy/paste/select-all.
		term.attachCustomKeyEventHandler(event => !(event.metaKey && !["c", "v", "a"].includes(event.key.toLowerCase())));
		term.open(element);
		term.write(terminalBuffer(tab.termId));
		const offData = onTerminalData(tab.termId, data => term.write(data));
		const input = term.onData(data => void window.vomp.invoke("term:write", tab.termId, data));

		let lastSize = "";
		const resize = () => {
			if (element.clientWidth === 0 || element.clientHeight === 0) return;
			fit.fit();
			const size = `${term.cols}x${term.rows}`;
			if (size === lastSize) return;
			lastSize = size;
			void window.vomp.invoke("term:resize", tab.termId, term.cols, term.rows);
		};
		const observer = new ResizeObserver(resize);
		observer.observe(element);
		resize();
		term.focus();

		const themeObserver = new MutationObserver(() => {
			term.options.theme = xtermTheme();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
		return () => {
			observer.disconnect();
			themeObserver.disconnect();
			offData();
			input.dispose();
			term.dispose();
		};
	}, [tab.termId]);

	return (
		<div className="relative flex min-h-0 flex-1 flex-col bg-(--term-bg)">
			<div ref={container} role="application" aria-label={t("terminal.region")} className="min-h-0 flex-1 p-2" />
			<Expand
				open={exitCode !== null}
				className="flex h-9 items-center gap-2 border-t border-border bg-panel px-3 text-sm text-fg-muted"
			>
				<span role="status" className="flex items-center gap-2">
					<StatusDot glyph status={exitCode === 0 ? "ok" : "err"} />
					{exitCode === 0 ? t("terminal.exitedOk") : t("terminal.exited", { code: exitCode })}
				</span>
			</Expand>
		</div>
	);
}

export function TerminalPane({ projectPath }: PaneProps) {
	const { t } = useTranslation("panes");
	const tabs = useTerminals(state => state.tabs);
	const active = useTerminals(state => state.active);
	const activeTab = tabs.find(tab => tab.termId === active) ?? tabs[0] ?? null;

	const open = () => {
		if (!projectPath) return;
		newShell(projectPath).catch((error: unknown) =>
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
		const folder = tab.cwd.slice(tab.cwd.lastIndexOf("/") + 1);
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
