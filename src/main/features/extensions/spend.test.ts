import { describe, expect, it } from "vitest";
import { dayStarts, localDate, parseTranscript, summarizeSpend } from "./spend";

const NOW = new Date(2026, 8, 30, 15, 0, 0).getTime();
const TODAY_10AM = new Date(2026, 8, 30, 10, 0, 0).getTime();
const YESTERDAY = new Date(2026, 8, 29, 23, 30, 0).getTime();
const EIGHT_DAYS_AGO = new Date(2026, 8, 22, 12, 0, 0).getTime();

function assistant(at: number, cost: number | null, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message",
		id: `m${at}`,
		parentId: null,
		timestamp: new Date(at).toISOString(),
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus",
			content: [{ type: "text", text: "said \"usage\" in passing" }],
			usage: {
				input: 10,
				output: 20,
				cacheRead: 100,
				cacheWrite: 5,
				totalTokens: 135,
				...(cost === null ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }),
			},
			stopReason: "stop",
			timestamp: at,
			...extra,
		},
	});
}

const TITLE = JSON.stringify({ type: "title", v: 1, title: "Fix checkout", source: "auto" });
const HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "s1",
	timestamp: new Date(2026, 8, 29, 9).toISOString(),
	cwd: "/work/shop",
	title: "old title",
});

describe("parseTranscript", () => {
	it("reads the title slot, header, assistant calls and model_usage side calls", () => {
		const sideCall = JSON.stringify({
			type: "model_usage",
			id: "u1",
			parentId: null,
			timestamp: new Date(TODAY_10AM).toISOString(),
			purpose: "title",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-mini",
			usage: { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { total: 0.001 } },
			stopReason: "stop",
		});
		const user = JSON.stringify({ type: "message", message: { role: "user", content: "what does usage cost?" } });
		const parsed = parseTranscript(
			[TITLE, HEADER, user, assistant(TODAY_10AM, 0.5, { duration: 1200 }), sideCall, "{not json", ""].join("\n"),
		);
		expect(parsed.header).toEqual({ id: "s1", cwd: "/work/shop", title: "Fix checkout", createdAt: new Date(2026, 8, 29, 9).getTime() });
		expect(parsed.calls).toEqual([
			{ at: TODAY_10AM, model: "anthropic/claude-opus", input: 10, output: 20, cacheRead: 100, cacheWrite: 5, tokens: 135, cost: 0.5, durationMs: 1200 },
			{ at: TODAY_10AM, model: "openai/gpt-mini", input: 3, output: 4, cacheRead: 0, cacheWrite: 0, tokens: 7, cost: 0.001, durationMs: 0 },
		]);
	});

	it("treats a missing price as free and falls back to the entry timestamp when the message has none", () => {
		const parsed = parseTranscript([HEADER, assistant(TODAY_10AM, null, { timestamp: 0 })].join("\n"));
		expect(parsed.calls[0]).toMatchObject({ at: TODAY_10AM, cost: 0 });
		expect(parsed.header?.title).toBe("old title");
	});
});

describe("summarizeSpend", () => {
	it("buckets calls into local days, rolls subagents into their chat and ignores calls outside the range", () => {
		const main = parseTranscript([TITLE, HEADER, assistant(TODAY_10AM, 1), assistant(YESTERDAY, 0.25), assistant(EIGHT_DAYS_AGO, 9)].join("\n"));
		const helper = parseTranscript(
			[JSON.stringify({ type: "session", id: "sub", cwd: "/work/shop" }), assistant(TODAY_10AM, 0.5).replace("claude-opus", "claude-haiku")].join("\n"),
		);
		const other = parseTranscript([JSON.stringify({ type: "session", id: "s2", cwd: "/work/blog" }), assistant(TODAY_10AM, 0.1)].join("\n"));
		const summary = summarizeSpend(
			[
				{ file: "/s/a.jsonl", main, subagents: [helper] },
				{ file: "/s/b.jsonl", main: other, subagents: [] },
				{ file: "/s/idle.jsonl", main: parseTranscript(HEADER), subagents: [] },
			],
			NOW,
			7,
		);
		expect(summary.days).toHaveLength(7);
		expect(summary.days.at(-1)).toMatchObject({ date: "2026-09-30", requests: 3 });
		expect(summary.days.at(-1)?.cost).toBeCloseTo(1.6);
		expect(summary.days.at(-2)).toMatchObject({ date: "2026-09-29", cost: 0.25, requests: 1 });
		expect(summary.totals).toMatchObject({ requests: 4, chats: 2 });
		expect(summary.totals.cost).toBeCloseTo(1.85);
		expect(summary.chats.map(chat => chat.id)).toEqual(["s1", "s2"]);
		expect(summary.chats[0]).toMatchObject({
			title: "Fix checkout",
			model: "anthropic/claude-opus",
			requests: 3,
			inputTokens: 30,
			firstAt: YESTERDAY,
			lastAt: TODAY_10AM,
		});
		expect(summary.chats[0]?.cost).toBeCloseTo(1.75);
	});
});

describe("dayStarts", () => {
	it("returns consecutive local midnights ending today", () => {
		const starts = dayStarts(NOW, 3);
		expect(starts.map(localDate)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
		expect(new Date(starts[2] ?? 0).getHours()).toBe(0);
	});
});
