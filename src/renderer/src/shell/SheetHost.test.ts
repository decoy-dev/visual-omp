// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lazyView } from "../registry/lazy";
import { useSheetPresence } from "../registry/sheetPresence";
import { sheets } from "../registry/slots";
import { useApp } from "../state/app";
import { SheetHost } from "./SheetHost";

// Idle preloading would load the nested part before the test fails it.
vi.mock("../registry/idle", () => ({ preloadWhenIdle: () => {} }));

const shell = import.meta.glob<{ load: Record<string, string> }>("../i18n/en/shell.json", { eager: true, import: "default" })["../i18n/en/shell.json"]!;

// Like the release notes sheet: the sheet claims presence, then a part it loads separately does not load.
const NestedPart = lazyView<object>(async () => {
	throw new Error("Chunk unavailable");
});
function ClaimingSheet(): ReactNode {
	useSheetPresence();
	return createElement(NestedPart);
}
sheets.register({ id: "test-claiming", component: ClaimingSheet });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	// Radix returns focus in a zero-delay timeout; fake timers run it without reaching the host's 1 s exit cap.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	useApp.getState().closeSheet();
	vi.useRealTimers();
});
it("closes a failed sheet at once and returns focus to its opener, even after the sheet claimed presence", async () => {
	const opener = document.createElement("button");
	document.body.append(opener);
	opener.focus();
	await act(async () => root.render(createElement(SheetHost)));
	await act(async () => useApp.getState().openSheet("test-claiming"));
	await act(async () => {
		await NestedPart.preload().catch(() => {});
	});
	const dialog = document.querySelector("[role=dialog]");
	expect(dialog?.textContent).toContain(shell.load.failedTitle);

	const close = [...dialog!.querySelectorAll("button")].find(button => button.textContent === shell.load.close)!;
	await act(async () => close.click());
	// The dialog has closed; Radix reports the finished exit (and the host returns focus) from its zero-delay timeout.
	await act(async () => vi.advanceTimersByTime(0));
	expect(useApp.getState().sheet).toBeNull();
	expect(document.querySelector("[role=dialog]")).toBeNull();
	expect(document.activeElement).toBe(opener);
	opener.remove();
});
