// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../../state/session";
import type { HostState } from "@shared/ipc";
import type { SessionModes } from "@shared/contracts/native";
import { TooltipProvider } from "../../ui/Tooltip";
import { Composer } from "./Composer";
import { useComposerDrafts } from "./drafts";
import { screenPoller, useOmpScreen } from "../../features/session-tools/status";
import { OmpDialogCard } from "../../features/session-tools/OmpDialogCard";
import { PlanReviewCard } from "../../features/session-tools/PlanReviewCard";
import { usePlanReviewPending } from "../../features/panes/PlanPane";
import { readScreen, waitForScreen } from "../../features/session-tools/drive";
import { PermissionButton } from "../../features/session-tools/pickers";
import "../../i18n";

const fake = vi.hoisted(() => {
	const invoke = vi.fn();
	const events = new Map<string, Set<(payload: unknown) => void>>();
	Object.assign(window, { vomp: { platform: "darwin", invoke, on(channel: string, listener: (payload: unknown) => void) {
		let listeners = events.get(channel); if (!listeners) events.set(channel, listeners = new Set()); listeners.add(listener);
		return () => listeners.delete(listener);
	} } });
	return { invoke, events };
});
vi.mock("../../state/app", () => ({ useApp: (select: (state: { prefs: { voiceInput: boolean } }) => unknown) => select({ prefs: { voiceInput: false } }) }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: () => null }));
vi.mock("../../features/session-tools/slash", () => ({ routeSlash: vi.fn() }));
vi.mock("../../features/session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../../registry/slots", () => ({ chatSlots: { use: () => [] } }));
vi.mock("../branch", () => ({ useDisplayedEntries: () => [] }));
vi.mock("./attach", () => ({ attachFiles: vi.fn(), attachPaths: vi.fn(), useThumbnail: () => null }));
vi.mock("./MentionPicker", () => ({ MentionPicker: () => null, useProjectFiles: () => null }));
vi.mock("./SlashMenu", () => ({ SlashMenu: () => null, useSlashCommands: () => [], slashOptions: () => null, slashAtCaret: () => null }));
vi.mock("./PromptLibrary", () => ({ PromptLibrary: () => null }));
vi.mock("./QueueTray", () => ({ QueueTray: () => null }));
vi.mock("./VoiceTool", () => ({ VoiceTool: () => null, useVoiceRequests: { getState: () => ({ requestStart: vi.fn() }) } }));
vi.mock("./tools", () => ({ QUICK_MODES: [] }));
vi.mock("./PredictionRecovery", () => ({ PredictionRecovery: () => null, acknowledgePrediction: vi.fn(), usePredictionCaptures: { getState: () => ({ merge: vi.fn() }) } }));

const modes: SessionModes = { plan: { status: "inactive" }, goal: { status: "active", objective: "Finish the task" }, vibe: { status: "inactive" }, loop: { status: "inactive" } };
let root: Root; let element: HTMLDivElement; let view: SessionView; let session: SessionController;
let fontsDescriptor: PropertyDescriptor | undefined;
const listeners = new Set<() => void>();
function setHost(transport: HostState["transport"], mode: SessionView["mode"] = "live") {
	// The mounted consumers need only these host fields; native and collab state are separate sources.
	const host = { hostId: "host", generation: 1, transport, tspAvailability: { available: true, reason: null }, tui: { overlays: 1, focused: "picker", overlayKinds: ["picker"] } } as HostState;
	view = { ...view, mode, host };
	for (const listener of listeners) listener();
}
function StatusConsumer({ id }: { id: string }) {
	const snapshot = useOmpScreen(session);
	return createElement("output", { "data-status": id }, JSON.stringify(snapshot));
}
function PlanPending() { return createElement("output", { "data-plan-pending": true }, String(usePlanReviewPending(session))); }
async function mount() {
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(Fragment, null,
		createElement(Composer, { session }), createElement(StatusConsumer, { id: "one" }), createElement(StatusConsumer, { id: "two" }),
		createElement(OmpDialogCard, { session }), createElement(PlanReviewCard, { session }), createElement(PlanPending), createElement(PermissionButton, { session })))));
	await act(async () => element.querySelector("textarea")!.focus());
}
const calls = (channel: string) => fake.invoke.mock.calls.filter(call => call[0] === channel);
async function advance(ms: number) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }

