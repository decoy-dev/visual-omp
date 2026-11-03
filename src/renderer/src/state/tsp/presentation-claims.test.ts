// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { FixtureDocuments, loadFixtureRecording } from "../../features/tsp/testing/documents";
import { presentationClaims } from "./presentation-claims";
import { OmpScreenSheet } from "../../features/tsp/OmpScreenSheet";
import { Shell } from "../../shell/Shell";
import "../../i18n";
import { OmpDialogCard } from "../../features/session-tools/OmpDialogCard";

const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown>, width: 900, controllers: new Map<string, SessionController>() }));
vi.mock("../../state/app", () => ({
	useApp: Object.assign((selector: (state: Record<string, unknown>) => unknown) => selector(fake.state), { getState: () => fake.state, subscribe: () => () => {} }),
	controllerFor: (id: string) => fake.controllers.get(id), currentDock: () => ({ open: false, width: 300 }), dockKey: () => null,
	dockTooNarrow: () => false, focusedTabId: () => "a", viewHidesDock: () => false, useWindowWidth: () => 1000, MAIN_ID: "main", DOCK_INSET: 8,
}));
vi.mock("../../chat/ChatView", () => ({
	ChatView: ({ session }: { session: SessionController }) => createElement(OmpDialogCard, { session }),
}));
vi.mock("../../registry/slots", () => ({ pages: { use: () => [{ id: "settings", component: () => createElement("p", null, "Settings page") }] }, screens: { use: () => [] }, sheets: { use: () => [] } }));
vi.mock("../../shell/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../../shell/StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../../shell/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("../../shell/Dock", () => ({ Dock: () => null }));
vi.mock("../../shell/LeaveConfirm", () => ({ LeaveConfirm: () => null }));
vi.mock("../../shell/ResizeHandle", () => ({ ResizeHandle: () => null }));
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), section: tag("section"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});
let root: Root;
let element: HTMLDivElement;
let snapshots: Map<string, TspHostSnapshot>;
const observers = new Set<{ callback: ResizeObserverCallback; target: Element }>();
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fake.state = { view: "chat", tabs: [{ id: "a", title: "A" }, { id: "b", title: "B" }], activeTabId: "a", splitTabId: "b", focusedSplit: "primary", sidebarOpen: false, sheet: null, page: null, pageReturn: null, chatOverDock: true };
	fake.width = 900; fake.controllers.clear(); snapshots = new Map(); observers.clear();
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: fake.width, height: 100, left: 0, top: 0, bottom: 100, right: fake.width, x: 0, y: 0, toJSON: () => ({}) }));
	vi.stubGlobal("ResizeObserver", class {
		constructor(private callback: ResizeObserverCallback) {}
		observe(target: Element) { observers.add({ callback: this.callback, target }); }
		unobserve() {}
		disconnect() { for (const observer of observers) if (observer.callback === this.callback) observers.delete(observer); }
	});
	const documents = new FixtureDocuments();
	for (const message of loadFixtureRecording("hook-select").messages) {
		documents.receive({ ...message, body: JSON.stringify(message.body) });
		if (hookDialogTarget(documents.snapshot().surfaces)) break;
	}
	for (const hostId of ["a", "b"]) {
		const recorded = structuredClone(documents.snapshot());
		const target = hookDialogTarget(recorded.surfaces)!;
		const snapshot: TspHostSnapshot = { ...recorded, hostId, generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: "Question open" }, failure: null,
			questionMatches: [{ surfaceId: target.surface.open.id, nodeId: target.node.id, status: "unmatched" }], surfaces: recorded.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
		snapshots.set(hostId, snapshot);
		const view = { mode: "live", readOnly: false, host: { hostId, generation: 1, transport: "tsp" } } as unknown as SessionView;
		fake.controllers.set(hostId, { tabId: hostId, hostId, subscribe: () => () => {}, getSnapshot: () => view } as unknown as SessionController);
	}
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke: vi.fn(async (channel: string, hostId: string) => channel === "host:tsp-snapshot" ? snapshots.get(hostId) : undefined), on: () => () => {} } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "vomp"); });
async function render(shell = true) {
	await act(async () => root.render(createElement(Fragment, null, shell ? createElement(Shell) : null,
		...[...snapshots].map(([hostId, snapshot]) => createElement("div", { key: hostId, "data-fallback-host": hostId }, createElement(OmpScreenSheet, { hostId, generation: 1, snapshot, readOnly: false, failed: false }))),
	)));
}
const fallbackOptions = (hostId: string) => element.querySelectorAll(`[data-fallback-host=${hostId}] [role=option]`).length;
it("restores generic hooks when an actual Shell page covers mounted chats, and releases on unmount", async () => {
	await render(); expect(presentationClaims.getSnapshot()).toHaveLength(2); expect(fallbackOptions("a")).toBe(0); expect(fallbackOptions("b")).toBe(0);
	fake.state = { ...fake.state, view: "page", page: { id: "settings", seq: 1 }, pageReturn: "chat" };
	await render(); expect(element.textContent).toContain("Settings page"); expect(presentationClaims.getSnapshot()).toHaveLength(0); expect(fallbackOptions("a")).toBe(4); expect(fallbackOptions("b")).toBe(4);
	fake.state = { ...fake.state, view: "chat", page: null };
	await render(); expect(presentationClaims.getSnapshot()).toHaveLength(2);
	await render(false); expect(presentationClaims.getSnapshot()).toHaveLength(0); expect(fallbackOptions("a")).toBe(4); expect(fallbackOptions("b")).toBe(4);
});
it("restores only the hidden split pane's generic hook when the actual ChatArea becomes narrow", async () => {
	await render(); expect(presentationClaims.getSnapshot()).toHaveLength(2);
	fake.width = 600;
	await act(async () => { for (const observer of observers) observer.callback([{ target: observer.target, contentRect: { width: fake.width } } as ResizeObserverEntry], {} as ResizeObserver); });
	expect(presentationClaims.getSnapshot().map(claim => claim.hostId)).toEqual(["a"]); expect(fallbackOptions("a")).toBe(0); expect(fallbackOptions("b")).toBe(4);
	fake.state = { ...fake.state, focusedSplit: "secondary" }; await render();
	expect(presentationClaims.getSnapshot().map(claim => claim.hostId)).toEqual(["b"]); expect(fallbackOptions("a")).toBe(4); expect(fallbackOptions("b")).toBe(0);
});
