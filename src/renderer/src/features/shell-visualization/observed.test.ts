// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import type { ActiveTool } from "../../collab/lib/client";
import { ObservedShellProvider, useObservedShell, type ObservedShellStore, type ObservedShellTrace } from "./observed";

it("isolates observed trace revisions to their command consumer and preserves outer endpoint identity", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const listeners = new Set<() => void>();
	const tool = (id: string, seq: number): ActiveTool => ({ toolCallId: id, toolName: "bash", args: {}, startedAt: 0, partialResult: { details: { trace: { v: 1, seq } } } });
	let guest = { activeTools: new Map([["first", tool("first", 1)], ["second", tool("second", 1)]]), backgroundTools: new Map<string, ActiveTool>() };
	const store: ObservedShellStore = { getSnapshot: () => guest, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
	const renders = { outer: 0, first: 0, second: 0 };
	function Outer() { useObservedShell("first", true); renders.outer++; return null; }
	function First() { const source = useObservedShell("first"); renders.first++; return createElement("span", null, JSON.stringify(source?.trace)); }
	function Second() { useObservedShell("second"); renders.second++; return null; }
	const element = document.createElement("div"); document.body.append(element);
	const root = createRoot(element);
	try {
		await act(async () => root.render(createElement(ObservedShellProvider, { store, identity: "host:1:session:branch", cwd: "/fixture", children: [createElement(Outer, { key: "outer" }), createElement(First, { key: "first" }), createElement(Second, { key: "second" })] })));
		const before = { ...renders };
		guest = { activeTools: new Map([["second", guest.activeTools.get("second")!]]), backgroundTools: new Map([["first", tool("first", 2)]]) };
		await act(async () => { for (const notify of listeners) notify(); });
		expect(renders.outer).toBe(before.outer);
		expect(renders.second).toBe(before.second);
		expect(renders.first).toBe(before.first + 1);
		expect(element.textContent).toBe('{"v":1,"seq":2}');
		expect(guest.activeTools.has("first")).toBe(false);
	} finally { await act(async () => root.unmount()); element.remove(); }
});

it("retains execution metadata beside an opaque byte-array trace without changing chat setting scope", async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	const trace = { v: 1, units: [{ source: [255], nodes: [{ argv: ["printf", [255]] }] }] };
	const store: ObservedShellStore = { subscribe: () => () => {}, getSnapshot: () => ({ activeTools: new Map([["call", { toolCallId: "call", toolName: "bash", args: {}, startedAt: 0, partialResult: { details: { trace, cwd: "/", cdSeparator: ";" } } }]]), backgroundTools: new Map() }) };
	let observed: ObservedShellTrace | null = null;
	function Probe() { observed = useObservedShell("call"); return null; }
	const element = document.createElement("div");
	const root = createRoot(element);
	try {
		await act(async () => root.render(createElement(ObservedShellProvider, { store, identity: "host:branch", cwd: "/chat", children: createElement(Probe) })));
		expect(observed!).toEqual({ sourceId: JSON.stringify(["host:branch", "call"]), cwd: "/chat", executionCwd: "/", cdSeparator: ";", trace });
		expect(observed!.trace).toBe(trace);
	} finally { await act(async () => root.unmount()); }
});
