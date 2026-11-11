// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { hookDialogTarget } from "@shared/tsp/dialogs";
import { hookQuestions } from "@shared/tsp/hook-questions";
import { planReview } from "@shared/tsp/plan-review";
import { openOverlay } from "@shared/tsp/view-state";
import { ChatArea } from "../../chat/ChatArea";
import { chatSlots } from "../../registry/slots";
import { controllerFor, useApp } from "../../state/app";
import { SessionController, type SessionView } from "../../state/session";
import { presentationClaims } from "../../state/tsp/presentation-claims";
import { TooltipProvider } from "../../ui/Tooltip";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import { OverlayWatcher } from "./OverlayWatcher";
import { autoOpened, TerminalSheetHost } from "./TerminalSheet";
import "../session-tools";
import "../../i18n";

const loads = vi.hoisted(() => {
	// Feature registration subscribes to provider changes before the fixture's live host is attached.
	Object.defineProperty(window, "vomp", { configurable: true, value: {
		platform: "darwin", on: () => () => {}, invoke: async () => undefined,
	} });
	return { dialog: Promise.withResolvers<void>(), plan: Promise.withResolvers<void>() };
});
// Hold only the imports. Registration, lazyView, its Suspense fallback and both loaded cards are production code.
vi.mock("../session-tools/OmpDialogCard", async importOriginal => {
	await loads.dialog.promise;
	return importOriginal();
});
vi.mock("../session-tools/PlanReviewCard", async importOriginal => {
	await loads.plan.promise;
	return importOriginal();
});
vi.mock("../../chat/ChatView", () => ({
	// Reduce the transcript to the production registered slots, without bypassing their lazy boundaries.
	ChatView: ({ session }: { session: SessionController }) => createElement(Fragment, null,
		...chatSlots.use().filter(slot => slot.placement === "transcriptEnd").map(slot => createElement(slot.component, { key: slot.id, session }))),
}));
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children,
		motion: { div: tag("div"), section: tag("section"), span: tag("span"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});

let root: Root;
let element: HTMLDivElement;
let focusTarget: HTMLButtonElement;
let tabId: string;
let snapshot: TspHostSnapshot;
let revision = 0;
let invoke: Mock;
let updates: Set<(patch: TspHostPatch) => void>;
let opened: string[];
let stopApp: () => void;

