// @vitest-environment happy-dom
import { act, type ComponentType, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BtwState } from "@shared/contracts/btw";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { btwOverlayTopics, mergeBtwTopics, projectBtw } from "@shared/tsp/btw";
import { walkNodes } from "@shared/tsp/view-state";
import { SessionController, type SessionView } from "../../state/session";
import { controllerFor, currentDock, useApp, useDockVisible } from "../../state/app";
import { TooltipProvider } from "../../ui/Tooltip";
import { Dock } from "../../shell/Dock";
import { routeSlash } from "../session-tools/slash";
import { OverlayWatcher } from "../palette/OverlayWatcher";
import { autoOpened, TerminalSheetHost } from "../palette/TerminalSheet";
import { PresentationVisibility } from "../../state/tsp/presentation-claims";
import { screenActivity } from "../../state/tsp/screen-activity";
import { FixtureDocuments, loadFixtureRecording, type FixtureMessage } from "../tsp/testing/documents";
import type * as LazyModule from "../../registry/lazy";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import streamingMessages from "../../../../main/omp/tsp/fixtures/18.15.0/btw-open-main-abort.messages.jsonl?raw";
import { ChatView } from "../../chat/ChatView";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { Shell } from "../../shell/Shell";
import { BtwDrawerContent } from "./BtwPane";
import { clearToasts, useToasts } from "../../ui/toast";
import "../panes";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
vi.mock("../../chat/ChatArea", () => ({ ChatArea: () => createElement(ChatView, { session: controller, title: "Fixture chat", focused: true }) }));
vi.mock("../../chat/SessionHeader", () => ({ SessionHeader: () => createElement("header", null, "Chat header") }));
vi.mock("../../chat/transcript/Transcript", () => ({ Transcript: () => createElement("button", { "data-transcript-action": true }, backgroundText) }));
vi.mock("../../shell/Sidebar", () => ({ Sidebar: () => null, focusChatSearch: () => {} }));
vi.mock("../../shell/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("../../shell/StatusBar", () => ({ StatusBar: () => null }));
vi.mock("../../shell/LeaveConfirm", () => ({ LeaveConfirm: () => null }));
vi.mock("../../registry/lazy", async importOriginal => {
	const original = await importOriginal<typeof LazyModule>();
	const { OmpScreenSheet } = await vi.importActual<typeof OmpScreenModule>("../tsp/OmpScreenSheet");
	// Only remove the generic screen's chunk boundary, keeping its production renderer.
	return { ...original, lazyView: (load: () => Promise<ComponentType<object>>, fallback: ComponentType<object> | null) =>
		load.toString().includes("OmpScreenSheet") ? OmpScreenSheet : original.lazyView(load, fallback) };
});
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), section: tag("section"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});

let root: Root;
let element: HTMLDivElement;
let tabId: string;
let controller: SessionController;
let otherController: SessionController;
let snapshot: TspHostSnapshot;
let state: BtwState;
let opened: string[];
let stopApp: () => void;
let revision: number;
let documents: FixtureDocuments;
let messages: FixtureMessage[];
let cursor: number;
let separateDeliveries = false;
let openingGate: Promise<void> | null = null;
let skipOpeningDocument = false;
let closeFailure: string | null = null;
let closeGate: Promise<void> | null = null;
let readGate: Promise<void> | null = null;
let separateCloseDocument = false;
let deliverCloseDocument: (() => void) | null = null;
let realShell = false;
let showOtherChat = false;
let backgroundText = "Transcript action";
const originalWidth = window.innerWidth;
let view: SessionView;
const viewUpdates = new Set<() => void>();
const closeRequests: unknown[][] = [];
const hostUpdates = new Set<(patch: TspHostPatch) => void>();
const btwUpdates = new Set<(state: BtwState) => void>();
const originalVomp = window.vomp;

