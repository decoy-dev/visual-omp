/**
 * Provider usage limits (`omp usage --json`), usage-limit history (`omp usage --history --json`),
 * per-client token burn (`omp usage clients --json`) and local cost/token statistics
 * (`omp stats --json`).
 *
 * Shapes mirror omp's own types (`@oh-my-pi/pi-ai` usage types, `omp-stats` DashboardStats) with
 * the heavy provider-specific `raw` payload already dropped by omp.
 *
 * omp gaps: `omp stats --json` always reports omp's default dashboard range (the last 24 hours) and
 * has no range flag; the frustration/tools/providers/gain views exist only in the `omp stats`
 * dashboard server, which this app never starts. `omp stats --summary` prints a text rendering of a
 * subset of the same data, so it has no channel of its own.
 */

/** Unit of a {@link UsageAmount}. */
export type UsageUnit = "percent" | "tokens" | "requests" | "credits" | "usd" | "minutes" | "bytes" | "unknown";

/** Provider-reported health of a limit. */
export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

/** Time window of a limit (e.g. 5h, 7d, monthly). */
export interface UsageWindow {
	/** Stable identifier, e.g. `5h`, `7d`, `monthly`. */
	id: string;
	/** Human label, e.g. `5 Hour`, `7 days`. */
	label: string;
	/** Window duration in ms, when known. */
	durationMs?: number;
	/** Epoch ms the window resets. */
	resetsAt?: number;
	/** Verb shown before the reset countdown (`tick`, `regen`); omp defaults to "resets". */
	resetLabel?: string;
}

/** Quantitative usage of one limit. Any subset may be present; see {@link UsageLimit}. */
export interface UsageAmount {
	used?: number;
	limit?: number;
	remaining?: number;
	/** 0..1 (above 1 means overage). */
	usedFraction?: number;
	/** 0..1. */
	remainingFraction?: number;
	unit: UsageUnit;
}

/** What a limit applies to. */
export interface UsageScope {
	provider: string;
	accountId?: string;
	projectId?: string;
	orgId?: string;
	modelId?: string;
	tier?: string;
	windowId?: string;
	/** Quota shared across models/accounts. */
	shared?: boolean;
	/** Identity shared by routing-specific copies of one upstream quota. */
	sharedGroup?: string;
}

/**
 * One limit window or quota bucket of an account. omp resolves the used fraction as:
 * `amount.usedFraction` > `used / limit` > `used / 100` for percent units > `1 - remainingFraction`.
 */
export interface UsageLimit {
	/** Stable id, e.g. `anthropic:5h`. */
	id: string;
	label: string;
	scope: UsageScope;
	window?: UsageWindow;
	amount: UsageAmount;
	status?: UsageStatus;
	notes?: string[];
}

/** One banked rate-limit reset credit (OpenAI Codex credits, Claude reset grants). */
export interface UsageResetCreditDetail {
	id?: string;
	title?: string;
	/** Provider reset program/family. */
	program?: string;
	/** Resets still banked in this credit. */
	remainingCount?: number;
	/** Redeemable now. */
	usable?: boolean;
	/** Redemption requires an exhausted covered limit. */
	requiresLimit?: boolean;
	/** {@link UsageLimit.id}s this credit resets. */
	clears?: string[];
	/** Limit ids currently preventing redemption. */
	blocking?: string[];
	/** Used fraction of each covered limit, keyed by limit id. */
	usedFractions?: Record<string, number>;
	/** ISO timestamp. */
	grantedAt?: string;
	/** ISO timestamp after which the credit can no longer be redeemed. */
	expiresAt?: string;
	/** Backend status, e.g. `available`, `redeemed`. */
	status?: string;
}

/** Saved/banked rate-limit resets of an account (read-only; redeeming happens inside omp). */
export interface UsageResetCredits {
	/** Banked resets, including ones not usable right now. */
	availableCount: number;
	/** Resets redeemable now. */
	redeemableCount?: number;
	/** Credit the provider would redeem next. */
	nextCreditId?: string;
	eligible?: boolean;
	/** Why the program or its credits are unavailable. */
	reason?: string;
	/** ISO timestamp until which redemption is cooling down. */
	cooldownUntil?: string;
	credits?: UsageResetCreditDetail[];
}

