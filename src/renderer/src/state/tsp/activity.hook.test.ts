// @vitest-environment happy-dom
import type { TspNode } from "@shared/tsp";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionController, SessionView } from "../session";
import { type ShownActivity, useOmpActivity } from "./activity";

const store = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	let snapshot: unknown = null;
	return {
		get: () => snapshot,
		set(next: unknown) { snapshot = next; for (const listener of listeners) listener(); },
		subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
	};
});
vi.mock("./hosts", () => ({ tspHost: (hostId: string) => ({ hostId, getSnapshot: store.get, failed: () => false, subscribe: store.subscribe }) }));

const loader = (id: string): TspNode => ({ id, k: "row", p: { role: "omp.loader" }, c: [{ id: `${id}/message`, k: "text", p: { spans: [{ t: "Generating handoff… (", s: "muted" }, { t: "\u{f12b7}", s: "muted icon" }, { t: "to cancel)", s: "muted" }] } }] });
function tsp(epoch: number, nodes: TspNode[]): TspHostSnapshot {
	return { hostId: "host", generation: 1, epoch, revision: epoch, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: true, reason: null },
		surfaces: [{ open: { id: "s:1", mode: "inline", role: "omp.session" }, sequence: 1, closed: false, suspended: false, focus: null, settled: [], documentGeneration: 1,
			document: { id: "s:1", k: "col", c: [{ id: "dock", k: "col", c: nodes }] } }] } as TspHostSnapshot;
}

let root: Root; let element: HTMLDivElement; let view: SessionView; let shown: ShownActivity | null = null;
const sessionListeners = new Set<() => void>();
const keys = vi.fn(async () => {});
const session = {
	subscribe: (listener: () => void) => { sessionListeners.add(listener); return () => sessionListeners.delete(listener); },
	getSnapshot: () => view,
	keys,
} as unknown as SessionController;
function setEpoch(epoch: number) {
	view = { mode: "live", readOnly: false, host: { hostId: "host", generation: 1, transport: "tsp", tspEpoch: epoch } } as unknown as SessionView;
	for (const listener of sessionListeners) listener();
}
function Probe() { shown = useOmpActivity(session); return null; }

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000);
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	setEpoch(1);
	store.set(null);
	element = document.createElement("div");
	root = createRoot(element);
	await act(async () => root.render(createElement(Probe)));
});
afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
	keys.mockClear();
});

describe("useOmpActivity", () => {
	it("starts a new run when omp's replacement process reuses the surface and node ids", async () => {
		await act(async () => store.set(tsp(1, [loader("z")])));
		expect(shown).toMatchObject({ label: "Generating handoff…", since: 1_000 });
		vi.setSystemTime(5_000);
		await act(async () => { setEpoch(2); store.set(tsp(2, [loader("z")])); });
		expect(shown?.since).toBe(5_000);
	});
	it("starts a new run after a gap with no activity, even with reused ids", async () => {
		await act(async () => store.set(tsp(1, [loader("z")])));
		vi.setSystemTime(3_000);
		await act(async () => store.set(tsp(1, [])));
		expect(shown).toBeNull();
		vi.setSystemTime(7_000);
		await act(async () => store.set(tsp(1, [loader("z")])));
		expect(shown?.since).toBe(7_000);
	});
	it("ignores documents from another protocol epoch", async () => {
		await act(async () => store.set(tsp(2, [loader("z")])));
		expect(shown).toBeNull();
	});
	it("stops only the run it displayed", async () => {
		await act(async () => store.set(tsp(1, [loader("z")])));
		const first = shown!;
		await act(async () => { setEpoch(2); store.set(tsp(2, [loader("z")])); });
		first.stop();
		expect(keys).not.toHaveBeenCalled();
		const second = shown!;
		await act(async () => store.set(tsp(2, [])));
		second.stop();
		expect(keys).not.toHaveBeenCalled();
		await act(async () => store.set(tsp(2, [loader("y")])));
		shown!.stop();
		expect(keys).toHaveBeenCalledExactlyOnceWith("escape");
	});
	it("does not let a Stop from an earlier run cancel a later run that reuses its ids", async () => {
		await act(async () => store.set(tsp(1, [loader("z")])));
		const earlier = shown!;
		await act(async () => store.set(tsp(1, [])));
		await act(async () => store.set(tsp(1, [loader("z")])));
		earlier.stop();
		expect(keys).not.toHaveBeenCalled();
		shown!.stop();
		expect(keys).toHaveBeenCalledExactlyOnceWith("escape");
	});
});
