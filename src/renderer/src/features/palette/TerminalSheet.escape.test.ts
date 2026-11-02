// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import type { TspNode } from "@shared/tsp";
import type { QuestionMatch } from "@shared/tsp/question-match";
import { hookQuestions, QuestionArbitrator } from "@shared/tsp/question-match";
import { TSP_ROLES } from "@shared/tsp/roles";
import type * as SheetModule from "../../ui/Sheet";
import { FixtureDocuments } from "../tsp/testing/documents";
import { openOverlay, screenSurface, walkNodes } from "@shared/tsp/view-state";
import type * as ButtonModule from "../../ui/Button";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import { TooltipProvider } from "../../ui/Tooltip";
import "../../i18n";
import { Shortcuts } from "./Shortcuts";
import { TerminalSheetHost } from "./TerminalSheet";

const fake = vi.hoisted(() => ({
	view: null as SessionView | null,
	controller: null as unknown as SessionController,
	tabId: "tab" as string | null,
	updates: new Set<(snapshot: TspHostSnapshot) => void>(),
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
vi.mock("../../registry/lazy", async () => {
	// This test intentionally replaces the lazy loading boundary with the real semantic content.
	const { OmpScreenSheet } = await vi.importActual<typeof OmpScreenModule>("../tsp/OmpScreenSheet");
	let count = 0;
	return { lazyView: () => ++count === 1 ? () => null : OmpScreenSheet };
});
vi.mock("../../ui", async () => {
	// Load the real Radix primitive inside the hoisted mock, without the mocked UI barrel.
	const { Sheet, SheetContent } = await vi.importActual<typeof SheetModule>("../../ui/Sheet");
	const { Button, IconButton } = await vi.importActual<typeof ButtonModule>("../../ui/Button");
	return {
		Sheet, SheetContent,
		cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
		Dialog: () => null, DialogContent: () => null,
		Button,
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
	fake.updates.clear();
	fake.view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, phase: "live", transport: "tsp", tui: { overlays: 1, focused: "picker", overlayKinds: ["picker"] } } } as unknown as SessionView;
	fake.closeTerminal.mockReset().mockImplementation(() => { fake.tabId = null; });
	fake.closePage.mockReset(); fake.closeSheet.mockReset(); fake.setPaletteOpen.mockReset(); fake.keys.mockReset();
	fake.invoke.mockReset().mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? {
		hostId: "host", generation: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null,
		surfaces: [{ documentGeneration: 1, open: { id: "dock", mode: "inline" }, sequence: 1, closed: false, focus: "editor", suspended: false, settled: [], document: { id: "root", k: "col", c: [{ id: "editor", k: "editor", p: { text: "Draft", sendable: true } }] } }],
	} : undefined);
	fake.controller = { ensureLive: async () => undefined, getSnapshot: () => fake.view, keys: fake.keys } as unknown as SessionController;
	Object.assign(window, { vomp: { platform: "darwin", invoke: fake.invoke, on: (channel: string, listener: (snapshot: TspHostSnapshot) => void) => { if (channel === "host:tsp-update") fake.updates.add(listener); return () => fake.updates.delete(listener); } } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

it.each(["outline", "nested node"])("closes once from a focused %s through the real sheet and app keyboard boundary", async target => {
	await act(async () => root.render(sheetTree()));
	const outline = document.querySelector<HTMLElement>('[role="region"]')!;
	const focused = target === "outline" ? outline : outline.querySelector<HTMLElement>("summary")!;
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
	const outline = document.querySelector<HTMLElement>('[role="region"][aria-label="omp screen"]')!;
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

it("lets a nested shared Select consume Escape before a later Escape dismisses omp's screen", async () => {
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? {
		hostId: "host", generation: 1, epoch: 4, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: "Settings open" }, failure: null,
		surfaces: [{ documentGeneration: 1, open: { id: "s:1", mode: "screen" }, sequence: 1, closed: false, focus: "prefs", suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "main", k: "col", c: [{ id: "prefs", k: "prefs", p: { title: "Settings", page: "display", pages: [], sections: [{ id: "theme", title: "Theme", rows: [{ id: "theme.dark", label: "Dark theme", control: { k: "choice", value: "a", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }] }] } }] }] } }],
	} : undefined);
	await act(async () => root.render(sheetTree()));
	const trigger = document.querySelector<HTMLElement>('[role="combobox"][aria-label="Dark theme"]')!;
	await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
	const popup = document.querySelector<HTMLElement>(".tsp-select-popup")!;
	expect(popup).not.toBeNull();
	await act(async () => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(document.querySelector(".tsp-select-popup")).toBeNull();
	expect(fake.invoke.mock.calls.some(call => call[0] === "host:keys")).toBe(false);
	expect(fake.closeTerminal).not.toHaveBeenCalled();
	await act(async () => document.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(fake.invoke).toHaveBeenCalledWith("host:keys", "host", "escape", 1, 4);
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:keys")).toHaveLength(1);
});
function hookSnapshot(status: QuestionMatch["status"] | "closing", place: "layer" | "dock"): TspHostSnapshot {
	const hook: TspNode = place === "dock"
		? { id: "hook", k: "col", p: { role: TSP_ROLES.hookInput }, c: [{ id: "field", k: "input", p: { text: "" } }] }
		: { id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "yes", label: "Yes" }], query: null } }] };
	return { hostId: "host", generation: 1, epoch: 4, revision: 1, negotiated: true, closing: status === "closing", lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: "Question" }, failure: null, questionMatches: [{ surfaceId: "s:1", nodeId: "hook", status: status === "closing" ? "unmatched" : status }], surfaces: [{ open: { id: "s:1", mode: "inline" }, documentGeneration: 1, sequence: 1, closed: false, suspended: false, focus: null, settled: [], document: { id: "s:1", k: "col", c: [{ id: place, k: "col", c: [hook] }] } }] };
}
it.each((["matched", "ambiguous", "unavailable", "settling", "answering", "closing"] as const).flatMap(status => (["layer", "dock"] as const).map(place => ({ status, place }))))("closes a $status hook sheet in $place on Escape without writing to omp", async ({ status, place }) => {
	const snapshot = hookSnapshot(status, place);
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	await act(async () => document.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(fake.closeTerminal).toHaveBeenCalledOnce(); expect(fake.keys).not.toHaveBeenCalled();
	expect(fake.invoke.mock.calls.some(call => call[0] === "host:keys" || call[0] === "host:tsp-answer")).toBe(false);
	await act(async () => root.render(sheetTree()));
	expect(document.querySelector('[role="dialog"]')).toBeNull();
});
it.each(["layer", "dock"] as const)("keeps guarded Escape cancellation for an unmatched hook in %s", async place => {
	const snapshot = hookSnapshot("unmatched", place);
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	await act(async () => document.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(fake.invoke).toHaveBeenCalledWith("host:keys", "host", "escape", 1, 4);
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:keys")).toHaveLength(1);
	expect(fake.closeTerminal).not.toHaveBeenCalled();
});
it("closes the sheet when a mirrored request wins while an unmatched Escape is queued", async () => {
	const snapshot = hookSnapshot("unmatched", "layer");
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "host:tsp-snapshot") return snapshot;
		if (channel === "host:keys") throw new Error("TSP preview: This question cannot be answered here (matched).");
	});
	await act(async () => root.render(sheetTree()));
	await act(async () => document.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
});

