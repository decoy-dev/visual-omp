// @vitest-environment happy-dom
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { QuestionMatch } from "@shared/tsp/question-match";
import { TSP_ROLES } from "@shared/tsp/roles";
import { commandPanelFrames } from "@shared/tsp/testing/command-panel-fixtures";
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverlayWatcher } from "./OverlayWatcher";
import { autoOpened } from "./TerminalSheet";
import { PresentationVisibility, presentationClaims } from "../../state/tsp/presentation-claims";
import { screenActivity } from "../../state/tsp/screen-activity";
const releaseClaims: (() => void)[] = [];
const claimHook = () => releaseClaims.push(presentationClaims.acquire({ hostId: "host", epoch: 1, surfaceId: "s:1", nodeId: "hook" }));
const fake = vi.hoisted(() => {
	const state = { active: "tab", split: null as string | null, terminal: null as string | null, snapshot: null as TspHostSnapshot | null, transport: "tsp" as "tsp" | "classic", overlays: 0, open: vi.fn(), close: vi.fn(), invoke: vi.fn(), storeListeners: new Set<() => void>(), sessionListeners: new Set<() => void>(), appListeners: new Set<() => void>() };
	const controller = (hostId: string) => ({
		getSnapshot: () => ({ mode: "live", readOnly: false, host: { hostId, generation: 1, transport: state.transport, tui: { overlays: state.overlays, focused: "editor", overlayKinds: [] } } }),
		subscribe: (listener: () => void) => { state.sessionListeners.add(listener); return () => state.sessionListeners.delete(listener); },
	});
	return Object.assign(state, {
		primary: controller("host"), secondary: controller("other"),
		store: { getSnapshot: () => state.snapshot, subscribe: (listener: () => void) => { state.storeListeners.add(listener); return () => state.storeListeners.delete(listener); } },
		otherStore: { getSnapshot: () => null, subscribe: () => () => {} },
	});
});
vi.mock("../../shell/hooks", () => ({ useSessionView: (controller: typeof fake.primary) => controller.getSnapshot() }));
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: (hostId: string) => ({ snapshot: hostId === "host" ? fake.snapshot : null, store: hostId === "host" ? fake.store : fake.otherStore }) }));
vi.mock("./TerminalSheet", () => ({ autoOpened: { tabId: null } }));
vi.mock("../../state/app", () => ({
	controllerFor: (tabId: string) => tabId === "tab" ? fake.primary : fake.secondary,
	useApp: Object.assign((select: (state: unknown) => unknown) => select({ view: "chat", activeTabId: fake.active, splitTabId: fake.split }), {
		getState: () => ({ view: "chat", activeTabId: fake.active, splitTabId: fake.split, terminalTabId: fake.terminal, openTerminal: fake.open, closeTerminal: fake.close }),
		subscribe: (listener: () => void) => { fake.appListeners.add(listener); return () => fake.appListeners.delete(listener); },
	}),
}));
let root: Root; let element: HTMLDivElement;
const advance = async (ms = 300) => { await act(async () => vi.advanceTimersByTimeAsync(ms)); };
const render = async (settle = true) => { await act(async () => root.render(createElement(OverlayWatcher))); if (settle) await advance(); };
function snapshot(overlay: boolean, screen = false): TspHostSnapshot {
	return { hostId: "host", generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: null }, failure: null, surfaces: [{ documentGeneration: 1, open: { id: "s:1", mode: screen ? "screen" : "inline" }, sequence: 1, closed: false, focus: null, suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: overlay ? [{ id: "menu", k: "picker", p: { title: "Options" } }] : [] }] } }] };
}
beforeEach(() => { vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fake.terminal = null; autoOpened.tabId = null; fake.open.mockReset().mockImplementation(id => { fake.terminal = id; for (const listener of fake.appListeners) listener(); }); fake.close.mockReset().mockImplementation(() => { fake.terminal = null; for (const listener of fake.appListeners) listener(); }); fake.snapshot = snapshot(false); fake.invoke.mockClear(); Object.assign(window, { vomp: { invoke: fake.invoke } }); element = document.createElement("div"); document.body.append(element); root = createRoot(element); });
beforeEach(() => { fake.active = "tab"; fake.split = null; fake.transport = "tsp"; fake.overlays = 0; });
afterEach(async () => { await act(async () => root.unmount()); for (const release of releaseClaims.splice(0)) release(); element.remove(); vi.useRealTimers(); });
it.each(["overlay", "screen"])("keeps an unsolicited omp %s closed indefinitely", async kind => {
	fake.snapshot = snapshot(kind === "overlay", kind === "screen");
	await render(false); await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
	expect(fake.invoke).not.toHaveBeenCalled();
});

it("does not open for a rate-limit error and task output", async () => {
	fake.snapshot = snapshot(false, true);
	fake.snapshot.surfaces[0]!.document.c = [{ id: "main", k: "col", c: [
		{ id: "rate-limit", k: "text", p: { text: "429 rate_limit_error: Please try again later." } },
		{ id: "tasks", k: "text", p: { text: "8 of 13 tasks complete" } },
	] }];
	await render(false); await advance(60_000);
	expect(fake.terminal).toBeNull();
	expect(fake.open).not.toHaveBeenCalled();
});

