import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { UsageLimit, UsageLimitsSnapshot, UsageReport } from "@shared/contracts/usage";
import realSnapshot from "../../../../../main/features/usage/fixtures/usage-limits.json";
import { chatModel, modelsInUse, parseModelSelector, parseWindowDuration, planLimits, planUsage, providerSummary } from "./planUsage";

/** Real `omp usage --json` output: Kimi, Codex and one Claude account with a Fable tier row and spent extra usage. */
const fixture = realSnapshot as unknown as UsageLimitsSnapshot;

const opus = { provider: "anthropic", modelId: "claude-opus-5-5" };

function limit(id: string, fraction: number, patch: Partial<UsageLimit> = {}): UsageLimit {
	const durationMs = id.endsWith("5h") ? 18_000_000 : 604_800_000;
	return {
		id,
		label: id,
		scope: { provider: id.split(":")[0]!, shared: true },
		window: { id: id.split(":")[1]!, label: id, durationMs, resetsAt: 1_000 },
		amount: { usedFraction: fraction, unit: "percent" },
		status: "ok",
		...patch,
	};
}

function snapshot(reports: UsageReport[], capacity: UsageLimitsSnapshot["capacity"] = {}): UsageLimitsSnapshot {
	return { generatedAt: 0, reports, accountsWithoutUsage: [], disabledCredentials: [], capacity };
}

const report = (provider: string, limits: UsageLimit[], fetchedAt = 10): UsageReport => ({ provider, fetchedAt, limits });

describe("parseModelSelector", () => {
	it("splits provider and model, dropping a thinking level and a route", () => {
		expect(parseModelSelector("anthropic/claude-opus-5-5:high")).toEqual(opus);
		expect(parseModelSelector("openai-codex/gpt-5.6-luna@azure:low")).toEqual({ provider: "openai-codex", modelId: "gpt-5.6-luna" });
	});

	it("keeps namespaced ids and non-thinking suffixes", () => {
		expect(parseModelSelector("openrouter/anthropic/claude-x:free")).toEqual({ provider: "openrouter", modelId: "anthropic/claude-x:free" });
	});

	it("rejects selectors without a provider", () => {
		expect(parseModelSelector("claude-opus-5-5")).toBeNull();
		expect(parseModelSelector("/claude")).toBeNull();
	});
});

describe("modelsInUse", () => {
	it("lists the chat model, then running subagents' models once each", () => {
		const models = modelsInUse(opus, [
			{ status: "running", resolvedModel: "openai-codex/gpt-5.6-luna:medium" },
			{ status: "pending", resolvedModel: "anthropic/claude-opus-5-5" },
			{ status: "completed", resolvedModel: "kimi-code/kimi-k3" },
			{ status: "running" },
		]);
		expect(models).toEqual([opus, { provider: "openai-codex", modelId: "gpt-5.6-luna" }]);
	});
});

describe("chatModel", () => {
	const base = { parentId: null, timestamp: "2026-10-12T00:00:00Z" };
	const change = (id: string, model: string): SessionEntry => ({ ...base, id, type: "model_change", model });
	/** As omp writes it to the session file: `provider` beside `model`, which the wire type leaves out. */
	const reply = (id: string, provider: string | undefined, model: string): SessionEntry =>
		({ ...base, id, type: "message", message: { role: "assistant", content: [], provider, model, usage: {}, stopReason: "stop", timestamp: 0 } }) as unknown as SessionEntry;
	const user: SessionEntry = { ...base, id: "u", type: "message", message: { role: "user", content: "hi", timestamp: 0 } };

	it("prefers the live model", () => {
		expect(chatModel({ id: "gpt-5.6-luna", name: "GPT", provider: "openai-codex", contextWindow: null }, [change("m", "anthropic/claude-opus-5-5")])).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
		});
	});

	it("falls back to the saved branch's last model change, ahead of later replies", () => {
		const entries = [change("m1", "openai-codex/gpt-5.6-luna"), reply("a1", "openai-codex", "gpt-5.6-luna"), change("m2", "anthropic/claude-opus-5-5"), user, reply("a2", "kimi-code", "kimi-k3")];
		expect(chatModel(undefined, entries)).toEqual(opus);
	});

	it("uses the last assistant reply when the branch has no model change", () => {
		expect(chatModel(undefined, [reply("a1", "kimi-code", "kimi-k3"), user, reply("a2", "anthropic", "claude-opus-5-5"), user])).toEqual(opus);
		expect(chatModel(undefined, [reply("a1", undefined, "anthropic/claude-opus-5-5")])).toEqual(opus);
	});

	it("finds nothing in a branch without a model", () => {
		expect(chatModel(undefined, [user])).toBeNull();
		expect(chatModel(undefined, [])).toBeNull();
	});
});

