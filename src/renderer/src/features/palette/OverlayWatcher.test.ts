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
const releaseClaims: (() => void)[] = [];
const claimHook = () => releaseClaims.push(presentationClaims.acquire({ hostId: "host", epoch: 1, surfaceId: "s:1", nodeId: "hook" }));
const fake = vi.hoisted(() => ({ active: "tab", split: null as string | null, terminal: null as string | null, snapshot: null as TspHostSnapshot | null, open: vi.fn(), close: vi.fn(), invoke: vi.fn() }));
vi.mock("../../shell/hooks", () => ({ useSessionView: (tabId: string) => ({ mode: "live", readOnly: false, host: { hostId: tabId === "tab" ? "host" : "other", generation: 1, transport: "tsp" } }) }));
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: (hostId: string) => ({ snapshot: hostId === "host" ? fake.snapshot : null }) }));
vi.mock("./TerminalSheet", () => ({ autoOpened: { tabId: null } }));
vi.mock("../../state/app", () => ({ controllerFor: (tabId: string) => tabId, useApp: Object.assign((select: (state: unknown) => unknown) => select({ view: "chat", activeTabId: fake.active, splitTabId: fake.split }), { getState: () => ({ terminalTabId: fake.terminal, openTerminal: fake.open, closeTerminal: fake.close }) }) }));
let root: Root; let element: HTMLDivElement;
const render = async () => { await act(async () => root.render(createElement(OverlayWatcher))); };
function snapshot(overlay: boolean, screen = false): TspHostSnapshot {
	return { hostId: "host", generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: null }, failure: null, surfaces: [{ documentGeneration: 1, open: { id: "s:1", mode: screen ? "screen" : "inline" }, sequence: 1, closed: false, focus: null, suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: overlay ? [{ id: "menu", k: "picker", p: { title: "Options" } }] : [] }] } }] };
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fake.terminal = null; autoOpened.tabId = null; fake.open.mockReset().mockImplementation(id => { fake.terminal = id; }); fake.close.mockReset().mockImplementation(() => { fake.terminal = null; }); fake.snapshot = snapshot(false); fake.invoke.mockClear(); Object.assign(window, { vomp: { invoke: fake.invoke } }); element = document.createElement("div"); document.body.append(element); root = createRoot(element); });
beforeEach(() => { fake.active = "tab"; fake.split = null; });
afterEach(async () => { await act(async () => root.unmount()); for (const release of releaseClaims.splice(0)) release(); element.remove(); });
it.each(["overlay", "screen"])("opens an omp %s immediately and closes only its automatic sheet", async kind => {
	fake.snapshot = snapshot(kind === "overlay", kind === "screen"); await render(); expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab"); expect(autoOpened.tabId).toBe("tab"); expect(fake.invoke).not.toHaveBeenCalled();
	fake.snapshot = snapshot(false); await render(); expect(fake.close).toHaveBeenCalledOnce();
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
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab");
});
