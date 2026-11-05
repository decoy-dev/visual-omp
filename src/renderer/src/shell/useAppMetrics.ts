import type { AppMetrics } from "@shared/contracts/app-metrics";
import { useSyncExternalStore } from "react";

export const APP_METRICS_INTERVAL = 2_000;
export const APP_METRICS_HISTORY = 30;
export interface CpuSample { at: number; percent: number | null }
interface Snapshot extends AppMetrics { history: CpuSample[] }
const empty = (): Snapshot => ({ cpuPercent: null, memoryBytes: null, history: [] });
let snapshot = empty();
const listeners = new Set<() => void>();
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function publish(next: Snapshot): void {
	snapshot = next;
	for (const listener of listeners) listener();
}

function sync(): void {
	const current = ++generation;
	clearTimeout(timer);
	publish(empty());
	if (document.visibilityState === "hidden") return;
	let reset = true;
	let previousAt: number | null = null;
	const poll = async () => {
		const at = performance.now();
		if (previousAt !== null && at - previousAt > APP_METRICS_INTERVAL * 3) {
			reset = true;
			publish(empty());
		}
		previousAt = at;
		let metrics: AppMetrics;
		try {
			metrics = await window.vomp.invoke("app:metrics", reset);
			reset = false;
		} catch {
			metrics = { cpuPercent: null, memoryBytes: null };
			reset = true;
		}
		if (current !== generation) return;
		publish({
			...metrics,
			history: [...snapshot.history.filter(sample => at - sample.at < 60_000), { at, percent: metrics.cpuPercent }].slice(-APP_METRICS_HISTORY),
		});
		timer = setTimeout(() => void poll(), APP_METRICS_INTERVAL);
	};
	void poll();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		document.addEventListener("visibilitychange", sync);
		sync();
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		generation++;
		clearTimeout(timer);
		document.removeEventListener("visibilitychange", sync);
		snapshot = empty();
	};
}
const getSnapshot = () => snapshot;

/** CPU and RAM share one renderer polling loop. Hiding both or the window pauses sampling. */
export function useAppMetrics(): Snapshot {
	return useSyncExternalStore(subscribe, getSnapshot);
}
