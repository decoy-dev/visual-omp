// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren, useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type * as MotionModule from "motion/react";
import { expect, it, vi } from "vitest";
import type * as UiModule from "../../ui";
import type { SessionController } from "../../state/session";
import { TooltipProvider, useScrollFollow } from "../../ui";
import { QueueTray } from "./QueueTray";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin" } }); });
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionModule>();
	// The hoisted factory runs before static React imports initialize.
	const { createElement } = await import("react");
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { ...actual, AnimatePresence: ({ children }: PropsWithChildren) => children, motion: { ...actual.motion, div: tag("div"), li: tag("li") }, useReducedMotionConfig: () => true };
});
vi.mock("../../ui", async importOriginal => {
	const actual = await importOriginal<typeof UiModule>();
	// vi.mock is hoisted before static React imports initialize.
	const { createElement } = await import("react");
	return { ...actual, Expand: ({ open, instant = false, children }: PropsWithChildren<{ open: boolean; instant?: boolean }>) => createElement("div", { "data-tray-expand": true, "data-open": open, "data-instant": instant }, open ? children : null) };
});

it("shows omp's image rejection on the retained message without a stranded-image restart hint", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	const error = "Failed to read pasted image path <live-check.png>";
	try {
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(QueueTray, {
			session: {} as SessionController,
			queue: [{ id: "failed", text: "Describe this image", images: [{ path: "/workspace/live-check.png", name: "live-check.png" }], error }],
			questionId: null, strandedImages: false,
		}))));
		expect(container.querySelector('[role="status"]')?.textContent).toBe(error);
		expect(container.textContent).toContain("Describe this image");
		expect(container.textContent).toContain("1 image");
		expect(container.textContent).toContain("Send message now");
		expect(container.textContent).not.toContain("Restart omp");
		expect(container.querySelector('[role="status"]')?.childElementCount).toBe(0);
		expect(container.textContent).toContain("Review the failed message, then send it again.");
	} finally { await act(async () => root.unmount()); container.remove(); }
});

it("releases transcript following before the question chip scrolls to its card", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let scroller: HTMLElement;
	let pinned: { current: boolean };
	const navigation = vi.fn();
	function QuestionNavigation() {
		const ref = useRef<HTMLElement>(null);
		pinned = useRef(true);
		const follow = useScrollFollow(ref, pinned);
		useLayoutEffect(() => {
			scroller = ref.current!;
			Object.defineProperties(scroller, {
				scrollHeight: { configurable: true, value: 1400 },
				clientHeight: { configurable: true, value: 200 },
			});
			const card = scroller.querySelector<HTMLElement>("[data-question-card]")!;
			vi.spyOn(card, "scrollIntoView").mockImplementation(options => {
				navigation(options);
				expect(pinned.current).toBe(false);
				scroller.scrollTop = 400;
				scroller.dispatchEvent(new Event("scroll"));
			});
		}, []);
		return createElement(Fragment, null,
			createElement("section", { ref, onScroll: follow.onScroll },
				createElement("div", { "data-question-card": 42 }, createElement("button", null, "Answer"))),
			createElement(QueueTray, { session: {} as SessionController, queue: [], questionId: 42, strandedImages: false }));
	}
	try {
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(QuestionNavigation))));
		expect(pinned!.current).toBe(true);
		const chip = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent !== "Answer")!;
		await act(async () => chip.click());
		expect(navigation).toHaveBeenCalledWith({ block: "center", behavior: "auto" });
		expect(pinned!.current).toBe(false);
		expect(scroller!.scrollTop).toBe(400);
		expect(document.activeElement?.textContent).toBe("Answer");
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.restoreAllMocks();
	}
});

it.each([false, true])("collapses the native form tray instantly while preserving queued-row motion (queued=%s)", async queued => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	const queue = queued ? [{ id: "queued", text: "My next message", images: [] }] : [];
	const session = {} as SessionController;
	try {
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(QueueTray, { session, queue, questionId: 7, formQuestion: true, strandedImages: false }))));
		const outer = container.querySelector("[data-tray-expand]")!;
		expect(outer.getAttribute("data-instant")).toBe("false");
		await act(async () => root.render(createElement(TooltipProvider, null, createElement(QueueTray, { session, queue, questionId: null, formQuestion: false, strandedImages: false }))));
		expect(outer.getAttribute("data-open")).toBe(String(queued));
		expect(outer.getAttribute("data-instant")).toBe(String(!queued));
		if (queued) {
			const question = outer.querySelector("[data-tray-expand]")!;
			expect(question.getAttribute("data-open")).toBe("false");
			expect(question.getAttribute("data-instant")).toBe("true");
			expect(container.textContent).toContain("My next message");
		}
	} finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps legacy question tray departures animated", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const container = document.createElement("div"); document.body.append(container);
	const root = createRoot(container);
	const props = { session: {} as SessionController, queue: [], strandedImages: false };
	try {
		await act(async () => root.render(createElement(QueueTray, { ...props, questionId: 7 })));
		await act(async () => root.render(createElement(QueueTray, { ...props, questionId: null })));
		expect(container.querySelector("[data-tray-expand]")?.getAttribute("data-instant")).toBe("false");
	} finally { await act(async () => root.unmount()); container.remove(); }
});
