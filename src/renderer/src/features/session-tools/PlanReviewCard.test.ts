// @vitest-environment happy-dom
import { act, createElement, useSyncExternalStore, type PropsWithChildren, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import type { TspHostSnapshot, TspRendererEvent as RendererEvent } from "@shared/tsp-host";
import { TspRendererEvent } from "@shared/tsp-host.schema";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { planReview } from "@shared/tsp/plan-review";
import type { SessionController, SessionView } from "../../state/session";
import { FixtureDocuments, loadFixtureRecording } from "../tsp/testing/documents";
import { PlanReviewCard } from "./PlanReviewCard";
import { TooltipProvider } from "../../ui/Tooltip";
import { useComposerDrafts } from "../../chat/composer/drafts";
import { clearToasts, useToasts } from "../../ui/toast";
import "../../i18n";
import { PlanPane } from "../panes/PlanPane";
import { useApp } from "../../state/app";
import { composer, openOverlay, walkNodes } from "@shared/tsp/view-state";
import type { TspNode } from "@shared/tsp";
import { TSP_ROLES } from "@shared/tsp/roles";
import { currentPresentationConsumers, presentationClaims, PresentationVisibility } from "../../state/tsp/presentation-claims";
import { screenActivity } from "../../state/tsp/screen-activity";
import { autoOpened } from "../palette/TerminalSheet";
import { screenCandidateKey } from "../palette/auto-screen";
import { Composer } from "../../chat/composer/Composer";
import { OmpScreenSheet } from "../tsp/OmpScreenSheet";
vi.hoisted(() => { Object.assign(window, { vomp: { platform: "darwin", invoke: async () => [], on: () => () => {} } }); });
vi.mock("../../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../../chat/branch", () => ({ useBranchEntries: () => [] }));
vi.mock("./slash", () => ({ routeSlash: vi.fn() }));
vi.mock("./typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../../chat/composer/attach", () => ({ attachFiles: vi.fn(), attachPaths: vi.fn(), useThumbnail: () => null }));
vi.mock("../../chat/composer/MentionPicker", () => ({ MentionPicker: () => null, useProjectFiles: () => null }));
vi.mock("../../chat/composer/SlashMenu", () => ({ SlashMenu: () => null, useSlashCommands: () => [], slashOptions: () => null, slashAtCaret: () => null }));
vi.mock("../../chat/composer/PromptLibrary", () => ({ PromptLibrary: () => null }));
vi.mock("../../chat/composer/QueueTray", () => ({ QueueTray: () => null }));
vi.mock("../../chat/composer/VoiceTool", () => ({ VoiceTool: () => null, useVoiceRequests: { getState: () => ({ requestStart: vi.fn() }) } }));
vi.mock("../../chat/composer/predictions", () => ({ useGhostText: () => ({ suffix: "" }), ghostSourceUnchanged: () => true }));
vi.mock("../../chat/composer/tools", () => ({ QUICK_MODES: [] }));
vi.mock("../../chat/composer/PredictionRecovery", () => ({ PredictionRecovery: () => null, acknowledgePrediction: vi.fn(), usePredictionCaptures: { getState: () => ({ merge: vi.fn() }) } }));
vi.mock("../panes/common", () => ({ usePaneVisible: () => true, PaneToolbar: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children) }));
// Chrome covers production motion. DOM tests exercise decisions without cancellable WAAPI animations.
vi.mock("motion/react", () => {
	const tag = (name: string) => ({ children, initial, animate, exit, transition, layout, layoutId, variants, custom, ...props }: PropsWithChildren<Record<string, unknown>>) => createElement(name, props, children);
	return { AnimatePresence: ({ children }: PropsWithChildren) => children, MotionConfig: ({ children }: PropsWithChildren) => children, motion: { div: tag("div"), span: tag("span"), section: tag("section"), ul: tag("ul"), li: tag("li") }, useReducedMotionConfig: () => true };
});
const mocks = vi.hoisted(() => ({ auto: vi.fn(), approval: vi.fn().mockResolvedValue(undefined), exit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./approval", () => ({ acknowledgeAuto: mocks.auto, setApprovalMode: mocks.approval }));
vi.mock("./plan", () => ({ exitPlan: mocks.exit, loadPlan: vi.fn().mockResolvedValue(null) }));
let element: HTMLDivElement, root: Root;
let snapshot: TspHostSnapshot;
let listeners: Set<(patch: TspHostPatch) => void>;
let invoke: ReturnType<typeof vi.fn>;
let view: SessionView;
let controller: SessionController;
let sessionListeners: Set<() => void>;
let requestOnce: MockInstance<typeof screenActivity.requestOnce>;
function recorded(name: string, version?: string) {
	const doc = new FixtureDocuments();
	for (const message of loadFixtureRecording(name, version).messages) {
		doc.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		if (planReview(doc.snapshot().surfaces)) return doc.snapshot();
	}
	throw new Error("Missing recorded plan review");
}
function planSnapshot(name: string, version?: string): TspHostSnapshot {
	const docs = recorded(name, version);
	return { ...docs, hostId: "host", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: false, reason: "Plan review" }, surfaces: docs.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
}
function update(next: TspHostSnapshot) {
	snapshot = next;
	view = { ...view, host: { ...view.host!, tspAvailability: next.availability } };
	for (const listener of sessionListeners) listener();
	for (const listener of listeners) listener(tspHostPatch(null, snapshot));
}
function withoutReview() {
	const next = structuredClone(snapshot);
	next.revision++;
	for (const surface of next.surfaces) {
		const layer = surface.document.c?.find(node => node.id === "layer");
		if (layer) layer.c = layer.c?.filter(node => node.p?.role !== TSP_ROLES.planReview);
	}
	return next;
}
function changeReview(change: (node: TspNode, next: TspHostSnapshot) => void) {
	const next = structuredClone(snapshot); next.revision++;
	const node = next.surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.p?.role === TSP_ROLES.planReview)!;
	change(node, next); update(next);
}
function commitReview(node: TspNode) {
	for (const parent of walkNodes(node)) parent.c = parent.c?.filter(child => child.p?.role !== TSP_ROLES.planOptions && child.p?.role !== TSP_ROLES.planTools && child.p?.role !== TSP_ROLES.planSlider);
	node.c = [...node.c!, { id: "committed", k: "spinner" }];
}
function Workflow() {
	useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	return createElement(TooltipProvider, null, createElement(PlanReviewCard, { session: controller }), createElement(Composer, { session: controller }),
		createElement(OmpScreenSheet, { hostId: "host", generation: 1, snapshot, failed: false, readOnly: false }));
}
/** Only accepted input advances this recording. Production card, composer and screen own the controls. */
function workflowRecording(name: string, version?: string) {
	const recording = loadFixtureRecording(name, version);
	const first = recording.inputs.findIndex(input => !("keys" in input) && (input.body.ev === "activate" || input.body.ev === "action"));
	const inputs = recording.inputs.slice(first);
	const documents = new FixtureDocuments();
	let cursor = 0, inputIndex = 0;
	const advance = () => {
		const stop = inputs[inputIndex]?.afterMessage ?? recording.messages.length;
		for (; cursor < stop; cursor++) {
			const message = recording.messages[cursor]!;
			// The final close belongs to recorder teardown, after the accepted workflow finishes.
			if (message.verb === "x") continue;
			documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
			const next = documents.snapshot();
			const available = !!composer(next.surfaces) && !openOverlay(next.surfaces, true);
			update({ ...snapshot, ...next, revision: snapshot.revision + 1, availability: { available, reason: available ? null : "Review the plan" },
				surfaces: next.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) });
		}
	};
	advance();
	invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "host:tsp-snapshot") return snapshot;
		if (channel !== "host:tsp-event") return undefined;
		const expected = inputs[inputIndex];
		if (!expected || "keys" in expected) throw new Error("Unexpected application input");
		expect(args[0]).toBe("host"); expect(args[1]).toBe(1); expect(args[3]).toBe(snapshot.epoch);
		expect(TspRendererEvent.parse(args[2])).toEqual(expected.body);
		inputIndex++; advance();
		return undefined;
	});
	Object.defineProperty(controller, "send", { value: async (text: string) => {
		const editor = composer(snapshot.surfaces)!;
		await window.vomp.invoke("host:tsp-event", "host", 1, { ev: "send", sf: editor.surface.open.id, id: editor.node.id, text }, snapshot.epoch);
	} });
	return { count: () => inputIndex, finish: () => { expect(inputIndex).toBe(inputs.length); expect(planReview(snapshot.surfaces)).toBeNull(); } };
}
function ToastProbe() {
	const toasts = useToasts();
	return createElement("output", { "data-testid": "toast-messages" }, toasts.map(item => item.message).join("\n"));
}
async function toastMessages() {
	await act(async () => root.render(createElement(ToastProbe)));
	return element.querySelector('[data-testid="toast-messages"]')?.textContent ?? "";
}
async function render() {
	await act(async () => root.render(createElement("div", null,
		createElement(TooltipProvider, { children: createElement(PlanReviewCard, { session: controller }) }), createElement(ToastProbe))));
}
async function click(label: string) {
	const button = [...element.querySelectorAll("button"), ...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent?.trim() === label);
	expect(button, label).toBeTruthy();
	await act(async () => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
async function menu() {
	const more = [...element.querySelectorAll("button")].find(button => button.textContent?.trim() === "More options")!;
	await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	clearToasts();
	vi.clearAllMocks(); mocks.approval.mockReset().mockResolvedValue(undefined); listeners = new Set(); sessionListeners = new Set();
	requestOnce = vi.spyOn(screenActivity, "requestOnce");
	useComposerDrafts.getState().forget("plan-test"); useApp.setState({ terminalTabId: null });
	autoOpened.tabId = null;
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
	snapshot = planSnapshot("plan-review-execute");
	view = {
		mode: "live", readOnly: false, working: false, workingSince: null, guest: null, history: null,
		inputHistory: [], queue: [], sendingNow: [], strandedImages: false, follow: null, ownerUnverified: false, displayLeaf: null, carryover: null, error: null,
		host: { hostId: "host", generation: 1, transport: "tsp", tspAvailability: snapshot.availability, cwd: "/tmp/plan-test", phase: "live",
			link: null, sessionId: null, sessionFile: null, pid: null, exitCode: null, error: null, tui: null, cols: 80, rows: 24 },
	};
	controller = { hostId: "host", tabId: "plan-test", projectPath: "/tmp/plan-test", sessionFile: null, getSnapshot: () => view, subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); }, preserveFailedMessage: vi.fn(), btwLine: () => null } as unknown as SessionController;
	invoke = vi.fn(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", invoke, on: (channel: string, listener: (patch: TspHostPatch) => void) => { if (channel === "host:tsp-patch") listeners.add(listener); return () => listeners.delete(listener); } } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	for (const result of requestOnce.mock.results) if (result.type === "return") { result.value.cancel(); await result.value.done; }
	requestOnce.mockRestore();
	await act(async () => root.unmount()); element.remove();
});
it.each([["Approve and run", "execute"], ["Approve and compact first", "compact"], ["Save and stop", "save"]] as const)("renders the recorded card and sends %s once by option id", async (label, action) => {
	await render();
	expect(element.textContent).toContain("Fixture plan"); expect(element.textContent).toContain("Cover the consumer-visible result.");
	const review = planReview(snapshot.surfaces)!;
	await click(label);
	const emitted = invoke.mock.calls.filter(call => call[0] === "host:tsp-event");
	expect(emitted).toEqual([["host:tsp-event", "host", 1, { ev: "activate", sf: review.sf, id: review.optionsId, item: review.options.find(option => option.action === action)!.id }, snapshot.epoch]]);
	expect(element.querySelectorAll("button:disabled").length).toBeGreaterThan(2);
	await click(label); expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toHaveLength(1);
	await act(async () => update(withoutReview()));
	expect(invoke.mock.calls.some(call => call[0] === "host:screen" || call[0] === "host:keys")).toBe(false);
});
it("refines through omp and focuses the existing comment draft only after the review leaves", async () => {
	await render(); await menu(); await click("Refine with a comment");
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBeUndefined();
	await act(async () => update(withoutReview()));
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBe("About this plan: ");
});
it("keeps Auto on the existing permission config before activating approval", async () => {
	await render(); await menu(); await click("Switch to Auto and run");
	expect(mocks.auto).toHaveBeenCalledOnce(); expect(mocks.approval).toHaveBeenCalledWith("/tmp/plan-test", "yolo");
	expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toHaveLength(1);
	await act(async () => update(withoutReview()));
});
it("cancels the recorded overlay before leaving plan mode through the extension", async () => {
	await render(); await menu(); await click("Discard plan");
	expect(mocks.exit).not.toHaveBeenCalled();
	const review = planReview(snapshot.surfaces)!;
	expect(invoke).toHaveBeenCalledWith("host:tsp-event", "host", 1, { ev: "action", sf: review.sf, id: review.cancelId, act: "cancel" }, snapshot.epoch);
	await act(async () => update(withoutReview()));
	expect(mocks.exit).toHaveBeenCalledWith(controller);
});
/** The current snapshot, one revision later, with `edit` applied to its layer region. */
function changed(edit: (layer: TspNode) => void, change: Partial<TspHostSnapshot> = {}): TspHostSnapshot {
	const next: TspHostSnapshot = { ...structuredClone(snapshot), ...change, revision: snapshot.revision + 1 };
	edit(next.surfaces[0]!.document.c!.find(node => node.id === "layer")!);
	return next;
}
function savePrompt(id = "save", extra: TspNode[] = []): TspNode {
	return { id, k: "overlay", p: { role: TSP_ROLES.planSave, head: "Save plan", modal: true }, c: [{ id: `${id}.body`, k: "col", c: [
		{ id: "save.path", k: "input", p: { text: "", cursor: 0, prompt: "Path: " } },
		{ id: "save.default", k: "text", p: { spans: [{ t: "Empty saves to ", s: "dim" }, { t: "FIXTURE_PLAN.md", s: "path" }] } },
		{ id: "save.actions", k: "row", c: [
			{ id: "save.cancel", k: "button", p: { text: "Cancel", actions: { click: "cancel" } } },
			{ id: "save.save", k: "button", p: { text: "Save", actions: { click: "save" } } },
			...extra,
		] },
	] }] };
}
const withSavePrompt = (prompt = savePrompt()) => changed(layer => { layer.c = [...(layer.c ?? []), prompt]; });
const withoutSavePrompt = () => changed(layer => { layer.c = layer.c?.filter(node => node.p?.role !== TSP_ROLES.planSave); });
const withPath = (text: string) => changed(layer => {
	for (const node of walkNodes(layer)) if (node.id === "save.path" && node.k === "input") node.p = { ...node.p, text, cursor: text.length };
});
const sentEvents = () => invoke.mock.calls.filter(call => call[0] === "host:tsp-event").map(call => call[3]);
async function typePath(text: string) {
	const input = element.querySelector<HTMLInputElement>('form[aria-label="Save a copy of this plan"] input')!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
/** omp's reply to the card's edit: `reply(text)` returns the snapshot omp shows next, or null for none. */
function ompEdits(reply: (text: string) => TspHostSnapshot | null) {
	invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "host:tsp-snapshot") return snapshot;
		const event = args[2] as RendererEvent;
		if (channel === "host:tsp-event" && event.ev === "edit") queueMicrotask(() => { const next = reply(event.text); if (next) update(next); });
		return undefined;
	});
}
async function saveCopy() {
	await act(async () => { [...element.querySelectorAll("button")].find(button => button.textContent === "Save copy")!.click(); });
}
it("answers omp's Save plan prompt in the card with a typed file name once omp shows it, or cancels it", async () => {
	await render();
	const sf = planReview(snapshot.surfaces)!.sf;
	await act(async () => update(withSavePrompt()));
	expect(element.querySelector<HTMLInputElement>('form[aria-label="Save a copy of this plan"] input')!.placeholder).toBe("FIXTURE_PLAN.md");
	expect(element.textContent).toContain("Leave it empty to use FIXTURE_PLAN.md.");
	await typePath("docs/plan.md");
	ompEdits(text => withPath(text));
	await saveCopy();
	await vi.waitFor(() => expect(sentEvents()).toHaveLength(2));
	expect(sentEvents()).toEqual([
		{ ev: "edit", sf, id: "save.path", from: 0, to: 0, text: "docs/plan.md", cursor: 12, len: 0 },
		{ ev: "action", sf, id: "save.save", act: "save" },
	]);
	await act(async () => update(withoutSavePrompt()));
	expect(element.querySelector('form[aria-label="Save a copy of this plan"]')).toBeNull();
	await act(async () => update(withSavePrompt()));
	invoke.mockClear();
	await click("Cancel");
	expect(sentEvents()).toEqual([{ ev: "action", sf, id: "save.cancel", act: "cancel" }]);
	await act(async () => update(withoutSavePrompt()));
	expect(element.textContent).toContain("Approve and run");
});
it.each([
	["omp replaces the prompt", () => changed(layer => { layer.c = [...layer.c!.filter(node => node.p?.role !== TSP_ROLES.planSave), savePrompt("save-2")]; })],
	["the chat's TSP epoch changes", () => ({ ...withPath("docs/plan.md"), epoch: snapshot.epoch + 1 })],
	["omp shows a different path", () => withPath("elsewhere.md")],
] as const)("does not send Save after the edit when %s", async (_case, reply) => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		await render();
		await act(async () => update(withSavePrompt()));
		await typePath("docs/plan.md");
		ompEdits(() => reply());
		const scope = snapshot;
		await saveCopy();
		await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
		expect(sentEvents().map(event => (event as RendererEvent).ev)).toEqual(["edit"]);
		// The answer has finished and let go of the omp screen.
		expect(screenActivity.has(scope, "drive")).toBe(false);
	} finally { vi.useRealTimers(); }
});
it("hands an unfamiliar Save prompt to the omp screen", async () => {
	useApp.setState({ view: "chat", activeTabId: "plan-test", splitTabId: null, sheet: null });
	await act(async () => update(changed(layer => {
		for (const node of walkNodes(layer)) if (node.k === "item" && typeof node.p?.label === "string" && node.p.label.startsWith("Save and quit")) node.p = { ...node.p, label: "Save" };
	})));
	await render();
	await click("Save plan as…");
	expect(screenActivity.has(snapshot, "drive")).toBe(true);
	const browse = { id: "save.browse", k: "button", p: { text: "Browse", actions: { click: "browse" } } } satisfies TspNode;
	await act(async () => update(withSavePrompt(savePrompt("save", [browse]))));
	expect(screenActivity.has(snapshot, "drive")).toBe(false);
	expect(requestOnce).toHaveBeenCalledOnce();
	expect(element.querySelector('form[aria-label="Save a copy of this plan"]')).toBeNull();
});
it("selects a continuation tier by id and disables decisions on read-only or stale documents", async () => {
	await render();
	await click("smol"); const review = planReview(snapshot.surfaces)!;
	expect(invoke).toHaveBeenCalledWith("host:tsp-event", "host", 1, { ev: "select", sf: review.sf, id: review.slider!.id, item: "t0" }, snapshot.epoch);
	view = { ...view, readOnly: true }; await render();
	expect([...element.querySelectorAll("button")].find(button => button.textContent === "Approve and run")?.disabled).toBe(true);
	await act(async () => update({ ...snapshot, revision: 2, generation: 2 })); expect(element.textContent).not.toContain("Approve and run");
});
it("approves from the Plan pane with activate and opens all options in the omp screen", async () => {
	Object.defineProperty(controller, "sessionFile", { value: "/tmp/fixture.jsonl" });
	invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : channel === "panes:planFile" ? { path: "/tmp/fixture-plan.md", text: "# Fixture plan", mtime: 1 } : undefined);
	await act(async () => root.render(createElement(TooltipProvider, { children: createElement(PlanPane, { session: controller, projectPath: controller.projectPath }) })));
	expect(element.textContent).toContain("omp is waiting for your decision");
	await click("See all options");
	expect(useApp.getState().terminalTabId).toBe("plan-test");
	await click("Approve plan");
	const review = planReview(snapshot.surfaces)!;
	expect(invoke).toHaveBeenCalledWith("host:tsp-event", "host", 1, { ev: "activate", sf: review.sf, id: review.optionsId, item: review.options[0]!.id }, snapshot.epoch);
	await act(async () => update(withoutReview()));
	expect(invoke.mock.calls.some(call => call[0] === "host:screen" || call[0] === "host:keys")).toBe(false);
});