function ToastEvidence() {
	const toasts = useToasts();
	return createElement("div", { "data-test-toasts": true }, toasts.map(toast => createElement("p", { key: toast.id }, toast.message)));
}
function Harness() {
	const visible = useDockVisible();
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		realShell ? createElement(Shell) : createElement(Fragment, null,
			visible && createElement(PresentationVisibility, { visible }, createElement(Dock, { chatKey: tabId, width: 440 })),
			createElement(ChatView, { session: controller, title: "Fixture chat", focused: true })),
		showOtherChat && createElement(ChatView, { session: otherController, title: "Other chat", focused: false }),
		createElement(OverlayWatcher), createElement(TerminalSheetHost), createElement(ToastEvidence)));
}
function receive(message: FixtureMessage = messages[cursor++]!) {
	documents.receive({ ...message, body: JSON.stringify(message.body) });
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces);
	const selectedTopic = projection?.turns.length ? { id: "live:1" } : null;
	snapshot = { ...protocol, hostId: "opening-btw", generation: 1, revision: ++revision, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: !projection, reason: projection ? "Finish the side question to send a message." : null, ...(projection ? { reasonCode: "btw" as const } : {}) }, questionMatches: [], surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	state = { hostId: "opening-btw", generation: 1, epoch: protocol.epoch, revision,
		topics: mergeBtwTopics([], projection, { id: "live:1" }), overlay: projection ? {
			epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic,
			topics: btwOverlayTopics(projection, [], selectedTopic), actions: Object.keys(projection.actions),
			followUp: !!projection.field, draft: projection.field?.text ?? null, supported: projection.supported, notice: projection.notice,
		} : null };
	return projection;
}
function publish() {
	view = { ...view, host: { ...view.host!, tspAvailability: snapshot.availability } };
	for (const listener of viewUpdates) listener();
	for (const listener of hostUpdates) listener(tspHostPatch(null, snapshot));
	for (const listener of btwUpdates) listener(state);
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	separateDeliveries = false;
	openingGate = null; skipOpeningDocument = false;
	backgroundText = "Transcript action";
	clearToasts(); closeFailure = null; closeGate = null; closeRequests.length = 0; viewUpdates.clear();
	readGate = null; separateCloseDocument = false; deliverCloseDocument = null; realShell = false; showOtherChat = false;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1500 });
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
	hostUpdates.clear(); btwUpdates.clear(); opened = []; revision = 0; cursor = 0; autoOpened.tabId = null;
	documents = new FixtureDocuments();
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin",
		invoke: async (channel: string, ...args: unknown[]) => {
			if (channel === "app:info") return { homeDir: "/tmp", defaultChatFolder: "/tmp" };
			if (channel === "host:tsp-snapshot") return snapshot;
			if (channel === "btw:list") { if (readGate) await readGate; return state; }
			if (channel === "btw:close") {
				closeRequests.push(args);
				if (closeGate) await closeGate;
				if (closeFailure) throw new Error(closeFailure);
				const topics = state.topics;
				const node = state.overlay!.nodeId;
				const close = messages.slice(cursor).find(message => {
					const body = message.body;
					return message.verb === "f" && body && typeof body === "object" && "ops" in body && Array.isArray(body.ops)
						&& body.ops.some(op => Array.isArray(op) && op[0] === "del" && op[1] === node);
				});
				expect(close, "recording contains omp's overlay close frame").toBeDefined();
				deliverCloseDocument = () => {
					receive(close!);
					state = { ...state, topics };
					publish();
				};
				if (separateCloseDocument) state = { ...state, overlay: null };
				else deliverCloseDocument();
			}
			if (channel === "omp:commands" || channel === "panes:files" || channel === "prompts:list") return [];
			if (channel === "btw:ask") {
				expect(currentDock(useApp.getState()).open).toBe(false);
				expect(useApp.getState().btwDrawers[tabId]).toBe(true);
				if (openingGate) await openingGate;
				if (skipOpeningDocument) return;
				receive();
				if (separateDeliveries) {
					for (const listener of hostUpdates) listener(tspHostPatch(null, snapshot));
				} else publish();
			}
		},
		on: (channel: string, listener: (payload: unknown) => void) => {
			if (channel === "host:tsp-patch") hostUpdates.add(listener);
			if (channel === "btw:changed") btwUpdates.add(listener);
			return () => { hostUpdates.delete(listener); btwUpdates.delete(listener); };
		},
	} });
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, docks: {}, btwDrawers: {}, view: "chat", sidebarOpen: false, chatOverDock: false });
	tabId = (await useApp.getState().newChat("/tmp/fixture"))!;
	controller = controllerFor(tabId)!;
	view = { ...controller.getSnapshot(), mode: "live", readOnly: false, host: { hostId: "opening-btw", transport: "tsp", generation: 1, tspEpoch: 1, phase: "live", cols: 110, rows: 32, tspAvailability: snapshot?.availability } } as unknown as SessionView;
	vi.spyOn(controller, "getSnapshot").mockImplementation(() => view);
	vi.spyOn(controller, "subscribe").mockImplementation(listener => { viewUpdates.add(listener); return () => { viewUpdates.delete(listener); }; });
	otherController = new SessionController({ tabId: "other-chat", projectPath: "/tmp/other", sessionFile: null });
	const otherView = { ...view, host: { ...view.host!, hostId: "other-host", tspAvailability: { available: true, reason: null } } };
	vi.spyOn(otherController, "getSnapshot").mockReturnValue(otherView);
	useComposerDrafts.getState().setDraft(tabId, "A message ready to send");
	stopApp = useApp.subscribe((next, previous) => {
		if (next.terminalTabId && next.terminalTabId !== previous.terminalTabId) opened.push(next.terminalTabId);
		if (next.sheet && next.sheet !== previous.sheet) opened.push(`sheet:${next.sheet.id}`);
	});
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	vi.useRealTimers();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
	await act(async () => root.unmount()); stopApp(); await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null, sheet: null }); autoOpened.tabId = null;
	element.remove(); window.vomp = originalVomp; vi.restoreAllMocks(); vi.unstubAllGlobals();
	clearToasts();
});

