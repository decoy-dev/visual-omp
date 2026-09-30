import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { cn } from "../../ui";
import type { CommandRun } from "./terminal";

/** xterm colors come from the theme tokens (`--term-*`), re-read whenever the theme flips. */
function terminalTheme(): ITheme {
	const style = getComputedStyle(document.documentElement);
	const token = (name: string) => style.getPropertyValue(name).trim();
	return {
		background: token("--term-bg"),
		foreground: token("--term-fg"),
		cursor: token("--term-cursor"),
		cursorAccent: token("--term-bg"),
		selectionBackground: token("--term-selection"),
	};
}

export interface InlineTerminalProps {
	run: CommandRun;
	label: string;
	className?: string;
}

/** Live, typeable view of a {@link CommandRun} (the installer may ask for a password). */
export function InlineTerminal({ run, label, className }: InlineTerminalProps) {
	const host = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = host.current;
		if (!element) return;
		const style = getComputedStyle(document.documentElement);
		const term = new Terminal({
			fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace",
			fontSize: 12,
			lineHeight: 1.25,
			cursorBlink: false,
			scrollback: 5000,
			theme: terminalTheme(),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(element);
		const refit = () => {
			try {
				fit.fit();
				run.resize(term.cols, term.rows);
			} catch {
				// Not laid out yet (zero size); the next resize fits it.
			}
		};
		refit();
		// Exit is reported by the owner (status line); the view just stops receiving output.
		const detach = run.attach({ data: chunk => term.write(chunk), exit: () => {} });
		const input = term.onData(data => run.write(data));
		const resize = new ResizeObserver(refit);
		resize.observe(element);
		const themeWatch = new MutationObserver(() => {
			term.options.theme = terminalTheme();
		});
		themeWatch.observe(document.documentElement, { attributes: true });
		return () => {
			detach();
			input.dispose();
			resize.disconnect();
			themeWatch.disconnect();
			term.dispose();
		};
	}, [run]);

	return (
		<div
			role="group"
			aria-label={label}
			className={cn("overflow-hidden rounded-md border border-border bg-inset p-2", className)}
		>
			<div ref={host} className="size-full" />
		</div>
	);
}
