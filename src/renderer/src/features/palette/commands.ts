/** Core app/view commands the menu and shortcuts send that no other feature owns. */
import { commandChatFolder } from "@shared/chatFolder";
import {
	ArrowCounterClockwise,
	ArrowLeft,
	ArrowRight,
	ChatCircleText,
	CircleHalf,
	Columns,
	House,
	MagnifyingGlass,
	NotePencil,
	SidebarSimple,
	TerminalWindow,
	TextAa,
	TextT,
	X,
} from "@phosphor-icons/react";
import { i18n } from "../../i18n";
import { registerCommand } from "../../registry/commands";
import { chatStatus } from "../../shell/hooks";
import { nextWaitingChat, stepChat } from "../../shell/sidebarRows";
import { canReopenChat, closeChat, controllerFor, focusedTabId, useApp } from "../../state/app";
import { toast } from "../../ui";
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

/** Show the open chat `delta` steps along "Current chats" from the focused one, wrapping around. */
function cycleChat(delta: number): void {
	const state = useApp.getState();
	if (state.tabs.length < 2) return;
	const next = stepChat(
		state.tabs.map(tab => tab.id),
		focusedTabId(state) ?? state.activeTabId,
		delta,
	);
	if (next) state.activateTab(next);
}

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
	id: "view.home",
	title: "palette:cmd.home.title",
	hint: "palette:cmd.home.hint",
	keywords: "palette:cmd.home.keywords",
	group: "navigation",
	icon: House,
	shortcut: keys("H", { shift: true }),
	run: () => useApp.getState().goHome(),
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
	header: 510,
	when: () => useApp.getState().splitTabId !== null,
	run: ctx => {
		const state = useApp.getState();
		if (ctx.session) state.closeSplit(ctx.session.tabId === state.splitTabId ? "secondary" : "primary");
		else state.toggleSplit();
	},
});

registerCommand({
	id: "chat.openSideBySide",
	title: "palette:cmd.openSideBySide.title",
	hint: "palette:cmd.openSideBySide.hint",
	keywords: "palette:cmd.openSideBySide.keywords",
	group: "chat",
	icon: Columns,
	shortcut: keys("\\"),
	header: 510,
	when: ctx => ctx.session !== null && useApp.getState().splitTabId === null,
	run: () => useApp.getState().toggleSplit(),
});

registerCommand({
	id: "view.prevTab",
	title: "palette:cmd.prevChat.title",
	keywords: "palette:cmd.prevChat.keywords",
	group: "navigation",
	icon: ArrowLeft,
	shortcut: keys("[", { shift: true }),
	when: () => useApp.getState().tabs.length > 1,
	run: () => cycleChat(-1),
});

registerCommand({
	id: "view.nextTab",
	title: "palette:cmd.nextChat.title",
	keywords: "palette:cmd.nextChat.keywords",
	group: "navigation",
	icon: ArrowRight,
	shortcut: keys("]", { shift: true }),
	when: () => useApp.getState().tabs.length > 1,
	run: () => cycleChat(1),
});

registerCommand({
	id: "chat.nextWaiting",
	title: "palette:cmd.nextWaiting.title",
	hint: "palette:cmd.nextWaiting.hint",
	keywords: "palette:cmd.nextWaiting.keywords",
	group: "navigation",
	icon: ChatCircleText,
	shortcut: keys("A", { shift: true }),
	run() {
		// The open chat after the focused one, along "Current chats", that is waiting for your answer.
		const state = useApp.getState();
		const next = nextWaitingChat(
			state.tabs.map(tab => tab.id),
			focusedTabId(state),
			tabId => chatStatus(controllerFor(tabId)?.getSnapshot() ?? null) === "needsInput",
		);
		if (next) state.activateTab(next);
		else toast({ tone: "info", message: i18n.t("palette:cmd.nextWaiting.none") });
	},
});

registerCommand({
	id: "chat.reopenClosed",
	title: "palette:cmd.reopenClosed.title",
	hint: "palette:cmd.reopenClosed.hint",
	keywords: "palette:cmd.reopenClosed.keywords",
	group: "chat",
	icon: ArrowCounterClockwise,
	shortcut: keys("T", { shift: true }),
	when: canReopenChat,
	async run() {
		if (!(await useApp.getState().reopenClosedChat()) && !canReopenChat()) toast({ tone: "info", message: i18n.t("palette:cmd.reopenClosed.none") });
	},
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
		const state = useApp.getState();
		return state.newChat(commandChatFolder(state.view, ctx.session?.projectPath ?? null, ctx.projectPath)).then(() => undefined);
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
	header: 520,
	when: ctx => ctx.session !== null,
	run: async ctx => {
		if (ctx.session) await closeChat(ctx.session.tabId);
	},
});
