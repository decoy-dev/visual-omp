// @vitest-environment happy-dom
import type { TspHostSnapshot } from "@shared/tsp-host";
import { act, createElement, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import "../../i18n";
import { TerminalSheetHost, terminalSheet } from "./TerminalSheet";

const fake = vi.hoisted(() => ({
	view: null as SessionView | null,
	controller: null as unknown as SessionController,
	tabId: "tab" as string | null,
	closeTerminal: vi.fn(), ensureLive: vi.fn(), restart: vi.fn(), keys: vi.fn(), invoke: vi.fn(), on: vi.fn(), mirror: vi.fn(),
}));
vi.mock("../../shell/hooks", () => ({ useSessionView: () => fake.view }));
vi.mock("../../state/app", () => ({
	controllerFor: () => fake.controller,
	useApp: Object.assign((select: (state: { terminalTabId: string | null }) => unknown) => select({ terminalTabId: fake.tabId }), {
		getState: () => ({ closeTerminal: fake.closeTerminal, terminalTabId: fake.tabId }),
	}),
}));
vi.mock("../../registry/lazy", async () => {
	// This test intentionally replaces the lazy loading boundary with the real semantic content.
	const { OmpScreenSheet } = await vi.importActual<typeof OmpScreenModule>("../tsp/OmpScreenSheet");
	let count = 0;
	return { lazyView: () => ++count === 1 ? () => { fake.mirror(); return createElement("div", { className: "xterm" }); } : OmpScreenSheet };
});
vi.mock("../../ui", () => ({
	cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
	Sheet: ({ children }: PropsWithChildren) => children,
	SheetContent: ({ children, title, description, onEscapeKeyDown, onKeyDownCapture }: PropsWithChildren<{ title: ReactNode; description: ReactNode; onEscapeKeyDown: (event: unknown) => void; onKeyDownCapture: (event: ReactKeyboardEvent) => void }>) => createElement("div", {
		onKeyDownCapture,
		onKeyDown: (event: ReactKeyboardEvent) => { if (event.key === "Escape") onEscapeKeyDown(event); },
	}, createElement("h2", null, title), createElement("p", null, description), children),
	Dialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
	DialogContent: ({ title, footer }: { title: ReactNode; footer: ReactNode }) => createElement("div", { role: "dialog" }, title, footer),
	Button: ({ children, onClick }: PropsWithChildren<{ onClick: () => void }>) => createElement("button", { onClick }, children),
	IconButton: () => null,
	Expand: ({ open, children }: PropsWithChildren<{ open: boolean }>) => open ? children : null,
	EmptyState: ({ title }: { title: string }) => createElement("p", null, title),
	Spinner: () => null,
}));

let element: HTMLDivElement;
let root: Root;
const render = async () => { await act(async () => root.render(createElement(TerminalSheetHost))); };
const hostView = (tsp: boolean) => ({
	mode: "live", readOnly: false,
	host: { hostId: "host", generation: 2, phase: "running", cols: 80, rows: 24, ...(tsp ? { transport: "tsp" } : {}), tui: { overlays: 1, focused: "picker", overlayKinds: ["picker"] } },
}) as unknown as SessionView;

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.useFakeTimers();
	fake.tabId = "tab"; fake.view = hostView(true);
	fake.closeTerminal.mockReset().mockImplementation(() => { fake.tabId = null; });
	fake.ensureLive.mockReset().mockResolvedValue(undefined); fake.keys.mockReset().mockResolvedValue(undefined);
	fake.restart.mockReset().mockResolvedValue(undefined);
	fake.mirror.mockClear(); fake.invoke.mockReset(); fake.on.mockReset().mockReturnValue(() => {});
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "host:screen") return ["╭─ Settings ───╮"];
		if (channel === "host:tsp-snapshot") return { hostId: "host", generation: 2, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 2, failure: null, surfaces: [] };
		return undefined;
	});
	fake.controller = { ensureLive: fake.ensureLive, restart: fake.restart, keys: fake.keys, getSnapshot: () => fake.view } as unknown as SessionController;
	Object.assign(window, { vomp: { invoke: fake.invoke, on: fake.on } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); });

it("shows the omp screen without mounting xterm, polling painted titles or resizing the classic terminal", async () => {
	await render();
	await act(async () => { vi.advanceTimersByTime(1000); });
	expect(fake.mirror).not.toHaveBeenCalled();
	expect(element.querySelector(".xterm")).toBeNull();
	expect(element.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("omp screen");
	expect(element.querySelector("h2")?.textContent).toBe("omp screen");
	expect(element.textContent).toContain("Show raw outline");
	expect(fake.invoke.mock.calls.map(call => call[0])).toEqual(["host:tsp-snapshot"]);
	expect(fake.on.mock.calls.map(call => call[0])).toEqual(["host:tsp-update"]);
	await act(async () => terminalSheet.requestClose?.()); await render();
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.keys).not.toHaveBeenCalled();
	expect(element.querySelector('[role="dialog"]')).toBeNull();
	expect(fake.invoke.mock.calls.map(call => call[0])).toEqual(["host:tsp-snapshot"]);
});