describe("planUsage", () => {
	it("shows the shared Claude windows for an Opus chat, leaving out the Fable tier and extra usage spend", () => {
		const [claude, ...rest] = planUsage(fixture, [opus]);
		expect(rest).toEqual([]);
		expect(claude?.provider).toBe("anthropic");
		expect(claude?.accounts).toBe(1);
		expect(claude?.windows.map(window => [window.window, window.fraction])).toEqual([
			["5h", 0.29],
			["7d", 0.45],
		]);
		expect(claude?.top).toMatchObject({ window: "5h", fraction: 0.29, tone: "ok", resetsAt: 1790802600000 });
		expect(claude?.fetchedAt).toBe(1790789907366);
	});

	it("adds the Fable tier window for a Fable model and names it apart from the shared 7d window", () => {
		const [claude] = planUsage(fixture, [{ provider: "anthropic", modelId: "claude-fable-5" }]);
		expect(claude?.windows.map(window => window.window)).toEqual(["5h", "7d", "7d fable"]);
	});

	it("follows the model's provider and shows nothing for providers without a report", () => {
		expect(planUsage(fixture, [{ provider: "openai-codex", modelId: "gpt-5.6-luna" }]).map(usage => [usage.provider, usage.top.window, usage.top.fraction])).toEqual([
			["openai-codex", "7d", 0.01],
		]);
		expect(planUsage(fixture, [{ provider: "openai", modelId: "gpt-5" }])).toEqual([]);
		expect(planUsage(null, [opus])).toEqual([]);
	});

	it("keeps one item per provider in the order the models appear", () => {
		const providers = planUsage(fixture, [{ provider: "kimi-code", modelId: "kimi-k3" }, opus, { provider: "anthropic", modelId: "claude-fable-5" }]);
		expect(providers.map(usage => usage.provider)).toEqual(["kimi-code", "anthropic"]);
		expect(providers[1]?.windows).toHaveLength(3);
	});

	it("names Kimi's windows by duration and tells its two weekly meters apart by a readable label", () => {
		const [kimi] = planUsage(fixture, [{ provider: "kimi-code", modelId: "kimi-k3" }]);
		expect(kimi?.windows.map(window => [window.window, window.fraction, window.detail])).toEqual([
			["7d", 0.06, "Weekly limit"],
			["5h", 0.16, undefined],
			["7d", 0, undefined],
		]);
		expect(kimi?.top.window).toBe("5h");
	});

	it("keeps Claude's shared 7d and Fable 7d apart although they reset together", () => {
		const [claude] = planUsage(fixture, [{ provider: "anthropic", modelId: "claude-fable-5" }]);
		expect(claude?.windows.map(window => [window.window, window.fraction, window.detail])).toEqual([
			["5h", 0.29, undefined],
			["7d", 0.45, undefined],
			["7d fable", 0.22, undefined],
		]);
	});

	it("keeps independent quotas of one duration and one reset separate", () => {
		const weekly = (id: string, fraction: number, unit: UsageLimit["amount"]["unit"], label: string) =>
			limit(id, fraction, { label, window: { id: "7d", label: "7 Day", resetsAt: 1_000_000 }, amount: { usedFraction: fraction, unit } });
		const rows = (limits: UsageLimit[]) =>
			planUsage(snapshot([report("synthetic", limits)]), [{ provider: "synthetic", modelId: "s" }])[0]?.windows.map(window => [window.id, window.window, window.fraction, window.detail]);
		expect(rows([weekly("synthetic:requests", 0.1, "requests", "Weekly requests"), weekly("synthetic:usd", 0.3, "usd", "Weekly spend")])).toEqual([
			["synthetic:requests", "7d", 0.1, "Weekly requests"],
			["synthetic:usd", "7d", 0.3, "Weekly spend"],
		]);
		expect(rows([weekly("synthetic:a", 0.1, "percent", "Pro models"), weekly("synthetic:b", 0.3, "percent", "7 days")])).toEqual([
			["synthetic:a", "7d", 0.1, "Pro models"],
			["synthetic:b", "7d", 0.3, undefined],
		]);
	});

	it("falls back to the human window label, then the limit label, when no duration can be read", () => {
		const monthly = limit("cursor:usd", 0.2, { window: { id: "billing-period", label: "Billing period" } });
		const bare = limit("cursor:extra", 0.1, { window: undefined, scope: { provider: "cursor", windowId: "extra" }, label: "On-demand spend" });
		const [cursor] = planUsage(snapshot([report("cursor", [monthly, bare])]), [{ provider: "cursor", modelId: "auto" }]);
		expect(cursor?.windows.map(window => window.window)).toEqual(["Billing period", "On-demand spend"]);
	});

	it("ignores limits scoped to another model", () => {
		const scoped = (modelId: string, fraction: number) => limit(`copilot:${modelId}`, fraction, { scope: { provider: "github-copilot", modelId } });
		const data = snapshot([report("github-copilot", [limit("github-copilot:monthly", 0.1), scoped("gpt-5", 0.8), scoped("claude-opus-5-5", 0.5)])]);
		const [usage] = planUsage(data, [{ provider: "github-copilot", modelId: "claude-opus-5-5" }]);
		expect(usage?.windows.map(window => window.id)).toEqual(["github-copilot:monthly", "copilot:claude-opus-5-5"]);
		expect(usage?.top.fraction).toBe(0.5);
	});

	it("pools several accounts through omp's capacity figures", () => {
		const data = snapshot(
			[
				report("anthropic", [limit("anthropic:5h", 0.2, { window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 9_000 } })], 30),
				report("anthropic", [limit("anthropic:5h", 0.6, { window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: 4_000 } })], 20),
			],
			{ anthropic: [{ window: "5h", durationMs: 18_000_000, accounts: 2, usedAccounts: 0.9, remainingAccounts: 1.1 }] },
		);
		const [claude] = planUsage(data, [opus]);
		expect(claude?.accounts).toBe(2);
		expect(claude?.top).toMatchObject({ window: "5h", fraction: 0.45, resetsAt: 4_000 });
		expect(claude?.fetchedAt).toBe(20);
	});

	it("matches pooled capacity by meter and averages when omp reports no bucket", () => {
		const fable = { scope: { provider: "anthropic", tier: "fable" } };
		const data = snapshot([report("anthropic", [limit("anthropic:7d", 0.2), limit("anthropic:7d:fable", 0.4, fable)]), report("anthropic", [limit("anthropic:7d", 0.6), limit("anthropic:7d:fable", 0.8, fable)])], {
			anthropic: [
				{ window: "7d", durationMs: 604_800_000, accounts: 2, usedAccounts: 1.0, remainingAccounts: 1 },
				{ window: "7d", durationMs: 604_800_000, meter: "fable", accounts: 2, usedAccounts: 1.6, remainingAccounts: 0.4 },
			],
		});
		const fableModel = [{ provider: "anthropic", modelId: "claude-fable-5" }];
		expect(planUsage(data, fableModel)[0]?.windows.map(window => window.fraction)).toEqual([0.5, 0.8]);
		const averaged = planUsage({ ...data, capacity: {} }, fableModel)[0]?.windows.map(window => window.fraction) ?? [];
		expect(averaged[0]).toBeCloseTo(0.4);
		expect(averaged[1]).toBeCloseTo(0.6);
	});

	it("never lends a Claude window another meter's bucket: a missing bucket falls back to the mean", () => {
		const fable = { scope: { provider: "anthropic", tier: "fable" } };
		const reports = [report("anthropic", [limit("anthropic:7d", 0.2), limit("anthropic:7d:fable", 0.4, fable)]), report("anthropic", [limit("anthropic:7d", 0.6), limit("anthropic:7d:fable", 0.8, fable)])];
		const shared = { window: "7d", durationMs: 604_800_000, accounts: 2, usedAccounts: 1.8, remainingAccounts: 0.2 };
		const tier = { window: "7d", durationMs: 604_800_000, meter: "fable", accounts: 2, usedAccounts: 0.2, remainingAccounts: 1.8 };
		const fractions = (stats: (typeof shared | typeof tier)[]) =>
			planUsage(snapshot(reports, { anthropic: stats }), [{ provider: "anthropic", modelId: "claude-fable-5" }])[0]?.windows.map(window => window.fraction) ?? [];
		// Fable bucket missing: the shared bucket (0.9) stays with the shared window, Fable averages 0.4 and 0.8.
		const noTier = fractions([shared]);
		expect(noTier[0]).toBeCloseTo(0.9);
		expect(noTier[1]).toBeCloseTo(0.6);
		// Shared bucket missing: the Fable bucket (0.1) stays with Fable, the shared window averages 0.2 and 0.6.
		const noShared = fractions([tier]);
		expect(noShared[0]).toBeCloseTo(0.4);
		expect(noShared[1]).toBeCloseTo(0.1);
	});

	it("gives a Codex window its only bucket even when omp names a meter", () => {
		const data = snapshot([report("openai-codex", [limit("openai-codex:7d", 0.1)]), report("openai-codex", [limit("openai-codex:7d", 0.3)])], {
			"openai-codex": [{ window: "7d", durationMs: 604_800_000, meter: "chat", accounts: 2, usedAccounts: 1.2, remainingAccounts: 0.8 }],
		});
		expect(planUsage(data, [{ provider: "openai-codex", modelId: "gpt-5.6-luna" }])[0]?.top.fraction).toBeCloseTo(0.6);
	});

	it("warns a pooled window when one account is exhausted, and errs only when all are", () => {
		const one = snapshot([report("anthropic", [limit("anthropic:5h", 1, { status: "exhausted" })]), report("anthropic", [limit("anthropic:5h", 0)])]);
		expect(planUsage(one, [opus])[0]?.top).toMatchObject({ fraction: 0.5, status: "warning", tone: "warn" });
		const both = snapshot([report("anthropic", [limit("anthropic:5h", 0.5, { status: "exhausted" })]), report("anthropic", [limit("anthropic:5h", 0.5, { status: "exhausted" })])]);
		expect(planUsage(both, [opus])[0]?.top.tone).toBe("err");
	});

	it("shows the 5h window, else 7d, else monthly, taking the most-used of several", () => {
		const top = (limits: UsageLimit[]) => planUsage(snapshot([report("synthetic", limits)]), [{ provider: "synthetic", modelId: "s" }])[0]?.top.id;
		const window = (id: string, fraction: number, durationMs: number | undefined, label = id) =>
			limit(`synthetic:${id}`, fraction, { window: { id, label, durationMs, resetsAt: 1_000 } });
		const day = 86_400_000;
		expect(top([window("7d", 0.6, 7 * day), window("5h", 0.3, 5 * 3_600_000)])).toBe("synthetic:5h");
		expect(top([window("30d", 0.9, 30 * day), window("7d", 0.2, 7 * day), window("weekly-pro", 0.4, 7 * day)])).toBe("synthetic:weekly-pro");
		expect(top([window("1d", 0.9, day), window("30d", 0.1, 30 * day)])).toBe("synthetic:30d");
		expect(top([window("1d", 0.9, day), window("billing", 0.1, undefined, "Monthly")])).toBe("synthetic:billing");
		expect(top([window("1h", 0.2, 3_600_000), window("30m", 0.5, 1_800_000)])).toBe("synthetic:30m");
	});

	it("counts 28 to 31 days, or a month-named window without a duration, as monthly", () => {
		const top = (limits: UsageLimit[]) => planUsage(snapshot([report("synthetic", limits)]), [{ provider: "synthetic", modelId: "s" }])[0]?.top.id;
		const day = 86_400_000;
		const versusDaily = (id: string, durationMs: number, label = id) =>
			top([limit("synthetic:1d", 0.9, { window: { id: "1d", label: "1d", durationMs: day } }), limit(`synthetic:${id}`, 0.1, { window: { id, label, durationMs } })]);
		expect(versusDaily("28d", 28 * day)).toBe("synthetic:28d");
		expect(versusDaily("31d", 31 * day)).toBe("synthetic:31d");
		expect(versusDaily("27d", 27 * day)).toBe("synthetic:1d");
		expect(versusDaily("32d", 32 * day)).toBe("synthetic:1d");
		expect(versusDaily("monthly", 14 * day, "Monthly")).toBe("synthetic:1d");
	});

	it("shows a window the provider reports as exhausted ahead of the 5h window", () => {
		const top = (limits: UsageLimit[]) => planUsage(snapshot([report("anthropic", limits)]), [opus])[0]?.top.id;
		expect(top([limit("anthropic:5h", 0.3), limit("anthropic:7d", 1, { status: "exhausted" })])).toBe("anthropic:7d");
		expect(top([limit("anthropic:5h", 0.3), limit("anthropic:7d", 0.95, { status: "warning" })])).toBe("anthropic:5h");
		expect(top([limit("anthropic:5h", 1, { status: "exhausted" }), limit("anthropic:7d", 1.05, { status: "exhausted" })])).toBe("anthropic:7d");
	});

	it("puts a pooled window first only when every account reports it exhausted", () => {
		const pooled = (second: UsageLimit[]) =>
			planUsage(snapshot([report("anthropic", [limit("anthropic:5h", 0.2), limit("anthropic:7d", 1, { status: "exhausted" })]), report("anthropic", second)]), [opus])[0];
		const missing = pooled([limit("anthropic:5h", 0.4)]);
		expect(missing?.top.id).toBe("anthropic:5h");
		expect(missing?.windows.find(window => window.id === "anthropic:7d")?.status).toBe("warning");
		const mixed = pooled([limit("anthropic:5h", 0.4), limit("anthropic:7d", 0.5)]);
		expect(mixed?.top.id).toBe("anthropic:5h");
		expect(mixed?.windows.find(window => window.id === "anthropic:7d")?.status).toBe("warning");
		const unanimous = pooled([limit("anthropic:5h", 0.4), limit("anthropic:7d", 1, { status: "exhausted" })]);
		expect(unanimous?.top).toMatchObject({ id: "anthropic:7d", status: "exhausted", tone: "err" });
	});

	it("leaves out a provider whose windows report no usable fraction", () => {
		const unknown = limit("anthropic:5h", 0, { amount: { unit: "unknown" } });
		expect(planUsage(snapshot([report("anthropic", [unknown])]), [opus])).toEqual([]);
	});

	it("turns warn at 70% and err at 90%", () => {
		const tone = (fraction: number) => planUsage(snapshot([report("anthropic", [limit("anthropic:5h", fraction)])]), [opus])[0]?.top.tone;
		expect([tone(0.69), tone(0.7), tone(0.89), tone(0.9)]).toEqual(["ok", "warn", "warn", "err"]);
	});
});

