// @vitest-environment happy-dom
import { act, createElement, Fragment, type PropsWithChildren } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionController } from "../../state/session";
import type { SessionView } from "../../state/session";
import type { TspHostSnapshot, TspRendererEvent } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import type { TspHookAnswer } from "@shared/tsp/dialogs";
import { hookAnswerEvents, hookDialogTarget } from "@shared/tsp/dialogs";
import { hookQuestions } from "@shared/tsp/question-match";
import { walkNodes } from "@shared/tsp/view-state";
import type * as OmpScreenModule from "../tsp/OmpScreenSheet";
import { FixtureDocuments, loadFixtureRecording, type FixtureInput } from "../tsp/testing/documents";
import { ChatArea } from "../../chat/ChatArea";
import { OmpDialogCard } from "../session-tools/OmpDialogCard";
import { PlanReviewCard } from "../session-tools/PlanReviewCard";
import { planReview } from "@shared/tsp/plan-review";
import { controllerFor, useApp } from "../../state/app";
import { TooltipProvider } from "../../ui/Tooltip";
import { OverlayWatcher } from "./OverlayWatcher";
import { autoOpened, TerminalSheetHost } from "./TerminalSheet";
import { presentationClaims } from "../../state/tsp/presentation-claims";
import { screenActivity } from "../../state/tsp/screen-activity";
import { openRequestedScreen } from "../session-tools/drive";
import { TSP_ROLES } from "@shared/tsp/roles";
import type { TspNode } from "@shared/tsp";
import "../../i18n";

vi.mock("../../chat/ChatView", () => ({
	// The transcript is reduced to its native slot; ChatArea, controller registration, stores,
	// OverlayWatcher, native card, sheet and semantic fallback remain production components.
	ChatView: ({ session }: { session: SessionController }) => createElement(Fragment, null, createElement(OmpDialogCard, { session }), createElement(PlanReviewCard, { session })),
}));
vi.mock("../../registry/lazy", async () => {
	// Only the chunk boundary is replaced, using the production semantic renderer.
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
let snapshot: TspHostSnapshot;
let revision: number;
let invoke: ReturnType<typeof vi.fn>;
let updates: Set<(patch: TspHostPatch) => void>;
let opened: string[];
let stopApp: () => void;
let runtimeErrors: string[];
const recordError = (event: ErrorEvent) => runtimeErrors.push(event.message);
function Harness() {
	return createElement(TooltipProvider, null, createElement(Fragment, null, createElement(ChatArea), createElement(OverlayWatcher), createElement(TerminalSheetHost)));
}
function build(documents: FixtureDocuments): TspHostSnapshot {
	const state = documents.snapshot();
	return { ...state, hostId: "fixture", generation: 1, revision: ++revision, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: "Fixture replay" }, failure: null,
		questionMatches: hookQuestions(state.surfaces, 1).map(hook => ({ surfaceId: hook.surfaceId, nodeId: hook.nodeId, status: "unmatched" })),
		surfaces: state.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
}
function publish(documents: FixtureDocuments) {
	snapshot = build(documents);
	for (const listener of updates) listener(tspHostPatch(null, snapshot));
}
beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
	updates = new Set(); opened = []; runtimeErrors = []; revision = 0; autoOpened.tabId = null;
	window.addEventListener("error", recordError);
	invoke = vi.fn(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke, on: (channel: string, listener: (patch: TspHostPatch) => void) => {
		if (channel === "host:tsp-patch") updates.add(listener);
		return () => updates.delete(listener);
	} } });
	// No omp process or network client is launched. The real controller/store receive recorded host facts.
	vi.spyOn(SessionController.prototype, "ensureLive").mockResolvedValue(undefined);
	useApp.setState({ terminalTabId: null, sheet: null, tabs: [], activeTabId: null, splitTabId: null, view: "chat" });
	tabId = (await useApp.getState().newChat("/tmp/fixture"))!;
	const session = controllerFor(tabId)!;
	const view = { ...session.getSnapshot(), mode: "live", host: { hostId: "fixture", transport: "tsp", generation: 1, phase: "live", cols: 110, rows: 32, tui: { overlays: 0, focused: "editor", overlayKinds: [] } } } as unknown as SessionView;
	vi.spyOn(session, "getSnapshot").mockReturnValue(view);
	stopApp = useApp.subscribe((state, previous) => { if (state.terminalTabId && state.terminalTabId !== previous.terminalTabId) opened.push(state.terminalTabId); });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); stopApp(); await useApp.getState().closeTab(tabId);
	useApp.setState({ terminalTabId: null, sheet: null }); autoOpened.tabId = null;
	element.remove(); window.removeEventListener("error", recordError); Reflect.deleteProperty(window, "vomp"); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
