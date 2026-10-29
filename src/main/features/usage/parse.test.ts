import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClientUsageSchema, parseResetListing, UsageHistorySchema, UsageLimitsSnapshotSchema, UsageStatsSchema, usageArgv } from "./parse";

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

	it("retains account policy diagnostics for reported and unavailable accounts", () => {
		const policy = { priority: 4, reservePct: 15, reserveSource: "override", state: "inside-reserve", remainingPct: 9, reclaimAbovePct: 30 };
		const raw = JSON.parse(JSON.stringify(fixture("usage-limits.json")));
		raw.reports[0].policy = policy;
		raw.accountsWithoutUsage = [{ provider: "anthropic", type: "oauth", email: "unknown@example.com", policy: { ...policy, state: "unknown", remainingPct: undefined } }];
		const parsed = UsageLimitsSnapshotSchema.parse(raw);
		expect(parsed.reports[0]?.policy).toEqual(policy);
		expect(parsed.accountsWithoutUsage[0]?.policy).toMatchObject({ state: "unknown", priority: 4, reservePct: 15 });
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

describe("omp usage reset --json", () => {
	const listing = fixture("usage-reset.json");
	const { readable, accounts } = parseResetListing(listing);

	it("retains targets, structured identities, counts and expiry", () => {
		expect(readable).toBe(true);
		expect(accounts).toHaveLength(4);
		expect(accounts[0]).toMatchObject({
			provider: "openai-codex", credentialId: 4, email: "user1@example.com",
			label: "user1@example.com · self_serve_business_prolite",
			savedCount: 3, usableCount: 3, expiresAt: "2026-10-22T20:27:34.150512Z", unavailable: null,
		});
		expect(accounts[1]).toMatchObject({ credentialId: 6, orgId: "org-2", orgName: "Example Org 2" });
	});

	it("retains provider reasons and distinguishes unreadable account counts", () => {
		expect(accounts[2]).toMatchObject({ credentialId: 9, savedCount: 1, usableCount: 0, unavailable: "the provider did not identify a grant that can be safely spent" });
		expect(accounts[3]).toMatchObject({ credentialId: 12, label: "account-12", savedCount: null, usableCount: null, unavailable: "token refresh failed" });
	});

	it("accepts an understood empty listing", () => {
		expect(parseResetListing({ generatedAt: 1, accounts: [] })).toEqual({ readable: true, accounts: [] });
	});

	it("fails closed on malformed or partly readable JSON data", () => {
		for (const invalid of [null, "", { accounts: [] }, { generatedAt: 1, accounts: [{}] }]) {
			expect(parseResetListing(invalid)).toEqual({ readable: false, accounts: [] });
		}
		for (const credentialId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4"]) {
			const raw = JSON.parse(JSON.stringify(listing));
			raw.accounts[1].credentialId = credentialId;
			expect(parseResetListing(raw)).toEqual({ readable: false, accounts: [] });
		}
	});
});