it("lets Escape close the TSP sheet when omp has no semantic overlay", async () => {
	await render();
	await act(async () => { element.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.keys).not.toHaveBeenCalled();
	expect(element.querySelector('[role="dialog"]')).toBeNull();
});

it("sends one guarded Escape to omp while a semantic overlay is open", async () => {
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? {
		hostId: "host", generation: 2, epoch: 9, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 2, availability: { available: false, reason: "Menu open" }, failure: null,
		surfaces: [{ documentGeneration: 2, open: { id: "s:1", mode: "inline" }, sequence: 1, closed: false, focus: "menu", suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: [{ id: "menu", k: "overlay", p: { head: "Options" } }] }] } }],
	} : undefined);
	await render();
	expect(element.querySelector("h2")?.textContent).toBe("omp screen: Options");
	await act(async () => element.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
	expect(fake.invoke).toHaveBeenCalledWith("host:keys", "host", "escape", 2, 9);
	expect(fake.invoke.mock.calls.filter(call => call[0] === "host:keys")).toHaveLength(1);
	expect(fake.closeTerminal).not.toHaveBeenCalled();
});

it.each(["epoch", "generation"])("clears local tree selection when the %s changes with reused node ids", async transition => {
	const initial: TspHostSnapshot = {
		hostId: "host", generation: 2, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 2, availability: { available: false, reason: "Menu open" }, failure: null,
		surfaces: [{ documentGeneration: 2, open: { id: "s:1", mode: "inline" }, sequence: 1, closed: false, focus: "tree", suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: [{ id: "tree", k: "picker", p: { layout: "tree", query: null, selected: "a", items: [{ id: "a", label: "A" }, { id: "b", label: "B" }], actions: [{ id: "switch", label: "Switch", primary: true }] } }] }] } }],
	};
	fake.invoke.mockImplementation(async channel => channel === "host:tsp-snapshot" ? initial : undefined);
	await render();
	await act(async () => (element.querySelectorAll('[role="option"]')[1] as HTMLElement).click());
	expect(element.querySelectorAll('[role="option"]')[1]?.getAttribute("aria-selected")).toBe("true");
	const generation = transition === "generation" ? 3 : 2;
	const epoch = transition === "epoch" ? 2 : 1;
	const update = fake.on.mock.calls.find(call => call[0] === "host:tsp-update")![1];
	await act(async () => {
		fake.view = { ...fake.view!, host: { ...fake.view!.host!, generation } };
		update({ ...initial, generation, epoch, revision: 2, documentGeneration: generation, surfaces: initial.surfaces.map(surface => ({ ...surface, documentGeneration: generation })) });
		root.render(createElement(TerminalSheetHost));
	});
	await act(async () => element.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
	expect(fake.invoke).toHaveBeenCalledWith("host:tsp-event", "host", generation, { ev: "activate", sf: "s:1", id: "tree", item: "a" }, epoch);
});

it("shows a failed preview restart error in the sheet", async () => {
	fake.invoke.mockResolvedValue({ hostId: "host", generation: 2, epoch: 1, revision: 1, negotiated: false, lifecycle: "failed", documentGeneration: null, availability: { available: false, reason: "Not ready" }, failure: "omp did not start its semantic screen", surfaces: [] });
	fake.restart.mockRejectedValue(new Error("Could not stop omp"));
	await render();
	const restart = [...element.querySelectorAll("button")].find(button => button.textContent === "Restart omp")!;
	await act(async () => restart.click());
	expect(fake.restart).toHaveBeenCalledOnce();
	expect(element.textContent).toContain("Could not stop omp");
});

it("does not offer a misleading classic restart control for an exited preview", async () => {
	fake.view = { ...hostView(true), mode: "exited", host: { ...hostView(true).host!, phase: "exited" } };
	fake.invoke.mockResolvedValue({ hostId: "host", generation: 2, revision: 2, negotiated: false, lifecycle: "exited", documentGeneration: 1, failure: null, surfaces: [] });
	await render();
	expect(element.textContent).toContain("Quit and relaunch visual-omp without VOMP_TSP");
	expect([...element.querySelectorAll("button")].some(button => button.textContent === "Restart omp")).toBe(false);
	expect(element.textContent).not.toContain("Restart it to use this screen again.");
});

it("keeps classic screen naming, the mirror and the leave confirmation with Escape", async () => {
	fake.view = hostView(false);
	await render();
	await act(async () => { vi.advanceTimersByTime(250); });
	expect(fake.mirror).toHaveBeenCalled();
	expect(element.querySelector("h2")?.textContent).toBe("omp terminal: Settings");
	expect(fake.on.mock.calls.map(call => call[0])).toContain("host:data");
	expect(fake.invoke.mock.calls.map(call => call[0])).not.toContain("host:tsp-snapshot");
	await act(async () => terminalSheet.requestClose?.());
	expect(fake.closeTerminal).not.toHaveBeenCalled();
	expect(element.querySelector('[role="dialog"]')?.textContent).toContain("Leave this omp screen?");
	const leave = [...element.querySelectorAll("button")].find(button => button.textContent === "Leave screen")!;
	await act(async () => leave.click()); await render();
	expect(fake.keys).toHaveBeenCalledWith("escape");
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.invoke).toHaveBeenCalledWith("host:resize", "host", 80, 24);
});
