// @vitest-environment happy-dom
import type { TspHostSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tspHost } from "./hosts";

function snapshot(revision: number, lifecycle: TspHostSnapshot["lifecycle"] = "live", text = `revision ${revision}`): TspHostSnapshot {
	return {
		hostId: "host", generation: 1, revision, epoch: 1, availability: { available: true, reason: null }, negotiated: true,
		lifecycle, documentGeneration: 1, failure: null,
		surfaces: [{ open: { id: "s:1", mode: "inline" }, sequence: revision, closed: false, focus: null, suspended: false, settled: [], documentGeneration: 1,
			document: { id: "s:1", k: "col", c: [{ id: "editor", k: "editor", p: { text, sendable: true } }] } }],
	};
}

let patches: ((patch: TspHostPatch) => void) | null;
let reads: PromiseWithResolvers<TspHostSnapshot | null>[];
const off = vi.fn();

beforeEach(() => {
	vi.useFakeTimers();
	patches = null; reads = []; off.mockClear();
	Object.assign(window, { vomp: {
		on: (channel: string, listener: (patch: TspHostPatch) => void) => {
			if (channel === "host:tsp-patch") patches = listener;
			return () => { off(); patches = null; };
		},
		invoke: (channel: string) => {
			if (channel !== "host:tsp-snapshot") throw new Error(`unexpected ${channel}`);
			const read = Promise.withResolvers<TspHostSnapshot | null>();
			reads.push(read);
			return read.promise;
		},
	} });
});
afterEach(() => { vi.useRealTimers(); });

/** Subscribes and records what each notification showed. */
function watch() {
	const source = tspHost("host");
	const seen: { revision: number | null; lifecycle: string | null; failed: boolean }[] = [];
	const unsubscribe = source.subscribe(() => {
		const current = source.getSnapshot();
		seen.push({ revision: current?.revision ?? null, lifecycle: current?.lifecycle ?? null, failed: source.failed() });
	});
	return { source, seen, unsubscribe };
}

describe("shared TSP host documents", () => {
	it("shows a read together with the patches that arrived during it", async () => {
		const { seen, unsubscribe } = watch();
		// The read was answered before omp went live; the live patch was sent after it.
		patches!(tspHostPatch(snapshot(1, "transitioning"), snapshot(2)));
		reads[0]!.resolve(snapshot(1, "transitioning"));
		await vi.advanceTimersByTimeAsync(0);
		expect(seen).toEqual([{ revision: 2, lifecycle: "live", failed: false }]);
		unsubscribe(); await vi.advanceTimersByTimeAsync(0);
	});

	it("keeps a document that arrived while its read failed", async () => {
		const { source, seen, unsubscribe } = watch();
		patches!(tspHostPatch(null, snapshot(1)));
		reads[0]!.reject(new Error("read failed"));
		await vi.advanceTimersByTimeAsync(5000);
		expect(seen).toEqual([{ revision: 1, lifecycle: "live", failed: false }]);
		expect(source.failed()).toBe(false);
		expect(reads).toHaveLength(1);
		unsubscribe(); await vi.advanceTimersByTimeAsync(0);
	});

	it("hides a copy that fell behind until a later read brings it current", async () => {
		const { source, unsubscribe } = watch();
		reads[0]!.resolve(snapshot(1));
		await vi.advanceTimersByTimeAsync(0);
		patches!(tspHostPatch(snapshot(4), snapshot(5)));
		expect(reads).toHaveLength(2);
		reads[1]!.reject(new Error("read failed"));
		await vi.advanceTimersByTimeAsync(0);
		expect(source.failed()).toBe(true);
		expect(source.getSnapshot()).toBeNull();
		// No further patch arrives; the timed retry recovers on its own.
		await vi.advanceTimersByTimeAsync(1000);
		reads[2]!.resolve(snapshot(5));
		await vi.advanceTimersByTimeAsync(0);
		expect(source.failed()).toBe(false);
		expect(source.getSnapshot()?.revision).toBe(5);
		unsubscribe(); await vi.advanceTimersByTimeAsync(0);
	});

	it("stops reading after the last subscriber leaves", async () => {
		const { unsubscribe } = watch();
		reads[0]!.reject(new Error("read failed"));
		await vi.advanceTimersByTimeAsync(0);
		unsubscribe();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(reads).toHaveLength(1);
		expect(off).toHaveBeenCalledOnce();
	});

	it("lets a new subscriber retry after the timed retries are used up", async () => {
		const first = watch();
		for (const delay of [0, 1000, 4000]) {
			await vi.advanceTimersByTimeAsync(delay);
			reads.at(-1)!.reject(new Error("read failed"));
		}
		await vi.advanceTimersByTimeAsync(10_000);
		expect(reads).toHaveLength(3);
		expect(first.source.failed()).toBe(true);
		const second = watch();
		expect(reads).toHaveLength(4);
		reads[3]!.resolve(snapshot(1));
		await vi.advanceTimersByTimeAsync(0);
		expect(first.seen.at(-1)).toEqual({ revision: 1, lifecycle: "live", failed: false });
		first.unsubscribe(); second.unsubscribe(); await vi.advanceTimersByTimeAsync(0);
	});
});
