import { expect, it } from "vitest";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "../tsp-host";
import type { TspNode } from "../tsp";
import { promptCacheFact } from "./prompt-cache";

const host = { hostId: "host", generation: 2, tspEpoch: 3 };
const warm = { id: "cache", k: "seg", p: { role: "omp.composer.cache", aria: "Cached until 4:53 PM", title: "Cached until 4:53 PM\nNext message reads ~42k from cache" } } satisfies TspNode;
function snapshot(node: TspNode | null = warm): TspHostSnapshot {
	const surface = { open: { id: "session", mode: "inline", role: "omp.session" }, documentGeneration: 2,
		sequence: 1, focus: null, settled: [], closed: false, suspended: false, document: { id: "root", k: "col", c: [{ id: "dock", k: "col", c: node ? [node] : [] }] } } as TspSurfaceSnapshot & { documentGeneration: number };
	return { hostId: "host", generation: 2, epoch: 3, negotiated: true, lifecycle: "live", documentGeneration: 2, surfaces: [surface] } as TspHostSnapshot;
}
it("retains omp's next-request prediction and cache-read amount verbatim", () => {
	expect(promptCacheFact(snapshot(), host)).toEqual({ label: warm.p.aria, detail: warm.p.title, warning: false });
});
it("retains omp's miss reason and resend upper bound without recomputing them", () => {
	const miss = { ...warm, p: { ...warm.p, tone: "warning" as const, aria: "Not cached: system prompt changed", title: "Not cached: system prompt changed\nNext message re-sends up to ~42k" } };
	expect(promptCacheFact(snapshot(miss), host)).toEqual({ label: miss.p.aria, detail: miss.p.title, warning: true });
});
it("preserves inferred predictions rather than presenting them as confirmed hits", () => {
	const inferred = { ...warm, p: { ...warm.p, aria: "Likely cached until 4:53 PM" } };
	expect(promptCacheFact(snapshot(inferred), host)?.label).toBe(inferred.p.aria);
});
it("omits absent, hidden, incomplete or unsupported facts", () => {
	expect(promptCacheFact(snapshot(null), host)).toBeNull();
	for (const p of [{ ...warm.p, hidden: true }, { ...warm.p, aria: undefined }, { ...warm.p, title: undefined }, { ...warm.p, role: "omp.composer.fact" }]) expect(promptCacheFact(snapshot({ ...warm, p }), host)).toBeNull();
});
it("never reuses cache facts from another host, generation, epoch or stopped document", () => {
	for (const change of [{ hostId: "other" }, { generation: 1 }, { epoch: 2 }, { documentGeneration: 1 }, { lifecycle: "transitioning" as const }, { lifecycle: "exited" as const }, { negotiated: false }, { closing: true }]) expect(promptCacheFact({ ...snapshot(), ...change }, host)).toBeNull();
	expect(promptCacheFact(snapshot(), null)).toBeNull();
});
it("omits closed, suspended, stale and non-main-session surfaces", () => {
	for (const change of [{ closed: true }, { suspended: true }, { documentGeneration: 1 }, { open: { id: "other", mode: "screen" as const } }]) {
		const value = snapshot(); Object.assign(value.surfaces[0]!, change);
		expect(promptCacheFact(value, host)).toBeNull();
	}
});
