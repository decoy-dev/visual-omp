import type { AppMetrics } from "@shared/contracts/app-metrics";

const unavailable = (): AppMetrics => ({ cpuPercent: null, memoryBytes: null });
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

interface Baseline {
	at: number;
	cpu: Map<string, number>;
}

/** Native metrics only; no child-process inspection, timers or renderer-visible process identities. */
export class AppMetricsSampler {
	private baseline: Baseline | null = null;

	constructor(private readonly read: () => unknown, private readonly logicalCpus: number, private readonly now: () => number = () => performance.now()) {}

	reset(): void {
		this.baseline = null;
	}

	sample(reset = false): AppMetrics {
		if (reset) this.reset();
		let metrics: unknown;
		try { metrics = this.read(); } catch { this.reset(); return unavailable(); }
		if (!Array.isArray(metrics) || metrics.length === 0) { this.reset(); return unavailable(); }
		const at = this.now();
		const cpu = new Map<string, number>();
		let cpuValid = true;
		let memoryBytes = 0;
		let memoryValid = true;
		for (const metric of metrics) {
			const process = record(metric);
			const workingSet = record(process.memory).workingSetSize;
			if (nonnegative(workingSet) && Number.isInteger(workingSet)) memoryBytes += workingSet * 1024;
			else memoryValid = false;
			const cumulative = record(process.cpu).cumulativeCPUUsage;
			if (!Number.isInteger(process.pid) || !nonnegative(process.pid) || process.pid === 0 || !nonnegative(process.creationTime) || !nonnegative(cumulative)) {
				cpuValid = false;
				continue;
			}
			const key = `${process.pid}:${process.creationTime}`;
			if (cpu.has(key)) cpuValid = false;
			cpu.set(key, cumulative);
		}
		let cpuPercent: number | null = null;
		const previous = this.baseline;
		// Electron's percentCPUUsage docs/types do not specify core normalization. Use its
		// documented cumulative CPU seconds instead: delta / elapsed seconds / logical CPUs.
		// https://www.electronjs.org/docs/latest/api/structures/cpu-usage
		if (cpuValid && previous && nonnegative(at) && at > previous.at && Number.isInteger(this.logicalCpus) && this.logicalCpus > 0 && cpu.size === previous.cpu.size) {
			let delta = 0;
			let comparable = true;
			for (const [key, seconds] of cpu) {
				const before = previous.cpu.get(key);
				if (before === undefined || seconds < before) { comparable = false; break; }
				delta += seconds - before;
			}
			const percent = delta / ((at - previous.at) / 1000) / this.logicalCpus * 100;
			if (comparable && Number.isFinite(percent)) cpuPercent = Math.min(100, percent);
		}
		this.baseline = cpuValid && nonnegative(at) ? { at, cpu } : null;
		return { cpuPercent, memoryBytes: memoryValid && Number.isSafeInteger(memoryBytes) ? memoryBytes : null };
	}
}
