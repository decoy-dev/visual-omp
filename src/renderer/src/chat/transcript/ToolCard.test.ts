// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AppPreferences } from "@shared/ipc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRefContext } from "./FileLinks";
import { ToolCard } from "./ToolCard";
import { useApp } from "../../state/app";
import { useLivePreview } from "../../features/live-preview/store";
import { TooltipProvider } from "../../ui";
import "../../i18n";

vi.hoisted(() => {
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin" } });
});

let element: HTMLDivElement, root: Root;
const showPane = vi.fn();
const previousState = useApp.getState();
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	useApp.setState({ prefs: { livePreview: true } as AppPreferences, showPane });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
	useLivePreview.getState().forget("watch-chat");
	useApp.setState(previousState);
	showPane.mockClear();
});

async function render(running: boolean) {
	await act(async () => root.render(createElement(TooltipProvider, null,
		createElement(FileRefContext.Provider, { value: { chat: "watch-chat", bases: [], home: null } },
			createElement(ToolCard, { name: "eval", args: { language: "js", code: "console.log(1)" }, running, verbose: false, engageId: "visual-call" })))));
	await vi.waitFor(async () => {
		await act(async () => {});
		expect(element.querySelector("[data-live-watch]")).not.toBeNull();
	});
}

describe("tool card Watch control", () => {
	it.each([true, false])("keeps Watch after the disclosure in keyboard order and opens only the preview (running: %s)", async running => {
		await render(running);
		const buttons = [...element.querySelectorAll<HTMLButtonElement>("button")];
		expect(buttons).toHaveLength(2);
		const [toggle, watch] = buttons as [HTMLButtonElement, HTMLButtonElement];
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(watch.getAttribute("aria-label")).toBe("Watch");
		expect(toggle.tabIndex).toBe(0);
		expect(watch.tabIndex).toBe(0);
		expect(toggle.contains(watch)).toBe(false);
		await act(async () => watch.click());
		expect(showPane).toHaveBeenCalledWith("outputs", "watch-chat");
		expect(useLivePreview.getState().chats["watch-chat"]?.selected).toBe("call:visual-call");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});
});
