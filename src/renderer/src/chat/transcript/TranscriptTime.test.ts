// @vitest-environment happy-dom
import { act, createElement, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../ui/Tooltip";
import { TranscriptTime } from "./TranscriptTime";
import { ToolCard } from "./ToolCard";
import "../../i18n";

// Startup preloads schedule real timers during import. Keep that separate clock
// out of the timestamp tests, which explicitly control Date and midnight timers.
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
});

const recorded = new Date(2026, 11, 31, 23, 59, 8).getTime();

async function keyboardFocus(element: HTMLElement): Promise<void> {
	await act(async () => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
		element.focus();
	});
}

describe("timestamp keyboard details", () => {
	it("opens the shared tooltip from standalone metadata and dismisses it with Escape", async () => {
		await act(async () => root.render(createElement(TooltipProvider, { delayDuration: 0, children: createElement(TranscriptTime, { timestamp: recorded }) })));
		const time = container.querySelector("time")!;
		expect(time.tabIndex).toBe(0);
		expect(time.className).toContain("focus-visible:outline-ring");
		await keyboardFocus(time);
		const tooltip = document.querySelector('[role="tooltip"]');
		expect(tooltip?.textContent).toBe(time.getAttribute("aria-label"));
		expect(tooltip?.textContent).toContain("08");
		expect(time.hasAttribute("aria-describedby")).toBe(false);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(document.activeElement).toBe(time);
	});

	it("uses the existing disclosure focus for suppressed duplicate labels without a nested tab stop", async () => {
		await act(async () => root.render(createElement(TooltipProvider, { delayDuration: 0, children: createElement(ToolCard, { name: "read", args: { path: "source.ts" }, running: false, verbose: false, timestamp: recorded + 1000, previousTime: recorded }) })));
		const button = container.querySelector("button")!;
		const time = button.querySelector("time")!;
		expect(time.hasAttribute("tabindex")).toBe(false);
		expect(time.querySelector(".invisible")).not.toBeNull();
		await keyboardFocus(button);
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(time.getAttribute("aria-label"));
		expect(button.hasAttribute("aria-describedby")).toBe(false);
		expect(time.hasAttribute("aria-describedby")).toBe(false);
		await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(document.activeElement).toBe(button);
	});
});

describe("local date refresh", () => {
	const MemoTime = memo(TranscriptTime);
	it("updates memoized rows across local midnight and the year boundary using one timer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
		await act(async () => root.render(createElement(TooltipProvider, null, createElement("div", null, createElement(MemoTime, { timestamp: recorded }), createElement(MemoTime, { timestamp: recorded })))));
		const times = [...container.querySelectorAll("time")];
		for (const time of times) expect(time.textContent).not.toContain("2026");
		expect(vi.getTimerCount()).toBe(1);
		await act(async () => vi.advanceTimersByTime(2000));
		for (const time of times) {
			expect(time.textContent).toContain("2026");
			expect(time.textContent).toContain(new Date(recorded).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
		}
		expect(vi.getTimerCount()).toBe(1);
	});

	it.each(["focus", "visibilitychange"])("refreshes resumed rows on %s after a suspended midnight", async event => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59));
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(MemoTime, { timestamp: recorded }))));
		const time = container.querySelector("time")!;
		expect(time.textContent).not.toContain("2026");
		vi.setSystemTime(new Date(2027, 0, 1, 9));
		await act(async () => (event === "focus" ? window : document).dispatchEvent(new Event(event)));
		expect(time.textContent).toContain("2026");
		expect(vi.getTimerCount()).toBe(1);
	});
});