it.each(["btw-ask", "btw-empty"])("opens %s in a chat-column drawer without a side panel or transient sheet", async recording => {
	messages = loadFixtureRecording(recording).messages;
	// Keep the production store, eager drawer, overlay watcher and lazy controls.
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	const line = recording === "btw-ask" ? "/btw What is the first fixture side question?" : "/btw";
	await act(async () => { await routeSlash(controller, line); });
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(useApp.getState().sheet).toBeNull();
	expect(document.querySelector(".tsp-screen")).toBeNull();
	expect(currentDock(useApp.getState()).open).toBe(false);
	const drawer = element.querySelector('[data-btw-drawer][role="dialog"][aria-label="Side question"]')!;
	expect(drawer).not.toBeNull();
	expect(drawer.closest("[data-chat-column]")).not.toBeNull();
	expect(element.querySelector("aside")).toBeNull();
	expect(element.querySelector("[data-btw-paused]")).toBeNull();
	if (recording === "btw-ask") {
		expect(element.textContent).toContain("What is the first fixture side question?");
		expect(element.textContent).toContain("Answering");
		await act(async () => { receive(); publish(); });
		expect(element.textContent).toContain("The first fixture side answer is complete.");
	} else expect(element.textContent).toContain("No side questions yet");
	expect(opened).toEqual([]);
});

it("claims the first overlay frame before the history notification arrives", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	separateDeliveries = true;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expect(opened).toEqual([]);
	const preview = element.querySelector("section[aria-busy=true]");
	expect(preview?.textContent).toContain("What is the first fixture side question?");
	expect(preview?.querySelector("button, textarea")).toBeNull();
	await act(async () => { for (const listener of btwUpdates) listener(state); });
	expect(opened).toEqual([]);
	expect(element.querySelector("section[aria-busy=true]")).toBeNull();
});

it.each(["epoch change", "overlay removal"])("removes a pending document preview on %s", async change => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	separateDeliveries = true;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expect(element.querySelector("section[aria-busy=true]")?.textContent).toContain("What is the first fixture side question?");
	await act(async () => {
		if (change === "epoch change") receive({ verb: "q", body: { q: "hello", v: [1], features: ["send"] } });
		else receive({ verb: "f", body: { sf: snapshot.surfaces[0]!.open.id, s: snapshot.surfaces[0]!.sequence + 1, ops: [["del", state.overlay!.nodeId]] } });
		for (const listener of hostUpdates) listener(tspHostPatch(null, snapshot));
	});
	expect(element.querySelector("section[aria-busy=true]")).toBeNull();
	expect(opened).toEqual([]);
});

