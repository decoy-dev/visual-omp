/** The omp terminal sheet's live xterm.js mirror of omp's hidden terminal; loads from its own chunk (see `TerminalSheet`). */
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

function xtermTheme() {
	const css = getComputedStyle(document.documentElement);
	const token = (name: string) => css.getPropertyValue(name).trim();
	return {
		background: token("--term-bg"),
		foreground: token("--term-fg"),
		cursor: token("--term-cursor"),
		cursorAccent: token("--term-bg"),
		selectionBackground: token("--term-selection"),
	};
}

export interface MirrorProps {
	hostId: string;
	/** Re-attach when omp restarts in place. */
	generation: number;
	readOnly: boolean;
	/** Esc with no omp menu open closes the sheet instead of reaching omp. */
	onIdleEscape(): void;
	overlaysOpen(): boolean;
}

export function Mirror({ hostId, generation, readOnly, onIdleEscape, overlaysOpen }: MirrorProps) {
	const { t } = useTranslation("palette");
	const container = useRef<HTMLDivElement>(null);
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;
	const escapeRef = useRef({ onIdleEscape, overlaysOpen });
	escapeRef.current = { onIdleEscape, overlaysOpen };

	useEffect(() => {
		const element = container.current;
		if (!element) return;
		const css = getComputedStyle(document.documentElement);
		const term = new Terminal({
			fontFamily: css.getPropertyValue("--font-mono").trim() || "monospace",
			fontSize: 13,
			lineHeight: 1.15,
			cursorBlink: true,
			allowProposedApi: true,
			scrollback: 0,
			theme: xtermTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(new WebLinksAddon((_event, uri) => void window.vomp.invoke("app:openExternal", uri)));
		term.open(element);
		term.attachCustomKeyEventHandler(event => {
			if (event.type !== "keydown" || event.key !== "Escape" || escapeRef.current.overlaysOpen()) return true;
			escapeRef.current.onIdleEscape();
			return false;
		});

		let disposed = false;
		let attached = false;
		const pending: string[] = [];
		let sent = { cols: 0, rows: 0 };
		const offData = window.vomp.on("host:data", ({ hostId: id, data }) => {
			if (id !== hostId) return;
			if (attached) term.write(data);
			else pending.push(data);
		});
		const onInput = term.onData(data => {
			if (!readOnlyRef.current) void window.vomp.invoke("host:write", hostId, data);
		});
		const sendSize = async () => {
			if (term.cols === sent.cols && term.rows === sent.rows) return;
			sent = { cols: term.cols, rows: term.rows };
			await window.vomp.invoke("host:resize", hostId, term.cols, term.rows);
		};

		void (async () => {
			await document.fonts.ready;
			if (disposed) return;
			fit.fit();
			await sendSize();
			const buffer = await window.vomp.invoke("host:buffer", hostId);
			if (disposed) return;
			term.reset();
			term.write(buffer);
			for (const chunk of pending) term.write(chunk);
			pending.length = 0;
			attached = true;
			// omp repaints its whole screen on resize: nudge the height once so the mirror is exact.
			await window.vomp.invoke("host:resize", hostId, term.cols, Math.max(5, term.rows - 1));
			await window.vomp.invoke("host:resize", hostId, term.cols, term.rows);
			if (!readOnlyRef.current) term.focus();
		})();

		let resizeTimer: number | undefined;
		const observer = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = window.setTimeout(() => {
				if (disposed || element.clientWidth === 0) return;
				fit.fit();
				if (attached) void sendSize();
			}, 60);
		});
		observer.observe(element);
		const themeObserver = new MutationObserver(() => {
			term.options.theme = xtermTheme();
		});
		themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

		return () => {
			disposed = true;
			clearTimeout(resizeTimer);
			observer.disconnect();
			themeObserver.disconnect();
			offData();
			onInput.dispose();
			term.dispose();
		};
	}, [hostId, generation]);

	useEffect(() => {
		if (!readOnly) container.current?.querySelector("textarea")?.focus();
	}, [readOnly]);

	return <div ref={container} role="application" aria-label={t("terminal.mirrorLabel")} className="h-full min-h-0 w-full" />;
}
