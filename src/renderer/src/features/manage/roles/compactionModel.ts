import type { JsonValue, ModelInfo, SettingInfo } from "@shared/contracts/config";

export type CompactionEntry = number | string;
export interface CompactionPolicy {
	enabled: boolean;
	extendedContext: boolean;
	modelThresholdsEnabled?: boolean;
	thresholdPercent: number;
	thresholdTokens: number;
	reserveTokens?: number;
}
export interface CompactionPlan {
	entry: CompactionEntry | null;
	window: number | null;
	tokens: number | null;
	basis: "fixed" | "capped" | "base" | "window";
	base: number | null;
	percent: number | null;
	opensExtended: boolean;
	/** This is a future policy preview while omp ignores per-model entries. */
	appliesWhenEnabled: boolean;
	premiumFrom: number | null;
	error: "invalid" | "baseTooLarge" | "fixedTooLarge" | null;
}

/** omp 18.14 config/compaction-threshold.ts parseCompactionPointInput. */
export function parseCompactionInput(input: string): CompactionEntry | null {
	const text = input.trim();
	if (!text) return null;
	const percent = /^(\d+(?:\.\d+)?)%$/.exec(text);
	if (percent && Number(percent[1]) > 0 && Number(percent[1]) <= 100) return text;
	const tokens = /^(f)?(\d+)([kmb])?$/i.exec(text);
	if (tokens) {
		const scales: Record<string, number> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
		const count = Number(tokens[2]) * (tokens[3] ? scales[tokens[3].toLowerCase()]! : 1);
		if (Number.isSafeInteger(count) && count > 0) return tokens[1] ? `f${count}` : count;
	}
	throw new Error("invalid");
}

/**
 * A typed point for omp's fixed `compaction.thresholdTokens`: a plain token count with the same suffixes
 * (`400k`, `600000`). Percentages and `f` triggers belong to per-model limits. Empty restores the inherited point.
 */
export function parseTokenPoint(input: string): { ok: true; tokens: number | null } | { ok: false } {
	let entry: CompactionEntry | null;
	try { entry = parseCompactionInput(input); } catch { return { ok: false }; }
	if (entry === null) return { ok: true, tokens: null };
	return typeof entry === "number" ? { ok: true, tokens: entry } : { ok: false };
}

/**
 * Slider ticks for a chat's compaction point on a `window`-token model: 10, 8, 5 or 4 equal parts, the first that
 * gives a whole number of thousands (1M: every 100K; 128K: every 16K), else whole-thousand quarters that stop at
 * the last tick inside the window. The slider runs from the first tick to the last in quarter ticks, so every
 * tick can be chosen.
 */
export function compactionTicks(window: number): { min: number; max: number; step: number; ticks: number[] } {
	const parts = [10, 8, 5, 4].find(count => window % count === 0 && (window / count) % 1_000 === 0);
	const spacing = parts ? window / parts : Math.max(1_000, Math.floor(window / 4 / 1_000) * 1_000);
	const ticks = Array.from({ length: parts ?? Math.max(1, Math.floor(window / spacing)) }, (_, index) => (index + 1) * spacing);
	return { min: spacing, max: ticks.at(-1)!, step: spacing / 4, ticks };
}

/** omp's compaction policy from its effective settings. */
export function compactionPolicy(byKey: ReadonlyMap<string, SettingInfo>): CompactionPolicy {
	const number = (key: string, fallback: number) => typeof byKey.get(key)?.value === "number" ? byKey.get(key)!.value as number : fallback;
	return {
		enabled: byKey.get("compaction.enabled")?.value !== false && byKey.get("compaction.strategy")?.value !== "off",
		extendedContext: byKey.get("extendedContext")?.value === true,
		modelThresholdsEnabled: byKey.get("compaction.modelThresholdsEnabled")?.value !== false,
		thresholdPercent: number("compaction.thresholdPercent", -1),
		thresholdTokens: number("compaction.thresholdTokens", -1),
		reserveTokens: typeof byKey.get("compaction.reserveTokens")?.value === "number" ? number("compaction.reserveTokens", 16_384) : undefined,
	};
}

export interface ChatCompactionPreview {
	/** What decides the point: the model's own limit, the chat's point, or omp's settings. */
	source: "model" | "chat" | "settings";
	/** The model limit's key when `source` is `model`. */
	modelKey: string | null;
	/** Where omp summarizes; null when automatic summaries are off or the window is unknown. */
	tokens: number | null;
	enabled: boolean;
}

/**
 * Where omp summarizes a chat on `model`. The chat's point is omp's fixed `compaction.thresholdTokens` in the
 * chat's overlay, so a matching per-model limit still replaces it, as it replaces the global point.
 */
