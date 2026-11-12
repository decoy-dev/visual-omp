// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { TspShellProps } from "@shared/tsp/shell";
import { LiveShellProvider, type LiveShellScope } from "./context";
import { useLiveShell } from "./live";

const fixture = vi.hoisted(() => ({ snapshot: null as TspHostSnapshot | null, invoke: vi.fn(), listeners: new Set<() => void>() }));
const source = { getSnapshot: () => fixture.snapshot, subscribe: (listener: () => void) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; }, failed: () => false, hostId: "host" };
vi.mock("../../state/tsp/hosts", () => ({ tspHost: () => source }));
vi.hoisted(() => { Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
const props: TspShellProps = { presentation: {
	preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
	rows: [{ id: "row", depth: 0, node: "0:0:1", segments: [{ text: "printf fixture", node: "0:0:1" }], effects: [] }], original: [], output: "", executing: true, watches: [], timeline: { length: 1, cursor: 1, elapsedNs: 1, durationNs: 1 },
} };
function snapshot(epoch = 3): TspHostSnapshot {
	return { hostId: "host", generation: 2, revision: 1, epoch, negotiated: true, lifecycle: "live", documentGeneration: 2, failure: null, availability: { available: true, reason: null }, surfaces: [{
		open: { id: "surface", mode: "inline", role: "omp.session" }, sequence: 1, closed: false, suspended: false, focus: null, settled: [], documentGeneration: 2,
		document: { id: "surface", k: "col", c: [{ id: "main", k: "col", c: [{ id: "tool", k: "tool", p: { role: "omp.tool.bash", key: "call", name: "bash", title: "Bash", status: "running" }, c: [{ id: "shell", k: "shell", p: props }] }] }] },
	}] };
}
let root: Root;
let element: HTMLDivElement;
let callback: ((value: string) => void) | undefined;
function Probe() {
	const result = useLiveShell("call");
	callback = result.act;
	return createElement("button", { onClick: () => result.act("view:raw") }, result.projection ? "Projected" : "Plain command");
}
const scope: LiveShellScope = { hostId: "host", generation: 2, epoch: 3, readOnly: false };
async function render(next: LiveShellScope | null = scope) {
	await act(async () => root.render(next ? createElement(LiveShellProvider, { ...next, children: createElement(Probe) }) : createElement(Probe)));
}
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	fixture.snapshot = snapshot(); fixture.invoke.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", on: () => () => {}, invoke: fixture.invoke } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });
it("dispatches a canonical action to only the matching scoped live call", async () => {
	await render();
	expect(element.textContent).toBe("Projected");
	await act(async () => element.querySelector("button")!.click());
	expect(fixture.invoke).toHaveBeenCalledExactlyOnceWith("host:tsp-event", "host", 2, { ev: "action", sf: "surface", id: "shell", act: "shell-viz", value: "view:raw" }, 3);
});
it("keeps absent helper or saved scopes on the ordinary command", async () => {
	await render(null);
	expect(element.textContent).toBe("Plain command");
	await act(async () => element.querySelector("button")!.click());
	expect(fixture.invoke).not.toHaveBeenCalled();
});
it.each([{ ...scope, epoch: 1 }, { ...scope, generation: 1 }, { ...scope, hostId: "other" }, { ...scope, readOnly: true }])("does not claim or dispatch for a stale or read-only scope %#", async value => {
	await render(value);
	expect(element.textContent).toBe("Plain command");
	await act(async () => element.querySelector("button")!.click());
	expect(fixture.invoke).not.toHaveBeenCalled();
});
it("refuses a captured callback after its host epoch changes", async () => {
	await render(); const old = callback;
	fixture.snapshot = snapshot(4);
	await act(async () => old?.("play"));
	expect(fixture.invoke).not.toHaveBeenCalled();
});
it("does not retarget a callback when the exact shell node disappears", async () => {
	await render(); const old = callback;
	const next = snapshot(); next.surfaces[0]!.document = { id: "surface", k: "col" }; fixture.snapshot = next;
	await act(async () => old?.("view:raw"));
	expect(fixture.invoke).not.toHaveBeenCalled();
});
it("keeps callback identity stable across presentation frames", async () => {
	await render(); const old = callback;
	fixture.snapshot = { ...snapshot(), revision: 2 };
	await render();
	expect(callback).toBe(old);
});
it("keeps presentation notifications below outer cards and isolates unrelated call panes", async () => {
	const renders = { outer: 0, matching: 0, other: 0 };
	function Outer() { useLiveShell("call", true); renders.outer++; return null; }
	function Matching() { const { projection } = useLiveShell("call"); renders.matching++; return createElement("span", null, projection?.props.presentation.output); }
	function Other() { useLiveShell("other-call"); renders.other++; return null; }
	await act(async () => root.render(createElement(LiveShellProvider, { ...scope, children: [createElement(Outer, { key: "outer" }), createElement(Matching, { key: "matching" }), createElement(Other, { key: "other" })] })));
	const before = { ...renders };
	const next = snapshot();
	next.revision = 2;
	next.surfaces[0]!.document.c![0]!.c![0]!.c![0]!.p = { ...props, presentation: { ...props.presentation, output: "new frame" } };
	fixture.snapshot = next;
	await act(async () => { for (const listener of fixture.listeners) listener(); });
	expect(renders.outer).toBe(before.outer);
	expect(renders.other).toBe(before.other);
	expect(renders.matching).toBe(before.matching + 1);
	expect(element.textContent).toBe("new frame");
});
