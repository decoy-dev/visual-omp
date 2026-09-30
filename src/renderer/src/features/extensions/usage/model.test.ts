import { describe, expect, it } from "vitest";
import type { SpendChat } from "@shared/contracts/extensions";
import type { UsageLimit } from "@shared/contracts/usage";
import { limitTone, sortChats, usedFraction } from "./model";

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