it.each(["hook-input", "hook-confirm", "hook-editor", "extension-rows", "plan-review-execute"])("keeps the real chat/card/watcher/sheet composition stable and answers recorded %s", async name => {
	const recording = loadFixtureRecording(name);
	const application = recording.inputs.filter(input => "keys" in input || ["activate", "edit", "action"].includes(input.body.ev));
	const finalEdit = application.findLastIndex(input => "body" in input && input.body.ev === "edit");
	const expected: FixtureInput[] = finalEdit >= 0 ? application.slice(finalEdit) : application;
	const boundary = expected[0]!.afterMessage!;
	const documents = new FixtureDocuments();
	let cursor = 0;
	const hasDialog = () => !!hookDialogTarget(documents.snapshot().surfaces) || !!planReview(documents.snapshot().surfaces) || documents.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(node => node.k === "rows"));
	while (cursor < boundary) {
		snapshot = build(documents);
		const message = recording.messages[cursor++]!;
		documents.receive({ ...message, body: JSON.stringify(message.body) });
		if (hasDialog()) break;
	}
	await act(async () => root.render(createElement(Harness)));
	expect(useApp.getState().terminalTabId).toBeNull();
	while (cursor < boundary) { const message = recording.messages[cursor++]!; documents.receive({ ...message, body: JSON.stringify(message.body) }); }
	await act(async () => publish(documents));
	for (let update = 0; update < 3; update++) await act(async () => publish(documents));
	expect(runtimeErrors).toEqual([]);
	if (name === "extension-rows") {
		expect(useApp.getState().terminalTabId).toBeNull();
		expect(opened).toEqual([]);
		let release = () => {};
		await act(async () => { release = screenActivity.hold(snapshot, "request"); });
		await act(async () => { release(); });
		expect(useApp.getState().terminalTabId).toBe(tabId); expect(opened).toEqual([tabId]); expect(presentationClaims.getSnapshot()).toHaveLength(0);
	} else {
		expect(element.querySelector(`section[aria-label="${name.startsWith("plan-") ? "Plan ready for review" : "Question from omp"}"]`)).not.toBeNull();
		expect(useApp.getState().terminalTabId).toBeNull(); expect(opened).toEqual([]); expect(presentationClaims.getSnapshot()).toHaveLength(1);
	}
	const emitted: (TspRendererEvent | { keys: string })[] = [];
	invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "host:tsp-snapshot") return snapshot;
		if (channel === "host:tsp-answer") {
			const target = hookDialogTarget(snapshot.surfaces)!;
			emitted.push(...hookAnswerEvents(target.node, args[2] as TspHookAnswer));
		} else if (channel === "host:tsp-event") emitted.push(args[2] as TspRendererEvent);
		else if (channel === "host:keys") emitted.push({ keys: String(args[1]) });
		else return;
		while (cursor < recording.messages.length) { const message = recording.messages[cursor++]!; if (message.verb !== "x") documents.receive({ ...message, body: JSON.stringify(message.body) }); }
		publish(documents);
	});
	const first = expected[0]!;
	if ("keys" in first) {
		const rows = document.querySelector<HTMLElement>(".tsp-screen pre")!; expect(rows.textContent).toContain("Fixture custom rows");
		await act(async () => rows.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })));
	} else if (first.body.ev === "activate") {
		await act(async () => [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === (name.startsWith("plan-") ? "Approve and run" : "Yes"))!.click());
	} else if (first.body.ev === "edit") {
		const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
		const text = first.body.text;
		await act(async () => { Object.getOwnPropertyDescriptor(field.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
		await act(async () => [...element.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Send answer")!.click());
	}
	expect(emitted).toEqual(expected.map(input => "keys" in input ? { keys: input.keys } : input.body));
	expect(runtimeErrors).toEqual([]); expect(useApp.getState().terminalTabId).toBeNull(); expect(presentationClaims.getSnapshot()).toHaveLength(0);
});

function recordedUntil(name: string, ready: (node: TspNode) => boolean): FixtureDocuments {
	const documents = new FixtureDocuments();
	for (const message of loadFixtureRecording(name).messages) {
		documents.receive({ ...message, body: JSON.stringify(message.body) });
		if (documents.snapshot().surfaces.some(surface => [...walkNodes(surface.document)].some(ready))) return documents;
	}
	throw new Error(`Missing recorded native state: ${name}`);
}
function replaceNativeDocument(documents: FixtureDocuments): void {
	const previous = snapshot;
	const next = build(documents);
	snapshot = { ...next, surfaces: next.surfaces.map(surface => ({ ...surface, sequence: Math.max(surface.sequence, (previous.surfaces.find(prior => prior.open.id === surface.open.id)?.sequence ?? 0) + 1) })) };
	for (const listener of updates) listener(tspHostPatch(null, snapshot));
}

it("lets a replacement native card register before deciding an explicit handoff", async () => {
	snapshot = build(recordedUntil("plan-review-execute", node => node.p?.role === TSP_ROLES.planReview));
	await act(async () => root.render(createElement(Harness)));
	const request = vi.spyOn(screenActivity, "requestOnce");
	const replacement = recordedUntil("hook-input-open", node => node.p?.role === TSP_ROLES.hookInput);
	await act(async () => {
		replaceNativeDocument(replacement);
		openRequestedScreen(controllerFor(tabId)!, snapshot);
		expect(request).toHaveBeenCalledOnce();
	});
	expect(element.querySelector('section[aria-label="Question from omp"]')).not.toBeNull();
	expect(opened).toEqual([]);
	expect(screenActivity.has(snapshot, "request")).toBe(false);
	expect(runtimeErrors).toEqual([]);
});

it("defers an explicit native handoff until an overlapping app drive releases", async () => {
	vi.useFakeTimers();
	snapshot = build(recordedUntil("model-switch", node => node.p?.role === TSP_ROLES.editor));
	await act(async () => root.render(createElement(Harness)));
	const release = screenActivity.hold(snapshot, "drive");
	try {
		await act(async () => {
			replaceNativeDocument(recordedUntil("model-switch", node => node.k === "picker" && node.p?.noun === "models"));
			openRequestedScreen(controllerFor(tabId)!, snapshot);
		});
		await act(async () => { await vi.advanceTimersByTimeAsync(350); });
		expect(opened).toEqual([]);
		expect(screenActivity.has(snapshot, "request")).toBe(true);
		await act(async () => release());
		expect(opened).toEqual([tabId]);
		expect(screenActivity.has(snapshot, "request")).toBe(false);
	} finally { release(); vi.useRealTimers(); }
	expect(runtimeErrors).toEqual([]);
});

it("preserves an explicit startup handoff without enabling unattended startup opening", async () => {
	const session = controllerFor(tabId)!;
	vi.mocked(session.getSnapshot).mockReturnValue({ ...session.getSnapshot(), mode: "starting" });
	snapshot = build(recordedUntil("plan-review-save", node => node.p?.role === TSP_ROLES.planSave));
	await act(async () => root.render(createElement(Harness)));
	expect(opened).toEqual([]);
	await act(async () => openRequestedScreen(session, snapshot));
	expect(opened).toEqual([tabId]);
	expect(autoOpened.tabId).toBe(tabId);
	expect(screenActivity.has(snapshot, "request")).toBe(false);
});