/** Usage report of one provider account. */
export interface UsageReport {
	/** Provider id, e.g. `anthropic`, `openai-codex`. */
	provider: string;
	/** Epoch ms the report was fetched (reports are cached by omp). */
	fetchedAt: number;
	limits: UsageLimit[];
	resetCredits?: UsageResetCredits;
	/** Provider-wide disclaimers shown once above the account's limits. */
	notes?: string[];
	/**
	 * Provider-specific account metadata. Common keys: `email`, `accountId`, `orgId`, `orgName`,
	 * `projectId`, `planType`, `endpoint`.
	 */
	metadata?: Record<string, unknown>;
}

/** A stored credential whose provider has a usage endpoint but produced no report. */
export interface UsageAccountIdentity {
	provider: string;
	type: "api_key" | "oauth";
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
	/** Epoch ms of the interactive login that minted the OAuth grant. */
	authorizedAt?: number;
}

/** A credential omp auto-disabled (e.g. revoked or expired grant) that needs the user's attention. */
export interface DisabledCredential {
	/** Auth database row id. */
	id: number;
	provider: string;
	type: "api_key" | "oauth";
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	/** Verbatim disable cause. */
	cause: string;
	/** Epoch ms the credential was disabled. */
	disabledAtMs?: number;
}

/** Pooled capacity of one provider window across all reporting accounts. */
export interface ProviderWindowStat {
	/** Compact window label, e.g. `5h`, `7d`. */
	window: string;
	durationMs?: number;
	/** Meter identity when a provider keeps independent meters in one window. */
	meter?: string;
	/** Accounts reporting a limit in this window. */
	accounts: number;
	/** Sum of each account's used fraction — accounts' worth of quota burned. */
	usedAccounts: number;
	/** Accounts' worth of quota still available. */
	remainingAccounts: number;
}

/** `omp usage --json`. */
export interface UsageLimitsSnapshot {
	/** Epoch ms. */
	generatedAt: number;
	reports: UsageReport[];
	/** Accounts with a usage-capable provider that returned no report. */
	accountsWithoutUsage: UsageAccountIdentity[];
	/** Auto-disabled credentials worth surfacing. */
	disabledCredentials: DisabledCredential[];
	/** Pooled window capacity per provider id. */
	capacity: Record<string, ProviderWindowStat[]>;
}

export interface UsageLimitsOptions {
	/** Only this provider id (e.g. `anthropic`). */
	provider?: string;
	/** Mask emails/account ids/org names with shortest-unique prefixes (for screenshots). */
	redact?: boolean;
	/** Run `omp usage invalidate` first so omp refetches from the providers instead of its cache. */
	refresh?: boolean;
}

/** One hourly-ish snapshot of one limit window of one account. */
export interface UsageHistoryEntry {
	/** Epoch ms the report was fetched. */
	recordedAt: number;
	provider: string;
	/** Stable credential identity key. */
	accountKey: string;
	email?: string;
	accountId?: string;
	/** {@link UsageLimit.id}. */
	limitId: string;
	label: string;
	windowLabel?: string;
	/** 0..1 when resolvable. */
	usedFraction?: number;
	status?: UsageStatus;
	/** Epoch ms the window resets. */
	resetsAt?: number;
}

/** `omp usage --history --json`. */
export interface UsageHistory {
	generatedAt: number;
	/** Inclusive lower bound of `entries[].recordedAt` (epoch ms). */
	sinceMs: number;
	/** Oldest first, as recorded. Empty when omp has no snapshots yet. */
	entries: UsageHistoryEntry[];
}

export interface UsageHistoryOptions {
	provider?: string;
	redact?: boolean;
}