it("opens requested content immediately and closes when that content leaves", async () => {
	fake.snapshot = snapshot(true);
	releaseClaims.push(screenActivity.hold(fake.snapshot, "request"));
	await render(false);
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
	fake.snapshot = snapshot(false);
	await render(false);
	expect(fake.close).toHaveBeenCalledOnce();
});

it("keeps a manually opened sheet open after native content leaves", async () => {
	fake.terminal = "tab"; await render();
	fake.snapshot = snapshot(true); await render();
	fake.snapshot = snapshot(false); await render();
	expect(fake.close).not.toHaveBeenCalled();
});

function hookSnapshot(status: QuestionMatch["status"], place: "layer" | "dock"): TspHostSnapshot {
	const value = snapshot(false);
	value.questionMatches = [{ surfaceId: "s:1", nodeId: "hook", status }];
	value.surfaces[0]!.document = { id: "s:1", k: "col", c: [{ id: place, k: "col", c: [{ id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "0", label: "First option" }] } }] }] }] };
	return value;
}

it.each(["matched", "ambiguous", "unmatched", "unavailable", "settling", "answering"] as const)("keeps a %s question in chat without requesting its screen", async status => {
	fake.snapshot = hookSnapshot(status, "dock");
	await render(); await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
});

it("keeps unclaimed output closed when a question card releases its claim", async () => {
	fake.snapshot = hookSnapshot("unmatched", "layer"); claimHook(); await render();
	await act(async () => releaseClaims.pop()!());
	await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
});

it.each(["layer", "dock"] as const)("allows an explicit request to view an ambiguous %s hook", async place => {
	fake.snapshot = hookSnapshot("ambiguous", place);
	releaseClaims.push(screenActivity.hold(fake.snapshot, "request"));
	await render(false);
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it("closes a command-opened hook when its chat card claims it", async () => {
	fake.snapshot = hookSnapshot("unmatched", "layer");
	releaseClaims.push(screenActivity.hold(fake.snapshot, "request"));
	await render(false);
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
	await act(async () => claimHook()); await render(false);
	expect(fake.close).toHaveBeenCalledOnce();
});

it.each(["cleanse", "omfg-error-panel"])("does not open an unsolicited %s board", async name => {
	fake.snapshot = commandPanelFrames(name).at(-1)!;
	await render(); await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
});

it.each(["primary", "secondary"])("does not open when the %s split pane becomes visible without a request", async hidden => {
	fake.active = hidden === "primary" ? "tab" : "other";
	fake.split = hidden === "primary" ? "other" : "tab";
	fake.snapshot = snapshot(true);
	const layout = (visible: boolean) => createElement(Fragment, null,
		createElement(PresentationVisibility, { tabId: "tab", visible }),
		createElement(OverlayWatcher));
	await act(async () => root.render(layout(false)));
	await act(async () => root.render(layout(true)));
	await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
});

it("does not open a leftover picker after an app drive ends", async () => {
	fake.snapshot = snapshot(true);
	const release = screenActivity.hold(fake.snapshot, "drive"); releaseClaims.push(release);
	await render(); await act(async () => release()); await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
});

it("waits for an app drive to end before honoring an explicit request", async () => {
	fake.snapshot = snapshot(true);
	const drive = screenActivity.hold(fake.snapshot, "drive");
	releaseClaims.push(screenActivity.hold(fake.snapshot, "request"), drive);
	await render(false); expect(fake.open).not.toHaveBeenCalled();
	await act(async () => drive());
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it("does not reopen a command screen after its request has ended", async () => {
	fake.snapshot = snapshot(true);
	const release = screenActivity.hold(fake.snapshot, "request"); releaseClaims.push(release);
	await render(false);
	await act(async () => { release(); fake.terminal = null; autoOpened.tabId = null; });
	fake.snapshot = { ...fake.snapshot!, revision: 2 };
	await render(); await advance(60_000);
	expect(fake.open).toHaveBeenCalledTimes(1);
});

it("rejects an explicit request from a previous epoch", async () => {
	fake.snapshot = snapshot(true);
	releaseClaims.push(screenActivity.hold({ ...fake.snapshot, epoch: 0 }, "request"));
	await render(); await advance(60_000);
	expect(fake.open).not.toHaveBeenCalled();
});

it("keeps classic overlays closed until requested", async () => {
	fake.transport = "classic"; fake.overlays = 1;
	fake.invoke.mockResolvedValue(["Unrecognized omp UI"]);
	await render(); await advance(60_000);
	expect(fake.invoke).not.toHaveBeenCalled();
	expect(fake.open).not.toHaveBeenCalled();
	releaseClaims.push(screenActivity.hold({ hostId: "host", generation: 1, epoch: null }, "request"));
	await render(false);
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it("ignores a classic screen read that finishes after its request is cancelled", async () => {
	fake.transport = "classic"; fake.overlays = 1;
	const read = Promise.withResolvers<string[]>();
	fake.invoke.mockReturnValue(read.promise);
	const release = screenActivity.hold({ hostId: "host", generation: 1, epoch: null }, "request");
	releaseClaims.push(release);
	await render(false);
	await act(async () => { release(); read.resolve(["Unrecognized omp UI"]); });
	expect(fake.open).not.toHaveBeenCalled();
});
