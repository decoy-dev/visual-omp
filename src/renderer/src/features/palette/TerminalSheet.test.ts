// @vitest-environment happy-dom
import { act, createElement, type KeyboardEvent as ReactKeyboardEvent, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import "../../i18n";
import { TerminalSheetHost, terminalSheet } from "./TerminalSheet";

const fake = vi.hoisted(() => ({
	view: null as SessionView | null,
	controller: null as unknown as SessionController,
	tabId: "tab" as string | null,
	closeTerminal: vi.fn(), ensureLive: vi.fn(), keys: vi.fn(), invoke: vi.fn(), on: vi.fn(), mirror: vi.fn(),
}));
vi.mock("../../shell/hooks", () => ({ useSessionView: () => fake.view }));
vi.mock("../../state/app", () => ({
	controllerFor: () => fake.controller,
	useApp: Object.assign((select: (state: { terminalTabId: string | null }) => unknown) => select({ terminalTabId: fake.tabId }), {
		getState: () => ({ closeTerminal: fake.closeTerminal, terminalTabId: fake.tabId }),
	}),
}));
vi.mock("../../registry/lazy", () => ({ lazyView: () => () => { fake.mirror(); return createElement("div", { className: "xterm" }); } }));
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
	fake.mirror.mockClear(); fake.invoke.mockReset(); fake.on.mockReset().mockReturnValue(() => {});
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "host:screen") return ["╭─ Settings ───╮"];
		if (channel === "host:tsp-snapshot") return { hostId: "host", generation: 2, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 2, failure: null, surfaces: [] };
		return undefined;
	});
	fake.controller = { ensureLive: fake.ensureLive, keys: fake.keys, getSnapshot: () => fake.view } as unknown as SessionController;
	Object.assign(window, { vomp: { invoke: fake.invoke, on: fake.on } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.useRealTimers(); });

it("shows a read-only TSP outline without mounting xterm, polling painted titles or resizing", async () => {
	await render();
	await act(async () => { vi.advanceTimersByTime(1000); });
	expect(fake.mirror).not.toHaveBeenCalled();
	expect(element.querySelector(".xterm")).toBeNull();
	expect(element.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("omp semantic outline");
	expect(element.querySelector("h2")?.textContent).toBe("omp semantic inspector");
	expect(element.textContent).toContain("Closing this view leaves omp unchanged.");
	expect(fake.invoke.mock.calls.map(call => call[0])).toEqual(["host:tsp-snapshot"]);
	expect(fake.on.mock.calls.map(call => call[0])).toEqual(["host:tsp-update"]);
	await act(async () => terminalSheet.requestClose?.()); await render();
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.keys).not.toHaveBeenCalled();
	expect(element.querySelector('[role="dialog"]')).toBeNull();
	expect(fake.invoke.mock.calls.map(call => call[0])).toEqual(["host:tsp-snapshot"]);
});

it("lets Escape close the TSP sheet without answering omp's open menu", async () => {
	await render();
	await act(async () => { element.querySelector('[role="region"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
	expect(fake.closeTerminal).toHaveBeenCalledOnce();
	expect(fake.keys).not.toHaveBeenCalled();
	expect(element.querySelector('[role="dialog"]')).toBeNull();
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
