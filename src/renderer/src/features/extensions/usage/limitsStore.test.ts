import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageLimitsSnapshot } from "@shared/contracts/usage";
import { publishUsageLimits, refreshUsageLimits, subscribeUsageLimits, usageLimitsSnapshot } from "./limitsStore";

vi.mock("@/state/app", () => ({ allControllers: () => [], useApp: { subscribe: () => () => {} } }));

const snapshot = (generatedAt: number): UsageLimitsSnapshot => ({ generatedAt, reports: [], accountsWithoutUsage: [], disabledCredentials: [], capacity: {} });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("usage limits store", () => {
	it("keeps a newer sheet snapshot when an older passive read resolves after it", async () => {
		const reads: PromiseWithResolvers<UsageLimitsSnapshot>[] = [];
		const invoke = vi.fn(() => {
			const read = Promise.withResolvers<UsageLimitsSnapshot>();
			reads.push(read);
			return read.promise;
		});
		vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
		vi.stubGlobal("window", { vomp: { invoke }, setInterval: () => 1 });
		vi.stubGlobal("clearInterval", () => {});

		const stop = subscribeUsageLimits(() => {});
		expect(invoke).toHaveBeenCalledTimes(1);
		const passive = refreshUsageLimits();
		expect(invoke).toHaveBeenCalledTimes(1);
		// The sheet's manual refresh finishes first with a snapshot omp generated later.
		publishUsageLimits(snapshot(200));
		reads[0]?.resolve(snapshot(100));
		await passive;
		expect(usageLimitsSnapshot()?.generatedAt).toBe(200);

		// A passive read generated after the sheet's snapshot still replaces it.
		const next = refreshUsageLimits();
		expect(invoke).toHaveBeenCalledTimes(2);
		reads[1]?.resolve(snapshot(300));
		await next;
		expect(usageLimitsSnapshot()?.generatedAt).toBe(300);
		stop();
	});
});
