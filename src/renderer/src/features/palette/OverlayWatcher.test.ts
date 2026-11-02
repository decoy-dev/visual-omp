// @vitest-environment happy-dom
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { QuestionMatch } from "@shared/tsp/question-match";
import { TSP_ROLES } from "@shared/tsp/roles";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverlayWatcher } from "./OverlayWatcher";
import { autoOpened } from "./TerminalSheet";
const fake = vi.hoisted(() => ({ terminal: null as string | null, snapshot: null as TspHostSnapshot | null, open: vi.fn(), close: vi.fn(), invoke: vi.fn() }));
vi.mock("../../shell/hooks", () => ({ useSessionView: () => ({ mode: "live", readOnly: false, host: { hostId: "host", generation: 1, transport: "tsp" } }) }));
vi.mock("../tsp/useTsp", () => ({ useTsp: () => ({ snapshot: fake.snapshot }) }));
vi.mock("./TerminalSheet", () => ({ autoOpened: { tabId: null } }));
vi.mock("../../state/app", () => ({ controllerFor: () => ({}), useApp: Object.assign((select: (state: unknown) => unknown) => select({ view: "chat", activeTabId: "tab", splitTabId: null }), { getState: () => ({ terminalTabId: fake.terminal, openTerminal: fake.open, closeTerminal: fake.close }) }) }));
let root: Root; let element: HTMLDivElement;
const render = async () => { await act(async () => root.render(createElement(OverlayWatcher))); };
function snapshot(overlay: boolean, screen = false): TspHostSnapshot {
	return { hostId: "host", generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, availability: { available: false, reason: null }, failure: null, surfaces: [{ documentGeneration: 1, open: { id: "s:1", mode: screen ? "screen" : "inline" }, sequence: 1, closed: false, focus: null, suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "layer", k: "col", c: overlay ? [{ id: "menu", k: "picker", p: { title: "Options" } }] : [] }] } }] };
}
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fake.terminal = null; autoOpened.tabId = null; fake.open.mockReset().mockImplementation(id => { fake.terminal = id; }); fake.close.mockReset().mockImplementation(() => { fake.terminal = null; }); fake.snapshot = snapshot(false); fake.invoke.mockClear(); Object.assign(window, { vomp: { invoke: fake.invoke } }); element = document.createElement("div"); document.body.append(element); root = createRoot(element); });
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
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
	value.surfaces[0]!.document = { id: "s:1", k: "col", c: [{ id: place, k: "col", c: [{ id: "hook", k: "overlay", p: { role: TSP_ROLES.hookSelect, head: "Choose" } }] }] };
	return value;
}
it.each(["layer", "dock"] as const)("does not auto-open a matched hook in %s over the chat card", async place => {
	fake.snapshot = hookSnapshot("matched", place); await render();
	expect(fake.open).not.toHaveBeenCalled(); expect(autoOpened.tabId).toBeNull();
});
it.each(["layer", "dock"] as const)("closes an automatic %s hook sheet when the request becomes matched", async place => {
	fake.snapshot = hookSnapshot("unmatched", place); await render();
	expect(fake.open).toHaveBeenCalledExactlyOnceWith("tab"); expect(autoOpened.tabId).toBe("tab");
	fake.snapshot = hookSnapshot("matched", place); await render();
	expect(fake.close).toHaveBeenCalledOnce(); expect(autoOpened.tabId).toBeNull();
});
it("keeps a manually opened matched hook sheet available as a display-only view", async () => {
	fake.terminal = "tab"; fake.snapshot = hookSnapshot("matched", "layer"); await render();
	expect(fake.close).not.toHaveBeenCalled(); expect(fake.open).not.toHaveBeenCalled(); expect(autoOpened.tabId).toBeNull();
});
