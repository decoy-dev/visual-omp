// @vitest-environment happy-dom
import { MotionConfig } from "motion/react";
import { act, createElement, Fragment, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualSnapshot } from "../../state/visualSnapshot";
import { useScrollFollow } from "../../ui/motion";
import { Playout, PlayoutPaused, PlayoutRegistry, revealedPrefix, usePlayout, useRevealed } from "./pace";

interface StreamSnapshot {
	texts: string[];
	pending: boolean;
}

interface Stream {
	getSnapshot(): StreamSnapshot;
	subscribe(listener: () => void): () => void;
	publish(texts: string[], pending?: boolean): void;
	listeners: Set<() => void>;
}

function stream(text: string): Stream {
	let snapshot: StreamSnapshot = { texts: [text], pending: true };
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		publish(texts: string[], pending = true) {
			snapshot = { texts, pending };
			for (const listener of listeners) listener();
		},
		listeners,
	};
}

type Order = "snapshot-first" | "playout-first";

let container: HTMLDivElement;
let root: Root;
let state: DocumentVisibilityState;
let now: number;
let frameId: number;
let frames: Map<number, FrameRequestCallback>;
let visibilityListeners: Set<EventListenerOrEventListenerObject>;
let visibilityDescriptor: PropertyDescriptor | undefined;
let hiddenDescriptor: PropertyDescriptor | undefined;

function TextBlock({ playout, text, index }: { playout: Playout | null; text: string; index: number }) {
	const length = useRevealed(playout, index, text.length);
	return createElement("span", { "data-block": index }, length < 0 ? "" : revealedPrefix(text, length));
}

function Reply({ snapshot }: { snapshot: StreamSnapshot }) {
	const playout = usePlayout("reply", snapshot.texts.map(text => ({ length: text.length, timed: true })), {
		pending: snapshot.pending,
		showExisting: true,
		synchronized: false,
	});
	return createElement(Fragment, null, snapshot.texts.map((text, index) => createElement(TextBlock, { key: index, playout, text, index })));
}

function TranscriptProbe({ id, source, registry, paused = false }: { id: string; source: Stream; registry: Map<string, Playout>; paused?: boolean }) {
	const snapshot = useVisualSnapshot(source.subscribe, source.getSnapshot);
	const scroller = useRef<HTMLElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const follow = useScrollFollow(scroller, pinned, { content, paused });
	useLayoutEffect(() => {
		const element = scroller.current!;
		// happy-dom has no layout. Only geometry is supplied; the production follow hook owns scrollTop and pinning.
		Object.defineProperties(element, {
			clientHeight: { configurable: true, value: 200 },
			scrollHeight: { configurable: true, get: () => 1200 + (element.textContent?.length ?? 0) },
		});
	}, []);
	return createElement("section", { ref: scroller, "data-probe": id, onScroll: follow.onScroll },
		createElement("div", { ref: content },
			createElement(PlayoutRegistry.Provider, { value: registry },
				createElement(PlayoutPaused.Provider, { value: paused }, createElement(Reply, { snapshot })))));
}

beforeEach(() => {
	state = "visible";
	now = 0;
	frameId = 0;
	frames = new Map();
	visibilityListeners = new Set();
	visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
	hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
	Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
	// Deliberately contradictory: the snapshot gate and playout must agree on visibilityState.
	Object.defineProperty(document, "hidden", { configurable: true, get: () => state !== "hidden" });
	const add = document.addEventListener.bind(document);
	const remove = document.removeEventListener.bind(document);
	vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
		if (type === "visibilitychange" && listener) visibilityListeners.add(listener);
		else add(type, listener, options);
	});
	vi.spyOn(document, "removeEventListener").mockImplementation((type, listener, options) => {
		if (type === "visibilitychange" && listener) visibilityListeners.delete(listener);
		else remove(type, listener, options);
	});
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
	vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
	vi.spyOn(performance, "now").mockImplementation(() => now);
	vi.stubGlobal("ResizeObserver", class {
		observe() {}
		unobserve() {}
		disconnect() {}
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (visibilityDescriptor) Object.defineProperty(document, "visibilityState", visibilityDescriptor);
	else Reflect.deleteProperty(document, "visibilityState");
	if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
	else Reflect.deleteProperty(document, "hidden");
});

function visibility(next: DocumentVisibilityState, order: Order) {
	state = next;
	const listeners = [...visibilityListeners].sort((a, b) => {
		const central = (listener: EventListenerOrEventListenerObject) => typeof listener === "function" && listener.name === "notifyVisibility" ? 1 : 0;
		return order === "snapshot-first" ? central(a) - central(b) : central(b) - central(a);
	});
	// Flush every subscriber separately to expose a stale-props commit before the gated snapshot refreshes.
	for (const listener of listeners) act(() => flushSync(() => {
		const event = new Event("visibilitychange");
		if (typeof listener === "function") listener.call(document, event);
		else listener.handleEvent(event);
	}));
}

function frame(at: number) {
	now = at;
	const callbacks = [...frames.values()];
	frames.clear();
	act(() => flushSync(() => { for (const callback of callbacks) callback(at); }));
}

function text(id: string): string {
	return container.querySelector(`[data-probe="${id}"]`)!.textContent!;
}

