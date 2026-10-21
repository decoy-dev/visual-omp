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

describe("/usage reset listing", () => {
	/** omp 18.12.4's printed listing, with identities redacted and two failure lines in omp's format. */
	const text = readFileSync(join(__dirname, "fixtures", "usage-reset.txt"), "utf8");
	const { readable, accounts } = parseResetListing(text);
	const heading = "Saved rate-limit resets:";
	const hint = "Spend one with `/usage reset <provider>/<credential id>` or `/usage reset <provider>/active`.";

	it("reads each account's target, label, counts and soonest expiry", () => {
		expect(readable).toBe(true);
		expect(accounts).toHaveLength(4);
		expect(accounts.slice(0, 2)).toEqual([
			{
				provider: "openai-codex",
				credentialId: 4,
				label: "user1@example.com · self_serve_business_prolite",
				savedCount: 3,
				usableCount: 3,
				expiresAt: "2026-10-22T20:27:34.150512Z",
				unavailable: null,
			},
			{
				provider: "anthropic",
				credentialId: 6,
				label: "user1@example.com · Example Org 2",
				savedCount: 1,
				usableCount: 1,
				expiresAt: "2026-10-22T16:00:00.000Z",
				unavailable: null,
			},
		]);
	});

	it("keeps omp's reason when nothing can be spent now", () => {
		expect(accounts[2]).toMatchObject({ credentialId: 9, savedCount: 1, usableCount: 0, unavailable: "the provider did not identify a grant that can be safely spent" });
		expect(accounts[3]).toMatchObject({ credentialId: 12, savedCount: null, usableCount: null, expiresAt: null, unavailable: "token refresh failed" });
	});

	it("keeps brackets inside a label", () => {
		expect(parseResetListing(`${heading}\n- Acme [EU] [Claude · anthropic/2]: 2 saved, 2 usable now\n\n${hint}`)).toEqual({
			readable: true,
			accounts: [{ provider: "anthropic", credentialId: 2, label: "Acme [EU]", savedCount: 2, usableCount: 2, expiresAt: null, unavailable: null }],
		});
	});

	it("reads omp's no-accounts reply as an understood empty listing", () => {
		expect(parseResetListing("No provider accounts found. Use /login to add one.")).toEqual({ readable: true, accounts: [] });
	});

	it("fails closed on a format it doesn't know", () => {
		// An older omp's Codex-only heading and email targets.
		expect(parseResetListing("Saved Codex rate-limit resets:\n- me@example.com: 2 available (active)")).toEqual({ readable: false, accounts: [] });
		expect(parseResetListing("")).toEqual({ readable: false, accounts: [] });
		expect(parseResetListing(`${heading}\n\n${hint}`)).toEqual({ readable: false, accounts: [] });
	});

	it("fails closed on a malformed credential id or detail", () => {
		expect(parseResetListing(`${heading}\n- me@example.com [Codex · openai-codex/4a]: 1 saved, 1 usable now`).readable).toBe(false);
		expect(parseResetListing(`${heading}\n- me@example.com [Codex · openai-codex/1234567890123456]: 1 saved, 1 usable now`).readable).toBe(false);
		expect(parseResetListing(`${heading}\n- me@example.com [Codex · openai-codex/4]: 1 banked, ready`).readable).toBe(false);
	});

	it("fails closed on a partly readable listing instead of keeping the lines it understood", () => {
		const partial = text.replace("- user2@example.com [Claude · anthropic/9]", "- user2@example.com {Claude · anthropic/9}");
		expect(parseResetListing(partial)).toEqual({ readable: false, accounts: [] });
		expect(parseResetListing(`${text}\nNote: one account is being refreshed.`).readable).toBe(false);
	});
});
