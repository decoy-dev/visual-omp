// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseScrollFollow, type ScrollFollow, useScrollFollow } from "./motion";

let container: HTMLDivElement;
let root: Root;
let element: HTMLElement;
let pinned: { current: boolean };
let follow: ScrollFollow;
let height: number;
let viewport: number;
let anchorPosition: number;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let resized: () => void;

function Probe({ instant = false }: { instant?: boolean }) {
	const ref = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	pinned = useRef(true);
	follow = useScrollFollow(ref, pinned, { content, instant });
	useLayoutEffect(() => {
		element = ref.current!;
		// Geometry is supplied because happy-dom has no layout. The hook owns writes, pinning and event ordering.
		Object.defineProperties(element, {
			scrollHeight: { configurable: true, get: () => height },
			clientHeight: { configurable: true, get: () => viewport },
			clientWidth: { configurable: true, value: 300 },
		});
		vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 0, right: 310, top: 0, bottom: 200, width: 310, height: 200, x: 0, y: 0, toJSON() {} });
		vi.spyOn(content.current!.firstElementChild!, "getBoundingClientRect").mockImplementation(() => ({
			left: 0, right: 300, top: anchorPosition - element.scrollTop, bottom: height - element.scrollTop,
			width: 300, height: height - anchorPosition, x: 0, y: anchorPosition - element.scrollTop, toJSON() {},
		}));
	}, []);
	return createElement("section", { ref, onScroll: follow.onScroll }, createElement("div", { ref: content }, createElement("input")));
}

function scroll(top: number) {
	element.scrollTop = top;
	element.dispatchEvent(new Event("scroll", { bubbles: true }));
}

function settle() {
	for (let tick = 1; frames.size && tick < 200; tick++) {
		const batch = [...frames.values()];
		frames.clear();
		for (const callback of batch) callback(tick * 1000 / 60);
	}
	expect(frames.size).toBe(0);
}

