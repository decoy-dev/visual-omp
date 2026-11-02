import type { AppMetrics } from "@shared/contracts/app-metrics";
import { useEffect, useState } from "react";

export const APP_METRICS_INTERVAL = 2_000;
export const APP_METRICS_HISTORY = 30;
export interface CpuSample { at: number; percent: number | null }
interface Snapshot extends AppMetrics { history: CpuSample[] }
const empty = (): Snapshot => ({ cpuPercent: null, memoryBytes: null, history: [] });

/** One renderer-owned polling loop. Hiding/unmounting cancels its timer and ignores late replies. */
export function useAppMetrics(): Snapshot {
	const [snapshot, setSnapshot] = useState<Snapshot>(empty);
	useEffect(() => {
		let generation = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const sync = () => {
			const current = ++generation;
			clearTimeout(timer);
			setSnapshot(empty());
			if (document.visibilityState === "hidden") return;
			let reset = true;
			let previousAt: number | null = null;
			const poll = async () => {
				const at = performance.now();
				if (previousAt !== null && at - previousAt > APP_METRICS_INTERVAL * 3) {
					reset = true;
					setSnapshot(empty());
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
				setSnapshot(previous => ({
					...metrics,
					history: [...previous.history.filter(sample => at - sample.at < 60_000), { at, percent: metrics.cpuPercent }].slice(-APP_METRICS_HISTORY),
				}));
				timer = setTimeout(() => void poll(), APP_METRICS_INTERVAL);
			};
			void poll();
		};
		document.addEventListener("visibilitychange", sync);
		sync();
		return () => {
			generation++;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", sync);
		};
	}, []);
	return snapshot;
}