it("keeps every recorded streaming frame in the drawer through main-turn abort and completion", async () => {
	messages = streamingMessages.trim().split("\n").map(line => JSON.parse(line) as FixtureMessage);
	while (cursor < 8) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	let streamingFrames = 0;
	for (;;) {
		const projection = projectBtw(snapshot.surfaces);
		if (!projection) break;
		const turn = projection.turns[0]!;
		expect(element.querySelector("[data-btw-drawer]")?.textContent).toContain(turn.question);
		if (turn.answer) expect(element.querySelector("[data-btw-drawer]")?.textContent).toContain(turn.answer.trim());
		if (turn.status === "running") streamingFrames++;
		expect(opened).toEqual([]);
		expect(document.querySelector(".tsp-screen")).toBeNull();
		if (turn.status === "complete") break;
		await act(async () => { receive(); publish(); });
	}
	expect(streamingFrames).toBeGreaterThan(1);
	expect(element.textContent).toContain("Side answer continues after the main turn stops.");
	expect(element.textContent).toContain("Complete");
});

function drawerDone() {
	const buttons = [...element.querySelectorAll<HTMLButtonElement>("[data-btw-drawer] button")].filter(button => button.textContent?.trim() === "Done");
	expect(buttons).toHaveLength(1);
	return buttons[0]!;
}
function dismissDrawer(action: string) {
	if (action === "Done") drawerDone().click();
	else if (action === "outside click") element.querySelector<HTMLElement>("[data-btw-scrim]")!.click();
	else element.querySelector<HTMLElement>("[data-btw-drawer]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}
async function openForClosing(stage = "completed answer") {
	messages = loadFixtureRecording(stage === "bare history" ? "btw-history" : "btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, stage === "bare history" ? "/btw" : "/btw What is the first fixture side question?"); });
	if (stage === "completed answer") await act(async () => { receive(); publish(); });
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();
	expect(currentDock(useApp.getState()).open).toBe(false);
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
}
function assertSendableWithoutScreen() {
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(document.querySelector(".tsp-screen")).toBeNull();
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
}
function savedToasts() {
	return [...element.querySelectorAll("[data-test-toasts] p")].filter(item => item.textContent === "Side question saved to History");
}

it.each(["Done", "outside click", "Escape"])("puts away once and announces one saved toast after %s", async action => {
	await openForClosing();
	const history = structuredClone(state.topics);
	const column = element.querySelector("[data-chat-column]")!;
	const transcript = column.querySelector("[data-transcript-action]")!;
	expect(transcript.isConnected).toBe(true);
	expect(column.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(true);
	expect(element.querySelector("[data-btw-paused]")).toBeNull();
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => { dismissDrawer(action); dismissDrawer(action); });
	expect(closeRequests).toEqual([["opening-btw", { id: "live:1" }, { generation: 1, epoch: 1 }]]);
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();
	expect(savedToasts()).toHaveLength(0);
	await act(async () => pending.resolve());
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(column.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(false);
	expect(transcript.isConnected).toBe(true);
	expect(state.topics).toEqual(history);
	expect(savedToasts()).toHaveLength(1);
	assertSendableWithoutScreen();
	const composer = column.querySelector("textarea");
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(composer)); });
});

it.each(["bare history", "streaming answer"])("puts away %s through drawer Done with the recorded close frame", async stage => {
	await openForClosing(stage);
	await act(async () => drawerDone().click());
	expect(closeRequests).toEqual([["opening-btw", stage === "bare history" ? null : { id: "live:1" }, { generation: 1, epoch: 1 }]]);
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(savedToasts()).toHaveLength(stage === "bare history" ? 0 : 1);
	assertSendableWithoutScreen();
});

it.each(["Done", "outside click", "Escape"])("recovers a stalled opening with %s and puts away a late native overlay", async action => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	const pending = Promise.withResolvers<void>();
	openingGate = pending.promise;
	vi.useFakeTimers();
	let sending: Promise<boolean>;
	await act(async () => { sending = routeSlash(controller, "/btw A delayed question"); });
	expect(screenActivity.has(snapshot, "drive")).toBe(true);
	expect(screenActivity.has(snapshot, "request")).toBe(false);
	expect(element.querySelector("[data-btw-drawer]")?.getAttribute("aria-modal")).toBeNull();
	expect(drawerDone().disabled).toBe(false);
	await act(async () => { await vi.advanceTimersByTimeAsync(8001); });
	await expect(sending!).resolves.toBe(true);
	expect(screenActivity.has(snapshot, "drive")).toBe(false);
	expect(element.querySelector("[data-btw-drawer] [role=alert]")?.textContent).toBe("omp did not open the side question.");
	await act(async () => dismissDrawer(action));
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(element.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(false);
	await act(async () => pending.resolve());
	expect(closeRequests).toHaveLength(1);
	expect(savedToasts()).toHaveLength(0);
	expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
	vi.useRealTimers();
});

it("bounds a successful native request that never publishes a document", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	skipOpeningDocument = true;
	vi.useFakeTimers();
	await act(async () => { await routeSlash(controller, "/btw Missing document"); });
	await act(async () => { await vi.advanceTimersByTimeAsync(8001); });
	expect(element.querySelector("[data-btw-drawer] [role=alert]")?.textContent).toBe("omp did not open the side question.");
	await act(async () => drawerDone().click());
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(savedToasts()).toHaveLength(0);
	vi.useRealTimers();
});

