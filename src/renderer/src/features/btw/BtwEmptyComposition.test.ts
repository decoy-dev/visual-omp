// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BtwState } from "@shared/contracts/btw";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { projectBtw } from "@shared/tsp/btw";
import { SessionController, type SessionView } from "../../state/session";
import { controllerFor, useApp, useDockVisible } from "../../state/app";
import { TooltipProvider } from "../../ui/Tooltip";
import { BtwPane } from "./BtwPane";
import { OverlayWatcher } from "../palette/OverlayWatcher";
import { autoOpened, TerminalSheetHost } from "../palette/TerminalSheet";
import { currentPresentationConsumers, PresentationVisibility, presentationClaims } from "../tsp/presentation-claims";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../../registry/lazy", async () => {
	// Replace only the chunk boundary; the generic semantic screen stays production code.
	const { OmpScreenSheet } = await vi.importActual<typeof OmpScreenModule>("../tsp/OmpScreenSheet");
	let count = 0;
	return { lazyView: () => ++count === 1 ? () => null : OmpScreenSheet };
});
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
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
const hostUpdates = new Set<(snapshot: TspHostSnapshot) => void>();
const btwUpdates = new Set<(state: BtwState) => void>();
const originalVomp = window.vomp;

function Harness() {
	const visible = useDockVisible();
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		createElement("div", { hidden: !visible, "data-native-btw": true }, createElement(PresentationVisibility, { visible }, createElement(BtwPane, { session: controller, projectPath: "/tmp/fixture" }))),
		createElement(OverlayWatcher), createElement(TerminalSheetHost)));
}
function publish() {
	snapshot = { ...snapshot, revision: ++revision };
	state = { ...state, revision };
	for (const listener of hostUpdates) listener(snapshot);
	for (const listener of btwUpdates) listener(state);
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	hostUpdates.clear(); btwUpdates.clear(); opened = []; revision = 1; autoOpened.tabId = null;
	const documents = new FixtureDocuments();
	for (const message of loadFixtureRecording("btw-empty").messages) {
		documents.receive({ ...message, body: JSON.stringify(message.body) });
		if (projectBtw(documents.snapshot().surfaces)) break;
	}
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces)!;
	expect(projection.turns).toEqual([]);
	expect(projection.supported).toBe(true);
	snapshot = { ...protocol, hostId: "empty-btw", generation: 1, revision, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: false, reason: "Put away the side question to send a message.", reasonCode: "btw" }, questionMatches: [],
		surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	state = { hostId: "empty-btw", generation: 1, epoch: protocol.epoch, revision, topics: [], overlay: {
		epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic: null, topics: [],
		actions: Object.keys(projection.actions), followUp: false, draft: null, supported: true, notice: null,
	} };
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin",
		invoke: async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : channel === "btw:list" ? state : undefined,
		on: (channel: string, listener: (payload: unknown) => void) => {
			if (channel === "host:tsp-update") hostUpdates.add(listener);
			if (channel === "btw:changed") btwUpdates.add(listener);
			return () => { hostUpdates.delete(listener); btwUpdates.delete(listener); };
		},
	} });
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, view: "chat" });
	tabId = (await useApp.getState().newChat("/tmp/fixture"))!;
	controller = controllerFor(tabId)!;
	const view = { ...controller.getSnapshot(), mode: "live", readOnly: false, host: { hostId: "empty-btw", transport: "tsp", generation: 1, tspEpoch: 1, phase: "live", cols: 110, rows: 32 } } as unknown as SessionView;
	vi.spyOn(controller, "getSnapshot").mockReturnValue(view);
	useApp.getState().showPane("btw", tabId);
	stopApp = useApp.subscribe((next, previous) => { if (next.terminalTabId && next.terminalTabId !== previous.terminalTabId) opened.push(next.terminalTabId); });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); stopApp(); await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null, sheet: null }); autoOpened.tabId = null;
	element.remove(); window.vomp = originalVomp; vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("owns recorded empty BTW while visible and restores the generic screen when hidden", async () => {
	await act(async () => root.render(createElement(Harness)));
	for (let update = 0; update < 3; update++) await act(async () => publish());
	const target = { hostId: "empty-btw", epoch: 1, surfaceId: state.overlay!.surfaceId, nodeId: state.overlay!.nodeId };
	const native = element.querySelector<HTMLElement>("[data-native-btw]")!;
	expect(native.hidden).toBe(false);
	expect(native.textContent).toContain("No side questions yet");
	expect(native.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
	expect([...native.querySelectorAll("button")].find(button => button.textContent?.trim() === "Put away")?.disabled).toBe(false);
	expect(presentationClaims.getSnapshot()).toContainEqual(target);
	expect(currentPresentationConsumers("empty-btw", 1).get(target.surfaceId)?.has(target.nodeId)).toBe(true);
	expect(useApp.getState().terminalTabId).toBeNull(); expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
	await act(async () => useApp.getState().toggleDock(false, tabId));
	expect(native.hidden).toBe(true);
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(currentPresentationConsumers("empty-btw", 1).size).toBe(0);
	expect(useApp.getState().terminalTabId).toBe(tabId); expect(opened).toEqual([tabId]);
	expect(document.querySelector(".tsp-screen")?.textContent).toContain("No side questions yet");
	await act(async () => useApp.getState().toggleDock(true, tabId));
	expect(native.hidden).toBe(false);
	expect(useApp.getState().terminalTabId).toBeNull(); expect(autoOpened.tabId).toBeNull();
	expect(presentationClaims.getSnapshot()).toContainEqual(target);
	expect(native.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
});

it("leaves recorded empty BTW unclaimed while a different saved helper topic is displayed", async () => {
	state = { ...state, topics: [{ id: "saved-helper", scope: "helper", title: "A saved helper question", live: false, turns: [{ question: "A saved helper question", answer: "The saved helper answer", status: "complete", createdAt: 1 }] }] };
	await act(async () => root.render(createElement(Harness)));
	expect(element.querySelector("[data-native-btw]")?.textContent).toContain("The saved helper answer");
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(currentPresentationConsumers("empty-btw", 1).size).toBe(0);
	expect(useApp.getState().terminalTabId).toBe(tabId); expect(opened).toEqual([tabId]);
	expect(document.querySelector(".tsp-screen")?.textContent).toContain("No side questions yet");
});
