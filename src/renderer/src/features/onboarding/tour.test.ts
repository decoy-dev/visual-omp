// @vitest-environment happy-dom
import { act, createElement, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as MotionModule from "motion/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentDock, dockKey, useApp } from "../../state/app";
import { startTour, TourHost } from "./tour";
import "../../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => null } });
});
vi.mock("../../state/session", () => ({ SessionController: class {
	view = { mode: "history", host: null, working: false, queue: [], guest: null };
	constructor(options: object) { Object.assign(this, options); }
	subscribe = () => () => {};
	getSnapshot = () => this.view;
	async loadHistory() {}
	async checkOwnership() {}
	async dispose() {}
	setForeground() {}
}, questionPresentation: () => ({ pending: false, form: null }) }));
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionModule>();
	const React = await import("react");
	const tag = (name: string) => React.forwardRef<HTMLElement, PropsWithChildren<Record<string, unknown>>>(({ children, initial, animate, exit, transition, layout, ...props }, ref) => React.createElement(name, { ...props, ref, children }));
	return { ...actual, AnimatePresence: ({ children }: PropsWithChildren) => children, motion: { ...actual.motion, div: tag("div"), span: tag("span") }, useReducedMotionConfig: () => true };
});

let root: Root;
let container: HTMLDivElement;
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
	useApp.setState({ tabs: [{ id: "chat", projectPath: "/workspace", sessionFile: "/chat.jsonl", title: "Chat" }], activeTabId: "chat", splitTabId: null, view: "home", docks: {}, sidebarOpen: false, chatOverDock: false, prefs: null });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root.render(createElement(TourHost)));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

const body = () => document.body.querySelector("[role=dialog] p")?.textContent ?? "";
const dockOpen = () => currentDock(useApp.getState()).open;
async function next() {
	const button = [...document.body.querySelectorAll("button")].find(node => node.textContent === "Show next step")!;
	await act(async () => button.click());
}
/** Starts the tour and steps to "Watch the work", the fifth stop. */
async function toDockStep() {
	await act(async () => startTour());
	for (let step = 0; step < 4; step++) await next();
	expect(document.body.querySelector("[role=dialog] h2")?.textContent).toBe("Watch the work");
}

it("says where to find the side panel on Home, which never shows one", async () => {
	await toDockStep();
	expect(body()).toMatch(/^In a chat, the side panel shows the work\./);
	expect(body()).toMatch(/Side panel button in the chat's header\.$/);
	await next();
	expect(dockOpen()).toBe(false);
});

it("opens a chat's closed side panel for the step and closes it again", async () => {
	await act(async () => useApp.setState({ view: "chat" }));
	await toDockStep();
	expect(dockOpen()).toBe(true);
	expect(body()).toMatch(/from the menu at the top of the panel\.$/);
	await next();
	expect(dockOpen()).toBe(false);
});

it("leaves a side panel that was already open as it was", async () => {
	await act(async () => {
		useApp.setState({ view: "chat" });
		useApp.getState().toggleDock(true, dockKey(useApp.getState()));
	});
	await toDockStep();
	expect(body()).toMatch(/from the menu at the top of the panel\.$/);
	await next();
	expect(dockOpen()).toBe(true);
});
