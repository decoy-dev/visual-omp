// @vitest-environment happy-dom
import { Folder } from "@phosphor-icons/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../i18n";
import { lazyView } from "../registry/lazy";
import { type PaneProps, panes } from "../registry/slots";
import { TooltipProvider } from "../ui";
import { Dock } from "./Dock";

// Idle preloading would load the pane before the test fails it.
vi.mock("../registry/idle", () => ({ preloadWhenIdle: () => {} }));

const shell = import.meta.glob<{ load: Record<string, string> }>("../i18n/en/shell.json", { eager: true, import: "default" })["../i18n/en/shell.json"]!;
const panesText = import.meta.glob<{ dock: Record<string, string> }>("../i18n/en/panes.json", { eager: true, import: "default" })["../i18n/en/panes.json"]!;

let available = false;
const PaneBody = lazyView<PaneProps>(async () => {
	if (!available) throw new Error("Chunk unavailable");
	return () => createElement("output", null, "Pane content");
});
panes.register({ id: "test-pane", order: 1, title: "panes:names.files", icon: Folder, component: PaneBody });

let container: HTMLDivElement;
let root: Root;
let crashes: unknown[];

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.append(container);
	crashes = [];
	root = createRoot(container, { onUncaughtError: error => crashes.push(error) });
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

it("shows Try again inside the side panel when a pane does not load, then the pane once it loads", async () => {
	// The project overview's side panel needs no chat.
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Dock, { chatKey: "overview", width: 360 }))));
	await act(async () => {
		await PaneBody.preload().catch(() => {});
	});
	expect(container.querySelector("aside")?.textContent).toContain(shell.load.failedTitle);
	expect(container.querySelector(`button[aria-label="${panesText.dock.close}"]`)).not.toBeNull();
	expect(container.querySelector("output")).toBeNull();

	available = true;
	const retry = [...container.querySelectorAll("button")].find(button => button.textContent === shell.load.retry)!;
	await act(async () => {
		retry.click();
		await PaneBody.preload();
	});
	expect(container.querySelector("output")?.textContent).toBe("Pane content");
	expect(crashes).toEqual([]);
});
