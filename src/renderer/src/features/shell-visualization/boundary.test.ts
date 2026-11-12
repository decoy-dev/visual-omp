// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellViewBoundary } from "./boundary";

let container: HTMLDivElement;
let root: Root;
let crashes: unknown[];

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.spyOn(console, "error").mockImplementation(() => {});
	container = document.createElement("div");
	document.body.append(container);
	crashes = [];
	root = createRoot(container, { onUncaughtError: error => crashes.push(error) });
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

/** Like a viewer whose bridge subscription throws while it mounts (the 0.8.0 `blocked channel` failure). */
function FailingViewer(): null {
	useEffect(() => { throw new Error("blocked channel"); }, []);
	return null;
}

it("falls back to the card's ordinary command and keeps the rest of the window when a viewer throws", () => {
	act(() => root.render(createElement("main", null,
		createElement("p", null, "Earlier reply"),
		createElement(ShellViewBoundary, { fallback: createElement("pre", null, "printf ok"), children: createElement(FailingViewer) }))));
	expect(crashes).toEqual([]);
	expect(container.textContent).toBe("Earlier replyprintf ok");
});