beforeEach(() => {
	vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");
	Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
	listeners.clear(); fake.invoke.mockReset(); fake.events.clear();
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "native:snapshot") return { modes, theme: null };
		if (channel === "host:screen") return ["╭── π ▶ ⬢ Opus 5.5 · ◕ xhigh ──╮", "╰─                          ─╯"];
		if (channel === "composer:tuiPrediction") return "Run the tests";
		if (channel === "config:approval") return { mode: "always-ask", supportedModes: ["always-ask", "write", "yolo"], modeSource: "project" };
		return undefined;
	});
	view = { mode: "live", readOnly: false, working: false, guest: null, history: null, inputHistory: [], queue: [], strandedImages: [], host: null } as unknown as SessionView;
	session = { tabId: "polling", projectPath: "/tmp", sessionFile: null, get hostId() { return view.host?.hostId ?? null; }, getSnapshot: () => view, subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as SessionController;
	useComposerDrafts.getState().setDraft("polling", "");
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
	await act(async () => root.unmount()); useComposerDrafts.getState().forget("polling"); element.remove();
	if (fontsDescriptor) Object.defineProperty(document, "fonts", fontsDescriptor); else Reflect.deleteProperty(document, "fonts");
	vi.useRealTimers();
});

it("mounts an idle TSP composer and shared consumers without painted screen or prediction reads, retaining native mode facts", async () => {
	setHost("tsp"); await mount();
	await act(async () => { await screenPoller(session).refresh(); });
	const nativeReads = calls("native:snapshot").length;
	await advance(60_000);
	expect(calls("host:screen")).toHaveLength(0); expect(calls("composer:tuiPrediction")).toHaveLength(0);
	expect(calls("native:snapshot")).toHaveLength(nativeReads);
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain('"goal":"active"');
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain('"lines":[]');
	expect(element.querySelector('[data-plan-pending]')?.textContent).toBe("false");
	await act(async () => { for (const listener of fake.events.get("native:changed") ?? []) listener({ hostId: "host", snapshot: { modes: { ...modes, goal: { status: "paused" } }, theme: null } }); });
	expect(element.querySelector('[data-status="two"]')?.textContent).toContain('"goal":"paused"');
	expect(element.querySelector('[data-tour="permission"]')?.textContent).toContain("Goal paused");
	await act(async () => { for (const listener of fake.events.get("native:changed") ?? []) listener({ hostId: "host", snapshot: { modes: { ...modes, plan: { status: "active" }, vibe: { status: "active" }, loop: { status: "active" } }, theme: null } }); });
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain('"plan":"on"');
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain('"vibe":true');
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain('"loop":true');
	expect(element.querySelector('[data-tour="permission"]')?.textContent).toContain("Plan mode");
	await act(async () => { for (const listener of fake.events.get("native:changed") ?? []) listener({ hostId: "host", snapshot: { modes: { ...modes, goal: { status: "inactive" }, vibe: { status: "active" } }, theme: null } }); });
	expect(element.querySelector('[data-tour="permission"]')?.textContent).toContain("Vibe mode");
	expect(element.querySelector('[data-tour="permission"]')?.textContent).toContain("Ask me first");
	expect(calls("host:screen")).toHaveLength(0);
});

it("keeps classic screen polling and next-message prediction offers while mounted", async () => {
	setHost("classic"); await mount(); await advance(3_000);
	expect(calls("host:screen").length).toBeGreaterThan(3);
	expect(calls("composer:tuiPrediction").length).toBeGreaterThan(3);
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain("Opus 5.5");
	expect(element.querySelector("[data-composer-ghost]")?.textContent).toBe("Run the tests");
});

it("shows semantic ghost text and accepts Tab without polling omp's painted editor", async () => {
	setHost("tsp");
	view = { ...view, host: { ...view.host!, tspComposer: { sendable: true, text: "", cursor: 0, ghost: "Run the recorded tests", editorId: "e", surfaceId: "s", queued: [], blockedBy: null } } };
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "native:snapshot") return { modes, theme: null };
		if (channel === "composer:takePrediction") return { id: "capture", text: "Run the recorded tests", blocked: false, error: null };
		return undefined;
	});
	await mount();
	expect(element.querySelector("[data-composer-ghost]")?.textContent).toBe("Run the recorded tests");
	await act(async () => element.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
	expect(calls("composer:takePrediction")[0]?.[1]).toMatchObject({ hostId: "host", generation: 1, expectedGhost: "Run the recorded tests" });
	expect(useComposerDrafts.getState().drafts.polling).toBe("Run the recorded tests");
	expect(calls("composer:tuiPrediction")).toHaveLength(0);
	expect(calls("host:screen")).toHaveLength(0);
});