describe("parseWindowDuration", () => {
	it("reads one token-bounded duration", () => {
		const day = 86_400_000;
		expect(["limit_7d", "7d", "7 Day", "30 days", "1w", "5h limit", "90 MIN", "2 hrs"].map(parseWindowDuration)).toEqual([7 * day, 7 * day, 7 * day, 30 * day, 7 * day, 5 * 3_600_000, 90 * 60_000, 2 * 3_600_000]);
	});

	it("ignores digits inside other words, several durations and other units", () => {
		expect(["gpt5h", "v2day", "7dx", "abc7d", "Weekly limit", "1mo", "5h and 7d", "monthly", "1.5.2h"].map(parseWindowDuration)).toEqual(Array(9).fill(null));
	});
});

describe("planLimits", () => {
	it("puts limit-reached accounts first, then the highest use, and keeps every window apart", () => {
		const providers = planLimits(fixture);
		expect(providers.map(provider => provider.provider)).toEqual(["anthropic", "kimi-code", "openai-codex"]);

		const claude = providers[0].accounts[0];
		expect(claude.rows.map(row => [row.id, row.state])).toEqual([
			["anthropic:extra", "reached"],
			["anthropic:5h", "ok"],
			["anthropic:7d", "ok"],
			["anthropic:7d:fable", "ok"],
		]);
		expect(claude.rows[0]).toMatchObject({ label: "Extra Usage", durationMs: null });
		expect(claude.rows[3]).toMatchObject({ durationMs: 604_800_000, qualifier: "Fable" });

		// Kimi's two 7-day rows report alike but have no shared identity, so both stay; the readable label tells them apart.
		const kimi = providers[1].accounts[0].rows;
		expect(kimi.map(row => [row.id, row.durationMs, row.qualifier])).toEqual([
			["kimi-code:0", 604_800_000, "Weekly limit"],
			["kimi-code:1", 18_000_000, null],
			["kimi-code:2", 604_800_000, null],
		]);
	});

	it("names accounts by email and organization and keeps raw plan ids in the technical details", () => {
		const codex = planLimits(fixture).find(provider => provider.provider === "openai-codex")?.accounts[0];
		expect(codex).toMatchObject({ name: "user1@example.com", detail: "Example Org 1", kind: "report", fetchedAt: 1790789893693 });
		expect(codex?.ids).toContainEqual({ key: "plan", value: "self_serve_business_prolite" });
	});

	it("reads a missing amount as unavailable and a warning status as near the limit", () => {
		const rows = planLimits(
			snapshot([report("anthropic", [limit("anthropic:5h", 0.2), { ...limit("anthropic:7d", 0), amount: { unit: "unknown" } }, limit("anthropic:7d:x", 0.5, { status: "warning" })])]),
		)[0].accounts[0].rows;
		expect(rows.map(row => [row.id, row.state])).toEqual([
			["anthropic:7d:x", "near"],
			["anthropic:5h", "ok"],
			["anthropic:7d", "unavailable"],
		]);
	});

	it("lists disabled credentials first, on their account when it matches, and keeps accounts without a report", () => {
		const providers = planLimits({
			...snapshot([
				{ ...report("anthropic", [limit("anthropic:5h", 0.95)]), metadata: { accountId: "a1" } },
				{ ...report("openai-codex", [limit("openai-codex:7d", 0.1)]), metadata: { accountId: "c1", email: "me@example.com" } },
			]),
			accountsWithoutUsage: [{ provider: "kimi-code", type: "oauth", email: "kimi@example.com" }],
			disabledCredentials: [
				{ id: 1, provider: "openai-codex", type: "oauth", accountId: "c1", cause: "revoked" },
				{ id: 2, provider: "openai-codex", type: "oauth", email: "old@example.com", cause: "expired" },
			],
		});
		expect(providers.map(provider => provider.provider)).toEqual(["openai-codex", "anthropic", "kimi-code"]);
		expect(providers[0].accounts.map(account => [account.kind, account.name, account.disabled.map(credential => credential.id)])).toEqual([
			["report", "me@example.com", [1]],
			["disabled", "old@example.com", [2]],
		]);
		expect(providers[2].accounts[0]).toMatchObject({ kind: "unavailable", name: "kimi@example.com", rows: [] });
	});
});

