// @vitest-environment happy-dom
import { act, type ComponentType, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BtwState } from "@shared/contracts/btw";
import type { TspHostSnapshot } from "@shared/tsp-host";
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
import { FixtureDocuments, loadFixtureRecording, type FixtureMessage } from "../tsp/testing/documents";
import type * as LazyModule from "../../registry/lazy";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import streamingMessages from "../../../../main/omp/tsp/fixtures/18.15.0/btw-open-main-abort.messages.jsonl?raw";
import { ChatView } from "../../chat/ChatView";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { getCommand } from "../../registry/commands";
import "../palette/commands";
import { Shell } from "../../shell/Shell";
import { BtwContent } from "./BtwPane";
import "../panes";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
vi.mock("../../chat/ChatArea", () => ({ ChatArea: () => createElement(ChatView, { session: controller, title: "Fixture chat", focused: true }) }));
vi.mock("../../chat/SessionHeader", () => ({ SessionHeader: () => createElement("header", null, "Chat header") }));
vi.mock("../../chat/transcript/Transcript", () => ({ Transcript: () => createElement("button", { "data-transcript-action": true }, "Transcript action") }));
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
let showComposer = false;
let closeFailure: string | null = null;
let closeGate: Promise<void> | null = null;
let readGate: Promise<void> | null = null;
let separateCloseDocument = false;
let deliverCloseDocument: (() => void) | null = null;
let realShell = false;
let showOtherChat = false;
const originalWidth = window.innerWidth;
let view: SessionView;
const viewUpdates = new Set<() => void>();
const closeRequests: unknown[][] = [];
const hostUpdates = new Set<(snapshot: TspHostSnapshot) => void>();
const btwUpdates = new Set<(state: BtwState) => void>();
const originalVomp = window.vomp;

function Harness() {
	const visible = useDockVisible();
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		realShell ? createElement(Shell) : visible && createElement(PresentationVisibility, { visible }, createElement(Dock, { chatKey: tabId, width: 440 })),
		showComposer && !realShell && createElement(ChatView, { session: controller, title: "Fixture chat", focused: true }),
		showOtherChat && createElement(ChatView, { session: otherController, title: "Other chat", focused: false }),
		createElement(OverlayWatcher), createElement(TerminalSheetHost)));
}
function receive(message: FixtureMessage = messages[cursor++]!) {
	documents.receive({ ...message, body: JSON.stringify(message.body) });
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces);
	const selectedTopic = projection?.turns.length ? { id: "live:1" } : null;
	snapshot = { ...protocol, hostId: "opening-btw", generation: 1, revision: ++revision, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: !projection, reason: projection ? "Put away the side question to send a message." : null, ...(projection ? { reasonCode: "btw" as const } : {}) }, questionMatches: [], surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
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
	for (const listener of hostUpdates) listener(snapshot);
	for (const listener of btwUpdates) listener(state);
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	separateDeliveries = false;
	showComposer = false; closeFailure = null; closeGate = null; closeRequests.length = 0; viewUpdates.clear();
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
				expect(currentDock(useApp.getState()).pane).toBe("btw");
				receive();
				if (separateDeliveries) {
					for (const listener of hostUpdates) listener(snapshot);
				} else publish();
			}
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
});

it.each(["btw-ask", "btw-empty"])("opens %s directly in Side questions without any transient sheet", async recording => {
	messages = loadFixtureRecording(recording).messages;
	// Exercise the production pane registration with a closed panel and no idle preload.
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	const line = recording === "btw-ask" ? "/btw What is the first fixture side question?" : "/btw";
	await act(async () => { await routeSlash(controller, line); });
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(useApp.getState().sheet).toBeNull();
	expect(document.querySelector(".tsp-screen")).toBeNull();
	expect(element.querySelector("aside")?.textContent).toContain("Side questions");
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
		for (const listener of hostUpdates) listener(snapshot);
	});
	expect(element.querySelector("section[aria-busy=true]")).toBeNull();
	expect(opened).toEqual([]);
});