it.each(["Done", "outside click", "Escape"])("keeps the drawer, disabled composer and error after failed %s", async action => {
	await openForClosing();
	closeFailure = "The fixture refused to put away the side question.";
	await act(async () => dismissDrawer(action));
	expect(closeRequests).toHaveLength(1);
	expect(element.querySelector("[data-btw-drawer] [role=alert]")?.textContent).toBe(closeFailure);
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	expect(savedToasts()).toHaveLength(0);
	expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
});

it("sends a follow-up inside the drawer while retaining the background transcript", async () => {
	await openForClosing();
	const drawer = element.querySelector<HTMLElement>("[data-btw-drawer]")!;
	expect([...drawer.querySelectorAll("button")].some(button => button.textContent?.trim() === "Follow up")).toBe(false);
	const field = drawer.querySelector<HTMLTextAreaElement>("textarea")!;
	expect(field).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Explain the fixture answer.");
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new Event("change", { bubbles: true }));
	});
	const invoke = vi.spyOn(window.vomp, "invoke");
	await act(async () => [...drawer.querySelectorAll("button")].find(button => button.textContent?.trim() === "Send follow-up")!.click());
	expect(invoke).toHaveBeenCalledWith("btw:followUp", "opening-btw", { id: "live:1" }, "Explain the fixture answer.", { generation: 1, epoch: 1 });
	expect(element.querySelector("[data-transcript-action]")).not.toBeNull();
	expect(currentDock(useApp.getState()).open).toBe(false);
	expect(opened).toEqual([]);
});

it("renders background transcript updates while the drawer keeps main input inert", async () => {
	await openForClosing();
	const transcript = element.querySelector("[data-transcript-action]")!;
	await act(async () => {
		backgroundText = "The main answer continued in the background.";
		view = { ...view };
		publish();
	});
	expect(transcript.textContent).toBe(backgroundText);
	expect(transcript.closest("[data-chat-content]")?.hasAttribute("inert")).toBe(true);
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();
	expect(opened).toEqual([]);
});

it("contains the drawer to its chat column in split view", async () => {
	showOtherChat = true;
	await openForClosing();
	const blocked = element.querySelector('section[aria-label="Fixture chat"]')!;
	const other = element.querySelector('section[aria-label="Other chat"]')!;
	expect(blocked.querySelector("[data-btw-drawer]")?.closest("[data-chat-column]")).toBe(blocked.querySelector("[data-chat-column]"));
	expect(other.querySelector("[data-btw-drawer]")).toBeNull();
	expect(other.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(false);
	other.querySelector<HTMLButtonElement>("[data-transcript-action]")!.focus();
	expect(document.activeElement).toBe(other.querySelector("[data-transcript-action]"));
});

it("keeps the first-frame claim when put-away fails before history arrives", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	separateDeliveries = true;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expect(element.querySelector("section[aria-busy=true]")).not.toBeNull();
	closeFailure = "The fixture refused to put away the pending history.";
	await act(async () => drawerDone().click());
	expect(closeRequests).toHaveLength(1);
	expect(element.querySelector("section[aria-busy=true]")).not.toBeNull();
	expect(element.querySelector("[data-btw-drawer] [role=alert]")?.textContent).toBe(closeFailure);
	expect(savedToasts()).toHaveLength(0);
	expect(opened).toEqual([]);
});

it("retains its presentation until the closing document arrives", async () => {
	await openForClosing();
	separateCloseDocument = true;
	await act(async () => drawerDone().click());
	expect(screenActivity.has(snapshot, "drive")).toBe(false);
	expect(closeRequests).toHaveLength(1);
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();
	expect(savedToasts()).toHaveLength(0);
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	await act(async () => deliverCloseDocument!());
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(savedToasts()).toHaveLength(1);
	assertSendableWithoutScreen();
});

