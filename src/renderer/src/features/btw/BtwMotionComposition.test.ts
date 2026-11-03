// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BtwState } from "@shared/contracts/btw";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { btwOverlayTopics, mergeBtwTopics, projectBtw } from "@shared/tsp/btw";
import { panes } from "../../registry/slots";
import { Dock } from "../../shell/Dock";
import { Shell } from "../../shell/Shell";
import { controllerFor, useApp, useDockVisible } from "../../state/app";
import { SessionController, type SessionView } from "../../state/session";
import { MotionProvider } from "../../ui/motion";
import { TooltipProvider } from "../../ui/Tooltip";
import { OverlayWatcher } from "../palette/OverlayWatcher";
import { autoOpened } from "../palette/TerminalSheet";
import { routeSlash } from "../session-tools/slash";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import "../panes";
import "../../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } });
	// Use Motion's real JavaScript animation driver. happy-dom's partial WAAPI rejects
	// cancellation promises unlike Chromium, which obscures presence/layout assertions.
	Object.defineProperty(Element.prototype, "animate", { configurable: true, value: undefined });
});
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
// Keep the production Shell, Dock, MotionProvider, PresenceSwap and AnimatePresence. Unrelated
// chrome and chat content are excluded so this composition isolates side-panel entry and layout.
vi.mock("../../chat/ChatArea", () => ({ ChatArea: () => createElement("div", { "data-test-chat": true }, "Main chat") }));
vi.mock("../../shell/Sidebar", () => ({ Sidebar: () => null, focusChatSearch: () => {} }));
vi.mock("../../shell/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("../../shell/StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../../shell/LeaveConfirm", () => ({ LeaveConfirm: () => null }));

let root: Root;
let element: HTMLDivElement;
let stylesheet: HTMLStyleElement;
let tabId: string;
let controller: SessionController;
let snapshot: TspHostSnapshot;
let state: BtwState;
let opened: string[];
let stopApp: () => void;
let shell: boolean;
let cursor: number;
let documents: FixtureDocuments;
const messages = loadFixtureRecording("btw-ask").messages;
const hostUpdates = new Set<(snapshot: TspHostSnapshot) => void>();
const btwUpdates = new Set<(state: BtwState) => void>();
const originalVomp = window.vomp;
const originalWidth = window.innerWidth;
const originalMotion = document.documentElement.dataset.motion;

function Harness() {
	const visible = useDockVisible();
	return createElement(MotionProvider, null, createElement(TooltipProvider, null, createElement(Fragment, null,
		shell ? createElement(Shell) : visible && createElement(Dock, { chatKey: tabId, width: 440 }), createElement(OverlayWatcher))));
}
function receive() {
	const message = messages[cursor++]!;
	documents.receive({ ...message, body: JSON.stringify(message.body) });
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces);
	const selectedTopic = projection?.turns.length ? { id: "live:1" } : null;
	snapshot = { ...protocol, hostId: "motion-btw", generation: 1, revision: cursor, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: !projection, reason: null }, questionMatches: [], surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	state = { hostId: "motion-btw", generation: 1, epoch: protocol.epoch, revision: cursor,
		topics: mergeBtwTopics([], projection, { id: "live:1" }), overlay: projection ? {
			epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic,
			topics: btwOverlayTopics(projection, [], selectedTopic), actions: Object.keys(projection.actions),
			followUp: !!projection.field, draft: projection.field?.text ?? null, supported: projection.supported, notice: projection.notice,
		} : null };
}
function expectExitOutsideFlow(outgoing: HTMLElement) {
	expect(outgoing.isConnected).toBe(true);
	expect(getComputedStyle(outgoing).position).toBe("absolute");
	expect(getComputedStyle(outgoing.parentElement!).position).toBe("relative");
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	hostUpdates.clear(); btwUpdates.clear(); opened = []; cursor = 0; shell = false; autoOpened.tabId = null;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1500 });
	documents = new FixtureDocuments();
	while (cursor < 4) receive();
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin",
		invoke: async (channel: string) => {
			if (channel === "app:info") return { homeDir: "/tmp", defaultChatFolder: "/tmp" };
			if (channel === "host:tsp-snapshot") return snapshot;
			if (channel === "btw:list") return state;
			if (channel === "btw:ask") { receive(); for (const listener of hostUpdates) listener(snapshot); for (const listener of btwUpdates) listener(state); }
		},
		on: (channel: string, listener: (payload: unknown) => void) => {
			if (channel === "host:tsp-update") hostUpdates.add(listener);
			if (channel === "btw:changed") btwUpdates.add(listener);
			return () => { hostUpdates.delete(listener); btwUpdates.delete(listener); };
		},
	} });
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, docks: {}, view: "chat", sidebarOpen: false, chatOverDock: false });
	tabId = (await useApp.getState().newChat("/tmp/fixture"))!;
	controller = controllerFor(tabId)!;
	const view = { ...controller.getSnapshot(), mode: "live", readOnly: false, host: { hostId: "motion-btw", transport: "tsp", generation: 1, tspEpoch: 1, phase: "live", cols: 110, rows: 32 } } as unknown as SessionView;
	vi.spyOn(controller, "getSnapshot").mockReturnValue(view);
	for (const id of ["motion-first", "motion-next"]) panes.register({ id, order: 100, title: id, icon: panes.get("btw")!.icon,
		component: () => createElement("div", { "data-test-pane": id }, id) });
	stopApp = useApp.subscribe((next, previous) => { if (next.terminalTabId && next.terminalTabId !== previous.terminalTabId) opened.push(next.terminalTabId); });
	stylesheet = document.createElement("style"); stylesheet.textContent = ".relative { position: relative; }"; document.head.append(stylesheet);
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); stopApp(); await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null, sheet: null }); autoOpened.tabId = null;
	element.remove(); stylesheet.remove(); window.vomp = originalVomp;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
	if (originalMotion === undefined) delete document.documentElement.dataset.motion;
	else document.documentElement.dataset.motion = originalMotion;
	vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each(["full", "reduced"])("removes the exiting pane from layout when BTW enters with %s motion", async preference => {
	document.documentElement.dataset.motion = preference;
	useApp.getState().showPane("motion-first", tabId);
	await act(async () => root.render(createElement(Harness)));
	const outgoing = element.querySelector<HTMLElement>('[data-test-pane="motion-first"]')!.parentElement!;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expectExitOutsideFlow(outgoing);
	expect(element.querySelector("aside")?.textContent).toContain("What is the first fixture side question?");
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
});

