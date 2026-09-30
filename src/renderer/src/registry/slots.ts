/**
 * UI slot registries. Features contribute right-dock panes, modal sheets and status-bar items
 * without editing the shell: register from `features/<name>/index.ts`.
 */
import type { Icon } from "@phosphor-icons/react";
import { type ComponentType, useSyncExternalStore } from "react";
import type { SessionController } from "../state/session";

export interface PaneProps {
	session: SessionController | null;
	projectPath: string | null;
}

export interface PaneSpec {
	id: string;
	/** Position in the dock tab strip (DESIGN §3.7: Diff 10 · Files 20 · Preview 30 · Tasks 40 · Plan 50 · Terminal 60). */
	order: number;
	/** i18n key. */
	title: string;
	icon: Icon;
	component: ComponentType<PaneProps>;
	/** Small count/indicator rendered on the tab (e.g. `+12 −3`, running dot). */
	badge?: ComponentType<PaneProps>;
}

export interface SheetProps<P = unknown> {
	props: P;
	close(): void;
}

export interface SheetSpec {
	id: string;
	component: ComponentType<SheetProps<never>>;
}

export interface StatusItemSpec {
	id: string;
	side: "left" | "right";
	order: number;
	component: ComponentType<PaneProps>;
}

export interface ChatSlotProps {
	session: SessionController;
}

export interface ChatSlotSpec {
	id: string;
	/**
	 * `transcriptEnd`: cards after the last message (Plan Review, context-full, errors).
	 * `aboveComposer`: strips pinned above the composer (notices, banners).
	 * `composerTools`: buttons in the composer's bottom row (voice, prompt library).
	 * `headerChips`: chips beside the model/mode chips in the session header.
	 * `watchers`: invisible components that react to session state (auto-open the terminal sheet).
	 */
	placement: "transcriptEnd" | "aboveComposer" | "composerTools" | "headerChips" | "watchers";
	order: number;
	component: ComponentType<ChatSlotProps>;
}

export interface ScreenProps {
	projectPath: string | null;
}

export interface ScreenSpec {
	/**
	 * `home`: the main area when no chat is focused (project dashboard).
	 * `setup`: replaces the whole window while omp is missing or too old.
	 */
	id: "home" | "setup";
	component: ComponentType<ScreenProps>;
}

export interface GlobalSpec {
	id: string;
	/** Rendered once at the app root (palette, terminal sheet, tour, quit guard, notifications). */
	component: ComponentType;
}

function createRegistry<T extends { id: string }>(sort?: (a: T, b: T) => number) {
	const items = new Map<string, T>();
	const listeners = new Set<() => void>();
	let snapshot: readonly T[] = [];
	return {
		register(item: T): void {
			items.set(item.id, item);
			const list = [...items.values()];
			snapshot = sort ? list.sort(sort) : list;
			for (const listener of listeners) listener();
		},
		get(id: string): T | undefined {
			return items.get(id);
		},
		use(): readonly T[] {
			return useSyncExternalStore(
				listener => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				() => snapshot,
			);
		},
	};
}

export const panes = createRegistry<PaneSpec>((a, b) => a.order - b.order);
export const sheets = createRegistry<SheetSpec>();
export const statusItems = createRegistry<StatusItemSpec>((a, b) => a.order - b.order);
export const chatSlots = createRegistry<ChatSlotSpec>((a, b) => a.order - b.order);
export const screens = createRegistry<ScreenSpec>();
export const globals = createRegistry<GlobalSpec>();
