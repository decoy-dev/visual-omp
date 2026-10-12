/**
 * Plan usage of the models a chat is using (status bar, DESIGN §3.8): which `omp usage` reports and
 * limit windows apply to those models, pooled across accounts, and the window each provider shows.
 */
import type { SessionEntry, WireModel } from "@oh-my-pi/pi-wire";
import type { ProviderWindowStat, UsageLimit, UsageLimitsSnapshot, UsageReport, UsageStatus } from "@shared/contracts/usage";
import { formatDuration } from "../format";
import { limitTone, usedFraction } from "./model";

/** A model as `provider/modelId`. */
export interface ModelRef {
	provider: string;
	modelId: string;
}

/** One limit window as the status bar shows it. */
export interface WindowUsage {
	/** {@link UsageLimit.id}. */
	id: string;
	/** omp's full limit label, e.g. `Claude 5 Hour`. */
	label: string;
	/** Compact window name, e.g. `5h`, `7d`, `7d fable`. */
	window: string;
	/**
	 * omp's limit label, set only when another window of the provider has the same compact name and
	 * this label is readable (Kimi's `Weekly limit` beside its `limit_7d` meter); the tooltip shows it.
	 */
	detail?: string;
	/** 0..1 (above 1 means overage); null when the provider reports nothing usable. */
	fraction: number | null;
	status: UsageStatus | undefined;
	tone: "ok" | "warn" | "err";
	/** Epoch ms of the next reset (the soonest one across pooled accounts). */
	resetsAt: number | null;
}

export interface ProviderUsage {
	provider: string;
	/** Accounts reporting for this provider; above 1 the windows use omp's pooled capacity. */
	accounts: number;
	windows: WindowUsage[];
	/** The window the status bar shows (see {@link pickTop}). */
	top: WindowUsage;
	/** Epoch ms of the oldest report behind these figures (omp caches provider reports). */
	fetchedAt: number;
}

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	"kimi-code": "Kimi",
	"github-copilot": "Copilot",
	"google-gemini-cli": "Gemini",
	"google-antigravity": "Antigravity",
	cursor: "Cursor",
	zai: "Z.ai",
	"minimax-code": "MiniMax",
	"xai-oauth": "Grok",
	"alibaba-token-plan": "Alibaba",
	"opencode-go": "OpenCode Go",
	"ollama-cloud": "Ollama Cloud",
	ollama: "Ollama",
	synthetic: "Synthetic",
	umans: "Umans",
};

/** Short product name of a model provider; unknown ids are title-cased the way `omp usage` prints them. */
export function providerName(provider: string): string {
	return (
		PROVIDER_NAMES[provider] ??
		provider
			.split(/[-_]/g)
			.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
			.join(" ")
	);
}

const THINKING_LEVELS: Record<string, true> = { inherit: true, off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };

/** Parses omp's `provider/modelId[@route][:thinking]` selector (subagent `resolvedModel`). */
export function parseModelSelector(selector: string): ModelRef | null {
	const slash = selector.indexOf("/");
	if (slash <= 0) return null;
	let modelId = selector.slice(slash + 1);
	const colon = modelId.lastIndexOf(":");
	if (colon > 0 && THINKING_LEVELS[modelId.slice(colon + 1)] === true) modelId = modelId.slice(0, colon);
	const at = modelId.lastIndexOf("@");
	if (at > 0) modelId = modelId.slice(0, at);
	return modelId ? { provider: selector.slice(0, slash), modelId } : null;
}

/**
 * The chat's own model. The live omp state wins; a saved chat that has not started omp yet falls back
 * to its active branch (`entries`, root to leaf): the last `model_change`, else the last assistant
 * reply's model. omp writes `provider` and `model` on each assistant message in the session file.
 */
export function chatModel(live: WireModel | undefined, entries: readonly SessionEntry[]): ModelRef | null {
	if (live) return { provider: live.provider, modelId: live.id };
	let reply: ModelRef | null = null;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "model_change") {
			const changed = parseModelSelector(entry.model);
			if (changed) return changed;
		} else if (!reply && entry.type === "message" && entry.message.role === "assistant") {
			const { model, provider } = entry.message as { model?: string; provider?: string };
			if (model) reply = provider ? { provider, modelId: model } : parseModelSelector(model);
		}
	}
	return reply;
}

/** The chat's own model first, then the models of its running subagents, without duplicates. */
export function modelsInUse(main: ModelRef | null, subagents: Iterable<{ status: string; resolvedModel?: string }>): ModelRef[] {
	const models: ModelRef[] = main ? [main] : [];
	for (const agent of subagents) {
		if (agent.status !== "running" && agent.status !== "pending") continue;
		const model = agent.resolvedModel ? parseModelSelector(agent.resolvedModel) : null;
		if (model && !models.some(known => known.provider === model.provider && known.modelId === model.modelId)) models.push(model);
	}
	return models;
}

const bareModelId = (modelId: string) => modelId.slice(modelId.lastIndexOf("/") + 1);