beforeEach(() => {
	height = 1400;
	viewport = 200;
	anchorPosition = 1100;
	frames = new Map();
	frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
	vi.stubGlobal("ResizeObserver", class {
		constructor(callback: () => void) { resized = callback; }
		observe() {}
		disconnect() {}
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	act(() => root.render(createElement(Probe)));
	expect(element.scrollTop).toBe(1200);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("transcript bottom pin", () => {
	it.each(["scroll-first", "resize-first"])("keeps following helper height changes and appended entries (%s)", order => {
		for (let update = 0; update < 8; update++) {
			// A helper above the view collapses 120px and browser anchoring moves scrollTop up. Entries appended
			// below it grow 240px before the queued scroll event, so the view is no longer at the new bottom.
			const anchored = element.scrollTop - 120;
			height += 120;
			anchorPosition -= 120;
			element.scrollTop = anchored;
			if (order === "resize-first") resized();
			scroll(anchored);
			if (order === "scroll-first") resized();
			follow.follow();
			expect(pinned.current).toBe(true);
			settle();
			expect(element.scrollTop).toBe(height - viewport);
		}
	});

	it("follows in-place question changes on the next frame without an eased glide", () => {
		act(() => root.render(createElement(Probe, { instant: true })));
		height += 140;
		resized();
		const batch = [...frames.values()];
		frames.clear();
		for (const callback of batch) callback(1000 / 60);
		expect(element.scrollTop).toBe(height - viewport);
		settle(); // The follow may schedule one final no-op frame after reaching its target.
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -30 }));
		scroll(element.scrollTop - 30);
		height += 100;
		resized();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1310);
	});

	it("keeps following when the helper strip changes the viewport during an eased append", () => {
		// The viewport grows and clamps the old bottom; new entries append before the scroll event is delivered.
		viewport += 100;
		element.scrollTop = 1100;
		height += 300;
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
		resized();
		expect(pinned.current).toBe(true);
		settle();
		expect(height - viewport - element.scrollTop).toBeLessThanOrEqual(0.5);
	});

	it("preserves a wheel scroll-up through helper resizes and appends, then follows again at the bottom", () => {
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
		scroll(1000);
		height += 240;
		resized();
		follow.follow();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1000);
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
		scroll(height - viewport);
		expect(pinned.current).toBe(true);
	});

	it("keeps a small wheel scroll-up unpinned inside the follow threshold", () => {
		element.dispatchEvent(new WheelEvent("wheel", { deltaY: -12 }));
		scroll(1188);
		resized();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1188);
	});

	it.each(["ArrowUp", "PageUp", "Home", " "])("stops following for the reader's %j key", key => {
		height += 240;
		resized();
		element.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: key === " ", bubbles: true }));
		scroll(1000);
		height += 240;
		resized();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1000);
	});

	it("leaves editing and prevented keys alone", () => {
		element.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
		const prevented = new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true });
		prevented.preventDefault();
		element.dispatchEvent(prevented);
		expect(pinned.current).toBe(true);
	});

	it("stops following for an upward scrollbar drag and releases the gesture outside the scroller", () => {
		element.dispatchEvent(new PointerEvent("pointerdown", { clientX: 305, button: 0, pointerType: "mouse", bubbles: true }));
		scroll(1000);
		document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
		height += 240;
		resized();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1000);
		follow.jumpToEnd();
		settle();
		anchorPosition -= 100;
		scroll(element.scrollTop - 100); // A later layout shift must not inherit the finished drag.
		resized();
		expect(pinned.current).toBe(true);
	});

	it("stops following when a touch moves the view upward", () => {
		const touch = (type: string, y: number) => {
			const event = new Event(type, { bubbles: true });
			Object.defineProperty(event, "touches", { value: [{ clientY: y }] });
			element.dispatchEvent(event);
		};
		touch("touchstart", 100);
		touch("touchmove", 140);
		scroll(1000);
		touch("touchend", 140);
		height += 240;
		resized();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1000);
	});

	it.each(["scroll-event", "before-scroll-event"])("keeps browser find/focus navigation in place (%s)", order => {
		height += 240;
		resized(); // A follow frame is already scheduled when browser navigation moves the view.
		element.querySelector("input")!.focus();
		element.scrollTop = 400;
		if (order === "scroll-event") element.dispatchEvent(new Event("scroll", { bubbles: true }));
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(400);
		resized();
		settle();
		expect(element.scrollTop).toBe(400);
	});

	it("releases following before app navigation starts a smooth scroll", () => {
		height += 240;
		resized();
		releaseScrollFollow(element.querySelector("input")!);
		expect(pinned.current).toBe(false);
		settle();
		scroll(400);
		resized();
		settle();
		expect(element.scrollTop).toBe(400);
	});

	it("reconciles an upward scrollbar drag before a delayed scroll event", () => {
		element.dispatchEvent(new MouseEvent("mousedown", { clientX: 305, button: 0, bubbles: true }));
		element.scrollTop = 900;
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		expect(pinned.current).toBe(false);
		resized();
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
		settle();
		expect(element.scrollTop).toBe(900);
	});

	it("preserves upward drag intent when viewport growth could also explain the final movement", () => {
		element.dispatchEvent(new PointerEvent("pointerdown", { clientX: 305, button: 0, pointerType: "mouse", bubbles: true }));
		viewport = 300;
		height = 1640;
		resized();
		element.scrollTop = 1100;
		document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
		expect(pinned.current).toBe(false);
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
		resized();
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(1100);
	});

	it("suspends follow frames throughout a scrollbar drag despite appends and resizes", () => {
		element.dispatchEvent(new PointerEvent("pointerdown", { clientX: 305, button: 0, pointerType: "mouse", bubbles: true }));
		height += 240;
		resized();
		follow.follow();
		follow.snap();
		settle();
		expect(element.scrollTop).toBe(1200);
		element.scrollTop = 900;
		resized();
		follow.follow();
		settle();
		expect(element.scrollTop).toBe(900);
		document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
		element.dispatchEvent(new Event("scroll", { bubbles: true }));
		settle();
		expect(pinned.current).toBe(false);
		expect(element.scrollTop).toBe(900);
	});
});
