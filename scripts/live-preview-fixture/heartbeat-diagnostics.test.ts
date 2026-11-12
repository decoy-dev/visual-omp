import { setImmediate as immediate, setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createHeartbeatDiagnostics, type HeartbeatHookCallbacks } from "./heartbeat-diagnostics.mjs";

function collector(options: Parameters<typeof createHeartbeatDiagnostics>[0] = {}) {
	let clock = 0;
	let cpu = 0;
	let stage = "worker-startup";
	let hooks!: HeartbeatHookCallbacks;
	const enable = vi.fn();
	const disable = vi.fn();
	const value = createHeartbeatDiagnostics({
		now: () => clock, context: () => ({ stage, case: "direct" }), runtime: false, timers: false, threadCpuUsage: null,
		...options,
		...(options.asyncHooks ? { hookFactory(callbacks: HeartbeatHookCallbacks) { hooks = callbacks; return { enable, disable }; } } : {}),
		...(options.threadCpuUsage ? { threadCpuUsage: () => ({ user: cpu * 1000, system: 0 }) } : {}),
	});
	return { value, get hooks() { return hooks; }, enable, disable, at(time: number, cpuMs = cpu) { clock = time; cpu = cpuMs; }, stage(next: string) { stage = next; } };
}

describe("Windows gate heartbeat diagnostics", () => {
	it("records synchronous spawn from before entry and correlates every delayed interval", () => {
		const test = collector();
		test.at(5);
		const result = test.value.sync("child_process.spawn", () => {
			expect(test.value.snapshot().syncSpans[0]!.start).toBe(5);
			test.at(135);
			return 17;
		}, { origin: "production" });
		expect(result).toBe(17);
		test.at(140); test.value.beat();
		test.stage("worker-requests");
		test.at(165); test.value.beat();
		const report = test.value.stop();
		expect(report.ticks).toBe(2);
		expect(report.maxDelayMs).toBe(120);
		expect(report.gaps).toHaveLength(2);
		expect(report.gaps[0]).toMatchObject({ stage: "worker-startup", exceeded: true, syncOverlaps: [{ id: 1, overlapMs: 130 }], observedWorkMs: 130, unattributedIntervalMs: 10 });
		expect(report.gaps[1]).toMatchObject({ stage: "worker-requests", exceeded: false, syncOverlaps: [], attribution: "unattributed" });
	});

	it("does not double count nested parsing and handling spans", () => {
		const test = collector();
		test.at(10);
		test.value.sync("child.stdout.data.handlers", () => {
			test.at(20);
			test.value.sync("json.parse", () => { test.at(120); }, { inputChars: 400 });
			test.at(130);
		});
		test.at(150); test.value.beat();
		const report = test.value.stop();
		expect(report.gaps[0]!.syncOverlaps).toEqual([{ id: 1, overlapMs: 120 }, { id: 2, overlapMs: 100 }]);
		expect(report.gaps[0]!.observedWorkMs).toBe(120);
		expect(report.gaps[0]!.unattributedIntervalMs).toBe(30);
	});

	it("retains the 100 ms delay threshold and reports unknown causes as unattributed", () => {
		const test = collector();
		test.at(120); test.value.beat();
		test.at(241); test.value.beat();
		const report = test.value.stop();
		expect(report.gaps.map(gap => gap.exceeded)).toEqual([false, true]);
		expect(report.gaps.every(gap => gap.attribution === "unattributed")).toBe(true);
		expect(report.support).toEqual({ gc: false, eventLoopDelay: false, asyncHooks: false, threadCpuUsage: false });
		expect(report.eventLoopDelay).toBeNull();
	});

	it("records failed synchronous work without retaining its error or content", () => {
		const test = collector();
		test.at(3);
		expect(() => test.value.sync("json.parse", () => { test.at(40); throw new Error("private protocol contents"); }, { inputChars: 18 })).toThrow("private protocol contents");
		const report = test.value.stop();
		expect(report.syncSpans).toEqual([{ id: 1, label: "json.parse", start: 3, end: 40, durationMs: 37, mainThreadCpuMs: null, stage: "worker-startup", case: "direct", inputChars: 18, threw: true }]);
		expect(JSON.stringify(report)).not.toContain("private protocol contents");
		expect(report.gaps[0]).toMatchObject({ end: 40, syncOverlaps: [{ id: 1, overlapMs: 37 }] });
	});

	it("attributes previously unobserved continuations and native callbacks with separate thread CPU", () => {
		const test = collector({ asyncHooks: true, threadCpuUsage: () => ({ user: 0, system: 0 }) });
		test.stage("preflight-files");
		test.hooks.init(1, "PROMISE");
		test.at(5, 1); test.hooks.before(1);
		test.at(15, 9); test.hooks.after(1);
		test.stage("worker-startup");
		test.hooks.init(2, "PIPEWRAP");
		test.at(20, 10); test.hooks.before(2);
		test.at(145, 12); test.hooks.after(2);
		test.at(150, 13); test.value.beat();
		const report = test.value.stop();
		expect(test.enable).toHaveBeenCalledOnce();
		expect(test.disable).toHaveBeenCalledOnce();
		expect(report.callbacks).toMatchObject([
			{ asyncId: 1, resourceKind: "PROMISE", stage: "preflight-files", start: 5, end: 15, durationMs: 10, mainThreadCpuMs: 8 },
			{ asyncId: 2, resourceKind: "PIPEWRAP", stage: "worker-startup", start: 20, end: 145, durationMs: 125, mainThreadCpuMs: 2 },
		]);
		expect(report.mainThreadCpuMs).toBe(13);
		expect(report.gaps[0]).toMatchObject({ exceeded: true, mainThreadCpuMs: 13, wallMinusMainThreadCpuMs: 137, observedWorkMs: 135, unattributedIntervalMs: 15 });
		expect(report.gaps[0]!.callbackOverlaps).toEqual([{ id: 1, resourceKind: "PROMISE", overlapMs: 10 }, { id: 2, resourceKind: "PIPEWRAP", overlapMs: 125 }]);
		expect(report.cpuDefinition).toContain("No operating-system cause is inferred");
		expect(report.threadCpuUnavailableReason).toBeNull();
	});

	it("unions nested callback and synchronous wall ranges without summing inclusive CPU", () => {
		const test = collector({ asyncHooks: true });
		test.hooks.init(1, "PROMISE"); test.hooks.init(2, "TickObject");
		test.at(5); test.hooks.before(1);
		test.at(10); test.hooks.before(2);
		test.value.sync("json.parse", () => { test.at(110); });
		test.hooks.after(2);
		test.at(130); test.hooks.after(1);
		test.at(140); test.value.beat();
		const report = test.value.stop();
		expect(report.callbacks.map(callback => callback.durationMs)).toEqual([100, 125]);
		expect(report.gaps[0]).toMatchObject({ observedWorkMs: 125, unattributedIntervalMs: 15, syncOverlaps: [{ id: 1, overlapMs: 100 }] });
	});

	it("bounds records and resource tracking while retaining full-lifecycle failures and omission counts", () => {
		const test = collector({ asyncHooks: true, limits: { callbacks: 2, resources: 2, syncSpans: 2, gaps: 2, callbackDepth: 2 } });
		for (let id = 1; id <= 3; id++) test.hooks.init(id, "PROMISE");
		test.at(1); test.hooks.before(1);
		test.at(2); test.hooks.after(1);
		for (let id = 1; id <= 3; id++) {
			test.at(id * 10); test.hooks.before(id);
			test.value.sync("dispatch", () => { test.at(id * 10 + 5); });
			test.hooks.after(id);
		}
		test.at(150); test.value.beat();
		test.at(175); test.value.beat();
		test.at(200); test.value.beat();
		const report = test.value.stop();
		expect(report.callbacks.map(callback => callback.id)).toEqual([2, 3]);
		expect(report.syncSpans.map(span => span.id)).toEqual([2, 3]);
		expect(report.callbackCounts).toMatchObject({ started: 4, completed: 4, significant: 3, belowThreshold: 1, unknownResourceKind: 2 });
		expect(report.retention).toMatchObject({ omittedCallbacks: 1, omittedSyncSpans: 1, omittedGaps: 1, resourceEvictions: 1, belowThresholdCallbacks: 1, trackedResources: 0 });
		expect(report.gaps).toHaveLength(3);
		expect(report.gaps.map(gap => gap.exceeded)).toEqual([true, false, false]);
		expect(report.maxDelayMs).toBe(130);
		expect(report.exceededIntervals).toBe(1);
	});

	it("preserves early worst-gap CPU and overlapping work after all recent rings roll over", () => {
		const test = collector({ asyncHooks: true, threadCpuUsage: () => ({ user: 0, system: 0 }), limits: { callbacks: 2, syncSpans: 2, gaps: 2 } });
		test.hooks.init(1, "PROMISE");
		test.at(10, 2); test.hooks.before(1);
		test.at(20, 3);
		test.value.sync("production.worker.start", () => { test.at(125, 11); });
		test.at(140, 12); test.hooks.after(1);
		test.at(150, 13); test.value.beat();
		for (let index = 0; index < 20; index++) {
			const start = 150 + index * 25;
			test.at(start + 1, 13 + index); test.hooks.before(1);
			test.value.sync("later.dispatch", () => { test.at(start + 6, 14 + index); });
			test.hooks.after(1);
			test.at(start + 25, 14 + index); test.value.beat();
		}
		const report = test.value.stop();
		expect(report.retention.omittedGaps).toBe(19);
		expect(report.retention.omittedCallbacks).toBe(19);
		expect(report.retention.preservedWorstGaps).toEqual([{ start: 0, end: 150, delayMs: 130, omittedSyncSpans: 0, omittedCallbacks: 0, omittedGcEntries: 0 }]);
		expect(report.gaps).toHaveLength(3);
		expect(report.gaps[0]).toMatchObject({
			start: 0, end: 150, exceeded: true, mainThreadCpuMs: 13, wallMinusMainThreadCpuMs: 137,
			syncOverlaps: [{ id: 1, overlapMs: 105 }], callbackOverlaps: [{ id: 1, resourceKind: "PROMISE", overlapMs: 130 }],
			observedWorkMs: 130, unattributedIntervalMs: 20,
		});
		expect(report.callbacks[0]).toMatchObject({ id: 1, start: 10, end: 140, mainThreadCpuMs: 10 });
		expect(report.syncSpans[0]).toMatchObject({ id: 1, label: "production.worker.start", mainThreadCpuMs: 8 });
		expect(report.maxDelayMs).toBe(130);
		expect(report.exceededIntervals).toBe(1);
	});

	it("bounds preserved worst gaps and their overlapping spans with explicit omissions", () => {
		const test = collector({ limits: { gaps: 1, syncSpans: 2, worstGaps: 2, spansPerWorstGap: 1 } });
		let start = 0;
		for (const interval of [150, 175, 200]) {
			test.at(start + 5); test.value.sync("shorter.dispatch", () => { test.at(start + 35); });
			test.at(start + 40); test.value.sync("longer.dispatch", () => { test.at(start + 90); });
			start += interval; test.at(start); test.value.beat();
		}
		for (let index = 0; index < 6; index++) {
			test.at(start + 1); test.value.sync("later.dispatch", () => { test.at(start + 6); });
			start += 25; test.at(start); test.value.beat();
		}
		const report = test.value.stop();
		expect(report.retention.preservedWorstGaps.map(gap => gap.delayMs)).toEqual([180, 155]);
		expect(report.retention.preservedWorstGaps.every(gap => gap.omittedSyncSpans === 1)).toBe(true);
		expect(report.gaps.filter(gap => gap.exceeded).map(gap => gap.delayMs)).toEqual([155, 180]);
		expect(report.syncSpans.filter(span => span.label === "longer.dispatch")).toHaveLength(2);
		expect(report.syncSpans).toHaveLength(4);
		expect(report.exceededIntervals).toBe(3);
		expect(report.maxDelayMs).toBe(180);
	});

	it("bounds nested callback frames and accounts for unknown and destroyed resource kinds", () => {
		const test = collector({ asyncHooks: true, limits: { callbackDepth: 1 } });
		test.hooks.init(1, "PROMISE"); test.hooks.destroy(1);
		test.at(1); test.hooks.before(1);
		test.at(2); test.hooks.before(2);
		test.at(20); test.hooks.after(2);
		test.at(30); test.hooks.after(1);
		const report = test.value.stop();
		expect(report.callbacks).toMatchObject([{ resourceKind: "unknown", start: 1, end: 30 }]);
		expect(report.callbackCounts).toMatchObject({ started: 2, completed: 1, depthOmitted: 1, unknownResourceKind: 1 });
		expect(report.retention.depthOmittedCallbacks).toBe(1);
	});

	it("does not inspect resource content or use it as callback context", () => {
		const test = collector({ asyncHooks: true });
		let inspected = 0;
		const resource = new Proxy({ secret: "private async protocol payload" }, { get() { inspected++; throw new Error("Resource must not be inspected"); } });
		const init = test.hooks.init as (id: number, kind: string, triggerId: number, resource: object) => void;
		init(1, "PIPEWRAP", 0, resource);
		test.at(5); test.hooks.before(1);
		test.at(15); test.hooks.after(1);
		test.hooks.destroy(1);
		const report = test.value.stop();
		expect(inspected).toBe(0);
		expect(report.callbacks[0]).toEqual({ id: 1, asyncId: 1, resourceKind: "PIPEWRAP", start: 5, end: 15, durationMs: 10, mainThreadCpuMs: null, stage: "worker-startup", case: "direct" });
		expect(JSON.stringify(report)).not.toContain("private async protocol payload");
		expect(report.retention.trackedResources).toBe(0);
	});

	it("reports thread CPU absence and counter failure without a process-wide or OS-cause fallback", () => {
		const absent = collector();
		absent.at(150); absent.value.beat();
		const report = absent.value.stop();
		expect(report.mainThreadCpuMs).toBeNull();
		expect(report.gaps[0]).toMatchObject({ mainThreadCpuMs: null, wallMinusMainThreadCpuMs: null });
		expect(report.threadCpuUnavailableReason).toContain("unavailable in this runtime");
		const failed = createHeartbeatDiagnostics({ runtime: false, timers: false, threadCpuUsage() { throw new Error("private failure details"); } });
		const failedReport = failed.stop();
		expect(failedReport.support.threadCpuUsage).toBe(false);
		expect(failedReport.threadCpuUnavailableReason).toContain("does not identify an operating-system cause");
		expect(JSON.stringify(failedReport)).not.toContain("private failure details");
	});

	it("records an active startup callback at stop and stops collection idempotently", () => {
		const test = collector({ asyncHooks: true });
		test.hooks.init(1, "PROMISE");
		test.at(1); test.hooks.before(1);
		test.at(150);
		const report = test.value.stop();
		expect(report.callbacks).toMatchObject([{ start: 1, end: 150, incomplete: true }]);
		expect(report.callbackCounts).toMatchObject({ started: 1, completed: 0, incomplete: 1 });
		expect(report.gaps[0]).toMatchObject({ exceeded: true, observedWorkMs: 149 });
		test.at(200); test.value.beat(); test.value.sync("after-stop", () => {});
		expect(test.value.stop()).toEqual(report);
		expect(test.disable).toHaveBeenCalledOnce();
	});

	it("keeps the timer fair during ordinary async callback traffic with bounded real hook collection", async () => {
		const value = createHeartbeatDiagnostics({
			runtime: false, asyncHooks: true, threadCpuUsage: null, intervalMs: 2,
			significantCallbackMs: 0, limits: { callbacks: 8, resources: 32, gaps: 8, worstGaps: 1, spansPerWorstGap: 1 },
		});
		try {
			for (let round = 0; round < 3; round++) {
				for (let index = 0; index < 16; index++) await immediate();
				await sleep(4);
			}
			const report = value.stop();
			expect(report.support.asyncHooks).toBe(true);
			expect(report.ticks).toBeGreaterThan(1);
			expect(report.callbackCounts.started).toBeGreaterThan(8);
			expect(report.callbacks.length).toBeLessThanOrEqual(9);
			expect(report.retention.omittedCallbacks).toBeGreaterThan(0);
			expect(report.retention.limits.resources).toBe(32);
		} finally { value.stop(); }
	});
});