const recordings = import.meta.glob<string>("../../../../main/omp/tsp/fixtures/18.14.0/*.jsonl", { query: "?raw", import: "default", eager: true });
function recorded<T = unknown>(name: string, suffix: string): { verb?: string; body: T; keys?: string; afterMessage?: number }[] {
	return recordings[`../../../../main/omp/tsp/fixtures/18.14.0/${name}.${suffix}.jsonl`]!.trim().split("\n").map(line => JSON.parse(line));
}
function replayedScreen(name: string) {
	const session = new FixtureDocuments();
	const messages = recorded(name, "messages");
	let boundary = 0;
	for (const message of messages) {
		session.receive({ verb: message.verb!, params: {}, body: JSON.stringify(message.body) });
		boundary++;
		const surfaces = session.snapshot().surfaces.filter(surface => surface.sequence > 0);
		if (openOverlay(surfaces) || screenSurface(surfaces) || surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "rows"))) break;
	}
	const snapshot: TspHostSnapshot = { ...session.snapshot(), hostId: "host", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: false, reason: "Recorded omp menu" },
		surfaces: session.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	return { session, snapshot, boundary, messages };
}
it.each(["hotkeys", "jobs", "session", "changelog", "tools", "model-picker", "settings-screen", "extension-rows", "extension-rows-cancel", "extension-rows-open"])("completes recorded %s through the real omp sheet with its next recorded input", async name => {
	const { snapshot, boundary, session, messages } = replayedScreen(name);
	const expected = recorded(name.replace(/-open$/, ""), "events").find(event => event.keys !== undefined)!;
	expect(expected).toBeDefined();
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	const screen = document.querySelector<HTMLElement>('[role="region"][aria-label="omp screen"]')!;
	expect(screen).not.toBeNull();
	expect(screen.querySelector("[data-tsp-kind]")).not.toBeNull();
	const target = name.startsWith("extension-rows") ? screen.querySelector("pre")! : screen;
	await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: name === "extension-rows" || name === "extension-rows-open" ? "Enter" : "Escape", bubbles: true, cancelable: true })));
	const emitted = fake.invoke.mock.calls.filter(call => call[0] === "host:keys" || call[0] === "host:tsp-event")
		.map(call => call[0] === "host:keys" ? { keys: call[2] === "escape" ? "\x1b" : call[2] } : { verb: "e", body: call[3] });
	expect(emitted).toEqual([{ keys: expected.keys }]);
	expect(fake.closeTerminal).not.toHaveBeenCalled();
	for (const message of messages.slice(boundary)) {
		session.receive({ verb: message.verb!, params: {}, body: JSON.stringify(message.body) });
	}
	expect(openOverlay(session.snapshot().surfaces)).toBeNull();
	expect(screenSurface(session.snapshot().surfaces)).toBeNull();
	expect(session.snapshot().surfaces.every(surface => surface.closed)).toBe(true);
});
it("keeps recorded tree-open pointer selection local and confirms with the recorded tree event", async () => {
	const { snapshot } = replayedScreen("tree-open");
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	const expected = recorded<TspRendererEvent>("tree-confirm", "events").find(event => event.body?.ev === "activate")!.body;
	if (expected.ev !== "activate") throw new Error("Missing recorded tree activation");
	const picker = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.k === "picker")!;
	if (picker.k !== "picker") throw new Error("Missing recorded tree picker");
	const index = picker.p!.items!.findIndex(item => item.id === expected.item);
	expect(index).toBeGreaterThanOrEqual(0);
	await act(async () => document.querySelectorAll('[role="option"]')[index]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toEqual([]);
	await act(async () => document.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toEqual([["host:tsp-event", "host", 1, expected, snapshot.epoch]]);
});
it("completes the recorded extensions picker by selecting a row and using its known Close action", async () => {
	const { snapshot, session, boundary, messages } = replayedScreen("extensions");
	const events = recorded<TspRendererEvent>("extensions", "events");
	const expected = events.filter(event => event.body?.ev === "select" || event.body?.ev === "action").map(event => event.body);
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	const screen = document.querySelector<HTMLElement>('[role="region"]')!;
	const expand = [...screen.querySelectorAll("button")].find(button => button.textContent === "Expand")!;
	expect(expand.disabled).toBe(true); expect(expand.title).toContain("expand");
	await act(async () => expand.click());
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toEqual([]);
	const selection = expected.find(event => event.ev === "select");
	if (selection?.ev !== "select") throw new Error("Missing recorded extension selection");
	const picker = snapshot.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.k === "picker");
	if (picker?.k !== "picker") throw new Error("Missing recorded extension picker");
	const label = picker.p!.items!.find(item => item.id === selection.item)!.label;
	await act(async () => [...screen.querySelectorAll('[role="option"]')].find(option => option.textContent === label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	const closeBoundary = events.find(event => event.body?.ev === "action")!.afterMessage!;
	for (const message of messages.slice(boundary, closeBoundary)) session.receive({ verb: message.verb!, params: {}, body: JSON.stringify(message.body) });
	const next = { ...snapshot, revision: snapshot.revision + 1, surfaces: session.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	await act(async () => { for (const update of fake.updates) update(next); });
	expect([...screen.querySelectorAll("button")].find(button => button.textContent === "Toggle")!.disabled).toBe(false);
	expect([...screen.querySelectorAll("button")].find(button => button.textContent === "Expand")!.disabled).toBe(true);
	const close = [...screen.querySelectorAll("button")].find(button => button.textContent === "Close")!;
	expect(close.disabled).toBe(false);
	await act(async () => close.click());
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:tsp-event").map(call => call[3])).toEqual(expected);
});

it("renders and completes the recorded startup import screen before the first collab link", async () => {
	const { snapshot } = replayedScreen("import-claude");
	snapshot.generation = 0; snapshot.documentGeneration = 0;
	for (const surface of snapshot.surfaces) surface.documentGeneration = 0;
	fake.view = { ...fake.view!, mode: "starting", host: { ...fake.view!.host!, generation: 0, phase: "connecting", link: null } };
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	expect(document.querySelector('[role="listbox"][aria-label="Import Claude Session"]')).not.toBeNull();
	const option = document.querySelector('[role="option"][aria-disabled="false"]')!;
	await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await act(async () => document.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	const expected = recorded<TspRendererEvent>("import-claude", "events").filter(event => event.body?.ev === "select" || event.body?.ev === "activate").map(event => event.body);
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:tsp-event").map(call => [call[2], call[3], call[4]])).toEqual(expected.map(event => [0, event, snapshot.epoch]));
});
it("offers a working Restart action when handshake-timeout marks the host tspFailed", async () => {
	const restart = vi.fn().mockResolvedValue(undefined);
	Object.assign(fake.controller, { restart });
	fake.view = { ...fake.view!, host: { ...fake.view!.host!, tspFailed: true } };
	const snapshot: TspHostSnapshot = { hostId: "host", generation: 1, epoch: 0, revision: 1, negotiated: false, lifecycle: "failed", documentGeneration: null, surfaces: [], failure: "omp did not start its semantic screen", availability: { available: false, reason: "omp did not start its semantic screen" } };
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	expect(document.body.textContent).toContain("omp did not start its semantic screen");
	const button = [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Restart"))!;
	expect(button).toBeDefined();
	await act(async () => button.click());
	expect(restart).toHaveBeenCalledOnce();
	expect(fake.invoke.mock.calls.some(call => call[0] === "host:keys" || call[0] === "host:tsp-event")).toBe(false);
});

it.each(["matched", "ambiguous"] as const)("keeps the recorded hook-collab-aware screen display-only with %s injected collab requests", async status => {
	const { snapshot } = replayedScreen("hook-collab-aware");
	const scope = { hostId: "host", generation: 1, epoch: snapshot.epoch };
	const dialogs = hookQuestions(snapshot.surfaces, 1); expect(dialogs).toHaveLength(1);
	const dialog = dialogs[0]!;
	const request = { reqId: 4, kind: "select", title: dialog.title, options: dialog.options ?? [] };
	const requests = status === "matched" ? [request] : [request, { ...request, reqId: 5 }];
	const mirror = { ...scope, connection: 1, revision: 1, connected: true, requests };
	const arb = new QuestionArbitrator();
	expect(arb.update(scope, mirror)).toBe(true);
	snapshot.questionMatches = arb.matches(scope, dialogs);
	expect(snapshot.questionMatches[0]?.status).toBe(status);
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	const picker = document.querySelector<HTMLElement>('[role="listbox"]')!;
	expect(picker).not.toBeNull(); expect(picker.getAttribute("aria-disabled")).toBe("true");
	await act(async () => document.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	expect([...document.querySelectorAll<HTMLButtonElement>('[role="region"] button')].every(button => button.disabled)).toBe(true);
	expect(fake.invoke.mock.calls.some(call => ["host:tsp-event", "host:tsp-answer", "host:keys"].includes(call[0]))).toBe(false);
	expect(mirror.requests.map(request => request.reqId)).toEqual(status === "matched" ? [4] : [4, 5]);
	if (status === "matched") expect(document.body.textContent).toContain("chat's question card");
});

it("allows Close on a main-authorized startup import picker while the session mode is starting", async () => {
	const { snapshot } = replayedScreen("import-claude");
	snapshot.generation = 0; snapshot.documentGeneration = 0;
	for (const surface of snapshot.surfaces) surface.documentGeneration = 0;
	fake.view = { ...fake.view!, mode: "starting", host: { ...fake.view!.host!, generation: 0, phase: "connecting", link: null } };
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	const surface = snapshot.surfaces.find(surface => surface.open.mode === "screen")!;
	const picker = [...walkNodes(surface.document)].find(node => node.k === "picker");
	if (picker?.k !== "picker") throw new Error("Missing recorded startup import picker");
	const closeAction = picker.p!.actions!.find(action => action.id === "close")!;
	const close = [...document.querySelectorAll<HTMLButtonElement>('[role="region"] button')].find(button => button.textContent === closeAction.label)!;
	expect(close).toBeDefined(); expect(close.disabled).toBe(false);
	await act(async () => close.click());
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toEqual([
		["host:tsp-event", "host", 0, { ev: "action", sf: surface.open.id, id: picker.id, act: "close" }, snapshot.epoch],
	]);
});
it("keeps startup hooks display-only while session mode is starting and the mirror is unavailable", async () => {
	const { snapshot } = replayedScreen("hook-collab-aware");
	snapshot.generation = 0; snapshot.documentGeneration = 0;
	for (const surface of snapshot.surfaces) surface.documentGeneration = 0;
	const scope = { hostId: "host", generation: 0, epoch: snapshot.epoch };
	snapshot.questionMatches = new QuestionArbitrator().matches(scope, hookQuestions(snapshot.surfaces, 0));
	expect(snapshot.questionMatches[0]?.status).toBe("unavailable");
	fake.view = { ...fake.view!, mode: "starting", host: { ...fake.view!.host!, generation: 0, phase: "connecting", link: null } };
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	await act(async () => root.render(sheetTree()));
	const region = document.querySelector<HTMLElement>('[role="region"]')!;
	const picker = region.querySelector<HTMLElement>('[role="listbox"]')!;
	expect(picker.getAttribute("aria-disabled")).toBe("true");
	expect([...region.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true);
	await act(async () => region.querySelector('[role="option"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await act(async () => picker.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	expect(fake.invoke.mock.calls.some(call => ["host:tsp-event", "host:tsp-answer", "host:keys"].includes(call[0]))).toBe(false);
});
