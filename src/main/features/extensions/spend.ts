/**
 * Cost/token totals straight from omp session transcripts (see `@shared/contracts/extensions`).
 *
 * Mirrors what omp's stats ingest counts (`packages/stats/src/parser.ts`): every assistant `message`
 * entry and every `model_usage` entry (side calls such as titles and summaries) with a `usage` block.
 * Cost is omp's recorded `usage.cost.total`; requests without a recorded price count as $0.
 */
import { z } from "zod";
import type { SpendChat, SpendDay, SpendSummary } from "@shared/contracts/extensions";

/** One model call, reduced to the numbers the dashboard needs. */
export interface SpendCall {
	/** Epoch ms. */
	at: number;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
	durationMs: number;
}

export interface TranscriptHeader {
	id: string;
	cwd: string;
	title: string | null;
	createdAt: number | null;
}

export interface ParsedTranscript {
	/** Present for top-level session files (subagent transcripts also carry one; unused for them). */
	header: TranscriptHeader | null;
	calls: SpendCall[];
}

const Count = z.number().finite().nonnegative().catch(0);

const Usage = z.object({
	input: Count,
	output: Count,
	cacheRead: Count,
	cacheWrite: Count,
	totalTokens: z.number().finite().nonnegative().optional().catch(undefined),
	cost: z.object({ total: Count }).optional().catch(undefined),
});

const AssistantEntry = z.object({
	type: z.literal("message"),
	timestamp: z.string().optional(),
	message: z.object({
		role: z.literal("assistant"),
		provider: z.string(),
		model: z.string(),
		usage: Usage,
		timestamp: z.number().optional().catch(undefined),
		duration: z.number().optional().catch(undefined),
	}),
});

const ModelUsageEntry = z.object({
	type: z.literal("model_usage"),
	timestamp: z.string().optional(),
	provider: z.string(),
	model: z.string(),
	usage: Usage,
});

const TitleSlot = z.object({ type: z.literal("title"), title: z.string().optional() });

const Header = z.object({
	type: z.literal("session"),
	id: z.string(),
	cwd: z.string(),
	timestamp: z.string().optional(),
	title: z.string().optional(),
});

/** How many leading lines may hold the title slot / session header. */
const HEADER_LINES = 4;

