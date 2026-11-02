// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../i18n";
import { StatusBar } from "./StatusBar";
import { TooltipProvider } from "../ui";

const fake = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../state/app", () => ({
	focusedTabId: () => null, focusedController: () => undefined,
	useApp: Object.assign((select: (state: unknown) => unknown) => select({ omp: { version: "18.15.0" }, activeProject: null }), { getState: () => ({}) }),
}));
vi.mock("./hooks", () => ({ useSessionView: () => undefined }));
vi.mock("../features/onboarding/updates", () => ({ OMP_UPDATE_SHEET: "update", useOmpUpdateStatus: () => null, useUpdates: () => null }));
vi.mock("../registry/slots", () => ({ statusItems: { use: () => [] } }));
vi.mock("../state/navigation", () => ({ openSettings: vi.fn() }));
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.assign(window, { vomp: { invoke: fake.invoke } });
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	fake.invoke.mockReset().mockResolvedValue({ cpuPercent: null, memoryBytes: 512 * 1024 ** 2 });
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("renders the app-only measurement beside the existing omp control and exposes scope in a shared popover", async () => {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBar))));
	const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="App CPU unavailable, RAM 512 MiB"]')!;
	expect(trigger).not.toBeNull();
	expect(trigger.textContent).toContain("CPU ?");
	expect(trigger.textContent).toContain("RAM 512 MiB");
	expect(trigger.previousElementSibling?.getAttribute("aria-label")).toBe("omp status: omp 18.15.0");
	expect(trigger.querySelector("svg[viewBox='0 0 48 16']")?.getAttribute("aria-hidden")).toBe("true");
	await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
	const popover = document.querySelector('[role="dialog"]')!;
	expect(popover.textContent).toContain("App resources");
	expect(popover.textContent).toContain("Excludes omp engines, tools, remote models and other applications.");
	expect(popover.textContent).toContain("Shared memory pages may be counted more than once.");
	await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
it("renders current values without presenting a missing metric as zero", async () => {
	fake.invoke.mockResolvedValue({ cpuPercent: 25.5, memoryBytes: null });
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBar))));
	const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="App CPU 25.5%, RAM unavailable"]')!;
	expect(trigger.textContent).toContain("CPU 25.5%");
	expect(trigger.textContent).toContain("RAM ?");
	expect(trigger.textContent).not.toContain("0 MiB");
});
it("breaks the rendered CPU trend at unavailable samples while retaining current accessible text", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		for (const cpuPercent of [null, 10, null, 30, 40]) fake.invoke.mockResolvedValueOnce({ cpuPercent, memoryBytes: 512 * 1024 ** 2 });
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(StatusBar))));
		await act(async () => vi.advanceTimersByTimeAsync(8000));
		const path = element.querySelector("svg[viewBox='0 0 48 16'] path")!.getAttribute("d")!;
		expect(path.match(/M/g)).toHaveLength(2);
		expect(path.match(/L/g)).toHaveLength(1);
		expect(element.querySelector('button[aria-label="App CPU 40%, RAM 512 MiB"]')).not.toBeNull();
	} finally {
		await act(async () => root.unmount());
		vi.useRealTimers();
	}
});
