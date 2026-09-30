/** Core app/view commands the menu and shortcuts send that no other feature owns. */
import { ArrowLeft, ArrowRight, CircleHalf, Columns, MagnifyingGlass, NotePencil, SidebarSimple, TerminalWindow, TextAa, TextT, X } from "@phosphor-icons/react";
import { registerCommand } from "../../registry/commands";
import { confirmTabClose } from "../../registry/guards";
import { focusedTabId, useApp } from "../../state/app";
import { runCommand } from "./run";
import { terminalSheet } from "./TerminalSheet";

const MAC = window.vomp.platform === "darwin";

/** Display label for a ⌘/Ctrl shortcut: "⌘⇧L" on macOS, "Ctrl+Shift+L" elsewhere. */
function keys(key: string, options: { shift?: boolean; alt?: boolean } = {}): string {
	if (MAC) return `${options.alt ? "⌥" : ""}${options.shift ? "⇧" : ""}⌘${key}`;
	return ["Ctrl", options.alt && "Alt", options.shift && "Shift", key].filter(Boolean).join("+");
}

const TEXT_SCALE = { min: 90, max: 130, step: 10, default: 100 };

function setTextScale(next: (current: number) => number): void {
	const current = useApp.getState().prefs?.textScale ?? TEXT_SCALE.default;
	const scale = Math.min(TEXT_SCALE.max, Math.max(TEXT_SCALE.min, next(current)));
	if (scale !== current) void useApp.getState().setPrefs({ textScale: scale });
}

/** Move focus `delta` tabs along the tab strip, wrapping around. */
function cycleTab(delta: number): void {
	const state = useApp.getState();
	if (state.tabs.length < 2) return;
	const current = state.tabs.findIndex(tab => tab.id === (focusedTabId(state) ?? state.activeTabId));
	const next = state.tabs[(Math.max(0, current) + delta + state.tabs.length) % state.tabs.length];
	if (next) state.activateTab(next.id);
}

const hasTabs = () => useApp.getState().tabs.length > 1;

registerCommand({
	id: "app.palette",
	title: "palette:cmd.palette.title",
	hint: "palette:cmd.palette.hint",
	keywords: "palette:cmd.palette.keywords",
	group: "navigation",
	icon: MagnifyingGlass,
	shortcut: keys("K"),
	run() {
		const { paletteOpen, setPaletteOpen } = useApp.getState();
		setPaletteOpen(!paletteOpen);
	},
});

registerCommand({
	id: "view.terminal",
	title: "palette:cmd.terminal.title",
	hint: "palette:cmd.terminal.hint",
	keywords: "palette:cmd.terminal.keywords",
	group: "navigation",
	icon: TerminalWindow,
	shortcut: keys("J"),
	when: ctx => ctx.session !== null || useApp.getState().terminalTabId !== null,
	run(ctx) {
		const state = useApp.getState();
		if (state.terminalTabId) {
			if (terminalSheet.requestClose) terminalSheet.requestClose();
			else state.closeTerminal();
			return;
		}
		if (ctx.session) state.openTerminal(ctx.session.tabId);
	},
});

registerCommand({
	id: "view.sidebar",
	title: "palette:cmd.sidebar.title",
	hint: "palette:cmd.sidebar.hint",
	keywords: "palette:cmd.sidebar.keywords",
	group: "navigation",
	icon: SidebarSimple,
	shortcut: keys("B"),
	run: () => useApp.getState().toggleSidebar(),
});

registerCommand({
	id: "view.panel",
	title: "palette:cmd.panel.title",
	hint: "palette:cmd.panel.hint",
	keywords: "palette:cmd.panel.keywords",
	group: "navigation",
	icon: SidebarSimple,
	shortcut: keys("B", { alt: true }),
	run: () => useApp.getState().toggleDock(),
});

registerCommand({
	id: "view.split",
	title: "palette:cmd.split.title",
	hint: "palette:cmd.split.hint",
	keywords: "palette:cmd.split.keywords",
	group: "navigation",
	icon: Columns,
	shortcut: keys("\\"),
	when: () => hasTabs() || useApp.getState().splitTabId !== null,
	run: () => useApp.getState().toggleSplit(),
});

registerCommand({
	id: "view.prevTab",
	title: "palette:cmd.prevTab.title",
	keywords: "palette:cmd.prevTab.keywords",
	group: "navigation",
	icon: ArrowLeft,
	shortcut: keys("[", { shift: true }),
	when: hasTabs,
	run: () => cycleTab(-1),
});

registerCommand({
	id: "view.nextTab",
	title: "palette:cmd.nextTab.title",
	keywords: "palette:cmd.nextTab.keywords",
	group: "navigation",
	icon: ArrowRight,
	shortcut: keys("]", { shift: true }),
	when: hasTabs,
	run: () => cycleTab(1),
});

registerCommand({
	id: "view.theme",
	title: "palette:cmd.theme.title",
	hint: "palette:cmd.theme.hint",
	keywords: "palette:cmd.theme.keywords",
	group: "settings",
	icon: CircleHalf,
	shortcut: keys("L", { shift: true }),
	run() {
		// "system" resolves to whatever <html> shows right now; flipping pins the other one.
		const dark = document.documentElement.dataset.theme === "dark";
		void useApp.getState().setPrefs({ theme: dark ? "light" : "dark" });
	},
});

registerCommand({
	id: "view.zoomIn",
	title: "palette:cmd.zoomIn.title",
	keywords: "palette:cmd.zoomIn.keywords",
	group: "settings",
	icon: TextAa,
	shortcut: keys("="),
	when: () => (useApp.getState().prefs?.textScale ?? TEXT_SCALE.default) < TEXT_SCALE.max,
	run: () => setTextScale(current => current + TEXT_SCALE.step),
});

registerCommand({
	id: "view.zoomOut",
	title: "palette:cmd.zoomOut.title",
	keywords: "palette:cmd.zoomOut.keywords",
	group: "settings",
	icon: TextAa,
	shortcut: keys("-"),
	when: () => (useApp.getState().prefs?.textScale ?? TEXT_SCALE.default) > TEXT_SCALE.min,
	run: () => setTextScale(current => current - TEXT_SCALE.step),
});

registerCommand({
	id: "view.zoomReset",
	title: "palette:cmd.zoomReset.title",
	keywords: "palette:cmd.zoomReset.keywords",
	group: "settings",
	icon: TextT,
	shortcut: keys("0"),
	run: () => setTextScale(() => TEXT_SCALE.default),
});

registerCommand({
	id: "chat.new",
	title: "palette:cmd.chatNew.title",
	hint: "palette:cmd.chatNew.hint",
	keywords: "palette:cmd.chatNew.keywords",
	slash: "/new",
	group: "chat",
	icon: NotePencil,
	shortcut: keys("N"),
	run(ctx) {
		if (ctx.projectPath) useApp.getState().newChat(ctx.projectPath);
		else runCommand("project.new");
	},
});

registerCommand({
	id: "chat.close",
	title: "palette:cmd.chatClose.title",
	hint: "palette:cmd.chatClose.hint",
	keywords: "palette:cmd.chatClose.keywords",
	group: "chat",
	icon: X,
	shortcut: keys("W"),
	when: ctx => ctx.session !== null,
	async run(ctx) {
		const tabId = ctx.session?.tabId;
		if (!tabId) return;
		if (ctx.session?.getSnapshot().working && !(await confirmTabClose(tabId))) return;
		await useApp.getState().closeTab(tabId);
	},
});