function Harness() {
	return createElement(TooltipProvider, null, createElement(Fragment, null,
		createElement(ChatArea), createElement(OverlayWatcher), createElement(TerminalSheetHost)));
}
function recordedDocument(name: string) {
	const recording = loadFixtureRecording(name);
	const boundary = recording.inputs.find(input => "keys" in input || ["activate", "edit", "action"].includes(input.body.ev))!.afterMessage!;
	const documents = new FixtureDocuments();
	for (const message of recording.messages.slice(0, boundary)) documents.receive({ ...message, body: JSON.stringify(message.body) });
	const state = documents.snapshot();
	snapshot = { ...state, hostId: "cold-native-fixture", generation: 1, revision: ++revision, lifecycle: "live", documentGeneration: 1,
		availability: { available: false, reason: "Fixture replay" }, failure: null,
		questionMatches: hookQuestions(state.surfaces, 1).map(hook => ({ surfaceId: hook.surfaceId, nodeId: hook.nodeId, status: "unmatched" })),
		surfaces: state.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
}
function expectSingleOwner(surfaceId: string, nodeId: string) {
	expect(presentationClaims.getSnapshot()).toEqual([{ hostId: snapshot.hostId, epoch: snapshot.epoch, surfaceId, nodeId }]);
	expect(openOverlay(snapshot.surfaces, false, new Map([[surfaceId, new Set([nodeId])]]))).toBeNull();
}
function expectNoSheetOrAnswer() {
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(autoOpened.tabId).toBeNull();
	expect(opened).toEqual([]);
	expect(document.querySelector('[role="dialog"], [role="region"][aria-label="omp screen"]')).toBeNull();
	expect(invoke.mock.calls.filter(([channel]) => ["host:tsp-answer", "host:tsp-event", "host:keys"].includes(String(channel)))).toEqual([]);
	expect(document.activeElement).toBe(focusTarget);
}

beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	updates = new Set(); opened = []; autoOpened.tabId = null;
	invoke = vi.fn(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke,
		on: (channel: string, listener: (patch: TspHostPatch) => void) => {
			if (channel === "host:tsp-patch") updates.add(listener);
			return () => updates.delete(listener);
		} } });
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, view: "chat" });
	tabId = (await useApp.getState().newChat("/tmp/cold-native-fixture"))!;
	const session = controllerFor(tabId)!;
	const view = { ...session.getSnapshot(), mode: "live", host: { hostId: "cold-native-fixture", transport: "tsp", generation: 1,
		phase: "live", cols: 110, rows: 32, tui: { overlays: 0, focused: "editor", overlayKinds: [] } } } as unknown as SessionView;
	vi.spyOn(session, "getSnapshot").mockReturnValue(view);
	stopApp = useApp.subscribe((state, previous) => { if (state.terminalTabId && state.terminalTabId !== previous.terminalTabId) opened.push(state.terminalTabId); });
	focusTarget = document.createElement("button"); focusTarget.textContent = "Keep draft focus";
	element = document.createElement("div"); document.body.append(focusTarget, element); root = createRoot(element);
	focusTarget.focus();
});
afterEach(async () => {
	// Resolve both import gates even if an assertion fails, so no deferred module remains pending.
	loads.dialog.resolve(); loads.plan.resolve();
	await act(async () => { await Promise.all([import("../session-tools/OmpDialogCard"), import("../session-tools/PlanReviewCard")]); root.unmount(); });
	stopApp(); await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null, sheet: null }); autoOpened.tabId = null;
	element.remove(); focusTarget.remove(); Reflect.deleteProperty(window, "vomp"); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it("keeps existing recorded dialogs and plans readable through each cold production slot import without opening or trapping focus in a sheet", async () => {
	// Each recording is already present before its first mount. Both imports start pending through the real slots.
	for (const kind of ["dialog", "plan"] as const) {
		recordedDocument(kind === "dialog" ? "hook-confirm" : "plan-review-execute");
		const hook = hookDialogTarget(snapshot.surfaces);
		const plan = planReview(snapshot.surfaces);
		const surfaceId = kind === "dialog" ? hook!.surface.open.id : plan!.sf;
		const nodeId = kind === "dialog" ? hook!.node.id : plan!.id;
		const title = kind === "dialog" ? hook!.dialog.title : plan!.title;
		const label = kind === "dialog" ? "Question from omp" : "Plan ready for review";
		await act(async () => root.render(createElement(Harness)));
		const pending = element.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
		expect(pending).not.toBeNull();
		expect(pending.getAttribute("aria-busy")).toBe("true");
		expect(pending.querySelector("h3")?.textContent).toBe(title);
		const labels = kind === "dialog" && hook!.dialog.body.kind === "select" ? hook!.dialog.body.options.map(option => option.label) : plan!.options.map(option => option.label);
		for (const option of labels) expect(pending.textContent).toContain(option);
		if (kind === "plan") expect(pending.textContent).toContain(plan!.body);
		expect(pending.querySelector("button,input,textarea,[role=option],[role=radio]")).toBeNull();
		expectSingleOwner(surfaceId, nodeId);
		expectNoSheetOrAnswer();
		// Exercise a new recorded-snapshot delivery while the import remains unresolved.
		await act(async () => { snapshot = { ...snapshot, revision: ++revision }; for (const listener of updates) listener(tspHostPatch(null, snapshot)); });
		expectSingleOwner(surfaceId, nodeId);
		expectNoSheetOrAnswer();
		await act(async () => {
			loads[kind].resolve();
			if (kind === "dialog") await import("../session-tools/OmpDialogCard");
			else await import("../session-tools/PlanReviewCard");
		});
		const cards = element.querySelectorAll<HTMLElement>(`section[aria-label="${label}"]`);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.getAttribute("aria-busy")).not.toBe("true");
		expect(cards[0]!.textContent).toContain(title);
		expect([...cards[0]!.querySelectorAll("button")].some(button => button.textContent === (kind === "dialog" ? "Yes" : "Approve and run") && !button.disabled)).toBe(true);
		expectSingleOwner(surfaceId, nodeId);
		expectNoSheetOrAnswer();
		// Focus remains usable outside the sheet after Suspense replaces its fallback.
		focusTarget.focus(); expect(document.activeElement?.isConnected).toBe(true); expect(document.activeElement).toBe(focusTarget);
		await act(async () => root.render(null));
		expect(presentationClaims.getSnapshot()).toEqual([]);
	}
});
