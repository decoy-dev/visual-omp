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
it.each(["overlay", "screen"])("settles an omp %s for 300 ms and closes its automatic sheet immediately", async kind => {
	fake.snapshot = snapshot(kind === "overlay", kind === "screen"); await render(false);
	await advance(299); expect(fake.open).not.toHaveBeenCalled();
	await advance(1); expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab"); expect(autoOpened.tabId).toBe("tab"); expect(fake.invoke).not.toHaveBeenCalled();
	fake.snapshot = snapshot(false); await render(false); expect(fake.close).toHaveBeenCalledOnce();
});
it("keeps a manually opened sheet open after omp dismisses its overlay", async () => {
	fake.terminal = "tab"; await render(); fake.snapshot = snapshot(true); await render(); expect(autoOpened.tabId).toBeNull(); fake.snapshot = snapshot(false); await render(); expect(fake.close).not.toHaveBeenCalled();
});
function hookSnapshot(status: QuestionMatch["status"], place: "layer" | "dock"): TspHostSnapshot {
	const value = snapshot(false);
	value.questionMatches = [{ surfaceId: "s:1", nodeId: "hook", status }];
	value.surfaces[0]!.document = { id: "s:1", k: "col", c: [{ id: place, k: "col", c: [{ id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" }, c: [{ id: "pick", k: "picker", p: { items: [{ id: "0", label: "First option" }] } }] }] }] };
	return value;
}
it.each(["layer", "dock"] as const)("does not auto-open a matched hook in %s over the chat card", async place => {
	fake.snapshot = hookSnapshot("matched", place); claimHook(); await render();
	expect(fake.open).not.toHaveBeenCalled(); expect(autoOpened.tabId).toBeNull();
});
it.each(["layer", "dock"] as const)("closes an automatic %s hook sheet when a mounted card claims it", async place => {
	fake.snapshot = hookSnapshot("unmatched", place); await render();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab"); expect(autoOpened.tabId).toBe("tab");
	fake.snapshot = hookSnapshot("matched", place); await act(async () => { claimHook(); }); await render();
	expect(fake.close).toHaveBeenCalledOnce(); expect(autoOpened.tabId).toBeNull();
});
it("keeps a manually opened matched hook sheet available as a display-only view", async () => {
	fake.terminal = "tab"; fake.snapshot = hookSnapshot("matched", "layer"); await render();
	expect(fake.close).not.toHaveBeenCalled(); expect(fake.open).not.toHaveBeenCalled(); expect(autoOpened.tabId).toBeNull();
});

it.each((["unmatched", "ambiguous", "unavailable", "answering"] as const).flatMap(status => (["layer", "dock"] as const).map(place => ({ status, place }))))("keeps the sheet closed for a native $status hook card in $place", async ({ status, place }) => {
	fake.snapshot = hookSnapshot(status, place);
	claimHook();
	await render();
	expect(fake.open).not.toHaveBeenCalled();
	expect(autoOpened.tabId).toBeNull();
	expect(fake.invoke).not.toHaveBeenCalled();
});

it("auto-opens the generic hook after the last visible native consumer releases it", async () => {
	fake.snapshot = hookSnapshot("unmatched", "layer"); claimHook(); await render();
	expect(fake.open).not.toHaveBeenCalled();
	await act(async () => releaseClaims.pop()!());
	await advance();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it("suppresses a claimed advisor screen only during apply and keeps unrelated screen content visible", async () => {
	fake.snapshot = snapshot(false, true);
	const surface = fake.snapshot.surfaces[0]!;
	surface.document.c = [{ id: "main", k: "col", c: [{ id: "advisor", k: "prefs", p: {
		title: "Advisors", page: "shared", pages: [{ id: "shared", label: "Shared instructions" }],
		sections: [{ id: "file", title: "WATCHDOG.yml · project", rows: [
			{ id: "save", label: "Save & apply", control: { k: "action", label: "Save", act: "save" } },
			{ id: "add", label: "Add advisor", control: { k: "action", label: "Add", act: "add" } },
			{ id: "scope", label: "Scope", control: { k: "action", label: "Open user", act: "scope" } },
		] }],
	} }] }];
	const release = presentationClaims.acquire({ hostId: "host", epoch: 1, surfaceId: "s:1", nodeId: "advisor" });
	releaseClaims.push(release);
	await render();
	expect(fake.open).not.toHaveBeenCalled();
	fake.snapshot = structuredClone(fake.snapshot);
	fake.snapshot.surfaces[0]!.document.c![0]!.c = [...fake.snapshot.surfaces[0]!.document.c![0]!.c!, { id: "other", k: "text", p: { text: "Unclaimed omp output" } }];
	await render();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
	fake.snapshot = structuredClone(fake.snapshot);
	fake.snapshot.surfaces[0]!.document.c![0]!.c = fake.snapshot.surfaces[0]!.document.c![0]!.c!.slice(0, -1);
	await render();
	expect(fake.close).toHaveBeenCalledOnce();
	await act(async () => release());
	await advance();
	expect(fake.open).toHaveBeenCalledTimes(2);
});

it.each(["cleanse", "omfg-error-panel"])("opens the %s dock board after its native question closes", async name => {
	const frames = commandPanelFrames(name);
	fake.snapshot = frames.at(-1)!;
	await render();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it.each(["primary", "secondary"])("does not open a sheet for the hidden %s split pane and opens when revealed", async hidden => {
	fake.active = hidden === "primary" ? "tab" : "other";
	fake.split = hidden === "primary" ? "other" : "tab";
	fake.snapshot = commandPanelFrames("omfg-error-panel").at(-1)!;
	const layout = (visible: boolean) => createElement(Fragment, null,
		createElement(PresentationVisibility, { tabId: "tab", visible }),
		createElement(PresentationVisibility, { tabId: "other", visible: true }),
		createElement(OverlayWatcher));
	await act(async () => root.render(layout(false)));
	expect(fake.open).not.toHaveBeenCalled();
	expect(fake.terminal).toBeNull();
	await act(async () => root.render(layout(true)));
	await advance();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});

it("keeps a 150 ms unpresented picker closed", async () => {
	fake.snapshot = snapshot(true); await render(false); await advance(150);
	fake.snapshot = snapshot(false); await render(false); await advance(500);
	expect(fake.open).not.toHaveBeenCalled();
});

it("does not restart the settle window for unrelated snapshot or selection updates", async () => {
	fake.snapshot = snapshot(true); await render(false); await advance(200);
	fake.snapshot = structuredClone(fake.snapshot); fake.snapshot.revision++;
	await render(false); await advance(99); expect(fake.open).not.toHaveBeenCalled();
	await advance(1); expect(fake.open).toHaveBeenCalledOnce();
});

it("observes a semantic disappearance skipped by the visual snapshot", async () => {
	fake.snapshot = snapshot(true); await render(false); await advance(200);
	fake.snapshot = snapshot(false); for (const listener of fake.storeListeners) listener();
	fake.snapshot = snapshot(true); for (const listener of fake.storeListeners) listener();
	await advance(100); expect(fake.open).not.toHaveBeenCalled();
	await advance(199); expect(fake.open).not.toHaveBeenCalled();
	await advance(1); expect(fake.open).toHaveBeenCalledOnce();
});

it("holds an app-driven picker beyond the settle interval and starts fresh after final release", async () => {
	fake.snapshot = snapshot(true);
	const first = screenActivity.hold(fake.snapshot, "drive");
	const second = screenActivity.hold(fake.snapshot, "drive");
	releaseClaims.push(first, second);
	await render(false); await advance(1000); expect(fake.open).not.toHaveBeenCalled();
	await act(async () => first()); await advance(500); expect(fake.open).not.toHaveBeenCalled();
	await act(async () => second()); await advance(299); expect(fake.open).not.toHaveBeenCalled();
	await advance(1); expect(fake.open).toHaveBeenCalledOnce();
});

it("opens explicit requested content immediately but never auto-opens over a drive lease", async () => {
	fake.snapshot = snapshot(true);
	const request = screenActivity.hold(fake.snapshot, "request");
	const drive = screenActivity.hold(fake.snapshot, "drive");
	releaseClaims.push(request, drive);
	await render(false); await advance(500); expect(fake.open).not.toHaveBeenCalled();
	await act(async () => drive());
	expect(fake.open).toHaveBeenCalledOnce();
});

it("does not close an already visible sheet just because an app drive starts", async () => {
	fake.snapshot = snapshot(true); await render();
	await act(async () => { releaseClaims.push(screenActivity.hold(fake.snapshot!, "drive")); });
	expect(fake.terminal).toBe("tab"); expect(fake.close).not.toHaveBeenCalled();
});

it("restarts continuity for a replacement candidate and ignores old-epoch leases", async () => {
	fake.snapshot = snapshot(true); releaseClaims.push(screenActivity.hold({ ...fake.snapshot, epoch: 0 }, "drive"));
	await render(false); await advance(200);
	fake.snapshot = snapshot(true); fake.snapshot.surfaces[0]!.document.c![0]!.c![0]!.id = "replacement";
	await render(false); await advance(299); expect(fake.open).not.toHaveBeenCalled();
	await advance(1); expect(fake.open).toHaveBeenCalledOnce();
});

it("keeps hidden-window candidates closed and settles after visibility returns", async () => {
	const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
	try {
		fake.snapshot = snapshot(true); await render(false); await advance(150);
		await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
		await advance(1000); expect(fake.open).not.toHaveBeenCalled();
		await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
		await advance(299); expect(fake.open).not.toHaveBeenCalled();
		await advance(1); expect(fake.open).toHaveBeenCalledOnce();
	} finally {
		if (original) Object.defineProperty(document, "visibilityState", original);
		else Reflect.deleteProperty(document, "visibilityState");
	}
});

it("also suppresses classic automatic sheets during an internal navigation drive", async () => {
	fake.transport = "classic"; fake.overlays = 1;
	fake.invoke.mockResolvedValue(["Unrecognized omp UI"]);
	const release = screenActivity.hold({ hostId: "host", generation: 1, epoch: null }, "drive"); releaseClaims.push(release);
	await render(false); await advance(1000); expect(fake.open).not.toHaveBeenCalled();
	await act(async () => release()); await advance();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});
