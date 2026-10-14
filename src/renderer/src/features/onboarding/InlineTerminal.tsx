/**
 * Live, typeable terminal for a {@link CommandRun} inside setup, sign-in and update flows. xterm.js
 * loads from its own chunk (`InlineTerminalView`); until then the same bordered box shows empty, and
 * the view replays everything the run printed once it attaches.
 */
import { lazyView } from "../../registry/lazy";
import { cn } from "../../ui";
import type { CommandRun } from "./terminal";

export interface InlineTerminalProps {
	run: CommandRun;
	label: string;
	className?: string;
	/** Expose terminal output to screen readers (xterm `screenReaderMode`); for flows that need answers. */
	screenReader?: boolean;
}

export const InlineTerminal = lazyView(
	() => import("./InlineTerminalView").then(m => m.InlineTerminalView),
	({ label, className }: InlineTerminalProps) => (
		<div role="group" aria-label={label} className={cn("overflow-hidden rounded-md border border-border bg-inset p-2", className)} />
	),
);
