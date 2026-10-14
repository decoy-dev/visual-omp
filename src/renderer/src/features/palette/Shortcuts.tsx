/**
 * App-wide keyboard routing. Menu accelerators arrive as `app:command` ids and run the matching
 * registered command; a few renderer-only shortcuts (split, chat switching, Esc) are handled here.
 */
import { useEffect } from "react";
import { openSidebarChat, sidebarChatAt } from "../../shell/Sidebar";
import { useApp } from "../../state/app";
import { runCommand } from "./run";

const MOD_SHIFT_SHORTCUTS: Record<string, string> = {
	BracketLeft: "view.prevTab",
	BracketRight: "view.nextTab",
};

/** Esc that belongs to a field being edited (it clears or cancels there) or to text composition. */
function editingKey(event: KeyboardEvent): boolean {
	if (event.isComposing) return true;
	const target = event.target instanceof HTMLElement ? event.target : null;
	return target !== null && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

/** A menu, popover, select list or dialog is open; its own Esc handling wins. */
function layerOpen(): boolean {
	return document.querySelector("[data-radix-popper-content-wrapper], [role=dialog][data-state=open]") !== null;
}

function onKeyDown(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		// Radix dialogs/sheets handle their own Esc (and mark it handled); this is the fallback.
		if (event.defaultPrevented) return;
		const state = useApp.getState();
		if (state.paletteOpen) state.setPaletteOpen(false);
		else if (state.sheet) state.closeSheet();
		else if (state.view === "page" && state.terminalTabId === null && !editingKey(event) && !layerOpen()) {
			// Esc on a full page is Back.
			event.preventDefault();
			state.closePage();
		}
		return;
	}
	const mod = window.vomp.platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
	if (!mod || event.altKey || event.repeat) return;
	// ⌘\ closes split view when it is on, otherwise opens another chat beside this one.
	const id = event.shiftKey ? MOD_SHIFT_SHORTCUTS[event.code] : event.code === "Backslash" ? (useApp.getState().splitTabId ? "view.split" : "chat.openSideBySide") : undefined;
	if (id) {
		event.preventDefault();
		runCommand(id);
		return;
	}
	// ⌘1-⌘9 open the first nine chats the sidebar lists under Projects, top to bottom (holding ⌘ shows the numbers).
	const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
	if (digit && !event.shiftKey) {
		const chat = sidebarChatAt(Number(digit));
		if (!chat) return;
		event.preventDefault();
		openSidebarChat(chat);
	}
}

export function Shortcuts() {
	useEffect(() => {
		const offCommand = window.vomp.on("app:command", ({ id }) => {
			runCommand(id);
		});
		window.addEventListener("keydown", onKeyDown);
		return () => {
			offCommand();
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);
	return null;
}