function entryTime(messageTs: number | undefined, isoTs: string | undefined): number {
	// omp stores 0 as "no timestamp"; fall back to the entry envelope like omp's stats parser does.
	if (messageTs !== undefined && Number.isFinite(messageTs) && messageTs > 0) return messageTs;
	const parsed = isoTs ? Date.parse(isoTs) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function toCall(
	usage: z.infer<typeof Usage>,
	provider: string,
	model: string,
	at: number,
	durationMs: number | undefined,
): SpendCall {
	const sum = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return {
		at,
		model: `${provider}/${model}`,
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		tokens: usage.totalTokens ?? sum,
		cost: usage.cost?.total ?? 0,
		durationMs: durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
	};
}

function parseLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/** Parse one transcript. Lines without a `usage` key are skipped without JSON-parsing them. */
export function parseTranscript(text: string): ParsedTranscript {
	let title: string | null = null;
	let header: TranscriptHeader | null = null;
	const calls: SpendCall[] = [];
	let lineNo = 0;
	let start = 0;
	while (start < text.length) {
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		const line = text.slice(start, end);
		start = end + 1;
		if (lineNo++ < HEADER_LINES && !header) {
			const entry = parseLine(line);
			const slot = TitleSlot.safeParse(entry);
			if (slot.success) {
				title = slot.data.title || title;
				continue;
			}
			const head = Header.safeParse(entry);
			if (head.success) {
				const created = head.data.timestamp ? Date.parse(head.data.timestamp) : Number.NaN;
				header = {
					id: head.data.id,
					cwd: head.data.cwd,
					title: title ?? head.data.title ?? null,
					createdAt: Number.isFinite(created) ? created : null,
				};
				continue;
			}
		}
		if (!line.includes('"usage"')) continue;
		const entry = parseLine(line);
		const assistant = AssistantEntry.safeParse(entry);
		if (assistant.success) {
			const { message } = assistant.data;
			calls.push(
				toCall(message.usage, message.provider, message.model, entryTime(message.timestamp, assistant.data.timestamp), message.duration),
			);
			continue;
		}
		const side = ModelUsageEntry.safeParse(entry);
		if (side.success) {
			calls.push(toCall(side.data.usage, side.data.provider, side.data.model, entryTime(undefined, side.data.timestamp), undefined));
		}
	}
	return { header, calls };
}

/** Local `YYYY-MM-DD` of an epoch ms. */
export function localDate(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local-midnight starts of the last `count` days, oldest first, ending with the day of `now`. */
export function dayStarts(now: number, count: number): number[] {
	const starts: number[] = [];
	for (let back = count - 1; back >= 0; back--) {
		const d = new Date(now);
		d.setHours(0, 0, 0, 0);
		d.setDate(d.getDate() - back);
		starts.push(d.getTime());
	}
	return starts;
}

/** A chat's transcripts: the top-level session file plus its subagent transcripts. */
export interface ChatTranscripts {
	file: string;
	main: ParsedTranscript;
	subagents: ParsedTranscript[];
}

export function summarizeSpend(chats: ChatTranscripts[], now: number, dayCount: number, skippedFiles = 0): SpendSummary {
	const starts = dayStarts(now, dayCount);
	const rangeStart = starts[0] ?? now;
	const dayIndex = new Map(starts.map((start, index) => [localDate(start), index]));
	const days: SpendDay[] = starts.map(start => ({ date: localDate(start), start, cost: 0, tokens: 0, requests: 0 }));
	const rows: SpendChat[] = [];
	const totals = { cost: 0, tokens: 0, requests: 0, chats: 0 };

	for (const chat of chats) {
		const header = chat.main.header;
		const row: SpendChat = {
			id: header?.id ?? chat.file,
			file: chat.file,
			cwd: header?.cwd ?? "",
			title: header?.title ?? null,
			model: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cost: 0,
			requests: 0,
			durationMs: 0,
			firstAt: Number.POSITIVE_INFINITY,
			lastAt: 0,
			createdAt: header?.createdAt ?? 0,
		};
		const modelCalls = new Map<string, number>();
		for (const transcript of [chat.main, ...chat.subagents]) {
			for (const call of transcript.calls) {
				if (call.at < rangeStart || call.at > now) continue;
				const index = dayIndex.get(localDate(call.at));
				if (index === undefined) continue;
				const day = days[index];
				if (!day) continue;
				day.cost += call.cost;
				day.tokens += call.tokens;
				day.requests += 1;
				row.inputTokens += call.input;
				row.outputTokens += call.output;
				row.cacheReadTokens += call.cacheRead;
				row.cacheWriteTokens += call.cacheWrite;
				row.cost += call.cost;
				row.requests += 1;
				row.durationMs += call.durationMs;
				row.firstAt = Math.min(row.firstAt, call.at);
				row.lastAt = Math.max(row.lastAt, call.at);
				// Subagent calls count toward cost but the chat's model is the one the user talks to.
				if (transcript === chat.main) modelCalls.set(call.model, (modelCalls.get(call.model) ?? 0) + 1);
				totals.cost += call.cost;
				totals.tokens += call.tokens;
				totals.requests += 1;
			}
		}
		if (row.requests === 0) continue;
		let best = 0;
		for (const [model, count] of modelCalls) {
			if (count > best) {
				best = count;
				row.model = model;
			}
		}
		rows.push(row);
	}
	rows.sort((a, b) => b.cost - a.cost || b.lastAt - a.lastAt);
	totals.chats = rows.length;
	return { generatedAt: now, days, chats: rows, totals, skippedFiles };
}
