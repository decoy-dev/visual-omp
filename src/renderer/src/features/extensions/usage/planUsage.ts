/**
 * Plan usage of the models a chat is using (status bar, DESIGN §3.8): which `omp usage` reports and
 * limit windows apply to those models, pooled across accounts, and each provider's most-used window.
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
	/** The most-used window with a known fraction. */
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

function windowName(limit: UsageLimit): string {
	const durationMs = limit.window?.durationMs;
	if (durationMs !== undefined) return formatDuration(durationMs);
	return limit.window?.id ?? limit.scope.windowId ?? limit.label;
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

/**
 * The provider's windows that bind `modelIds`. With one account each limit is read as reported; with
 * several, a limit id's rows across accounts merge into omp's pooled capacity figure (accounts' worth
 * of quota used / accounts), falling back to the mean fraction when omp reports no matching bucket.
 */
function providerWindows(reports: readonly UsageReport[], modelIds: readonly string[], stats: readonly ProviderWindowStat[]): WindowUsage[] {
	const groups = new Map<string, UsageLimit[]>();
	for (const report of reports) {
		for (const limit of report.limits) {
			if (limitApplies(limit, modelIds)) groups.set(limit.id, [...(groups.get(limit.id) ?? []), limit]);
		}
	}
	const names = [...groups.values()].map(([limit]) => windowName(limit));
	return [...groups.values()].map((limits, index) => {
		const first = limits[0];
		const stat = reports.length > 1 ? capacityStat(stats, first) : undefined;
		const known = limits.map(usedFraction).filter((fraction): fraction is number => fraction !== null);
		const fraction =
			stat && stat.accounts > 0 ? stat.usedAccounts / stat.accounts : known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
		const status = pooledStatus(limits.map(limit => limit.status));
		const resets = limits.map(limit => limit.window?.resetsAt).filter((at): at is number => at !== undefined);
		// Rows that share a compact name (`7d` and its Fable tier) keep apart by their tier.
		const name = names[index];
		const clash = names.some((other, otherIndex) => otherIndex !== index && other === name);
		return {
			id: first.id,
			label: first.label,
			window: clash && first.scope.tier ? `${name} ${first.scope.tier}` : name,
			fraction,
			status,
			tone: limitTone(fraction, status),
			resetsAt: resets.length > 0 ? Math.min(...resets) : null,
		};
	});
}

/** Higher first: provider-reported exhaustion, then the used fraction. */
function compareUse(a: WindowUsage, b: WindowUsage): number {
	const exhausted = Number(b.status === "exhausted") - Number(a.status === "exhausted");
	return exhausted !== 0 ? exhausted : (b.fraction ?? 0) - (a.fraction ?? 0);
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
		const top = windows.filter(window => window.fraction !== null).sort(compareUse)[0];
		if (!top) continue;
		out.push({ provider, accounts: reports.length, windows, top, fetchedAt: Math.min(...reports.map(report => report.fetchedAt)) });
	}
	return out;
}