it("keeps every recorded streaming frame in the side panel through main-turn abort and completion", async () => {
	messages = streamingMessages.trim().split("\n").map(line => JSON.parse(line) as FixtureMessage);
	while (cursor < 8) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	let streamingFrames = 0;
	for (;;) {
		const projection = projectBtw(snapshot.surfaces);
		if (!projection) break;
		const turn = projection.turns[0]!;
		expect(element.querySelector("aside")?.textContent).toContain(turn.question);
		if (turn.answer) expect(element.querySelector("aside")?.textContent).toContain(turn.answer.trim());
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

it.each(["bare history", "streaming answer", "completed answer"])("puts away %s before closing with the panel X", async stage => {
	await openForClosing(stage);
	const history = state.topics;
	const pending = Promise.withResolvers<void>();
	closeGate = pending.promise;
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
	expect(currentDock(useApp.getState()).open).toBe(true);
	expect(opened).toEqual([]);
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	await act(async () => pending.resolve());
	expect(closeRequests).toEqual([["opening-btw", stage === "bare history" ? null : { id: "live:1" }, { generation: 1, epoch: 1 }]]);
	expect(currentDock(useApp.getState()).open).toBe(false);
	expect(state.topics).toEqual(history);
	assertSendableWithoutScreen();
});

async function openForClosing(stage = "completed answer") {
	showComposer = true;
	messages = loadFixtureRecording(stage === "bare history" ? "btw-history" : "btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, stage === "bare history" ? "/btw" : "/btw What is the first fixture side question?"); });
	if (stage === "completed answer") await act(async () => { receive(); publish(); });
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
}

function assertSendableWithoutScreen() {
	expect(opened).toEqual([]);
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(document.querySelector(".tsp-screen")).toBeNull();
	expect(element.textContent).not.toContain("Put away the side question to send a message.");
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(false);
}

it("puts away once through the shared keyboard and menu toggle command", async () => {
	await openForClosing();
	await act(async () => { getCommand("view.panel")!.run({ session: controller, projectPath: "/tmp/fixture" }); });
	expect(closeRequests).toHaveLength(1);
	expect(currentDock(useApp.getState()).open).toBe(false);
	assertSendableWithoutScreen();
});

it("puts away once before switching the side panel to another pane", async () => {
	await openForClosing();
	await act(async () => useApp.getState().showPane("tasks", tabId));
	expect(closeRequests).toHaveLength(1);
	expect(currentDock(useApp.getState()).pane).toBe("tasks");
	assertSendableWithoutScreen();
});

it.each(["panel X", "toggle", "switch"])("keeps the pane visible with omp's error after a failed %s put-away", async action => {
	await openForClosing();
	closeFailure = "The fixture refused to put away the side question.";
	await act(async () => {
		if (action === "panel X") element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click();
		else if (action === "toggle") getCommand("view.panel")!.run({ session: controller, projectPath: "/tmp/fixture" });
		else useApp.getState().showPane("tasks", tabId);
	});
	expect(closeRequests).toHaveLength(1);
	expect(currentDock(useApp.getState())).toMatchObject({ open: true, pane: "btw" });
	expect(element.querySelector("aside [role=alert]")?.textContent).toBe(closeFailure);
	expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
});

it.each(["chat Done", "pane Done"])("resumes the chat once through %s and preserves History", async action => {
	await openForClosing();
	const history = structuredClone(state.topics);
	const column = element.querySelector("[data-chat-column]")!;
	expect(column.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(true);
	expect(column.querySelector("[data-chat-content]")?.getAttribute("aria-hidden")).toBe("true");
	expect(column.querySelector("[data-btw-paused] [role=status]")?.textContent).toBe("Main chat is paused");
	expect(element.textContent).not.toContain("Put away");
	const scope = action === "chat Done" ? column : element.querySelector("aside")!;
	const done = [...scope.querySelectorAll("button")].find(button => button.textContent?.trim() === "Done")!;
	expect(done.disabled).toBe(false);
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => { done.click(); done.click(); });
	expect(closeRequests).toHaveLength(1);
	expect(column.querySelector("[data-btw-paused]")).not.toBeNull();
	await act(async () => pending.resolve());
	expect(state.topics).toEqual(history);
	expect(element.querySelector("aside")?.textContent).toContain(`History (${history.length})`);
	expect(column.querySelector("[data-btw-paused]")).toBeNull();
	expect(column.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(false);
	assertSendableWithoutScreen();
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(column.querySelector("textarea"))); });
});

it("keeps the paused layer and error when Done fails", async () => {
	await openForClosing();
	closeFailure = "The fixture refused to finish.";
	const done = [...element.querySelectorAll("[data-btw-paused] button")].find(button => button.textContent?.trim() === "Done") as HTMLButtonElement;
	await act(async () => done.click());
	expect(closeRequests).toHaveLength(1);
	expect(element.querySelector("[data-btw-paused] [role=alert]")?.textContent).toBe(closeFailure);
	expect(element.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(true);
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
});

it("pauses only the blocked chat in a split and leaves the other column interactive", async () => {
	showOtherChat = true;
	await openForClosing();
	const blocked = element.querySelector('section[aria-label="Fixture chat"]')!;
	const other = element.querySelector('section[aria-label="Other chat"]')!;
	expect(blocked.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(true);
	expect(other.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(false);
	expect(other.querySelector("[data-btw-paused]")).toBeNull();
	expect(blocked.querySelector("[data-btw-paused]")?.closest("[data-chat-column]")).toBe(blocked.querySelector("[data-chat-column]"));
	other.querySelector<HTMLButtonElement>("[data-transcript-action]")!.focus();
	expect(document.activeElement).toBe(other.querySelector("[data-transcript-action]"));
	await act(async () => { view = { ...view, host: { ...view.host!, tspAvailability: { available: false, reason: "Open menu" } } }; for (const listener of viewUpdates) listener(); });
	expect(blocked.querySelector("[data-btw-paused]")).toBeNull();
	expect(blocked.querySelector("[data-chat-content]")?.hasAttribute("inert")).toBe(false);
});

it("keeps the first-frame presentation claimed when put-away fails before history arrives", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	separateDeliveries = true;
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	expect(element.querySelector("section[aria-busy=true]")).not.toBeNull();
	closeFailure = "The fixture refused to put away the pending history.";
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
	expect(closeRequests).toHaveLength(1);
	expect(currentDock(useApp.getState())).toMatchObject({ open: true, pane: "btw" });
	expect(element.querySelector("section[aria-busy=true]")).not.toBeNull();
	expect(element.querySelector("aside [role=alert]")?.textContent).toBe(closeFailure);
	expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
});

it("deduplicates double X while omp's close is pending", async () => {
	await openForClosing();
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => {
		element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click();
		element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click();
	});
	expect(closeRequests).toHaveLength(1);
	await act(async () => pending.resolve());
	expect(currentDock(useApp.getState()).open).toBe(false);
	assertSendableWithoutScreen();
});

it("does not apply an old close after Side questions is reopened", async () => {
	await openForClosing();
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
	await act(async () => useApp.getState().showPane("btw", tabId));
	await act(async () => pending.resolve());
	expect(closeRequests).toHaveLength(1);
	expect(currentDock(useApp.getState())).toMatchObject({ open: true, pane: "btw" });
	assertSendableWithoutScreen();
});

it("retains its presentation after close resolves until the closing document arrives", async () => {
	await openForClosing();
	separateCloseDocument = true;
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
	expect(closeRequests).toHaveLength(1);
	expect(currentDock(useApp.getState()).open).toBe(true);
	expect(opened).toEqual([]);
	expect(element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled).toBe(true);
	await act(async () => deliverCloseDocument!());
	expect(currentDock(useApp.getState()).open).toBe(false);
	assertSendableWithoutScreen();
});

it.each(["history read", "native close", "closing document"])("expires the entire put-away during a stalled %s without applying a late close", async stall => {
	await BtwContent.preload();
	await openForClosing();
	const pending = Promise.withResolvers<void>();
	if (stall === "history read") readGate = pending.promise;
	else if (stall === "native close") closeGate = pending.promise;
	else separateCloseDocument = true;
	vi.useFakeTimers();
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
	await act(async () => { await vi.advanceTimersByTimeAsync(8001); });
	expect(currentDock(useApp.getState())).toMatchObject({ open: true, pane: "btw" });
	expect(element.querySelector("aside [role=alert]")?.textContent).toBe("omp did not close the side-question history.");
	expect(opened).toEqual([]);
	const before = closeRequests.length;
	if (stall !== "closing document") {
		await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
		expect(closeRequests).toHaveLength(before);
	}
	await act(async () => {
		if (stall === "closing document") deliverCloseDocument!();
		else pending.resolve();
	});
	expect(currentDock(useApp.getState())).toMatchObject({ open: true, pane: "btw" });
	expect(opened).toEqual([]);
	if (stall === "history read") expect(closeRequests).toHaveLength(0);
	else expect(closeRequests).toHaveLength(1);
	vi.useRealTimers();
});

it("keeps one native close through a narrow real Shell remount", async () => {
	realShell = true;
	await openForClosing();
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Close side panel"]')!.click());
	expect(closeRequests).toHaveLength(1);
	await act(async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
		window.dispatchEvent(new Event("resize"));
	});
	expect(element.querySelector("[data-dock-expanded]")?.textContent).toContain("Side questions");
	await act(async () => element.querySelector<HTMLButtonElement>('[data-dock-expanded] button[aria-label="Close side panel"]')!.click());
	expect(closeRequests).toHaveLength(1);
	await act(async () => pending.resolve());
	expect(currentDock(useApp.getState()).open).toBe(false);
	assertSendableWithoutScreen();
});

it("returns from narrow-pane Done to that chat's composer with keyboard focus", async () => {
	realShell = true;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
	await openForClosing();
	const expanded = element.querySelector("[data-dock-expanded]")!;
	expect(expanded).not.toBeNull();
	const done = [...expanded.querySelectorAll("button")].find(button => button.textContent?.trim() === "Done")!;
	done.focus();
	await act(async () => done.click());
	expect(closeRequests).toHaveLength(1);
	expect(element.querySelector("[data-dock-expanded]")).toBeNull();
	expect(useApp.getState().chatOverDock).toBe(true);
	const composer = element.querySelector<HTMLTextAreaElement>('section[aria-label="Fixture chat"] textarea')!;
	await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(composer)); });
	expect(composer.closest("[inert]")).toBeNull();
	expect(state.topics).toHaveLength(1);
	assertSendableWithoutScreen();
});

it("does not restore a disposed tab's panel after its native close completes", async () => {
	await openForClosing();
	const pending = Promise.withResolvers<void>(); closeGate = pending.promise;
	await act(async () => useApp.getState().toggleDock(false, tabId));
	await act(async () => { await useApp.getState().closeTab(tabId); });
	await act(async () => pending.resolve());
	expect(useApp.getState().tabs.some(tab => tab.id === tabId)).toBe(false);
	expect(useApp.getState().docks[tabId]).toBeUndefined();
	expect(opened).toEqual([]);
});

it("releases the claim immediately for an unsupported document layout", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	const surface = snapshot.surfaces[0]!;
	const body = [...walkNodes(surface.document)].find(node => node.p?.role === "omp.btw.body")!;
	await act(async () => {
		const projection = receive({ verb: "f", body: { sf: surface.open.id, s: surface.sequence + 1, ops: [["set", body.id, { role: "extension.btw.layout" }]] } });
		expect(projection?.supported).toBe(false);
		for (const listener of hostUpdates) listener(snapshot);
	});
	expect(opened).toEqual([tabId]);
	expect(useApp.getState().terminalTabId).toBe(tabId);
	expect(document.querySelector(".tsp-screen")?.textContent).toContain("What is the first fixture side question?");
});