describe("providerSummary", () => {
	const summary = (data: UsageLimitsSnapshot) => planLimits(data).map(providerSummary);

	it("shows the status bar's window and keeps other near or reached windows as alerts", () => {
		const [claude] = summary(snapshot([report("anthropic", [limit("anthropic:7d", 0.95), limit("anthropic:5h", 0.4), limit("anthropic:7d:fable", 0.75)])]));
		expect(claude.binding?.row.id).toBe("anthropic:5h");
		expect(claude.alerts.map(alert => [alert.row.id, alert.row.state])).toEqual([
			["anthropic:7d", "near"],
			["anthropic:7d:fable", "near"],
		]);
	});

	it("binds a reached window first, across accounts, and names its account", () => {
		const [claude] = summary(
			snapshot([
				{ ...report("anthropic", [limit("anthropic:5h", 0.2)]), metadata: { email: "a@example.com" } },
				{ ...report("anthropic", [limit("anthropic:5h", 0.3), limit("anthropic:7d", 1)]), metadata: { email: "b@example.com" } },
			]),
		);
		expect(claude.binding).toMatchObject({ account: { name: "b@example.com" }, row: { id: "anthropic:7d", state: "reached" } });
		expect(claude.alerts).toEqual([]);
	});

	it("reads a provider without a usable figure as unknown, and lists disabled sign-ins", () => {
		const [codex, kimi] = summary({
			...snapshot([report("kimi-code", [{ ...limit("kimi-code:5h", 0), amount: { unit: "unknown" } }])]),
			disabledCredentials: [{ id: 1, provider: "openai-codex", type: "oauth", email: "old@example.com", cause: "expired" }],
		});
		expect(kimi).toMatchObject({ binding: null, alerts: [], disabled: [] });
		expect(kimi.unknown).toHaveLength(1);
		expect(codex).toMatchObject({ binding: null, unknown: [] });
		expect(codex.disabled.map(account => account.name)).toEqual(["old@example.com"]);
	});

	it("keeps a provider-reported warning without a figure as an alert with no fraction", () => {
		const [claude] = summary(
			snapshot([report("anthropic", [limit("anthropic:5h", 0.2), { ...limit("anthropic:7d", 0, { status: "exhausted" }), amount: { unit: "unknown" } }])]),
		);
		expect(claude.binding?.row.id).toBe("anthropic:5h");
		expect(claude.alerts.map(alert => [alert.row.id, alert.row.state, alert.row.fraction])).toEqual([["anthropic:7d", "reached", null]]);
	});
	it("keeps every account identity visible when no account has a usable window", () => {
		const [claude] = summary(
			snapshot([
				{ ...report("anthropic", [{ ...limit("anthropic:5h", 0), amount: { unit: "unknown" } }]), metadata: { email: "first@example.com" } },
				{ ...report("anthropic", [{ ...limit("anthropic:7d", 0), amount: { unit: "unknown" } }]), metadata: { email: "second@example.com" } },
			]),
		);
		expect(claude.binding).toBeNull();
		expect(claude.unknown.map(account => account.name)).toEqual(["first@example.com", "second@example.com"]);
	});

});
