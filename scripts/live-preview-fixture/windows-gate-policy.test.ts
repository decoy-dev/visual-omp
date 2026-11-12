import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { compareRssObservation, originalCloseWindow, RSS_COMPARISON_SLACK_BYTES } from "./windows-gate-policy.mjs";

it("permits the recorded three-page dip between separate working-set readings", () => {
	const comparison = compareRssObservation(93_351_936, 93_364_224, 93_622_272);
	expect(comparison.belowMinimumBytes).toBe(12_288);
	expect(comparison.independentRangeBytes).toBe(258_048);
	expect(comparison.toleranceBytes).toBe(65_536);
	expect(comparison.withinTolerance).toBe(true);
});

it("still rejects omitted monitor memory and deficits above the diagnostic allowance", () => {
	expect(compareRssObservation(0, 93_364_224, 93_622_272).withinTolerance).toBe(false);
	expect(compareRssObservation(100_000, 100_000 + RSS_COMPARISON_SLACK_BYTES + 1, 200_000).withinTolerance).toBe(false);
	expect(compareRssObservation(100_000, 100_000 + RSS_COMPARISON_SLACK_BYTES, 200_000).withinTolerance).toBe(true);
});

it("scales only the cross-time comparison by the number of independently pinned processes", () => {
	expect(compareRssObservation(300_000, 300_001, 300_002, 3).toleranceBytes).toBe(3 * RSS_COMPARISON_SLACK_BYTES);
	for (const count of [0, -1, 0.5, 4098]) expect(() => compareRssObservation(1, 1, 1, count)).toThrow();
	for (const value of [NaN, -1, Infinity]) expect(() => compareRssObservation(value, 1, 1)).toThrow();
});

it("starts failure-path confirmation at close dispatch rather than each later snapshot", () => {
	const window = originalCloseWindow({}, 1000, 250);
	expect(window.startWallAt).toBe(1000);
	expect(BigInt(window.exitDeadline)).toBe((1250n + 11644473600000n) * 10000n);
});

it("preserves the original normal-close or watchdog-loss deadline during later cleanup", () => {
	const normal = originalCloseWindow({ closeWallAt: 1000 }, 2000, 250);
	const loss = originalCloseWindow({ closeWallAt: 1100, lossWallAt: 900 }, 2000, 250);
	expect(normal.startWallAt).toBe(1000);
	expect(loss.startWallAt).toBe(900);
	expect(originalCloseWindow({ closeWallAt: 1000 }, 5000, 250).exitDeadline).toBe(normal.exitDeadline);
	expect(() => originalCloseWindow({}, NaN, 250)).toThrow();
	expect(() => originalCloseWindow({}, 1000, 251)).toThrow();
});

it("keeps comparison slack outside production guards and passes the original failure-cleanup deadline", async () => {
	const gate = await readFile(new URL("./bash-visualization-windows-gate.mjs", import.meta.url), "utf8");
	expect(gate).toContain("sample.requestedAt >= nextAt");
	expect(gate).toContain("observationWindows");
	expect(gate).toContain("originalCloseWindow(entry, Date.now(), thresholds.closeMs)");
	expect(gate).toContain("exitDeadline: entry.cleanupCloseWindow.exitDeadline");
	expect(gate).toContain("sample.jobRssBytes > thresholds.rssBytes");
	expect(gate).toContain("production.SHELL_WORKER_LIMITS.rssBytes, thresholds.rssBytes");
});