it.each([
	["execute", "Approve and run"], ["compact", "Approve and compact first"], ["keep", "Approve and keep context"],
	["refine", "Refine with a comment"], ["discard", "Discard plan"], ["save", "Save and stop"],
] as const)("completes the %s recording through production card, composer and screen controls", async (choice, label) => {
	const replay = workflowRecording(`plan-review-${choice}`);
	await act(async () => root.render(createElement(Workflow)));
	if (["keep", "refine", "discard"].includes(choice)) await menu();
	await click(label);
	expect(replay.count()).toBe(1);
	if (choice === "refine") {
		expect(element.querySelector("textarea")?.value).toBe("About this plan: ");
		await act(async () => useComposerDrafts.getState().setDraft("plan-test", "Refine the plan: include the empty state."));
		const button = element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
		expect(button.disabled).toBe(false);
		await act(async () => button.click());
	}
	if (choice === "save") {
		const button = [...element.querySelectorAll<HTMLButtonElement>(".tsp-screen button")].find(button => button.textContent?.startsWith("Save and quit"))!;
		expect(button).toBeTruthy();
		await act(async () => button.click());
	}
	replay.finish();
	if (choice === "discard") expect(mocks.exit).toHaveBeenCalledWith(controller);
});

// omp 18.22.0 lists Approve and execute, compact and keep, then Save; Refine appears only while its review has annotations or deleted sections.
it.each([
	["execute", "Approve and run"], ["compact", "Approve and compact first"], ["keep", "Approve and keep context"],
	["refine", "Refine with a comment"], ["discard", "Discard plan"],
] as const)("completes omp 18.22.0's %s recording through production card, composer and screen controls", async (choice, label) => {
	const replay = workflowRecording(`plan-review-${choice}`, "18.22.0");
	await act(async () => root.render(createElement(Workflow)));
	expect(planReview(snapshot.surfaces)!.options.map(option => option.action)).toEqual(["execute", "compact", "keep", "saveCopy"]);
	if (["keep", "refine", "discard"].includes(choice)) await menu();
	await click(label);
	expect(replay.count()).toBe(1);
	if (choice === "refine") {
		// No Refine was listed, so Cancel closed the review and plan mode stays, as a Refine without comments did before.
		expect(element.querySelector("textarea")?.value).toBe("About this plan: ");
		await act(async () => useComposerDrafts.getState().setDraft("plan-test", "Refine the plan: include the empty state."));
		await act(async () => element.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click());
	}
	replay.finish();
	if (choice === "discard") expect(mocks.exit).toHaveBeenCalledWith(controller);
	else expect(mocks.exit).not.toHaveBeenCalled();
});

