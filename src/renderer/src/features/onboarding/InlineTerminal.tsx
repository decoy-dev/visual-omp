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
		// ANSI colors from the status tokens so installer and brew output match the app; blue and magenta have their own.
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

export interface InlineTerminalProps {
	run: CommandRun;
	label: string;
	className?: string;
	/** Expose terminal output to screen readers (xterm `screenReaderMode`); for flows that need answers. */
	screenReader?: boolean;
}

/** Live, typeable view of a {@link CommandRun} (the installer may ask for a password). */
export function InlineTerminal({ run, label, className, screenReader = false }: InlineTerminalProps) {
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
			screenReaderMode: screenReader,
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
	}, [run, screenReader]);

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