/** Claude family of a model id (`claude-opus-5-5` → `opus`), as omp's `parseAnthropicModel` reads it. */
function claudeKind(modelId: string): string | undefined {
	const id = bareModelId(modelId);
	return (
		/claude-(opus|sonnet|fable|mythos)-\d{1,2}(?:[.-]\d{1,2}){0,2}\b/.exec(id)?.[1] ??
		/claude-\d{1,2}(?:[.-]\d{1,2}){0,2}-(opus|sonnet|fable|mythos)\b/.exec(id)?.[1]
	);
}

/**
 * Whether a limit binds any of the provider's models in use. A `scope.modelId` limit counts only for
 * that model. Anthropic rows follow omp's own scoping (`scopeClaudeLimitsForModel`): shared windows
 * always count, tier rows (Fable, Opus weekly) only for the matching Claude family, and the remaining
 * rows (extra usage spend) are left out.
 */
export function limitApplies(limit: UsageLimit, modelIds: readonly string[]): boolean {
	const scoped = limit.scope.modelId;
	if (scoped !== undefined) return modelIds.some(id => bareModelId(id) === bareModelId(scoped));
	if (limit.scope.provider !== "anthropic") return true;
	if (limit.scope.shared === true) return true;
	const tier = limit.scope.tier;
	return tier !== undefined && modelIds.some(id => claudeKind(id) === tier);
}

const DURATION_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DURATION_TOKEN = /(?<![a-z0-9.])(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)(?![a-z0-9])/gi;

/**
 * Duration in ms of a window name that holds exactly one duration token (`7d`, `limit_7d`, `7 Day`,
 * `30 days`, `1w`); null when it holds none or several, or digits sit inside another word.
 */
export function parseWindowDuration(text: string): number | null {
	const tokens = [...text.matchAll(DURATION_TOKEN)];
	if (tokens.length !== 1) return null;
	const [, amount, unit] = tokens[0];
	return Number(amount) * DURATION_UNIT_MS[unit[0].toLowerCase()];
}

/** omp's window duration, else one read from the window id, scope or label; null when none can be read. */
function windowDurationMs(limit: UsageLimit): number | null {
	const window = limit.window;
	let durationMs = window?.durationMs ?? null;
	for (const text of [window?.id, limit.scope.windowId, window?.label]) {
		if (durationMs === null && text) durationMs = parseWindowDuration(text);
	}
	return durationMs;
}

/** Compact window name: the window's duration, else the human label. */
function windowName(limit: UsageLimit): string {
	const durationMs = windowDurationMs(limit);
	return durationMs !== null ? formatDuration(durationMs) : (limit.window?.label ?? limit.label);
}

const FIVE_HOURS_MS = 5 * 3_600_000;
const SEVEN_DAYS_MS = 7 * 86_400_000;
const MONTHLY_WORD = /(?<![a-z])month(?:ly)?(?![a-z])/i;

/**
 * Which window kind the status bar prefers: 0 for 5 hours, 1 for 7 days, 2 for a month (28 to 31 days,
 * or a window without a duration whose id or label says monthly), null for any other window.
 */
function windowPreference(limit: UsageLimit): number | null {
	const durationMs = windowDurationMs(limit);
	if (durationMs === FIVE_HOURS_MS) return 0;
	if (durationMs === SEVEN_DAYS_MS) return 1;
	if (durationMs !== null) return durationMs >= 28 * 86_400_000 && durationMs <= 31 * 86_400_000 ? 2 : null;
	const texts = [limit.window?.id, limit.scope.windowId, limit.window?.label, limit.label];
	return texts.some(text => text !== undefined && MONTHLY_WORD.test(text)) ? 2 : null;
}

/**
 * omp's pooled capacity bucket for a limit (see `computeProviderWindowStats`): the same window, and
 * the limit's tier as the bucket's meter. Anthropic keeps tier rows (Fable weekly) and shared windows
 * in separate meters, so its buckets must match the meter exactly (no meter for a shared window) and a
 * missing bucket returns undefined. Other providers name meters without a tier (Codex's `chat`), so a
 * window's only bucket stands in for it.
 */
function capacityStat(stats: readonly ProviderWindowStat[], limit: UsageLimit): ProviderWindowStat | undefined {
	const durationMs = limit.window?.durationMs;
	const name = limit.window?.label ?? limit.scope.windowId ?? limit.label;
	const candidates = stats.filter(stat => (durationMs !== undefined ? stat.durationMs === durationMs : stat.durationMs === undefined && stat.window === name));
	const exact = candidates.find(stat => stat.meter === limit.scope.tier);
	if (exact || limit.scope.provider === "anthropic") return exact;
	return candidates.length === 1 ? candidates[0] : undefined;
}

function pooledStatus(statuses: readonly (UsageStatus | undefined)[]): UsageStatus | undefined {
	if (statuses.length > 0 && statuses.every(status => status === "exhausted")) return "exhausted";
	if (statuses.some(status => status === "warning" || status === "exhausted")) return "warning";
	return statuses.find(status => status !== undefined);
}

