import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { describe, expect, it } from "vitest";
import type { UsageLimit, UsageLimitsSnapshot, UsageReport } from "@shared/contracts/usage";
import realSnapshot from "../../../../../main/features/usage/fixtures/usage-limits.json";
import { chatModel, modelsInUse, parseModelSelector, planUsage } from "./planUsage";

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
		expect(claude?.top).toMatchObject({ window: "7d", fraction: 0.45, tone: "ok", resetsAt: 1790816400000 });
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

	it("picks the most-used window, with provider-reported exhaustion first", () => {
		const most = (limits: UsageLimit[]) => planUsage(snapshot([report("anthropic", limits)]), [opus])[0]?.top.id;
		expect(most([limit("anthropic:5h", 0.3), limit("anthropic:7d", 0.6)])).toBe("anthropic:7d");
		expect(most([limit("anthropic:5h", 0.3, { status: "exhausted" }), limit("anthropic:7d", 0.6)])).toBe("anthropic:5h");
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