it("saves through omp 18.22.0's Save, answers its file prompt in the card and returns to the open review", async () => {
	const replay = workflowRecording("plan-review-save", "18.22.0");
	await act(async () => root.render(createElement(Workflow)));
	expect(element.textContent).not.toContain("Save and stop");
	await click("Save plan as…");
	expect(replay.count()).toBe(1);
	// omp's "Save plan" prompt covers the review; the card keeps the review and asks for the file name itself.
	expect(planReview(snapshot.surfaces)).toBeNull();
	const form = element.querySelector<HTMLFormElement>('form[aria-label="Save a copy of this plan"]');
	expect(form).not.toBeNull();
	expect(form!.querySelector("input")!.placeholder).toBe("FIXTURE_WORK_COMPLETED_PLAN.md");
	// The card claims the prompt, so the omp screen does not open on it.
	expect(element.querySelector(".tsp-screen")?.textContent ?? "").not.toContain("Empty saves to");
	// The review's own choices wait while the prompt is open.
	expect([...element.querySelectorAll("button")].find(button => button.textContent === "Approve and run")).toBeUndefined();
	await click("Save copy");
	expect(replay.count()).toBe(2);
	expect(planReview(snapshot.surfaces)).not.toBeNull();
	expect(element.querySelector('form[aria-label="Save a copy of this plan"]')).toBeNull();
	expect(element.textContent).toContain("Save plan as…");
	await menu(); await click("Discard plan");
	replay.finish();
	expect(mocks.exit).toHaveBeenCalledWith(controller);
});