export function chatCompactionPreview(model: ModelInfo, byKey: ReadonlyMap<string, SettingInfo>, chatTokens: number | null): ChatCompactionPreview {
	const policy = compactionPolicy(byKey);
	if (chatTokens !== null) policy.thresholdTokens = chatTokens;
	const entry = policy.modelThresholdsEnabled ? matchingCompactionEntry(thresholdMap(byKey.get("compaction.modelThresholds")?.value), model.selector) : null;
	const plan = planCompaction(model, "", policy, entry?.entry ?? null);
	return {
		source: entry ? "model" : chatTokens !== null ? "chat" : "settings",
		modelKey: entry?.key ?? null,
		tokens: plan.error ? null : plan.tokens,
		enabled: policy.enabled,
	};
}

export function thresholdMap(value: JsonValue | undefined): Record<string, JsonValue> {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** An exact entry wins; otherwise omp uses the longest matching wildcard prefix. */
export function matchingCompactionEntry(entries: Record<string, JsonValue>, selector: string): { key: string; entry: CompactionEntry } | null {
	const valid = (value: JsonValue | undefined): value is CompactionEntry => typeof value === "number" || typeof value === "string";
	if (Object.hasOwn(entries, selector) && valid(entries[selector])) return { key: selector, entry: entries[selector] };
	let key: string | null = null;
	for (const candidate of Object.keys(entries)) {
		if (candidate.endsWith("*") && selector.startsWith(candidate.slice(0, -1)) && valid(entries[candidate]) && (!key || candidate.length > key.length)) key = candidate;
	}
	return key ? { key, entry: entries[key] as CompactionEntry } : null;
}

/** pi-agent-core 18.14 promptBudgetTokens, including its small-window reserve recovery. */
function promptBudget(window: number, reserve: number | undefined): number {
	const proportional = Math.max(1, Math.floor(window * 0.15));
	const floor = Math.max(Math.floor(window * 0.15), reserve ?? 16_384);
	const recovered = (reserve === undefined && floor >= window - proportional) || floor >= window;
	return Math.max(0, Math.min(window - 1, window - (recovered ? proportional : floor)));
}

/** Plan the model-entry policy, explicitly marking it hypothetical when model limits are disabled. */
export function planCompaction(model: ModelInfo, input: string, policy: CompactionPolicy, inherited: CompactionEntry | null = null): CompactionPlan {
	const plan: CompactionPlan = { entry: null, window: model.contextWindow, tokens: null, basis: "window", base: null, percent: null, opensExtended: false, appliesWhenEnabled: policy.modelThresholdsEnabled === false, premiumFrom: null, error: null };
	try { plan.entry = parseCompactionInput(input); } catch { return { ...plan, error: "invalid" }; }
	const entry = plan.entry ?? inherited;
	const fixed = typeof entry === "string" && /^f\d+$/i.test(entry);
	const base = typeof entry === "number" ? entry : null;
	const tokenEntry = base ?? (fixed ? Number((entry as string).slice(1)) : null);
	const tiers = model.contextWindowTiers;
	const opensExtended = Boolean(tiers && tokenEntry && (fixed ? tokenEntry >= tiers.standard : tokenEntry > tiers.standard));
	plan.window = tiers ? (opensExtended || policy.extendedContext ? tiers.extended : tiers.standard) : model.contextWindow;
	plan.opensExtended = plan.entry !== null && opensExtended && !policy.extendedContext;
	const ceiling = tiers?.extended ?? model.contextWindow;
	if (plan.entry !== null && tokenEntry && ceiling && (fixed ? tokenEntry >= ceiling : tokenEntry > ceiling)) {
		plan.error = fixed ? "fixedTooLarge" : "baseTooLarge";
		return plan;
	}
	const window = plan.window;
	if (!window) return plan;
	const percent = typeof entry === "string" && entry.endsWith("%") ? Number(entry.slice(0, -1)) : policy.thresholdPercent;
	const fixedTokens = fixed ? tokenEntry! : entry === null ? policy.thresholdTokens : -1;
	if (fixedTokens > 0) {
		plan.tokens = fixedTokens >= window ? promptBudget(window, policy.reserveTokens) : Math.min(window - 1, Math.max(1, fixedTokens));
		plan.basis = plan.tokens < fixedTokens ? "capped" : "fixed";
	} else {
		const scaledFrom = base ? Math.min(base, window) : window;
		plan.tokens = percent > 0 ? Math.floor(scaledFrom * Math.min(99, Math.max(1, percent)) / 100) : promptBudget(scaledFrom, policy.reserveTokens);
		plan.basis = base && base < window ? "base" : "window";
		plan.base = scaledFrom;
		plan.percent = percent > 0 ? Math.min(99, Math.max(1, percent)) : plan.tokens / scaledFrom * 100;
	}
	const premium = model.cost?.longContext?.inputThreshold;
	if (plan.opensExtended && premium !== undefined && plan.tokens > premium) plan.premiumFrom = premium;
	if (!policy.enabled) plan.tokens = null;
	return plan;
}
