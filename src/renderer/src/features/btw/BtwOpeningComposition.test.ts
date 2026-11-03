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
import "../panes";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../../registry/idle", () => ({ preloadWhenIdle: () => {} }));
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
let snapshot: TspHostSnapshot;
let state: BtwState;
let opened: string[];
let stopApp: () => void;
let revision: number;
let documents: FixtureDocuments;
let messages: FixtureMessage[];
let cursor: number;
let separateDeliveries = false;
const hostUpdates = new Set<(snapshot: TspHostSnapshot) => void>();
const btwUpdates = new Set<(state: BtwState) => void>();
const originalVomp = window.vomp;

function Harness() {
	const visible = useDockVisible();
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		visible && createElement(PresentationVisibility, { visible }, createElement(Dock, { chatKey: tabId, width: 440 })),
		createElement(OverlayWatcher), createElement(TerminalSheetHost)));
}
function receive(message: FixtureMessage = messages[cursor++]!) {
	documents.receive({ ...message, body: JSON.stringify(message.body) });
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces);
	const selectedTopic = projection?.turns.length ? { id: "live:1" } : null;
	snapshot = { ...protocol, hostId: "opening-btw", generation: 1, revision: ++revision, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: !projection, reason: projection ? "Put away the side question to send a message." : null }, questionMatches: [], surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	state = { hostId: "opening-btw", generation: 1, epoch: protocol.epoch, revision,
		topics: mergeBtwTopics([], projection, { id: "live:1" }), overlay: projection ? {
			epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic,
			topics: btwOverlayTopics(projection, [], selectedTopic), actions: Object.keys(projection.actions),
			followUp: !!projection.field, draft: projection.field?.text ?? null, supported: projection.supported, notice: projection.notice,
		} : null };
	return projection;
}
function publish() {
	for (const listener of hostUpdates) listener(snapshot);
	for (const listener of btwUpdates) listener(state);
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	separateDeliveries = false;
	hostUpdates.clear(); btwUpdates.clear(); opened = []; revision = 0; cursor = 0; autoOpened.tabId = null;
	documents = new FixtureDocuments();
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin",
		invoke: async (channel: string) => {
			if (channel === "app:info") return { homeDir: "/tmp", defaultChatFolder: "/tmp" };
			if (channel === "host:tsp-snapshot") return snapshot;
			if (channel === "btw:list") return state;
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
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, docks: {}, view: "chat" });
	tabId = (await useApp.getState().newChat("/tmp/fixture"))!;
	controller = controllerFor(tabId)!;
	const view = { ...controller.getSnapshot(), mode: "live", readOnly: false, host: { hostId: "opening-btw", transport: "tsp", generation: 1, tspEpoch: 1, phase: "live", cols: 110, rows: 32 } } as unknown as SessionView;
	vi.spyOn(controller, "getSnapshot").mockReturnValue(view);
	stopApp = useApp.subscribe((next, previous) => {
		if (next.terminalTabId && next.terminalTabId !== previous.terminalTabId) opened.push(next.terminalTabId);
		if (next.sheet && next.sheet !== previous.sheet) opened.push(`sheet:${next.sheet.id}`);
	});
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
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

it("keeps the generic screen available when the native pane is closed", async () => {
	messages = loadFixtureRecording("btw-ask").messages;
	while (cursor < 4) receive();
	await act(async () => root.render(createElement(Harness)));
	await act(async () => { await routeSlash(controller, "/btw What is the first fixture side question?"); });
	await act(async () => useApp.getState().toggleDock(false, tabId));
	expect(opened).toEqual([tabId]);
	expect(useApp.getState().terminalTabId).toBe(tabId);
	expect(document.querySelector(".tsp-screen")?.textContent).toContain("What is the first fixture side question?");
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