/** A window with its {@link windowPreference}. */
interface RankedWindow {
	usage: WindowUsage;
	preference: number | null;
}

/**
 * The provider's windows that bind `modelIds`. With one account each limit is read as reported; with
 * several, a limit id's rows across accounts merge into omp's pooled capacity figure (accounts' worth
 * of quota used / accounts), falling back to the mean fraction when omp reports no matching bucket.
 * A pooled window is exhausted only when every reporting account reports it exhausted; an account
 * without the row counts as not exhausted. Rows that share a compact name stay separate: a tier tells
 * them apart (`7d` and `7d fable`), else a readable limit label goes into `detail`.
 */
function providerWindows(reports: readonly UsageReport[], modelIds: readonly string[], stats: readonly ProviderWindowStat[]): RankedWindow[] {
	// Each limit id's row per account, by report index; undefined where an account has no such row.
	const groups = new Map<string, (UsageLimit | undefined)[]>();
	reports.forEach((report, account) => {
		for (const limit of report.limits) {
			if (!limitApplies(limit, modelIds)) continue;
			const rows = groups.get(limit.id) ?? new Array<UsageLimit | undefined>(reports.length).fill(undefined);
			rows[account] = limit;
			groups.set(limit.id, rows);
		}
	});
	const present = [...groups.values()].map(rows => rows.filter((row): row is UsageLimit => row !== undefined));
	const firsts = present.map(([limit]) => limit);
	const durations = firsts.map(windowName);
	// Rows that share a compact name (`7d` and its Fable tier) keep apart by their tier.
	const names = durations.map((name, index) => {
		const tier = firsts[index].scope.tier;
		return tier && durations.some((other, otherIndex) => otherIndex !== index && other === name) ? `${name} ${tier}` : name;
	});
	return [...groups.values()].map((rows, index): RankedWindow => {
		const limits = present[index];
		const first = limits[0];
		const stat = reports.length > 1 ? capacityStat(stats, first) : undefined;
		const known = limits.map(usedFraction).filter((fraction): fraction is number => fraction !== null);
		const fraction =
			stat && stat.accounts > 0 ? stat.usedAccounts / stat.accounts : known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
		const status = pooledStatus(rows.map(row => row?.status));
		const resets = limits.map(limit => limit.window?.resetsAt).filter((at): at is number => at !== undefined);
		const name = names[index];
		const clash = names.some((other, otherIndex) => otherIndex !== index && other === name);
		const readable = /\s/.test(first.label) && parseWindowDuration(first.label) === null;
		const usage: WindowUsage = {
			id: first.id,
			label: first.label,
			window: name,
			detail: clash && readable ? first.label : undefined,
			fraction,
			status,
			tone: limitTone(fraction, status),
			resetsAt: resets.length > 0 ? Math.min(...resets) : null,
		};
		return { usage, preference: windowPreference(first) };
	});
}

/** Higher first: provider-reported exhaustion, then the used fraction. */
function compareUse(a: WindowUsage, b: WindowUsage): number {
	const exhausted = Number(b.status === "exhausted") - Number(a.status === "exhausted");
	return exhausted !== 0 ? exhausted : (b.fraction ?? 0) - (a.fraction ?? 0);
}

/**
 * The window the status bar shows, among those with a known fraction: one the provider reports as
 * exhausted (it blocks the chat), else the 5h window, else 7d, else monthly, else the most-used one.
 * Several windows of the chosen kind (Claude's `7d` and `7d fable`) yield the most-used.
 */
function pickTop(windows: readonly RankedWindow[]): WindowUsage | undefined {
	const known = windows.filter(window => window.usage.fraction !== null);
	const exhausted = known.filter(window => window.usage.status === "exhausted");
	const preferences = known.map(window => window.preference).filter((preference): preference is number => preference !== null);
	const preferred = preferences.length > 0 ? Math.min(...preferences) : null;
	const pool = exhausted.length > 0 ? exhausted : preferred !== null ? known.filter(window => window.preference === preferred) : known;
	return pool.map(window => window.usage).sort(compareUse)[0];
}

/**
 * Plan usage per provider of `models`, in the order the providers first appear. Providers without a
 * report (API keys with no usage endpoint) and providers whose windows report no usable fraction are
 * left out.
 */
export function planUsage(snapshot: UsageLimitsSnapshot | null, models: readonly ModelRef[]): ProviderUsage[] {
	if (!snapshot) return [];
	const byProvider = new Map<string, string[]>();
	for (const model of models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model.modelId]);
	const out: ProviderUsage[] = [];
	for (const [provider, modelIds] of byProvider) {
		const reports = snapshot.reports.filter(report => report.provider === provider && report.limits.length > 0);
		if (reports.length === 0) continue;
		const windows = providerWindows(reports, modelIds, snapshot.capacity[provider] ?? []);
		const top = pickTop(windows);
		if (!top) continue;
		out.push({ provider, accounts: reports.length, windows: windows.map(window => window.usage), top, fetchedAt: Math.min(...reports.map(report => report.fetchedAt)) });
	}
	return out;
}