it.each(["history read", "native close", "closing document"])("expires the entire put-away during a stalled %s without a false saved toast", async stall => {
	await BtwDrawerContent.preload();
	await openForClosing();
	const pending = Promise.withResolvers<void>();
	if (stall === "history read") readGate = pending.promise;
	else if (stall === "native close") closeGate = pending.promise;
	else separateCloseDocument = true;
	vi.useFakeTimers();
	await act(async () => drawerDone().click());
	expect(screenActivity.has(snapshot, "drive")).toBe(stall === "native close");
	await act(async () => { await vi.advanceTimersByTimeAsync(8001); });
	expect(screenActivity.has(snapshot, "drive")).toBe(false);
	expect(element.querySelector("[data-btw-drawer] [role=alert]")?.textContent).toBe("omp did not close the side-question history.");
	expect(savedToasts()).toHaveLength(0);
	expect(opened).toEqual([]);
	const before = closeRequests.length;
	if (stall !== "closing document") {
		await act(async () => drawerDone().click());
		expect(closeRequests).toHaveLength(before);
	}
	await act(async () => {
		if (stall === "closing document") deliverCloseDocument!();
		else pending.resolve();
	});
	expect(savedToasts()).toHaveLength(0);
	expect(opened).toEqual([]);
	if (stall === "history read") expect(closeRequests).toHaveLength(0);
	else expect(closeRequests).toHaveLength(1);
	vi.useRealTimers();
});

it("keeps the transcript and one native close through a narrow real Shell resize", async () => {
	realShell = true;
	await openForClosing();
	const transcript = element.querySelector("[data-transcript-action]")!;
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => drawerDone().click());
	await act(async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
		window.dispatchEvent(new Event("resize"));
	});
	expect(element.querySelector("[data-btw-drawer]")).not.toBeNull();
	expect(element.querySelector("[data-dock-expanded]")).toBeNull();
	expect(transcript.isConnected).toBe(true);
	await act(async () => dismissDrawer("Escape"));
	expect(closeRequests).toHaveLength(1);
	await act(async () => pending.resolve());
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(savedToasts()).toHaveLength(1);
	assertSendableWithoutScreen();
});

it("returns from narrow drawer Done to the chat composer with keyboard focus", async () => {
	realShell = true;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
	await openForClosing();
	const done = drawerDone(); done.focus();
	await act(async () => done.click());
	expect(closeRequests).toHaveLength(1);
	expect(element.querySelector("[data-dock-expanded]")).toBeNull();
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	const composer = element.querySelector<HTMLTextAreaElement>('section[aria-label="Fixture chat"] textarea')!;
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(composer)); });
	expect(composer.closest("[inert]")).toBeNull();
	expect(state.topics).toHaveLength(1);
	assertSendableWithoutScreen();
});

it("releases the claim immediately for an unsupported document layout", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	const surface = snapshot.surfaces[0]!;
	const body = [...walkNodes(surface.document)].find(node => node.p?.role === "omp.btw.body")!;
	vi.useFakeTimers();
	await act(async () => {
		const projection = receive({ verb: "f", body: { sf: surface.open.id, s: surface.sequence + 1, ops: [["set", body.id, { role: "extension.btw.layout" }]] } });
		expect(projection?.supported).toBe(false);
		for (const listener of hostUpdates) listener(tspHostPatch(null, snapshot));
	});
	await act(async () => { await vi.advanceTimersByTimeAsync(301); });
	expect(opened).toEqual([tabId]);
	expect(useApp.getState().terminalTabId).toBe(tabId);
	expect(document.querySelector(".tsp-screen")?.textContent).toContain("What is the first fixture side question?");
});

it("releases an opening drive when its host scope changes before the native request returns", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	const pending = Promise.withResolvers<void>(); openingGate = pending.promise;
	let sending: Promise<boolean>;
	await act(async () => { sending = routeSlash(controller, "/btw A delayed scoped question"); });
	const scope = snapshot;
	expect(screenActivity.has(scope, "drive")).toBe(true);
	view = { ...view, host: { ...view.host!, generation: view.host!.generation + 1 } };
	await act(async () => { for (const listener of viewUpdates) listener(); });
	expect(screenActivity.has(scope, "drive")).toBe(false);
	await act(async () => pending.resolve());
	await sending!;
});
