import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientUsageSchema, UsageHistorySchema, UsageLimitsSnapshotSchema, UsageStatsSchema, usageArgv } from "./parse";

/** Real omp v18.4.4 outputs with account identities and folder names redacted. */
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));

describe("omp usage --json", () => {
	const snapshot = UsageLimitsSnapshotSchema.parse(fixture("usage-limits.json"));

	it("keeps every provider report with its limit windows", () => {
		expect(snapshot.reports.map(report => report.provider)).toEqual(["kimi-code", "openai-codex", "anthropic"]);
		const anthropic = snapshot.reports.find(report => report.provider === "anthropic");
		expect(anthropic?.limits.map(limit => limit.id)).toEqual([
			"anthropic:5h",
			"anthropic:7d",
			"anthropic:7d:fable",
			"anthropic:extra",
		]);
		const fiveHour = anthropic?.limits[0];
		expect(fiveHour?.window).toEqual({ id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 1790802600000 });
		expect(fiveHour?.amount).toMatchObject({ unit: "percent", usedFraction: 0.29, limit: 100 });
		expect(anthropic?.limits[3]).toMatchObject({ status: "exhausted", amount: { unit: "usd" } });
	});

	it("parses banked reset credits and pooled capacity", () => {
		const anthropic = snapshot.reports.find(report => report.provider === "anthropic");
		expect(anthropic?.resetCredits?.redeemableCount).toBe(1);
		expect(anthropic?.resetCredits?.credits?.[0]?.clears).toContain("anthropic:7d");
		expect(anthropic?.resetCredits?.credits?.[0]?.usedFractions?.["anthropic:5h"]).toBe(0.24);
		const codex = snapshot.reports.find(report => report.provider === "openai-codex");
		expect(codex?.resetCredits?.availableCount).toBe(2);
		expect(snapshot.capacity.anthropic?.find(stat => stat.meter === "fable")).toMatchObject({ window: "7d", accounts: 1 });
	});

	it("degrades unknown units and statuses instead of rejecting the report", () => {
		const raw = JSON.parse(JSON.stringify(fixture("usage-limits.json")));
		raw.reports[0].limits[0].amount.unit = "gigawatts";
		raw.reports[0].limits[0].status = "melting";
		const degraded = UsageLimitsSnapshotSchema.parse(raw).reports[0]?.limits[0];
		expect(degraded?.amount.unit).toBe("unknown");
		expect(degraded?.status).toBe("unknown");
	});
});

describe("omp usage --history / clients --json", () => {
	it("parses history snapshots with and without optional identity/reset fields", () => {
		const history = UsageHistorySchema.parse(fixture("usage-history.json"));
		expect(history.entries.length).toBeGreaterThan(0);
		expect(history.entries.some(entry => entry.resetsAt === undefined)).toBe(true);
		expect(history.entries.some(entry => entry.email === undefined)).toBe(true);
		expect(history.entries.every(entry => entry.recordedAt >= history.sinceMs)).toBe(true);
	});

	it("parses an empty client usage report", () => {
		expect(ClientUsageSchema.parse(fixture("usage-clients.json")).clients).toEqual([]);
	});
});

describe("omp stats --json", () => {
	it("parses aggregates and series", () => {
		const stats = UsageStatsSchema.parse(fixture("stats.json"));
		expect(stats.overall.totalRequests).toBe(1389);
		expect(stats.byModel.map(model => model.model)).toContain("claude-opus-5-5");
		expect(stats.byAgentType.map(row => row.agentType)).toEqual(["main", "subagent"]);
		expect(stats.costSeries[0]).toMatchObject({ provider: "anthropic", costCacheRead: expect.any(Number) });
	});

	it("accepts the null averages omp reports for a range without timed requests", () => {
		const raw = JSON.parse(JSON.stringify(fixture("stats.json")));
		raw.overall = { ...raw.overall, avgDuration: null, avgTtft: null, avgTokensPerSecond: null };
		expect(UsageStatsSchema.parse(raw).overall.avgTtft).toBeNull();
	});
});

describe("usageArgv", () => {
	it("passes provider/redact and whole positive days", () => {
		expect(usageArgv(["usage", "--history", "--json"], { provider: "anthropic", redact: true, days: 2.2 })).toEqual([
			"usage",
			"--history",
			"--json",
			"--provider",
			"anthropic",
			"--redact",
			"--days",
			"3",
		]);
	});

	it("drops invalid days so omp applies its default window", () => {
		for (const days of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(usageArgv(["usage", "clients", "--json"], { days })).toEqual(["usage", "clients", "--json"]);
		}
	});
});
