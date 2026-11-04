// @vitest-environment happy-dom
import { act, type ComponentType, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BtwState } from "@shared/contracts/btw";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { projectBtw } from "@shared/tsp/btw";
import { SessionController, type SessionView } from "../../state/session";
import { controllerFor, currentDock, useApp } from "../../state/app";
import { TooltipProvider } from "../../ui/Tooltip";
import { BtwDrawerContent, BtwDrawer, BtwPane } from "./BtwPane";
import { OverlayWatcher } from "../palette/OverlayWatcher";
import { autoOpened, TerminalSheetHost } from "../palette/TerminalSheet";
import { currentPresentationConsumers, PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import type * as LazyModule from "../../registry/lazy";
import "../../i18n";

vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../../registry/lazy", async importOriginal => {
	const original = await importOriginal<typeof LazyModule>();
	const { OmpScreenSheet } = await vi.importActual<typeof OmpScreenModule>("../tsp/OmpScreenSheet");
	return { ...original, lazyView: (load: () => Promise<ComponentType<object>>, fallback: ComponentType<object> | null) =>
		load.toString().includes("OmpScreenSheet") ? OmpScreenSheet : original.lazyView(load, fallback) };
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
let documents: FixtureDocuments;
const hostUpdates = new Set<(patch: TspHostPatch) => void>();
const btwUpdates = new Set<(state: BtwState) => void>();
const originalVomp = window.vomp;

function Harness() {
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		createElement("div", { "data-chat-column": true }, createElement(BtwDrawer, { session: controller })),
		createElement(OverlayWatcher), createElement(TerminalSheetHost)));
}
function publish() {
	snapshot = { ...snapshot, revision: ++revision };
	state = { ...state, revision };
	for (const listener of hostUpdates) listener(tspHostPatch(null, snapshot));
	for (const listener of btwUpdates) listener(state);
}
beforeEach(async () => {
	await BtwDrawerContent.preload();
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	hostUpdates.clear(); btwUpdates.clear(); opened = []; revision = 1; autoOpened.tabId = null;
	documents = new FixtureDocuments();
	for (const message of loadFixtureRecording("btw-history").messages) {
		documents.receive({ ...message, body: JSON.stringify(message.body) });
		if (projectBtw(documents.snapshot().surfaces)) break;
	}
	const protocol = documents.snapshot();
	const projection = projectBtw(protocol.surfaces)!;
	expect(projection.turns).toEqual([]);
	expect(projection.supported).toBe(true);
	snapshot = { ...protocol, hostId: "empty-btw", generation: 1, revision, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: false, reason: "Finish the side question to send a message.", reasonCode: "btw" }, questionMatches: [],
		surfaces: protocol.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
	state = { hostId: "empty-btw", generation: 1, epoch: protocol.epoch, revision, topics: [], overlay: {
		epoch: protocol.epoch, surfaceId: projection.surfaceId, nodeId: projection.nodeId, selectedTopic: null, topics: [],
		actions: Object.keys(projection.actions), followUp: false, draft: null, supported: true, notice: null,
	} };
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin",
		invoke: async (channel: string) => {
			if (channel === "host:tsp-snapshot") return snapshot;
			if (channel === "btw:list") return state;
			if (channel === "btw:close") {
				const node = state.overlay!.nodeId;
				const close = loadFixtureRecording("btw-history").messages.find(message => {
					const body = message.body;
					return message.verb === "f" && body && typeof body === "object" && "ops" in body && Array.isArray(body.ops)
						&& body.ops.some(op => Array.isArray(op) && op[0] === "del" && op[1] === node);
				})!;
				documents.receive({ ...close, body: JSON.stringify(close.body) });
				snapshot = { ...snapshot, surfaces: documents.snapshot().surfaces.map(surface => ({ ...surface, documentGeneration: 1 })), availability: { available: true, reason: null } };
				state = { ...state, overlay: null };
				publish();
			}
		},
		on: (channel: string, listener: (payload: unknown) => void) => {
			if (channel === "host:tsp-patch") hostUpdates.add(listener);
			if (channel === "btw:changed") btwUpdates.add(listener);
			return () => { hostUpdates.delete(listener); btwUpdates.delete(listener); };
		},
	} });
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, docks: {}, btwDrawers: {}, view: "chat" });
	tabId = (await useApp.getState().newChat("/tmp/fixture"))!;
	controller = controllerFor(tabId)!;
	const view = { ...controller.getSnapshot(), mode: "live", readOnly: false, host: { hostId: "empty-btw", transport: "tsp", generation: 1, tspEpoch: 1, phase: "live", cols: 110, rows: 32 } } as unknown as SessionView;
	vi.spyOn(controller, "getSnapshot").mockReturnValue(view);
	stopApp = useApp.subscribe((next, previous) => { if (next.terminalTabId && next.terminalTabId !== previous.terminalTabId) opened.push(next.terminalTabId); });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); stopApp(); await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null, sheet: null }); autoOpened.tabId = null;
	element.remove(); window.vomp = originalVomp; vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("owns recorded empty BTW in the drawer without opening the side panel", async () => {
	await act(async () => root.render(createElement(Harness)));
	for (let update = 0; update < 3; update++) await act(async () => publish());
	const target = { hostId: "empty-btw", epoch: 1, surfaceId: state.overlay!.surfaceId, nodeId: state.overlay!.nodeId };
	const native = element.querySelector<HTMLElement>('[data-btw-drawer][role="dialog"][aria-label="Side question"]')!;
	expect(native).not.toBeNull();
	expect(native.textContent).toContain("No side questions yet");
	expect(native.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
	const done = [...native.querySelectorAll("button")].filter(button => button.textContent?.trim() === "Done");
	expect(done).toHaveLength(1);
	expect(done[0]!.disabled).toBe(false);
	expect(presentationClaims.getSnapshot()).toContainEqual(target);
	expect(currentPresentationConsumers("empty-btw", 1).get(target.surfaceId)?.has(target.nodeId)).toBe(true);
	expect(currentDock(useApp.getState()).open).toBe(false);
	expect(useApp.getState().terminalTabId).toBeNull(); expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
	await act(async () => done[0]!.click());
	expect(element.querySelector("[data-btw-drawer]")).toBeNull();
	expect(presentationClaims.getSnapshot()).toEqual([]);
	expect(currentPresentationConsumers("empty-btw", 1).size).toBe(0);
	expect(currentDock(useApp.getState()).open).toBe(false);
	expect(useApp.getState().terminalTabId).toBeNull(); expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
});

it("keeps the active empty drawer claimed when a saved helper question exists", async () => {
	state = { ...state, topics: [{ id: "saved-helper", scope: "helper", title: "A saved helper question", live: false, turns: [{ question: "A saved helper question", answer: "The saved helper answer", status: "complete", createdAt: 1 }] }] };
	await act(async () => root.render(createElement(Harness)));
	expect(element.querySelector("[data-btw-drawer]")?.textContent).toContain("No side questions yet");
	expect(presentationClaims.getSnapshot()).toHaveLength(1);
	expect(currentPresentationConsumers("empty-btw", 1).size).toBe(1);
	expect(useApp.getState().terminalTabId).toBeNull(); expect(opened).toEqual([]);
	expect(document.querySelector(".tsp-screen")).toBeNull();
});

it("keeps the history pane browse-only and leaves active presentation ownership to the drawer", async () => {
	state = { ...state, overlay: null, topics: [{ id: "saved-helper", scope: "helper", title: "A saved helper question", live: false, turns: [{ question: "A saved helper question", answer: "The saved helper answer", status: "complete", createdAt: 1 }] }] };
	useApp.getState().showPane("btw", tabId);
	await act(async () => root.render(createElement(TooltipProvider, null,
		createElement(PresentationVisibility, { visible: true }, createElement(BtwPane, { session: controller, projectPath: "/tmp/fixture" })))));
	expect(element.textContent).toContain("The saved helper answer");
	expect(element.querySelector("textarea")).toBeNull();
	const labels = [...element.querySelectorAll("button")].map(button => button.textContent?.trim());
	expect(labels).toContain("Copy answers");
	for (const label of ["Done", "Follow up", "Ask question", "New question", "Open history", "Inject into main", "Stop side answer"]) expect(labels).not.toContain(label);
	expect(presentationClaims.getSnapshot()).toEqual([]);
});
