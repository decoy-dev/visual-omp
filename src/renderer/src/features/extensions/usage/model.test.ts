import { describe, expect, it } from "vitest";
import type { SpendChat } from "@shared/contracts/extensions";
import type { UsageLimit } from "@shared/contracts/usage";
import { chartScale, chatsCsv, chatsCsvName, filterChats, formatTick, limitTone, sortChats, usedFraction } from "./model";

function limit(amount: UsageLimit["amount"]): UsageLimit {
	return { id: "x", label: "5 Hour", scope: { provider: "anthropic" }, amount };
}

function chat(id: string, title: string | null, cost: number, inputTokens = 0, cacheReadTokens = 0): SpendChat {
	return {
		id,
		file: `/s/${id}.jsonl`,
		cwd: "/w",
		title,
		model: null,
		inputTokens,
		outputTokens: 0,
		cacheReadTokens,
		cacheWriteTokens: 0,
		cost,
		requests: 1,
		durationMs: 0,
		firstAt: 0,
		lastAt: 0,
		createdAt: 0,
	};
}

describe("usedFraction", () => {
	it("follows omp's precedence: usedFraction, used/limit, percent, remainingFraction", () => {
		expect(usedFraction(limit({ usedFraction: 0.4, used: 90, limit: 100, unit: "tokens" }))).toBe(0.4);
		expect(usedFraction(limit({ used: 30, limit: 120, unit: "requests" }))).toBe(0.25);
		expect(usedFraction(limit({ used: 62, unit: "percent" }))).toBe(0.62);
		expect(usedFraction(limit({ remainingFraction: 0.1, unit: "unknown" }))).toBeCloseTo(0.9);
		expect(usedFraction(limit({ used: 5, unit: "credits" }))).toBeNull();
	});
});

describe("limitTone", () => {
	it("turns warn at 70% and err at 90% or when exhausted", () => {
		expect([limitTone(0.69, "ok"), limitTone(0.7, undefined), limitTone(0.9, "ok"), limitTone(0.1, "exhausted")]).toEqual(["ok", "warn", "err", "err"]);
	});
});

describe("sortChats", () => {
	it("sorts numeric columns and keeps untitled chats last whichever way titles are sorted", () => {
		const rows = [chat("a", "beta", 2), chat("b", null, 5), chat("c", "Alpha", 1)];
		expect(sortChats(rows, "cost", "desc").map(r => r.id)).toEqual(["b", "a", "c"]);
		expect(sortChats(rows, "title", "asc").map(r => r.id)).toEqual(["c", "a", "b"]);
		expect(sortChats(rows, "title", "desc").map(r => r.id)).toEqual(["a", "c", "b"]);
	});

	it("sorts prompt tokens using the cached input included in the table", () => {
		const rows = [chat("fresh", "Fresh", 1, 100, 0), chat("cached", "Cached", 1, 10, 5000)];
		expect(sortChats(rows, "inputTokens", "desc").map(row => row.id)).toEqual(["cached", "fresh"]);
	});
});

describe("filterChats", () => {
	it("matches title, folder or model without case and combines with project and model filters", () => {
		const rows = [
			{ ...chat("a", "Fix Login", 1), cwd: "/w/app", model: "anthropic/claude-opus-5-5" },
			{ ...chat("b", "Docs", 1), cwd: "/w/site", model: "openai-codex/gpt-5.6" },
			{ ...chat("c", null, 1), cwd: "/w/app", model: "openai-codex/gpt-5.6" },
		];
		const ids = (filters: Parameters<typeof filterChats>[1]) => filterChats(rows, filters).map(row => row.id);
		expect(ids({ query: "login", project: null, model: null })).toEqual(["a"]);
		expect(ids({ query: "SITE", project: null, model: null })).toEqual(["b"]);
		expect(ids({ query: "", project: "/w/app", model: "openai-codex/gpt-5.6" })).toEqual(["c"]);
		expect(ids({ query: " ", project: null, model: null })).toEqual(["a", "b", "c"]);
	});
});

describe("chatsCsv", () => {
	it("labels the estimate and separates cache-inclusive from fresh input tokens, in the given order", () => {
		const rows = [{ ...chat("b", null, 0.5, 100, 900), cacheWriteTokens: 50 }, chat("a", 'Say "hi", then', 2)];
		const [header, first, second] = chatsCsv(rows, "Untitled chat").trimEnd().split("\r\n");
		const columns = header.split(",");
		expect(columns).toContain("estimated_api_cost_usd");
		expect(columns).not.toContain("cost_usd");
		const cells = Object.fromEntries(columns.map((column, index) => [column, first.split(",")[index]]));
		expect(cells).toMatchObject({ chat: "Untitled chat", input_tokens_incl_cache: "1050", fresh_input_tokens: "100", cache_read_tokens: "900", estimated_api_cost_usd: "0.5000" });
		expect(second.startsWith('"Say ""hi"", then",')).toBe(true);
	});

	it("names the file after the range's first and last local dates", () => {
		const day = (date: string) => ({ date, start: 0, cost: 0, tokens: 0, requests: 0 });
		expect(chatsCsvName([day("2026-09-15"), day("2026-10-14")])).toBe("omp-chats-2026-09-15-to-2026-10-14.csv");
		expect(chatsCsvName([])).toBe("omp-chats.csv");
	});
});

describe("chartScale", () => {
	it("starts at zero with 3 or 4 even ticks whose top covers the maximum", () => {
		for (const max of [0, 0.004, 0.07, 1, 2.01, 7.3, 15.2, 49, 100, 1299]) {
			const { ticks, top, step } = chartScale(max);
			expect(ticks[0]).toBe(0);
			expect(ticks.length).toBeGreaterThanOrEqual(3);
			expect(ticks.length).toBeLessThanOrEqual(4);
			expect(top).toBeGreaterThanOrEqual(max);
			ticks.forEach((tick, index) => expect(tick).toBeCloseTo(index * step, 9));
		}
		expect(chartScale(7.3).ticks).toEqual([0, 2.5, 5, 7.5]);
		expect(chartScale(1299).ticks).toEqual([0, 500, 1000, 1500]);
	});

	it("prints whole dollars for whole steps and cents otherwise", () => {
		expect(formatTick(1000, 500)).toBe("$1,000");
		expect(formatTick(0.5, 0.25)).toBe("$0.50");
	});
});
