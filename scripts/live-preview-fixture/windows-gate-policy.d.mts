export const RSS_COMPARISON_SLACK_BYTES: number;
export interface RssObservationComparison {
	sampleBytes: number;
	beforeBytes: number;
	afterBytes: number;
	processCount: number;
	minimumIndependentBytes: number;
	belowMinimumBytes: number;
	independentRangeBytes: number;
	toleranceBytes: number;
	withinTolerance: boolean;
}
export function compareRssObservation(sampleBytes: number, beforeBytes: number, afterBytes: number, processCount?: number): RssObservationComparison;
export function originalCloseWindow(entry: { lossWallAt?: number; closeWallAt?: number }, fallbackWallAt: number, closeMs: number): { startWallAt: number; exitDeadline: string };