it("cancels existing classic polling when the host becomes TSP and discards in-flight painted results", async () => {
	const screen = Promise.withResolvers<string[]>(); const prediction = Promise.withResolvers<string>();
	fake.invoke.mockImplementation(async (channel: string) => channel === "host:screen" ? screen.promise : channel === "composer:tuiPrediction" ? prediction.promise : channel === "native:snapshot" ? { modes, theme: null } : undefined);
	setHost("classic"); await mount();
	expect(calls("host:screen").length).toBeGreaterThan(0); expect(calls("composer:tuiPrediction").length).toBeGreaterThan(0);
	await act(async () => setHost("tsp")); fake.invoke.mockClear();
	await act(async () => { screen.resolve(["╭── π ▶ ⬢ Old model · ◕ xhigh ──╮", "╰─                          ─╯"]); prediction.resolve("Old prediction"); });
	await advance(60_000);
	expect(calls("host:screen")).toHaveLength(0); expect(calls("composer:tuiPrediction")).toHaveLength(0);
	expect(element.querySelector('[data-status="one"]')?.textContent).not.toContain("Old model");
	expect(element.querySelector("[data-composer-ghost]")).toBeNull();
	await act(async () => element.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
	expect(calls("composer:takePrediction")).toHaveLength(0);
});

it("starts classic polling after a subscribed TSP chat is replaced by a classic host", async () => {
	setHost("tsp"); await mount(); await advance(3_000); expect(calls("host:screen")).toHaveLength(0);
	await act(async () => setHost("classic")); await advance(3_000);
	expect(calls("host:screen").length).toBeGreaterThan(3); expect(calls("composer:tuiPrediction").length).toBeGreaterThan(3);
});

it("keeps a newer native mode event when the initial TSP snapshot arrives late", async () => {
	const initial = Promise.withResolvers<{ modes: SessionModes; theme: null }>();
	fake.invoke.mockImplementation(async (channel: string) => channel === "native:snapshot" ? initial.promise : undefined);
	setHost("tsp"); await mount();
	await act(async () => {
		for (const listener of fake.events.get("native:changed") ?? []) listener({ hostId: "host", snapshot: { modes: { ...modes, goal: { status: "paused" } }, theme: null } });
		initial.resolve({ modes, theme: null });
	});
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain('"goal":"paused"');
	fake.invoke.mockRejectedValueOnce(new Error("Temporary native snapshot failure"));
	await act(async () => { await screenPoller(session).refresh(); });
	expect(element.querySelector('[data-status="two"]')?.textContent).toContain('"goal":"paused"');
});

it("refuses incidental painted reads locally for TSP without invoking Electron", async () => {
	setHost("tsp");
	await expect(readScreen(session)).rejects.toThrow("not available in the TSP preview");
	await expect(waitForScreen(session, () => false)).rejects.toThrow("not available in the TSP preview");
	expect(calls("host:screen")).toHaveLength(0);
});

it.each(["reconnecting", "tsp"] as const)("keeps one screen loop after a classic %s cycle with a deferred old read", async transition => {
	const old = Promise.withResolvers<string[]>();
	let reads = 0;
	fake.invoke.mockImplementation(async (channel: string) => {
		if (channel === "native:snapshot") return { modes, theme: null };
		if (channel === "host:screen") return ++reads === 1 ? old.promise : ["╭── π ▶ ⬢ Fresh model · ◕ xhigh ──╮", "╰─                          ─╯"];
		return undefined;
	});
	setHost("classic");
	await act(async () => root.render(createElement(StatusConsumer, { id: "one" })));
	expect(calls("host:screen")).toHaveLength(1);
	await act(async () => transition === "tsp" ? setHost("tsp") : setHost("classic", "reconnecting"));
	await act(async () => setHost("classic"));
	expect(calls("host:screen")).toHaveLength(2);
	await act(async () => old.resolve(["╭── π ▶ ⬢ Stale model · ◕ xhigh ──╮", "╰─                          ─╯"]));
	expect(element.querySelector('[data-status="one"]')?.textContent).toContain("Fresh model");
	expect(element.querySelector('[data-status="one"]')?.textContent).not.toContain("Stale model");
	expect(vi.getTimerCount()).toBe(1);
	await advance(449); expect(calls("host:screen")).toHaveLength(2);
	await advance(1); expect(calls("host:screen")).toHaveLength(3);
	await advance(450); expect(calls("host:screen")).toHaveLength(4);
	expect(vi.getTimerCount()).toBe(1);
});

it("cannot revive or Tab-capture a resolved old prediction after a classic to TSP to classic cycle", async () => {
	setHost("classic"); await mount();
	expect(element.querySelector("[data-composer-ghost]")?.textContent).toBe("Run the tests");
	await act(async () => setHost("tsp"));
	const fresh = Promise.withResolvers<string>();
	const original = fake.invoke.getMockImplementation()!;
	fake.invoke.mockImplementation((channel: string, ...args: unknown[]) => channel === "composer:tuiPrediction" ? fresh.promise : original(channel, ...args));
	await act(async () => setHost("classic"));
	expect(element.querySelector("[data-composer-ghost]")).toBeNull();
	await act(async () => element.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
	expect(calls("composer:takePrediction")).toHaveLength(0);
	await act(async () => fresh.resolve("A fresh prediction"));
	expect(element.querySelector("[data-composer-ghost]")?.textContent).toBe("A fresh prediction");
});