it("defers Auto activation until config settles, then uses the currently enabled option id", async () => {
	const config = Promise.withResolvers<void>();
	mocks.approval.mockReturnValueOnce(config.promise);
	await render(); await menu(); await click("Switch to Auto and run");
	expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toHaveLength(0);
	await act(async () => changeReview(node => {
		const option = node.c?.flatMap(child => [...walkNodes(child)]).find(child => child.k === "item" && child.p?.label === "Approve and execute");
		if (!option) throw new Error("Missing execute option");
		option.id = "replacement-execute-id";
	}));
	await act(async () => config.resolve());
	expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-event")[0]?.[3]).toMatchObject({ ev: "activate", item: "replacement-execute-id" });
	await act(async () => update(withoutReview()));
});

it.each(["disabled", "committed", "restart"] as const)("refuses stale Auto activation after a %s transition during config", async transition => {
	const config = Promise.withResolvers<void>(); mocks.approval.mockReturnValueOnce(config.promise);
	await render(); await menu(); await click("Switch to Auto and run");
	await act(async () => {
		if (transition === "restart") update({ ...snapshot, revision: snapshot.revision + 1, epoch: snapshot.epoch + 1 });
		else changeReview(node => {
			if (transition === "committed") commitReview(node);
			else {
				const option = [...walkNodes(node)].find(child => child.k === "item" && child.p?.label === "Approve and execute");
				if (option?.k === "item") option.p = { ...option.p, label: "Approve and execute", disabled: true };
			}
		});
	});
	await act(async () => config.resolve());
	expect(invoke.mock.calls.filter(call => call[0] === "host:tsp-event")).toHaveLength(0);
	expect(element.textContent).not.toContain("Plan approved.");
});

