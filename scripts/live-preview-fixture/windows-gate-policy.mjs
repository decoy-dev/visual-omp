import assert from 'node:assert/strict';

// This slack applies only to independent working-set readings made at different instants.
// It never changes a production watchdog, complete-member sum, or memory-pressure threshold.
// 64 KiB per pinned process permits small resident-page changes; it is not a bound on OS trimming.
export const RSS_COMPARISON_SLACK_BYTES = 64 * 1024;
export function compareRssObservation(sampleBytes, beforeBytes, afterBytes, processCount = 1) {
  assert.ok([sampleBytes, beforeBytes, afterBytes].every(value => Number.isSafeInteger(value) && value >= 0), 'Invalid cross-time RSS reading');
  assert.ok(Number.isSafeInteger(processCount) && processCount > 0 && processCount <= 4097, 'Invalid cross-time RSS process count');
  const minimumIndependentBytes = Math.min(beforeBytes, afterBytes);
  const belowMinimumBytes = Math.max(0, minimumIndependentBytes - sampleBytes);
  const toleranceBytes = RSS_COMPARISON_SLACK_BYTES * processCount;
  return {
    sampleBytes, beforeBytes, afterBytes, processCount, minimumIndependentBytes, belowMinimumBytes,
    independentRangeBytes: Math.abs(afterBytes - beforeBytes), toleranceBytes,
    withinTolerance: belowMinimumBytes <= toleranceBytes,
  };
}

// A fallback is captured immediately before failure-path close. Existing loss/close starts
// always win when earlier, so a late inspection cannot restart the native exit budget.
export function originalCloseWindow(entry, fallbackWallAt, closeMs) {
  const starts = [entry.lossWallAt, entry.closeWallAt, fallbackWallAt].filter(value => value !== undefined);
  assert.ok(starts.every(value => Number.isSafeInteger(value) && value >= 0), 'Invalid original close timestamp');
  assert.ok(Number.isSafeInteger(closeMs) && closeMs > 0 && closeMs <= 250, 'Invalid original close budget');
  const startWallAt = Math.min(...starts);
  return { startWallAt, exitDeadline: ((BigInt(startWallAt + closeMs) + 11644473600000n) * 10000n).toString() };
}
