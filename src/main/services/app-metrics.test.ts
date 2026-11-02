import { describe, expect, it, vi } from "vitest";
import { AppMetricsSampler } from "./app-metrics";

const metric = (pid: number, seconds: number, workingSetSize = 1024, creationTime = 1) => ({ pid, creationTime, cpu: { cumulativeCPUUsage: seconds, percentCPUUsage: 999 }, memory: { workingSetSize } });

describe("AppMetricsSampler", () => {
	it("uses cumulative CPU seconds across app processes and converts working-set KiB to bytes", () => {
		let now = 1000;
		const read = vi.fn().mockReturnValue([metric(1, 10, 2048), metric(2, 5), metric(3, 0), metric(4, 1)]);
		const sampler = new AppMetricsSampler(read, 8, () => now);
		expect(sampler.sample()).toEqual({ cpuPercent: null, memoryBytes: 5 * 1024 ** 2 });
		now = 3000;
		read.mockReturnValue([metric(1, 12), metric(2, 6), metric(3, 0.5), metric(4, 1.5)]);
		expect(sampler.sample()).toEqual({ cpuPercent: 25, memoryBytes: 4 * 1024 ** 2 });
		now = 5000;
		expect(sampler.sample().cpuPercent).toBe(0);
		expect(sampler.sample(true).cpuPercent).toBeNull();
	});

	it.each([[], null, undefined, {}, [null], [{ pid: 1 }]])("keeps empty or malformed native output unavailable: %j", metrics => {
		const sampler = new AppMetricsSampler(() => metrics, 8);
		expect(sampler.sample()).toEqual({ cpuPercent: null, memoryBytes: null });
		expect(sampler.sample()).toEqual({ cpuPercent: null, memoryBytes: null });
	});

	it.each([undefined, null, -1, NaN, Infinity, "12"])("rejects invalid CPU fields without hiding valid RAM: %j", seconds => {
		let at = 0;
		const sampler = new AppMetricsSampler(() => [{ ...metric(1, 1), cpu: { cumulativeCPUUsage: seconds } }], 8, () => at += 2000);
		expect(sampler.sample()).toEqual({ cpuPercent: null, memoryBytes: 1024 ** 2 });
		expect(sampler.sample().cpuPercent).toBeNull();
	});

	it.each([undefined, null, -1, NaN, Infinity, 1.5, "12"])("rejects partial RAM totals: %j", workingSetSize => {
		const sampler = new AppMetricsSampler(() => [metric(1, 1), { ...metric(2, 1), memory: { workingSetSize } }], 8);
		expect(sampler.sample().memoryBytes).toBeNull();
	});

	it("does not bridge process creation, PID reuse, missing readings, counter rollback or failures", () => {
		let at = 0;
		const read = vi.fn().mockReturnValue([metric(1, 1)]);
		const sampler = new AppMetricsSampler(read, 2, () => at += 2000);
		sampler.sample();
		read.mockReturnValue([metric(1, 2, 1024, 2)]);
		expect(sampler.sample().cpuPercent).toBeNull();
		read.mockReturnValue([metric(1, 3, 1024, 2), metric(2, 0)]);
		expect(sampler.sample().cpuPercent).toBeNull();
		read.mockReturnValue([metric(1, 4, 1024, 2)]);
		expect(sampler.sample().cpuPercent).toBeNull();
		read.mockReturnValue([metric(1, 2, 1024, 2)]);
		expect(sampler.sample().cpuPercent).toBeNull();
		read.mockImplementationOnce(() => { throw new Error("native failure"); });
		expect(sampler.sample()).toEqual({ cpuPercent: null, memoryBytes: null });
		expect(sampler.sample().cpuPercent).toBeNull();
		read.mockReturnValue([metric(1, 3, 1024, 2)]);
		expect(sampler.sample().cpuPercent).toBe(25);
	});

	it("refuses duplicate identities and invalid capacity, and bounds capacity percent", () => {
		let at = 0;
		const read = vi.fn().mockReturnValue([metric(1, 0)]);
		const sampler = new AppMetricsSampler(read, 1, () => at += 2000);
		sampler.sample();
		read.mockReturnValue([metric(1, 3)]);
		expect(sampler.sample().cpuPercent).toBe(100);
		read.mockReturnValue([metric(1, 4), metric(1, 4)]);
		expect(sampler.sample().cpuPercent).toBeNull();
		const invalid = new AppMetricsSampler(read, 0, () => at += 2000);
		invalid.sample();
		expect(invalid.sample().cpuPercent).toBeNull();
	});

	it.each([NaN, Infinity, -1, 0, 1000])("leaves a nonfinite or non-increasing clock interval unavailable and recovers: %s", badAt => {
		let at = 1000;
		let seconds = 0;
		const sampler = new AppMetricsSampler(() => [metric(1, seconds++)], 2, () => at);
		expect(sampler.sample().cpuPercent).toBeNull();
		at = badAt;
		expect(sampler.sample().cpuPercent).toBeNull();
		at = 7000;
		sampler.sample();
		at = 9000;
		expect(sampler.sample().cpuPercent).toBe(25);
	});
});
