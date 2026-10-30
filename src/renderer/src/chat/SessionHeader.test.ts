import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "../registry/commands";
import type { SessionController, SessionView } from "../state/session";
import "../i18n";

const env = vi.hoisted(() => {
	vi.stubGlobal("window", { vomp: { platform: "darwin" } });
	return {
		commands: new Map<string, CommandSpec>(),
		state: { splitTabId: "b" as string | null, activeTabId: "a", prefs: null, tabs: [], closeSplit: vi.fn(), toggleSplit: vi.fn() },
		buttons: new Map<string, () => void>(),
		labelledButtons: new Map<string, () => void>(),
		items: new Map<string, () => void>(),
	};
});
vi.mock("../registry/commands", () => ({
	registerCommand: (command: CommandSpec) => env.commands.set(command.id, command),
	useCommands: () => [...env.commands.values()],
}));
vi.mock("../state/app", () => ({
	useApp: Object.assign((selector: (state: typeof env.state) => unknown) => selector(env.state), { getState: () => env.state }),
	currentDock: () => ({ pane: "diff" }), dockKey: () => "a", useDockVisible: () => false,
	canReopenChat: () => false, closeChat: vi.fn(), controllerFor: vi.fn(), focusedTabId: () => "a",
}));
vi.mock("../shell/hooks", () => ({ chatTitle: () => null, chatStatus: () => "saved" }));
vi.mock("../shell/ChatStatusMark", () => ({ ChatStatusMark: () => null }));
vi.mock("./branch", () => ({ useDisplayedEntries: () => [] }));
vi.mock("../features/palette/run", () => ({ runCommand: vi.fn() }));
vi.mock("../features/palette/TerminalSheet", () => ({ terminalSheet: {} }));
vi.mock("../ui", () => {
	const wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
	return {
		cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
		Button: ({ children, onClick, "aria-label": label }: { children?: ReactNode; onClick?: () => void; "aria-label"?: string }) => {
			if (label && onClick) env.labelledButtons.set(label, onClick);
			return createElement("button", { "aria-label": label }, children);
		},
		Tooltip: wrapper, PresenceSwap: wrapper, StatusDot: () => null, toast: vi.fn(),
		Menu: wrapper, MenuContent: wrapper, MenuLabel: wrapper, MenuRadioGroup: wrapper, MenuRadioItem: wrapper, MenuSeparator: () => null, MenuTrigger: wrapper,
		IconButton: ({ label, onClick }: { label: string; onClick?: () => void }) => {
			if (onClick) env.buttons.set(label, onClick);
			return createElement("button", { "aria-label": label }, label);
		},
		MenuItem: ({ children, onSelect }: { children: ReactNode; onSelect: () => void }) => {
			env.items.set(String(children), onSelect);
			return createElement("div", { role: "menuitem" }, children);
		},
	};
});

import "../features/palette/commands";
import { SessionHeader } from "./SessionHeader";

const session = (tabId: string) => ({ tabId, projectPath: "/project" }) as SessionController;
const view = { mode: "history", working: false, history: { entries: [] } } as unknown as SessionView;
const render = (tabId = "a") => renderToStaticMarkup(createElement(SessionHeader, { session: session(tabId), view, fallbackTitle: "Chat" }));

beforeEach(() => {
	env.state.splitTabId = "b";
	env.state.closeSplit.mockClear();
	env.state.toggleSplit.mockClear();
	env.buttons.clear();
	env.labelledButtons.clear();
	env.items.clear();
});

describe("split header actions", () => {
	it("shows Close split view in each header and its menu only while split is on", () => {
		for (const id of ["a", "b"]) {
			const html = render(id);
			expect(html).toContain('aria-label="Close split view (⌘\\)"');
			expect(html).toContain(">Close split view</button>");
			expect(env.items.has("Close split view")).toBe(true);
			expect(env.items.has("Open side by side")).toBe(false);
		}
		env.state.splitTabId = null;
		env.items.clear();
		expect(render()).not.toContain('aria-label="Close split view');
		expect(env.items.has("Close split view")).toBe(false);
		expect(env.items.has("Open side by side")).toBe(true);
	});

	it.each([["a", "primary"], ["b", "secondary"]] as const)("keeps header %s's chat for both the button and the menu", (id, keep) => {
		render(id);
		env.labelledButtons.get("Close split view (⌘\\)")!();
		expect(env.state.closeSplit).toHaveBeenLastCalledWith(keep);
		env.buttons.get("Close split view (⌘\\)")!();
		expect(env.state.closeSplit).toHaveBeenLastCalledWith(keep);
		env.items.get("Close split view")!();
		expect(env.state.closeSplit).toHaveBeenLastCalledWith(keep);
		expect(env.state.closeSplit).toHaveBeenCalledTimes(3);
	});

	it("delegates the sessionless split command to the focused-pane toggle", () => {
		env.commands.get("view.split")!.run({ session: null, projectPath: null });
		expect(env.state.toggleSplit).toHaveBeenCalledOnce();
	});

	it("uses the existing Windows shortcut formatter in the accessible label", async () => {
		vi.resetModules();
		window.vomp.platform = "win32";
		// Reloading this module exercises its platform-selected shortcut registration.
		await import("../features/palette/commands");
		expect(render()).toContain('aria-label="Close split view (Ctrl+\\)"');
		window.vomp.platform = "darwin";
	});
});