it.each([["refine", "restart"], ["discard", "restart"], ["execute", "restart"], ["refine", "room"], ["discard", "room"], ["execute", "failed"]] as const)("does not complete %s after %s invalidation", async (action, transition) => {
	await render();
	if (action !== "execute") await menu();
	await click(action === "refine" ? "Refine with a comment" : action === "discard" ? "Discard plan" : "Approve and run");
	await act(async () => update({ ...snapshot, revision: snapshot.revision + 1,
		...(transition === "restart" ? { epoch: snapshot.epoch + 1 } : transition === "room" ? { generation: snapshot.generation + 1 } : { lifecycle: "failed" as const }) }));
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBeUndefined();
	expect(mocks.exit).not.toHaveBeenCalled();
	expect(element.textContent).not.toContain("Plan approved.");
});

it("waits for physical departure through covered and unsupported states without refining early", async () => {
	await render(); await menu(); await click("Refine with a comment");
	await act(async () => changeReview((_node, next) => {
		const layer = next.surfaces[0]!.document.c!.find(node => node.id === "layer")!;
		layer.c = [...layer.c!, { id: "cover", k: "overlay", p: { head: "Another omp menu" } }];
	}));
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBeUndefined();
	await act(async () => changeReview((node, next) => {
		const layer = next.surfaces[0]!.document.c!.find(node => node.id === "layer")!;
		layer.c = layer.c!.filter(child => child.id !== "cover");
		node.c = [...node.c!, { id: "chooser", k: "list", p: { selected: "c0" }, c: [{ id: "c0", k: "item", p: { label: "Edit note" } }] }];
	}));
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBeUndefined();
	await act(async () => update(withoutReview()));
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBe("About this plan: ");
});

