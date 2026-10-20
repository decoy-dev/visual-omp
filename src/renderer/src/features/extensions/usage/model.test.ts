import { describe, expect, it } from "vitest";
import type { SpendChat, SpendDay } from "@shared/contracts/extensions";
import type { UsageLimit } from "@shared/contracts/usage";
import {
	activityWeeks,
	chartScale,
	chatsCsv,
	chatsCsvName,
	costByProject,
	dailyAverage,
	filterChats,
	formatTick,
	limitTone,
	sortChats,
	topProjects,
	usedFraction,
} from "./model";

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

describe("costByProject", () => {
	it("sums each project's chats, highest cost first, ties by folder name", () => {
		const rows = [
			{ ...chat("a", "A", 1.25), cwd: "/w/app" },
			{ ...chat("b", "B", 0.5), cwd: "/w/site" },
			{ ...chat("c", "C", 2), cwd: "/w/app" },
			{ ...chat("d", "D", 0.5), cwd: "/w/api" },
		];
		expect(costByProject(rows)).toEqual([
			{ cwd: "/w/app", cost: 3.25, chats: 2 },
			{ cwd: "/w/api", cost: 0.5, chats: 1 },
			{ cwd: "/w/site", cost: 0.5, chats: 1 },
		]);
	});

	it("folds the projects past the limit into one figure", () => {
		const projects = [5, 4, 3, 2, 1].map((cost, index) => ({ cwd: `/p${index}`, cost, chats: 1 }));
		expect(topProjects(projects, 5)).toEqual({ shown: projects, rest: null });
		const { shown, rest } = topProjects(projects, 3);
		expect(shown.map(project => project.cwd)).toEqual(["/p0", "/p1"]);
		expect(rest).toEqual({ count: 3, cost: 6 });
	});
});

describe("period totals", () => {
	it("agree across the KPI strip, the daily chart, the project shares and the CSV export", () => {
		// As the main process reports a period: each request lands in one day and one chat, and the totals sum them all.
		const calls = [
			{ chat: "a", cwd: "/w/app", day: 0, cost: 0.1234 },
			{ chat: "a", cwd: "/w/app", day: 2, cost: 1.005 },
			{ chat: "b", cwd: "/w/site", day: 2, cost: 0.3333 },
			{ chat: "c", cwd: "/w/app", day: 6, cost: 2.71828 },
			{ chat: "d", cwd: "/w/api", day: 6, cost: 0 },
		];
		const days = Array.from({ length: 7 }, (_, index) => ({
			date: `2026-10-0${index + 1}`,
			start: index,
			cost: calls.filter(call => call.day === index).reduce((sum, call) => sum + call.cost, 0),
			tokens: 0,
			requests: calls.filter(call => call.day === index).length,
		}));
		const chats = [...new Set(calls.map(call => call.chat))].map(id => {
			const own = calls.filter(call => call.chat === id);
			return { ...chat(id, id, own.reduce((sum, call) => sum + call.cost, 0)), cwd: own[0].cwd, requests: own.length };
		});
		const kpi = calls.reduce((sum, call) => sum + call.cost, 0);

		expect(dailyAverage(days) * days.length).toBeCloseTo(kpi, 10);
		expect(costByProject(chats).reduce((sum, project) => sum + project.cost, 0)).toBeCloseTo(kpi, 10);
		const [header, ...lines] = chatsCsv(chats, "Untitled chat").trimEnd().split("\r\n");
		const column = header.split(",").indexOf("estimated_api_cost_usd");
		const csvTotal = lines.reduce((sum, line) => sum + Number(line.split(",")[column]), 0);
		// The CSV rounds each chat to 4 decimals, so its sum stays within half a ten-thousandth per chat.
		expect(Math.abs(csvTotal - kpi)).toBeLessThanOrEqual(0.00005 * chats.length);
		expect(dailyAverage([])).toBe(0);
	});
});

/** Trailing local days ending on `today`, as the main process reports them, with `requests` per day from the end. */
function trailingDays(today: Date, count: number, requests: (back: number) => number = () => 0): SpendDay[] {
	return Array.from({ length: count }, (_, index) => {
		const back = count - 1 - index;
		const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
		const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		return { date: key, start: date.getTime(), cost: 0, tokens: 0, requests: requests(back) };
	});
}

describe("activityWeeks", () => {
	// Wednesday 21 October 2026, local time.
	const wednesday = new Date(2026, 9, 21);

	it("ends with the week holding today, top to bottom from the locale's first weekday", () => {
		const days = trailingDays(wednesday, 30);
		const sunday = activityWeeks(days, 3, 0);
		expect(sunday).toHaveLength(3);
		expect(sunday[2].map(cell => cell?.day.date ?? null)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", null, null, null]);
		expect(sunday[0][0]?.day.date).toBe("2026-10-04");

		const monday = activityWeeks(days, 1, 1);
		expect(monday[0].map(cell => cell?.day.date ?? null)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", null, null, null, null]);
	});

	it("keeps whole calendar days across a daylight saving change", () => {
		// US clocks fall back on 1 November 2026; weeks either side still start on Sunday.
		const days = trailingDays(new Date(2026, 10, 4), 21);
		const dates = activityWeeks(days, 3, 0).map(week => week[0]?.day.date);
		expect(dates).toEqual(["2026-10-18", "2026-10-25", "2026-11-01"]);
	});

	it("leaves days before the summary empty", () => {
		const grid = activityWeeks(trailingDays(wednesday, 3), 2, 0);
		expect(grid[0].every(cell => cell === null)).toBe(true);
		expect(grid[1].map(cell => cell?.day.date ?? null)).toEqual([null, "2026-10-19", "2026-10-20", "2026-10-21", null, null, null]);
	});

	it("ranks active days in quarters: idle days 0, the busiest quarter 4, equal days alike", () => {
		const counts = [0, 10, 20, 30, 40, 50, 60, 70, 70];
		const days = trailingDays(wednesday, counts.length, back => counts[counts.length - 1 - back]);
		const levels = new Map(activityWeeks(days, 2, 0).flat().flatMap(cell => (cell ? [[cell.day.requests, cell.level] as const] : [])));
		expect([0, 10, 20, 30, 40, 50, 60, 70].map(count => levels.get(count))).toEqual([0, 1, 1, 2, 2, 3, 3, 4]);

		// One active day is the busiest day.
		const single = activityWeeks(trailingDays(wednesday, 7, back => (back === 2 ? 3 : 0)), 1, 0).flat();
		expect(single.find(cell => cell?.day.requests === 3)?.level).toBe(4);
	});
});
