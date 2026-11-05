// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppMetrics } from "@shared/contracts/app-metrics";
import { useAppMetrics } from "./useAppMetrics";

let root: Root;
let element: HTMLDivElement;
const invoke = vi.fn();
function Probe() {
	const snapshot = useAppMetrics();
	return createElement("output", null, JSON.stringify(snapshot));
}
function visibility(state: "hidden" | "visible") {
	Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
	document.dispatchEvent(new Event("visibilitychange"));
}
const snapshot = () => JSON.parse(element.textContent!);
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	invoke.mockReset().mockResolvedValue({ cpuPercent: 20, memoryBytes: 1024 });
	Object.assign(window, { vomp: { invoke } });
	visibility("visible");
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove();
	vi.useRealTimers();
});
it("bounds history to 30 recent samples and polls every two seconds", async () => {
	await act(async () => root.render(createElement(Probe)));
	expect(invoke).toHaveBeenCalledExactlyOnceWith("app:metrics", true);
	await act(async () => vi.advanceTimersByTimeAsync(70_000));
	expect(invoke).toHaveBeenCalledTimes(36);
	expect(snapshot().history).toHaveLength(30);
	expect(snapshot().history[0].at).toBe(12_000);
	expect(snapshot().history.at(-1).at).toBe(70_000);
	expect(invoke).toHaveBeenLastCalledWith("app:metrics", false);
});
it("pauses hidden and unmounted, clears history, and requests a fresh CPU baseline on resume", async () => {
	await act(async () => root.render(createElement(Probe)));
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	await act(async () => visibility("hidden"));
	expect(snapshot()).toEqual({ cpuPercent: null, memoryBytes: null, history: [] });
	await act(async () => vi.advanceTimersByTimeAsync(60_000));
	expect(invoke).toHaveBeenCalledTimes(2);
	await act(async () => visibility("visible"));
	expect(invoke).toHaveBeenLastCalledWith("app:metrics", true);
	expect(snapshot().history).toHaveLength(1);
	await act(async () => root.unmount());
	await act(async () => vi.advanceTimersByTimeAsync(60_000));
	expect(invoke).toHaveBeenCalledTimes(3);
});
it("starts no requests while mounted hidden", async () => {
	visibility("hidden");
	await act(async () => root.render(createElement(Probe)));
	await act(async () => vi.advanceTimersByTimeAsync(10_000));
	expect(invoke).not.toHaveBeenCalled();
	expect(snapshot().history).toEqual([]);
});
it("discards late visibility-generation replies and does not overlap periodic polls", async () => {
	const { promise, resolve } = Promise.withResolvers<AppMetrics>();
	invoke.mockReturnValueOnce(promise);
	await act(async () => root.render(createElement(Probe)));
	await act(async () => vi.advanceTimersByTimeAsync(10_000));
	expect(invoke).toHaveBeenCalledOnce();
	await act(async () => visibility("hidden"));
	await act(async () => visibility("visible"));
	await act(async () => resolve({ cpuPercent: 99, memoryBytes: 999 }));
	expect(snapshot().cpuPercent).toBe(20);
	expect(snapshot().history).toHaveLength(1);
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	expect(invoke).toHaveBeenCalledTimes(3);
});
it("marks failures unavailable and resets the next CPU interval", async () => {
	invoke.mockRejectedValueOnce(new Error("IPC unavailable"));
	await act(async () => root.render(createElement(Probe)));
	expect(snapshot().cpuPercent).toBeNull();
	expect(snapshot().memoryBytes).toBeNull();
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	expect(invoke).toHaveBeenLastCalledWith("app:metrics", true);
});
it("starts a fresh baseline and history after a delayed polling interval", async () => {
	let at = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => at);
	try {
		await act(async () => root.render(createElement(Probe)));
		at = 20_000;
		await act(async () => vi.advanceTimersByTimeAsync(2000));
		expect(invoke).toHaveBeenLastCalledWith("app:metrics", true);
		expect(snapshot().history).toEqual([{ at: 20_000, percent: 20 }]);
	} finally {
		clock.mockRestore();
	}
});
it("discards a reply after unmount and remount without reviving its timer", async () => {
	const { promise, resolve } = Promise.withResolvers<AppMetrics>();
	invoke.mockReturnValueOnce(promise);
	await act(async () => root.render(createElement(Probe)));
	await act(async () => root.unmount());
	root = createRoot(element);
	await act(async () => root.render(createElement(Probe)));
	await act(async () => resolve({ cpuPercent: 99, memoryBytes: 999 }));
	expect(snapshot().cpuPercent).toBe(20);
	expect(invoke.mock.calls.map(call => call[1])).toEqual([true, true]);
	expect(vi.getTimerCount()).toBe(1);
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	expect(invoke).toHaveBeenCalledTimes(3);
});
it("shares polling and history between the independent CPU and RAM items", async () => {
	await act(async () => root.render(createElement("div", null, createElement(Probe, { key: "cpu" }), createElement(Probe, { key: "ram" }))));
	expect(invoke).toHaveBeenCalledExactlyOnceWith("app:metrics", true);
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	expect(invoke).toHaveBeenCalledTimes(2);
	const outputs = element.querySelectorAll("output");
	expect(outputs[0]?.textContent).toBe(outputs[1]?.textContent);
	await act(async () => root.render(createElement("div", null, createElement(Probe, { key: "ram" }))));
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	expect(invoke).toHaveBeenCalledTimes(3);
	await act(async () => root.render(null));
	await act(async () => vi.advanceTimersByTimeAsync(2000));
	expect(invoke).toHaveBeenCalledTimes(3);
});
