import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageLimitsSnapshot } from "@shared/contracts/usage";
import { checkUsageLimits, publishUsageLimits, refreshUsageLimits, subscribeUsageLimits, usageLimitsSnapshot, usageLimitsStatus } from "./limitsStore";

vi.mock("@/state/app", () => ({ allControllers: () => [], useApp: { subscribe: () => () => {} } }));

const snapshot = (generatedAt: number): UsageLimitsSnapshot => ({ generatedAt, reports: [], accountsWithoutUsage: [], disabledCredentials: [], capacity: {} });

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("usage limits store", () => {
	it("keeps a newer page snapshot when an older passive read resolves after it", async () => {
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
		// The page's manual refresh finishes first with a snapshot omp generated later.
		publishUsageLimits(snapshot(200));
		reads[0]?.resolve(snapshot(100));
		await passive;
		expect(usageLimitsSnapshot()?.generatedAt).toBe(200);

		// A passive read generated after the page's snapshot still replaces it.
		const next = refreshUsageLimits();
		expect(invoke).toHaveBeenCalledTimes(2);
		reads[1]?.resolve(snapshot(300));
		await next;
		expect(usageLimitsSnapshot()?.generatedAt).toBe(300);
		stop();
	});

	it("keeps the last snapshot when a refresh fails and clears the error after the next success", async () => {
		const invoke = vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method 'usage:limits': Error: omp timed out")).mockResolvedValueOnce(snapshot(500));
		vi.stubGlobal("window", { vomp: { invoke } });
		publishUsageLimits(snapshot(400));

		const failing = checkUsageLimits();
		expect(usageLimitsStatus().checking).toBe(true);
		await failing;
		expect(invoke).toHaveBeenCalledWith("usage:limits", { refresh: true });
		expect(usageLimitsStatus()).toEqual({ checking: false, error: "omp timed out" });
		expect(usageLimitsSnapshot()?.generatedAt).toBe(400);

		await checkUsageLimits();
		expect(usageLimitsStatus()).toEqual({ checking: false, error: null });
		expect(usageLimitsSnapshot()?.generatedAt).toBe(500);
	});
});
