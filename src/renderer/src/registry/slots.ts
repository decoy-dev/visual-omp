/**
 * UI slot registries. Features contribute right-dock panes, pages, settings sections, dialogs and
 * status-bar items without editing the shell: register from `features/<name>/index.ts`.
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
	/** Position in the side panel's pane selector (DESIGN §3.7: Changes 10 · Files 20 · Preview 30 · Outputs 35 · Tasks 40 · Plan 50 · Terminal 60). */
	order: number;
	/** i18n key. */
	title: string;
	icon: Icon;
	component: ComponentType<PaneProps>;
	/** Small count or indicator shown beside the pane's name in the selector (e.g. `+12 −3`, running dot). */
	badge?: ComponentType<PaneProps>;
}

/** Dialogs and edge sheets for bounded tasks (share, commit, wizards, confirmations). */
export interface SheetProps<P = unknown> {
	props: P;
	close(): void;
}

export interface SheetSpec {
	id: string;
	component: ComponentType<SheetProps<never>>;
}

export interface PageProps<P = unknown> {
	props: P;
	/**
	 * Changes on every `openPage`, including a new deep link into the page that is already open; apply
	 * `props` again (and move focus to the new heading) when it changes.
	 */
	seq: number;
	/** Back to where the page was opened from (chat or project); asks first when edits are unsaved. */
	close(): void;
}

/** A full page in the main area (Settings, Usage & limits, Help, project screens). See `useApp.openPage`. */
export interface PageSpec {
	id: string;
	component: ComponentType<PageProps<never>>;
}

/** Settings rail groups, in rail order. */
export type SettingsGroup = "app" | "agent" | "context" | "advanced";

export interface SettingsSectionProps {
	/** Project the "This project" scope edits: the one Settings was opened for, else the focused project. */
	projectPath: string | null;
	/** Layer to show and edit; sections that are not `scoped` ignore it. */
	scope: "global" | "project";
	setScope(scope: "global" | "project"): void;
	/** Extra props from the deep link that opened this section (`openPage("settings", { section, props })`). */
	props: unknown;
}

/** One Settings section. Each renders its own `PageHeader` (and `ScopeSwitch` when `scoped`). */
export interface SettingsSectionSpec {
	id: string;
	group: SettingsGroup;
	/** Position within the group. */
	order: number;
	/** i18n key with namespace, such as `manage:settings.tabs.general`. */
	title: string;
	icon: Icon;
	/** Edits a layer the scope switch chooses (all projects or this project). */
	scoped?: boolean;
	component: ComponentType<SettingsSectionProps>;
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
	 * `composerTools`: controls in the quiet row under the composer card; order below 50 sits left (folder, permission), the rest right (model, thinking, context).
	 * `watchers`: invisible components that react to session state (auto-open the terminal sheet).
	 */
	placement: "transcriptEnd" | "aboveComposer" | "composerTools" | "watchers";
	order: number;
	component: ComponentType<ChatSlotProps>;
}

export interface ScreenProps {
	projectPath: string | null;
}

export interface ScreenSpec {
	/**
	 * `home`: the app's Home screen (where the app opens, and the title bar's Home button).
	 * `project`: a project's overview (`projectPath` is the project).
	 * `setup`: replaces the whole window while omp is missing or too old.
	 */
	id: "home" | "project" | "setup";
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
export const pages = createRegistry<PageSpec>();
export const settingsSections = createRegistry<SettingsSectionSpec>((a, b) => a.order - b.order);
export const statusItems = createRegistry<StatusItemSpec>((a, b) => a.order - b.order);
export const chatSlots = createRegistry<ChatSlotSpec>((a, b) => a.order - b.order);
export const screens = createRegistry<ScreenSpec>();
export const globals = createRegistry<GlobalSpec>();