it("keeps committed compaction pending until the physical overlay leaves", async () => {
	await render(); await click("Approve and compact first");
	await act(async () => changeReview(commitReview));
	expect(element.textContent).toContain("omp is applying your plan choice.");
	expect(element.textContent).not.toContain("Plan approved.");
	await act(async () => update(withoutReview()));
	expect(element.textContent).toContain("Plan approved.");
});

it("uses omp's keep-context option even when collab reports more than 95 percent", async () => {
	view = { ...view, guest: { state: { contextUsage: { percent: 99 } } } as unknown as SessionView["guest"] };
	await render(); await menu();
	const keep = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent === "Approve and keep context");
	expect(keep).toBeTruthy(); expect(keep?.getAttribute("data-disabled")).not.toBe("");
});

it("claims only a mounted, visible card and releases when the omp screen covers it", async () => {
	await render(); expect(presentationClaims.getSnapshot()).toHaveLength(1);
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(PresentationVisibility, { visible: false }, createElement(PlanReviewCard, { session: controller })))));
	expect(presentationClaims.getSnapshot()).toHaveLength(0);
	expect(openOverlay(snapshot.surfaces)?.node.p?.role).toBe(TSP_ROLES.planReview);
	await render(); expect(presentationClaims.getSnapshot()).toHaveLength(1);
	await act(async () => useApp.setState({ terminalTabId: "plan-test" }));
	expect(presentationClaims.getSnapshot()).toHaveLength(0);
});