it.each(["full", "reduced"])("removes the previous main-area slot from layout when narrow Shell enters BTW with %s motion", async preference => {
	document.documentElement.dataset.motion = preference;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 }); shell = true;
	await act(async () => root.render(createElement(Harness)));
	const stage = element.querySelector("main")!.firstElementChild!;
	const outgoing = stage.lastElementChild as HTMLElement;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expectExitOutsideFlow(outgoing);
	expect(element.querySelector("[data-dock-expanded]")?.textContent).toContain("What is the first fixture side question?");
	expect(element.querySelector("[data-dock-expanded]")?.textContent).toContain("Back to chat");
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
});

it.each(["full", "reduced"])("keeps the existing wait transition for another pane with %s motion", async preference => {
	document.documentElement.dataset.motion = preference;
	useApp.getState().showPane("motion-first", tabId);
	await act(async () => root.render(createElement(Harness)));
	const outgoing = element.querySelector<HTMLElement>('[data-test-pane="motion-first"]')!.parentElement!;
	await act(async () => useApp.getState().showPane("motion-next", tabId));
	expect(outgoing.isConnected).toBe(true);
	expect(getComputedStyle(outgoing).position).not.toBe("absolute");
	expect(element.querySelector('[data-test-pane="motion-next"]')).toBeNull();
	expect(opened).toEqual([]);
	await vi.waitFor(async () => {
		await act(async () => {});
		expect(element.querySelector('[data-test-pane="motion-next"]')).not.toBeNull();
	}, { timeout: 2000, interval: 20 });
	expect(outgoing.isConnected).toBe(false);
});
