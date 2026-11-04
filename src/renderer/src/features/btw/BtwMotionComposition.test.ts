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
import { ChatView } from "../../chat/ChatView";
import "../../i18n";

vi.hoisted(() => {
	Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } });
	// Use Motion's real JavaScript animation driver. happy-dom's partial WAAPI rejects
	// cancellation promises unlike Chromium, which obscures presence/layout assertions.
	Object.defineProperty(Element.prototype, "animate", { configurable: true, value: undefined });
});
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
// Keep production Shell, ChatView, Dock, MotionProvider and AnimatePresence.
// Only unrelated chrome and transcript internals are excluded.
vi.mock("../../chat/ChatArea", () => ({ ChatArea: () => createElement(ChatView, { session: controller, title: "Fixture chat", focused: true }) }));
vi.mock("../../chat/SessionHeader", () => ({ SessionHeader: () => createElement("header", null, "Chat header") }));
vi.mock("../../chat/transcript/Transcript", () => ({ Transcript: () => createElement("div", { "data-test-transcript": true }, "Main chat transcript") }));
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
		shell ? createElement(Shell) : createElement(Fragment, null,
			createElement(ChatView, { session: controller, title: "Fixture chat", focused: true }),
			visible && createElement(Dock, { chatKey: tabId, width: 440 })), createElement(OverlayWatcher))));
}
function receive() {
	const message = messages[cursor++]!;
	documents.receive({ ...message, body: JSON.stringify(message.body) });
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces);
	const selectedTopic = projection?.turns.length ? { id: "live:1" } : null;
	snapshot = { ...protocol, hostId: "motion-btw", generation: 1, revision: cursor, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: !projection, reason: projection ? "Finish the side question to send a message." : null, ...(projection ? { reasonCode: "btw" as const } : {}) }, questionMatches: [], surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	state = { hostId: "motion-btw", generation: 1, epoch: protocol.epoch, revision: cursor,
		topics: mergeBtwTopics([], projection, { id: "live:1" }), overlay: projection ? {
			epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic,
			topics: btwOverlayTopics(projection, [], selectedTopic), actions: Object.keys(projection.actions),
			followUp: !!projection.field, draft: projection.field?.text ?? null, supported: projection.supported, notice: projection.notice,
		} : null };
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	hostUpdates.clear(); btwUpdates.clear(); opened = []; cursor = 0; shell = false; autoOpened.tabId = null;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1500 });
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
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
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, docks: {}, btwDrawers: {}, view: "chat", sidebarOpen: false, chatOverDock: false });
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

it.each(["full", "reduced"])("keeps the transcript and existing side pane rendered when the drawer enters with %s motion", async preference => {
	document.documentElement.dataset.motion = preference;
	useApp.getState().showPane("motion-first", tabId);
	await act(async () => root.render(createElement(Harness)));
	const pane = element.querySelector<HTMLElement>('[data-test-pane="motion-first"]')!;
	const transcript = element.querySelector<HTMLElement>("[data-test-transcript]")!;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expect(pane.isConnected).toBe(true);
	expect(transcript.isConnected).toBe(true);
	expect(element.querySelector("aside")?.textContent).toContain("motion-first");
	expect(element.querySelector("aside")?.textContent).not.toContain("What is the first fixture side question?");
	const drawer = element.querySelector("[data-btw-drawer]")!;
	expect(drawer.textContent).toContain("What is the first fixture side question?");
	expect(drawer.closest("[data-chat-column]")).toBe(transcript.closest("[data-chat-column]"));
	expect(element.querySelector("[data-btw-paused]")).toBeNull();
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
});

it.each(["full", "reduced"])("keeps the narrow Shell chat slot mounted when the drawer enters with %s motion", async preference => {
	document.documentElement.dataset.motion = preference;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 }); shell = true;
	await act(async () => root.render(createElement(Harness)));
	const transcript = element.querySelector<HTMLElement>("[data-test-transcript]")!;
	const column = transcript.closest("[data-chat-column]")!;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expect(transcript.isConnected).toBe(true);
	expect(element.querySelector("[data-btw-drawer]")?.closest("[data-chat-column]")).toBe(column);
	expect(element.querySelector("[data-btw-drawer]")?.textContent).toContain("What is the first fixture side question?");
	expect(element.querySelector("[data-dock-expanded]")).toBeNull();
	expect(element.querySelector("[data-btw-scrim]")?.closest("[data-chat-column]")).toBe(column);
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