/** One client's usage for one provider (and app label). */
export interface ClientProviderUsage {
	/** App label the usage was reported under (e.g. `omp`); absent for legacy rows. */
	app?: string;
	provider: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

/** One machine/install that burned tokens through the auth broker. */
export interface ClientUsageSummary {
	/** Stable per-machine install id. */
	installId: string;
	hostname?: string;
	/** Epoch ms. */
	firstSeen: number;
	/** Epoch ms. */
	lastSeen: number;
	providers: ClientProviderUsage[];
}

/**
 * `omp usage clients --json`. Data comes from the auth broker when one is configured
 * (`OMP_AUTH_BROKER_URL`), else from the local agent database, which only has rows on a broker host
 * — so `clients` is commonly empty.
 */
export interface ClientUsage {
	generatedAt: number;
	sinceMs: number;
	clients: ClientUsageSummary[];
}

/** Aggregated request stats for a model, folder, or everything. */
export interface AggregatedStats {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	/** 0..1. */
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	/** Share of prompt input tokens served from cache, 0..1. */
	cacheRate: number;
	/** Prompt-input cost saved vs uncached billing, 0..1 (negative when cache writes cost more). */
	cacheSavings: number;
	/** API-equivalent USD estimate. */
	totalCost: number;
	/** Requests with token usage but no public-equivalent price (their cost is excluded). */
	unpricedRequests: number;
	totalPremiumRequests: number;
	/** ms. */
	avgDuration: number | null;
	/** Time to first token, ms. */
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	/** Epoch ms of the first/last request in range (0 when there are none). */
	firstTimestamp: number;
	lastTimestamp: number;
}

export interface ModelStats extends AggregatedStats {
	model: string;
	provider: string;
}

export interface FolderStats extends AggregatedStats {
	/** Project folder as omp's stats key it (session-directory derived, e.g. `/private-tmp/`). */
	folder: string;
}

/** Which agent produced the usage: `main`, `subagent` (task agents) or `advisor`. */
export type StatsAgentType = "main" | "subagent" | "advisor";

export interface AgentTypeStats {
	agentType: StatsAgentType;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}

/** Request/token/cost bucket (hourly for the 24h range). */
export interface TimeSeriesPoint {
	/** Bucket start, epoch ms. */
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}

export interface ModelTimeSeriesPoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
}

export interface ModelPerformancePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
}

/** Daily cost bucket per model. */
export interface CostTimeSeriesPoint {
	/** Day start, epoch ms. */
	timestamp: number;
	model: string;
	provider: string;
	cost: number;
	unpricedRequests: number;
	costInput: number;
	costOutput: number;
	costCacheRead: number;
	costCacheWrite: number;
	requests: number;
}

/** `omp stats --json` — the last 24 hours. */
export interface UsageStats {
	overall: AggregatedStats;
	/** Busiest first. */
	byModel: ModelStats[];
	/** Busiest first. */
	byFolder: FolderStats[];
	byAgentType: AgentTypeStats[];
	timeSeries: TimeSeriesPoint[];
	modelSeries: ModelTimeSeriesPoint[];
	modelPerformanceSeries: ModelPerformancePoint[];
	costSeries: CostTimeSeriesPoint[];
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Live provider limits for every authenticated account (`omp usage --json`). omp serves cached
		 * reports when fresh; `refresh` invalidates the cache first (`omp usage invalidate`), which
		 * makes omp hit the provider APIs (network; can take several seconds).
		 */
		"usage:limits": { args: [options?: UsageLimitsOptions]; result: UsageLimitsSnapshot };
		/** Recorded usage-limit snapshots over the last `days` (default 7). Local, fast. */
		"usage:history": { args: [days?: number, options?: UsageHistoryOptions]; result: UsageHistory };
		/** Per-client token burn over the last `days` (default 7); see {@link ClientUsage}. */
		"usage:clients": { args: [days?: number]; result: ClientUsage };
		/**
		 * Cost/token statistics for the last 24 hours (`omp stats --json`). omp first ingests new
		 * session files into its stats database, so the first call can take tens of seconds;
		 * concurrent calls share one run.
		 */
		"usage:stats": { args: []; result: UsageStats };
	}
}
