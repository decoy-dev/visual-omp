/** Pure helpers for the Usage & limits page. */
import type { SpendChat, SpendDay } from "@shared/contracts/extensions";
import type { UsageLimit } from "@shared/contracts/usage";
import { meterTone } from "@/ui/Meter";
import { toCsv } from "../format";

/** omp's used-fraction resolution order (see `UsageLimit`); null when the limit reports nothing usable. */
export function usedFraction(limit: UsageLimit): number | null {
	const { amount } = limit;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) return amount.used / amount.limit;
	if (amount.used !== undefined && amount.unit === "percent") return amount.used / 100;
	if (amount.remainingFraction !== undefined) return 1 - amount.remainingFraction;
	return null;
}

/** The app's meter thresholds (`meterTone`: warn from 70%, err from 90% or exhausted); a provider-reported warning warns at any level. */
export function limitTone(fraction: number | null, status: UsageLimit["status"]): "ok" | "warn" | "err" {
	const tone = meterTone(fraction ?? 0, status === "exhausted");
	if (tone !== "accent") return tone;
	return status === "warning" ? "warn" : "ok";
}

/** Trailing local days the page reports on. */
export type UsageRange = 7 | 30;

export type ChatSortKey = "title" | "model" | "inputTokens" | "outputTokens" | "cost" | "durationMs";
export type SortDirection = "asc" | "desc";

/** Prompt tokens as the table shows them: fresh input plus cache reads and writes. */
export function promptTokens(chat: SpendChat): number {
	return chat.inputTokens + chat.cacheReadTokens + chat.cacheWriteTokens;
}

export function sortChats(chats: readonly SpendChat[], key: ChatSortKey, direction: SortDirection): SpendChat[] {
	const sign = direction === "asc" ? 1 : -1;
	return [...chats].sort((a, b) => {
		if (key === "title" || key === "model") {
			const left = (a[key] ?? "").toLocaleLowerCase();
			const right = (b[key] ?? "").toLocaleLowerCase();
			// Untitled rows stay at the bottom whichever way the column is sorted.
			if (!left !== !right) return left ? -1 : 1;
			return sign * left.localeCompare(right);
		}
		if (key === "inputTokens") return sign * (promptTokens(a) - promptTokens(b));
		return sign * (a[key] - b[key]);
	});
}

/** Last path segment of a project folder. */
export function projectName(cwd: string): string {
	const trimmed = cwd.replace(/[\\/]+$/, "");
	return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || cwd;
}

/** Table-only filters; the summary and chart always cover every chat in the range. */
export interface ChatFilters {
	/** Matches the title, project folder or model, ignoring case. */
	query: string;
	/** Project folder (`SpendChat.cwd`), or null for every project. */
	project: string | null;
	/** `provider/model`, or null for every model. */
	model: string | null;
}

export function filterChats(chats: readonly SpendChat[], { query, project, model }: ChatFilters): SpendChat[] {
	const needle = query.trim().toLocaleLowerCase();
	return chats.filter(
		chat =>
			(project === null || chat.cwd === project) &&
			(model === null || chat.model === model) &&
			(!needle || [chat.title, chat.cwd, chat.model].some(field => field?.toLocaleLowerCase().includes(needle))),
	);
}

/** One project's share of the period's estimated API cost. */
export interface ProjectCost {
	/** Project folder (`SpendChat.cwd`). */
	cwd: string;
	cost: number;
	chats: number;
}

/**
 * Estimated API cost per project folder, highest first (ties by folder name). A chat's cost includes
 * every model and subagent it ran, so it all counts toward the chat's own project.
 */
export function costByProject(chats: readonly SpendChat[]): ProjectCost[] {
	const byCwd = new Map<string, ProjectCost>();
	for (const chat of chats) {
		const entry = byCwd.get(chat.cwd) ?? { cwd: chat.cwd, cost: 0, chats: 0 };
		entry.cost += chat.cost;
		entry.chats += 1;
		byCwd.set(chat.cwd, entry);
	}
	return [...byCwd.values()].sort((a, b) => b.cost - a.cost || projectName(a.cwd).localeCompare(projectName(b.cwd)));
}

/** The first `limit` projects, and the rest folded into one figure (null when nothing is left over). */
export function topProjects(projects: readonly ProjectCost[], limit: number): { shown: ProjectCost[]; rest: { count: number; cost: number } | null } {
	if (projects.length <= limit) return { shown: [...projects], rest: null };
	const shown = projects.slice(0, limit - 1);
	const others = projects.slice(limit - 1);
	return { shown, rest: { count: others.length, cost: others.reduce((sum, project) => sum + project.cost, 0) } };
}

/** Mean estimated API cost per day over the range, today so far included. */
export function dailyAverage(days: readonly SpendDay[]): number {
	return days.length === 0 ? 0 : days.reduce((sum, day) => sum + day.cost, 0) / days.length;
}

/**
 * Chats as CSV, in the order given. Token columns say whether cache reads and writes are included,
 * and the cost column says it is omp's estimate at public API prices.
 */
export function chatsCsv(chats: readonly SpendChat[], untitled: string): string {
	return toCsv(
		[
			"chat",
			"project",
			"primary_model",
			"input_tokens_incl_cache",
			"fresh_input_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"output_tokens",
			"estimated_api_cost_usd",
			"requests",
			"generation_time_s",
			"first_activity",
			"last_activity",
			"session_file",
		],
		chats.map(chat => [
			chat.title ?? untitled,
			chat.cwd,
			chat.model ?? "",
			promptTokens(chat),
			chat.inputTokens,
			chat.cacheReadTokens,
			chat.cacheWriteTokens,
			chat.outputTokens,
			chat.cost.toFixed(4),
			chat.requests,
			Math.round(chat.durationMs / 1000),
			new Date(chat.firstAt).toISOString(),
			new Date(chat.lastAt).toISOString(),
			chat.file,
		]),
	);
}

/** `omp-chats-2026-10-08-to-2026-10-14.csv`: the range's first and last local dates. */
export function chatsCsvName(days: readonly SpendDay[]): string {
	const first = days[0]?.date;
	const last = days.at(-1)?.date;
	return first && last ? `omp-chats-${first}-to-${last}.csv` : "omp-chats.csv";
}

/** Y axis of the daily cost chart: zero-based, 2 or 3 equal steps (3 or 4 ticks), the top at or above `max`. */
export interface ChartScale {
	top: number;
	step: number;
	/** Ascending, starting at 0, ending at `top`. */
	ticks: number[];
}

const NICE_STEPS = [1, 2, 2.5, 5, 10];
/** Below a cent the axis would only repeat "$0.00". */
const MIN_STEP = 0.01;

export function chartScale(max: number): ChartScale {
	const raw = Math.max(max, 0) / 3;
	let step = MIN_STEP;
	if (raw > MIN_STEP) {
		const magnitude = 10 ** Math.floor(Math.log10(raw));
		step = (NICE_STEPS.find(nice => nice * magnitude >= raw * (1 - 1e-9)) ?? 10) * magnitude;
	}
	const intervals = Math.max(2, Math.ceil(max / step - 1e-9));
	const ticks = Array.from({ length: intervals + 1 }, (_, index) => Number((index * step).toPrecision(12)));
	return { top: ticks.at(-1) ?? step * 2, step, ticks };
}

/** Axis label: whole dollars when every tick is whole, else cents. */
export function formatTick(value: number, step: number): string {
	const digits = Number.isInteger(step) ? 0 : 2;
	return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
