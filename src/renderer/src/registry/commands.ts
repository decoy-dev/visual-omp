/**
 * Command registry: the single list of user actions. The command palette, app menu accelerators,
 * session-header buttons and keyboard shortcuts all run commands from here, so an action is
 * defined once. Features register commands from `features/<name>/index.ts`.
 */
import type { LucideIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { SessionController } from "../state/session";

export type CommandGroup = "actions" | "chat" | "modes" | "manage" | "navigation" | "settings" | "help";

export interface CommandContext {
	/** Controller for the focused chat, or null on Home / no chat open. */
	session: SessionController | null;
	/** Focused project folder, or null when none is selected. */
	projectPath: string | null;
}

export interface CommandSpec {
	id: string;
	/** i18n key for the plain-language title, e.g. `commands:compact.title`. */
	title: string;
	/** i18n key for a one-line tooltip / palette hint. */
	hint?: string;
	/** i18n key whose value is a comma-separated list of extra search words ("summarize, free space"). */
	keywords?: string;
	/** omp slash command shown as the right-hand hint, e.g. `/compact`. */
	slash?: string;
	group: CommandGroup;
	icon?: LucideIcon;
	/** Display shortcut, e.g. "⌘⇧R"; actual accelerators live in the app menu or keymap. */
	shortcut?: string;
	/** Shown as a session-header button when set; lower numbers appear first (max 5 visible). */
	header?: number;
	/** Destructive: rendered in `--err` and requires ⌘⏎ in the palette. */
	danger?: boolean;
	/** Hidden (and disabled) when this returns false. */
	when?(ctx: CommandContext): boolean;
	run(ctx: CommandContext): void | Promise<void>;
}

const commands = new Map<string, CommandSpec>();
const listeners = new Set<() => void>();
let snapshot: readonly CommandSpec[] = [];

export function registerCommand(spec: CommandSpec): void {
	commands.set(spec.id, spec);
	snapshot = [...commands.values()];
	for (const listener of listeners) listener();
}

export function getCommand(id: string): CommandSpec | undefined {
	return commands.get(id);
}

export function useCommands(): readonly CommandSpec[] {
	return useSyncExternalStore(
		listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
	);
}
