// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import type * as SheetModule from "../../ui/Sheet";
import type * as ButtonModule from "../../ui/Button";
import { TooltipProvider } from "../../ui/Tooltip";
import "../../i18n";
import { Shortcuts } from "./Shortcuts";
import { TerminalSheetHost } from "./TerminalSheet";

const fake = vi.hoisted(() => ({
	view: null as SessionView | null,
	controller: null as unknown as SessionController,
	tabId: "tab" as string | null,
	closeTerminal: vi.fn(), closePage: vi.fn(), closeSheet: vi.fn(), setPaletteOpen: vi.fn(), keys: vi.fn(), invoke: vi.fn(),
}));
vi.mock("../../shell/hooks", () => ({ useSessionView: () => fake.view }));
vi.mock("../../state/app", () => ({
	controllerFor: () => fake.controller,
	useApp: Object.assign((select: (state: { terminalTabId: string | null }) => unknown) => select({ terminalTabId: fake.tabId }), {
		getState: () => ({ terminalTabId: fake.tabId, closeTerminal: fake.closeTerminal, view: "page", paletteOpen: false, sheet: null, closePage: fake.closePage, closeSheet: fake.closeSheet, setPaletteOpen: fake.setPaletteOpen }),
	}),
}));
vi.mock("./run", () => ({ runCommand: vi.fn() }));
vi.mock("../../registry/lazy", () => ({ lazyView: () => () => null }));
vi.mock("../../ui", async () => {
	// Load the real Radix primitive inside the hoisted mock, without the mocked UI barrel.
	const { Sheet, SheetContent } = await vi.importActual<typeof SheetModule>("../../ui/Sheet");
	const { IconButton } = await vi.importActual<typeof ButtonModule>("../../ui/Button");
	return {
		Sheet, SheetContent,
		cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
		Dialog: () => null, DialogContent: () => null,
		Button: ({ children }: PropsWithChildren) => createElement("button", null, children),
		IconButton,
		Expand: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
		EmptyState: ({ title }: { title: ReactNode }) => createElement("p", null, title),
		Spinner: () => null,
	};
});

let element: HTMLDivElement;
let root: Root;
function sheetTree() {
	return createElement(TooltipProvider, { delayDuration: 0, children: createElement("div", null, createElement(Shortcuts), createElement(TerminalSheetHost)) });
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.tabId = "tab";
	fake.view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live", transport: "tsp", tui: { overlays: 1, focused: "picker", overlayKinds: ["picker"] } } } as unknown as SessionView;
	fake.closeTerminal.mockReset().mockImplementation(() => { fake.tabId = null; });
	fake.closePage.mockReset(); fake.closeSheet.mockReset(); fake.setPaletteOpen.mockReset(); fake.keys.mockReset();
	fake.invoke.mockReset().mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? {
		hostId: "host", generation: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null,
		surfaces: [{ documentGeneration: 1, open: { id: "dock", mode: "inline" }, sequence: 1, closed: false, focus: "editor", suspended: false, settled: [], document: { id: "root", k: "col", c: [{ id: "editor", k: "editor", p: { text: "Draft", sendable: true } }] } }],
	} : undefined);
	fake.controller = { ensureLive: async () => undefined, getSnapshot: () => fake.view, keys: fake.keys } as unknown as SessionController;
	Object.assign(window, { vomp: { platform: "darwin", invoke: fake.invoke, on: () => () => {} } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it.each(["outline", "nested node"])("closes once from a focused %s through the real sheet and app keyboard boundary", async target => {
	await act(async () => root.render(sheetTree()));
	const outline = document.querySelector<HTMLElement>('[role="region"]')!;
	const focused = target === "outline" ? outline : outline.querySelector<HTMLElement>("ul ul code")!;
	focused.tabIndex = 0;
	focused.focus();
	expect(document.activeElement).toBe(focused);
	const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	await act(async () => { focused.dispatchEvent(event); });
	expect(event.defaultPrevented).toBe(true);
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.closePage).not.toHaveBeenCalled();
	expect(fake.closeSheet).not.toHaveBeenCalled();
	expect(fake.setPaletteOpen).not.toHaveBeenCalled();
	expect(fake.keys).not.toHaveBeenCalled();
	expect(fake.invoke.mock.calls.map(call => call[0])).toEqual(["host:tsp-snapshot"]);
	await act(async () => root.render(sheetTree()));
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("initially focuses the scrollable inspector rather than opening the expand button tooltip, then closes on one Escape", async () => {
	await act(async () => root.render(sheetTree()));
	const outline = document.querySelector<HTMLElement>('[role="region"][aria-label="omp semantic outline"]')!;
	const expand = document.querySelector<HTMLButtonElement>('button[aria-label="Expand to full window"]')!;
	expect(expand).not.toBeNull();
	expect(outline.tabIndex).toBe(0);
	expect(document.activeElement).toBe(outline);
	expect(expand.dataset.state).toBe("closed");
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
	const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	await act(async () => { outline.dispatchEvent(event); });
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.keys).not.toHaveBeenCalled();
	expect(fake.closePage).not.toHaveBeenCalled();
	expect(fake.closeSheet).not.toHaveBeenCalled();
	expect(fake.setPaletteOpen).not.toHaveBeenCalled();
	await act(async () => root.render(sheetTree()));
	expect(document.querySelector('[role="dialog"]')).toBeNull();
	expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