it("queues Save for post-layout policy after the confirmed physical swap", async () => {
	useApp.setState({ view: "chat", activeTabId: "plan-test", splitTabId: null, sheet: null });
	await render();
	const scope = snapshot;
	await click("Save and stop");
	expect(screenActivity.has(scope, "request")).toBe(true);
	expect(screenActivity.has(scope, "drive")).toBe(false);
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(requestOnce).not.toHaveBeenCalled();
	const next = withoutReview();
	const layer = next.surfaces[0]!.document.c!.find(node => node.id === "layer")!;
	layer.c = [...(layer.c ?? []), { id: "save-path", k: "overlay", p: { role: TSP_ROLES.planSave, head: "Save plan" }, c: [{ id: "path", k: "input", p: { text: "/tmp/plan.md" } }] }];
	await act(async () => update(next));
	expect(requestOnce).toHaveBeenCalledExactlyOnceWith(snapshot, snapshot.revision, screenCandidateKey(snapshot, currentPresentationConsumers(snapshot.hostId, snapshot.epoch)));
	expect(useApp.getState().terminalTabId).toBeNull();
	expect(autoOpened.tabId).toBeNull();
	const request = requestOnce.mock.results[0]!.value!;
	const remainingListeners = sessionListeners.size;
	request.cancel(); await request.done;
	expect(sessionListeners.size).toBe(remainingListeners - 1);
});

it.each(["no native content", "hidden chat", "another sheet", "manual terminal"] as const)("does not take over Save after %s", async state => {
	useApp.setState({ view: "chat", activeTabId: "plan-test", splitTabId: null, sheet: null });
	await render(); await click("Save and stop");
	const next = withoutReview();
	const layer = next.surfaces[0]!.document.c!.find(node => node.id === "layer")!;
	if (state !== "no native content") layer.c = [...(layer.c ?? []), { id: "save-path", k: "overlay", p: { role: TSP_ROLES.planSave } }];
	if (state === "hidden chat") useApp.setState({ activeTabId: "other-chat" });
	if (state === "another sheet") useApp.getState().openSheet("session-text-action", { tabId: "plan-test", kind: "rename" });
	if (state === "manual terminal") useApp.setState({ terminalTabId: "plan-test" });
	await act(async () => update(next));
	expect(useApp.getState().terminalTabId).toBe(state === "manual terminal" ? "plan-test" : null);
	expect(autoOpened.tabId).toBeNull();
	expect(requestOnce).not.toHaveBeenCalled();
});

it.each(["Approve and run", "Approve and compact first"] as const)("holds %s drive until physical departure", async label => {
	await render();
	const scope = snapshot;
	await click(label);
	expect(screenActivity.has(scope, "drive")).toBe(true);
	expect(screenActivity.has(scope, "request")).toBe(false);
	await act(async () => changeReview(commitReview));
	expect(screenActivity.has(scope, "drive")).toBe(true);
	await act(async () => update(withoutReview()));
	expect(screenActivity.has(scope, "drive")).toBe(false);
});

it.each([
	["execute", "Approve and run", false],
	["compact", "Approve and compact first", false],
	["keep", "Approve and keep context", true],
] as const)("accepts delivered %s approval when the card unmounts before review removal", async (action, label, useMenu) => {
	snapshot = planSnapshot(`plan-review-${action}`, "18.22.0");
	view = { ...view, host: { ...view.host!, tspAvailability: snapshot.availability } };
	await render();
	const scope = snapshot;
	const write = Promise.withResolvers<undefined>();
	invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : write.promise);
	if (useMenu) await menu();
	await click(label);
	expect(screenActivity.has(scope, "drive")).toBe(true);
	await act(async () => write.resolve(undefined));
	view = { ...view, readOnly: true };
	await act(async () => root.render(null));
	expect(screenActivity.has(scope, "drive")).toBe(false);
	expect(await toastMessages()).toBe("");
});