function mount(left: Stream, right: Stream, registries: Map<string, Playout>[], paused = false, reduced = false) {
	act(() => flushSync(() => root.render(createElement(MotionConfig, { reducedMotion: reduced ? "always" : "never" },
		createElement(Fragment, null,
			createElement(TranscriptProbe, { id: "left", source: left, registry: registries[0]!, paused }),
			createElement(TranscriptProbe, { id: "right", source: right, registry: registries[1]!, paused }))))));
}

describe.each<Order>(["snapshot-first", "playout-first"])("playout visibility return (%s)", order => {
	it("catches up both gated transcripts before a frame, then paces later visible chunks", () => {
		const left = stream("left start");
		const right = stream("right start");
		const registries = [new Map<string, Playout>(), new Map<string, Playout>()];
		mount(left, right, registries);
		const original = registries.map(registry => registry.get("reply"));
		expect(text("left")).toBe("left start");
		expect(text("right")).toBe("right start");
		visibility("hidden", order);
		act(() => {
			left.publish(["left start plus hidden text", "a new hidden block"]);
			right.publish(["right start plus hidden text", "another hidden block"]);
		});
		expect(text("left")).toBe("left start");
		expect(text("right")).toBe("right start");
		expect(frames.size).toBe(0);

		visibility("visible", order);
		// No animation frame has run. This includes the commit whose props were still gated when playout notified first.
		expect(text("left")).toBe("left start plus hidden texta new hidden block");
		expect(text("right")).toBe("right start plus hidden textanother hidden block");
		for (const [index, registry] of registries.entries()) expect(registry.get("reply")).toBe(original[index]);
		frame(16);
		const caughtUp = text("left");
		const visibleText = `a new hidden block${" plus visible text".repeat(20)}`;
		act(() => left.publish(["left start plus hidden text", visibleText]));
		expect(text("left")).toBe(caughtUp);
		frame(32);
		frame(400);
		expect(text("left").length).toBeGreaterThan(caughtUp.length);
		expect(text("left").length).toBeLessThan(left.getSnapshot().texts.join("").length);

		act(() => left.publish(left.getSnapshot().texts, false));
		frame(500);
		frame(1100);
		expect(text("left")).toBe(left.getSnapshot().texts.join(""));
		expect(registries[0]!.has("reply")).toBe(false);
	});

	it("returns a pinned view to the latest position and preserves a scrolled-up view", () => {
		const left = stream("left start");
		const right = stream("right start");
		const registries = [new Map<string, Playout>(), new Map<string, Playout>()];
		mount(left, right, registries);
		const pinned = container.querySelector<HTMLElement>('[data-probe="left"]')!;
		const scrolled = container.querySelector<HTMLElement>('[data-probe="right"]')!;
		act(() => {
			scrolled.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
			scrolled.scrollTop = 200;
			scrolled.dispatchEvent(new Event("scroll", { bubbles: true }));
		});
		visibility("hidden", order);
		mount(left, right, registries, true);
		act(() => {
			left.publish(["left hidden reply ".repeat(80)]);
			right.publish(["right hidden reply ".repeat(80)]);
		});
		visibility("visible", order);
		mount(left, right, registries, false);
		expect(text("left")).toBe(left.getSnapshot().texts.join(""));
		expect(text("right")).toBe(right.getSnapshot().texts.join(""));
		expect(pinned.scrollTop).toBe(pinned.scrollHeight - pinned.clientHeight);
		expect(scrolled.scrollTop).toBe(200);
	});
});

it("catches up when a visible source notification precedes the visibility event", () => {
	const left = stream("left start");
	const right = stream("right start");
	const registries = [new Map<string, Playout>(), new Map<string, Playout>()];
	mount(left, right, registries);
	visibility("hidden", "playout-first");
	act(() => left.publish(["hidden text"]));
	state = "visible";
	act(() => flushSync(() => left.publish(["hidden text plus the first visible update"])));
	expect(text("left")).toBe("hidden text plus the first visible update");
	visibility("visible", "snapshot-first");
	frame(16);
	act(() => left.publish(["hidden text plus the first visible update and a paced chunk"]));
	expect(text("left")).toBe("hidden text plus the first visible update");
});

it("retains paused-context catch-up and reduced-motion registry cleanup", () => {
	const left = stream("left start");
	const right = stream("right start");
	const registries = [new Map<string, Playout>(), new Map<string, Playout>()];
	mount(left, right, registries, true);
	act(() => left.publish(["paused text appears in full"]));
	expect(text("left")).toBe("paused text appears in full");
	expect(frames.size).toBe(0);
	mount(left, right, registries, false);
	act(() => left.publish(["paused text appears in full plus paced text"]));
	expect(text("left")).toBe("paused text appears in full");
	mount(left, right, registries, false, true);
	expect(text("left")).toBe(left.getSnapshot().texts.join(""));
	expect(registries.every(registry => registry.size === 0)).toBe(true);
	act(() => root.unmount());
	expect(left.listeners.size).toBe(0);
	expect(right.listeners.size).toBe(0);
	expect(visibilityListeners.size).toBe(0);
	expect(frames.size).toBe(0);
});
