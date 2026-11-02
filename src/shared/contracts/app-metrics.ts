export interface AppMetrics {
	/** Percentage of total logical CPU capacity, measured between two native snapshots. */
	cpuPercent: number | null;
	/** Sum of Electron process working sets in bytes. Shared pages can be counted more than once. */
	memoryBytes: number | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		"app:metrics": { args: [reset: boolean]; result: AppMetrics };
	}
}
