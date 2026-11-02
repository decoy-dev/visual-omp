// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../i18n";
import { StatusBar } from "./StatusBar";

const fake = vi.hoisted(() => ({ transport: "classic" as "classic" | "tsp" | undefined, open: vi.fn() }));
vi.mock("../state/app", () => ({
	focusedTabId: () => "tab", focusedController: () => ({}),
	useApp: Object.assign((select: (state: unknown) => unknown) => select({ omp: { version: "18.14.0" }, activeProject: "/tmp" }), { getState: () => ({ openTerminal: fake.open }) }),
}));
vi.mock("./hooks", () => ({ useSessionView: () => ({ mode: "live", host: { transport: fake.transport } }) }));
vi.mock("../features/onboarding/updates", () => ({ OMP_UPDATE_SHEET: "update", useOmpUpdateStatus: () => null, useUpdates: () => null }));
vi.mock("../registry/slots", () => ({ statusItems: { use: () => [] } }));
vi.mock("../state/navigation", () => ({ openSettings: vi.fn() }));
vi.mock("./AppMetricsItem", () => ({ AppMetricsItem: () => null }));
vi.mock("../ui", () => ({
	Menu: ({ children }: PropsWithChildren) => children,
	MenuContent: ({ children }: PropsWithChildren) => children,
	MenuTrigger: ({ children }: PropsWithChildren) => children,
	MenuItem: ({ children, onSelect }: PropsWithChildren<{ onSelect(): void }>) => createElement("button", { onClick: onSelect }, children),
	PresenceSwap: ({ children }: PropsWithChildren) => children,
	StatusDot: () => null, toast: vi.fn(),
}));
let root: Root; let element: HTMLDivElement;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); element = document.createElement("div"); document.body.append(element); root = createRoot(element); fake.open.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it.each(["tsp", "classic", undefined] as const)("names the status menu's screen entry for a %s host", async transport => {
	fake.transport = transport;
	await act(async () => root.render(createElement(StatusBar)));
	const label = transport === "tsp" ? "Show omp screen" : "Show omp terminal";
	const button = [...element.querySelectorAll("button")].find(button => button.textContent === label)!;
	expect(button).toBeDefined();
	await act(async () => button.click());
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});
