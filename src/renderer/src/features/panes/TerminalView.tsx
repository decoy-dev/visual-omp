/** The Terminal pane's xterm.js view of one shell tab; loads from its own chunk (see `TerminalPane`). */
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Expand, StatusDot } from "../../ui";
import { onTerminalData, type TerminalTab, terminalBuffer } from "./terminal";

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

export function XTermView({ tab }: { tab: TerminalTab }) {
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
