// @vitest-environment happy-dom
import { MotionConfig } from "motion/react";
import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { useRowCue } from "./motion";

function Row({ revision }: { revision: number | null }) {
	const ref = useRef<HTMLSpanElement>(null);
	useRowCue(ref, revision);
	return createElement("span", { ref });
}

const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
afterEach(() => {
	if (original) Object.defineProperty(HTMLElement.prototype, "animate", original);
	else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("useRowCue", () => {
	it.each([false, true])("lights a row for growing revisions, joins a wash still fading, and never cues loading, viewing or a mount (reduced=%s)", async reduced => {
		const washes: { playState: string; cancel: Mock }[] = [];
		const animate = vi.fn(() => {
			const wash = { playState: "running", cancel: vi.fn() };
			washes.push(wash);
			return wash;
		});
		Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
		const root = createRoot(document.createElement("div"));
		const render = (revision: number | null) => act(() => root.render(createElement(MotionConfig, { reducedMotion: reduced ? "always" : "never" }, createElement(Row, { revision }))));
		// A chat that is still loading, then arrives with its transcript.
		await render(null);
		await render(12);
		expect(animate).not.toHaveBeenCalled();
		await render(13);
		expect(animate).toHaveBeenCalledExactlyOnceWith([{ opacity: 1 }, { opacity: 0 }], { duration: reduced ? 140 : 360, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
		// Another update while the wash fades joins it.
		await render(15);
		expect(animate).toHaveBeenCalledTimes(1);
		washes[0]!.playState = "finished";
		await render(16);
		expect(animate).toHaveBeenCalledTimes(2);
		// Opening the chat mid-wash clears it, and its updates while on screen stay at rest.
		await render(null);
		expect(washes[1]!.cancel).toHaveBeenCalledTimes(1);
		await render(20);
		// Unchanged or smaller (a /new or a resync) stay at rest too.
		await render(20);
		await render(3);
		expect(animate).toHaveBeenCalledTimes(2);
		await act(() => root.unmount());
		expect(washes.map(wash => wash.cancel.mock.calls.length)).toEqual([0, 1]);
	});
});