it("reports a rejected plan choice write and releases its activity hold", async () => {
	await render();
	const scope = snapshot;
	const write = Promise.withResolvers<undefined>();
	invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : write.promise);
	await click("Approve and run");
	expect(screenActivity.has(scope, "drive")).toBe(true);
	await act(async () => write.reject(new Error("Plan choice refused")));
	expect(screenActivity.has(scope, "drive")).toBe(false);
	expect(await toastMessages()).toContain("Plan choice refused");
});

it.each([
	["refine", "Refine with a comment"],
	["discard", "Discard plan"],
] as const)("keeps %s pending when the card unmounts before review removal", async (_action, label) => {
	await render();
	const scope = snapshot;
	const write = Promise.withResolvers<undefined>();
	invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : write.promise);
	await menu();
	await click(label);
	expect(screenActivity.has(scope, "drive")).toBe(true);
	await act(async () => write.resolve(undefined));
	await act(async () => root.render(null));
	expect(screenActivity.has(scope, "drive")).toBe(false);
	expect(useComposerDrafts.getState().drafts["plan-test"]).toBeUndefined();
	expect(mocks.exit).not.toHaveBeenCalled();
	expect(await toastMessages()).toContain("The plan review view closed.");
});

it.each(["write failure", "epoch change", "unmount"] as const)("releases a tier write drive on %s", async end => {
	await render();
	const scope = snapshot;
	const write = Promise.withResolvers<undefined>();
	invoke.mockImplementation(async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : write.promise);
	await click("smol");
	expect(screenActivity.has(scope, "drive")).toBe(true);
	if (end === "write failure") await act(async () => write.reject(new Error("Tier refused")));
	else if (end === "epoch change") await act(async () => update({ ...snapshot, revision: snapshot.revision + 1, generation: snapshot.epoch + 1 }));
	else await act(async () => root.render(null));
	expect(screenActivity.has(scope, "drive")).toBe(false);
	if (end !== "write failure") await act(async () => write.resolve(undefined));
});

it("renders model detail beside tier switcher and dispatches menu action events on omp 19.2 dock reviews", async () => {
	const emitted: unknown[][] = [];
	invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
		if (channel === "host:tsp-snapshot") return snapshot;
		if (channel === "host:tsp-event") emitted.push([channel, ...args]);
		return undefined;
	});
	const dockReview: Extract<TspNode, { k: "overlay" }> = {
		id: "review",
		k: "overlay",
		p: { role: TSP_ROLES.planReview, head: "omp 19.2 plan" },
		c: [
			{ id: "body", k: "col", p: { role: TSP_ROLES.planBody }, c: [{ id: "doc", k: "doc", p: { role: TSP_ROLES.planDoc, text: "Step one." } }] },
			{
				id: "dock",
				k: "row",
				p: { role: TSP_ROLES.planDock },
				c: [
					{
						id: "approve",
						k: "buttons",
						p: { role: TSP_ROLES.planApprove, variant: "split" },
						c: [
							{ id: "main", k: "button", p: { text: "Approve", actions: { click: "approve" } } },
							{
								id: "more",
								k: "menu",
								p: {
									items: [
										{ id: "execute", label: "Approve and execute" },
										{ id: "compact", label: "Approve and compact context" },
									],
								},
							},
						],
					},
					{
						id: "model",
						k: "menu",
						p: {
							role: TSP_ROLES.planModel,
							items: [
								{ id: "tier:0", label: "smol", detail: "Claude Haiku", radio: "tier", checked: false },
								{ id: "tier:1", label: "default", detail: "Claude Opus", radio: "tier", checked: true },
							],
						},
					},
					{ id: "cancel", k: "button", p: { role: "omp.btn", text: "Cancel", actions: { click: "cancel" } } },
				],
			},
		],
	};
	const surface: TspHostSnapshot["surfaces"][number] = {
		open: { id: "s:1", mode: "inline", role: TSP_ROLES.session },
		sequence: 1,
		closed: false,
		suspended: false,
		settled: [],
		focus: null,
		documentGeneration: 1,
		document: { id: "root", k: "col", c: [{ id: "layer", k: "col", c: [dockReview] }] },
	};
	await act(async () => update({ ...snapshot, revision: snapshot.revision + 1, surfaces: [surface] }));
	await render();
	expect(element.textContent).toContain("Claude Opus");

	await click("smol");
	await click("Approve and run");
	expect(emitted).toEqual([
		["host:tsp-event", "host", 1, { ev: "action", sf: "s:1", id: "model", act: "tier:0", checked: true }, snapshot.epoch],
		["host:tsp-event", "host", 1, { ev: "action", sf: "s:1", id: "more", act: "execute" }, snapshot.epoch],
	]);
});
