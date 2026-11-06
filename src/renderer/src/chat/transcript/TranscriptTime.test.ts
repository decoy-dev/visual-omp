// @vitest-environment happy-dom
import { act, createElement, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../ui/Tooltip";
import { compactTranscriptTime, TranscriptTime } from "./TranscriptTime";
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

describe("compact timestamp intervals", () => {
	const today = new Date(2026, 10, 6, 12);
	it("shares the date and period for a same-day AM or PM range", () => {
		expect(compactTranscriptTime(new Date(2026, 10, 6, 10, 37), new Date(2026, 10, 6, 10, 40), today, "en-US")).toBe("10:37-10:40 AM");
		expect(compactTranscriptTime(new Date(2026, 10, 5, 14, 37), new Date(2026, 10, 5, 14, 40), today, "en-US")).toBe("Nov 5 · 2:37-2:40 PM");
	});
	it("keeps both periods across noon", () => {
		expect(compactTranscriptTime(new Date(2026, 10, 6, 11, 59), new Date(2026, 10, 6, 12, 1), today, "en-US")).toBe("11:59 AM-12:01 PM");
	});
	it("keeps both dates across midnight, including today's endpoint", () => {
		expect(compactTranscriptTime(new Date(2026, 10, 5, 23, 59), new Date(2026, 10, 6, 0, 1), today, "en-US")).toBe("Nov 5 · 11:59 PM - Nov 6 · 12:01 AM");
	});
	it("keeps both years across a year boundary", () => {
		expect(compactTranscriptTime(new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 0, 1), new Date(2027, 0, 1, 12), "en-US")).toBe("Dec 31, 2026 · 11:59 PM - Jan 1, 2027 · 12:01 AM");
	});
	it("retains the locale's 24-hour clock without adding a period", () => {
		expect(compactTranscriptTime(new Date(2026, 10, 6, 14, 37), new Date(2026, 10, 6, 14, 40), today, "en-GB")).toBe("14:37-14:40");
	});
	it("shows one time for a lone timestamp or endpoints within one minute", () => {
		const start = new Date(2026, 10, 6, 10, 37, 2);
		expect(compactTranscriptTime(start, null, today, "en-US")).toBe("10:37 AM");
		expect(compactTranscriptTime(start, new Date(2026, 10, 6, 10, 37, 59), today, "en-US")).toBe("10:37 AM");
	});
});

describe("timestamp keyboard details", () => {
	it("exposes both interval endpoints from one disclosure keyboard stop and refreshes its latest activity", async () => {
		const started = new Date(2026, 2, 4, 9, 12, 8).getTime();
		const later = started + 30 * 60_000;
		const render = (through: number) => createElement(TooltipProvider, { delayDuration: 0, children: createElement("button", null, createElement(TranscriptTime, { timestamp: started, through, inControl: true })) });
		await act(async () => root.render(render(later)));
		const button = container.querySelector("button")!;
		const time = button.querySelector("time")!;
		expect(time.dataset.through).toBe(new Date(later).toISOString());
		expect(time.textContent).toContain("-");
		expect(time.hasAttribute("tabindex")).toBe(false);
		await keyboardFocus(button);
		expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(time.getAttribute("aria-label"));
		expect(time.getAttribute("aria-label")).toContain("9:42:08");
		await act(async () => root.render(render(later + 60_000)));
		expect(time.dataset.through).toBe(new Date(later + 60_000).toISOString());
		expect(document.querySelector('[role="tooltip"]')?.textContent).toContain("9:43:08");
		await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(document.activeElement).toBe(button);
	});

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
