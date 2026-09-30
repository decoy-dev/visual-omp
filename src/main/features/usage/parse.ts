import { z } from "zod";
import type {
	AgentTypeStats,
	AggregatedStats,
	ClientUsage,
	CostTimeSeriesPoint,
	DisabledCredential,
	FolderStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	ProviderWindowStat,
	TimeSeriesPoint,
	UsageAccountIdentity,
	UsageHistory,
	UsageHistoryEntry,
	UsageLimit,
	UsageLimitsSnapshot,
	UsageReport,
	UsageResetCreditDetail,
	UsageResetCredits,
	UsageStats,
} from "@shared/contracts/usage";

// Units/statuses are closed unions in omp; unknown future values degrade instead of failing the whole report.
const UsageUnitSchema = z
	.enum(["percent", "tokens", "requests", "credits", "usd", "minutes", "bytes", "unknown"])
	.catch("unknown");
const UsageStatusSchema = z.enum(["ok", "warning", "exhausted", "unknown"]).catch("unknown");

const UsageLimitSchema = z.object({
	id: z.string(),
	label: z.string(),
	scope: z.object({
		provider: z.string(),
		accountId: z.string().optional(),
		projectId: z.string().optional(),
		orgId: z.string().optional(),
		modelId: z.string().optional(),
		tier: z.string().optional(),
		windowId: z.string().optional(),
		shared: z.boolean().optional(),
		sharedGroup: z.string().optional(),
	}),
	window: z
		.object({
			id: z.string(),
			label: z.string(),
			durationMs: z.number().optional(),
			resetsAt: z.number().optional(),
			resetLabel: z.string().optional(),
		})
		.optional(),
	amount: z.object({
		used: z.number().optional(),
		limit: z.number().optional(),
		remaining: z.number().optional(),
		usedFraction: z.number().optional(),
		remainingFraction: z.number().optional(),
		unit: UsageUnitSchema,
	}),
	status: UsageStatusSchema.optional(),
	notes: z.array(z.string()).optional(),
}) satisfies z.ZodType<UsageLimit>;

const UsageResetCreditDetailSchema = z.object({
	id: z.string().optional(),
	title: z.string().optional(),
	program: z.string().optional(),
	remainingCount: z.number().optional(),
	usable: z.boolean().optional(),
	requiresLimit: z.boolean().optional(),
	clears: z.array(z.string()).optional(),
	blocking: z.array(z.string()).optional(),
	usedFractions: z.record(z.string(), z.number()).optional(),
	grantedAt: z.string().optional(),
	expiresAt: z.string().optional(),
	status: z.string().optional(),
}) satisfies z.ZodType<UsageResetCreditDetail>;

const UsageResetCreditsSchema = z.object({
	availableCount: z.number(),
	redeemableCount: z.number().optional(),
	nextCreditId: z.string().optional(),
	eligible: z.boolean().optional(),
	reason: z.string().optional(),
	cooldownUntil: z.string().optional(),
	credits: z.array(UsageResetCreditDetailSchema).optional(),
}) satisfies z.ZodType<UsageResetCredits>;

const UsageReportSchema = z.object({
	provider: z.string(),
	fetchedAt: z.number(),
	limits: z.array(UsageLimitSchema),
	resetCredits: UsageResetCreditsSchema.optional(),
	notes: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<UsageReport>;

const UsageAccountIdentitySchema = z.object({
	provider: z.string(),
	type: z.enum(["api_key", "oauth"]),
	email: z.string().optional(),
	accountId: z.string().optional(),
	projectId: z.string().optional(),
	enterpriseUrl: z.string().optional(),
	orgId: z.string().optional(),
	orgName: z.string().optional(),
	authorizedAt: z.number().optional(),
}) satisfies z.ZodType<UsageAccountIdentity>;

const DisabledCredentialSchema = z.object({
	id: z.number(),
	provider: z.string(),
	type: z.enum(["api_key", "oauth"]),
	email: z.string().optional(),
	accountId: z.string().optional(),
	orgId: z.string().optional(),
	orgName: z.string().optional(),
	cause: z.string(),
	disabledAtMs: z.number().optional(),
}) satisfies z.ZodType<DisabledCredential>;

const ProviderWindowStatSchema = z.object({
	window: z.string(),
	durationMs: z.number().optional(),
	meter: z.string().optional(),
	accounts: z.number(),
	usedAccounts: z.number(),
	remainingAccounts: z.number(),
}) satisfies z.ZodType<ProviderWindowStat>;

export const UsageLimitsSnapshotSchema = z.object({
	generatedAt: z.number(),
	reports: z.array(UsageReportSchema),
	accountsWithoutUsage: z.array(UsageAccountIdentitySchema),
	disabledCredentials: z.array(DisabledCredentialSchema),
	capacity: z.record(z.string(), z.array(ProviderWindowStatSchema)),
}) satisfies z.ZodType<UsageLimitsSnapshot>;

const UsageHistoryEntrySchema = z.object({
	recordedAt: z.number(),
	provider: z.string(),
	accountKey: z.string(),
	email: z.string().optional(),
	accountId: z.string().optional(),
	limitId: z.string(),
	label: z.string(),
	windowLabel: z.string().optional(),
	usedFraction: z.number().optional(),
	status: UsageStatusSchema.optional(),
	resetsAt: z.number().optional(),
}) satisfies z.ZodType<UsageHistoryEntry>;

export const UsageHistorySchema = z.object({
	generatedAt: z.number(),
	sinceMs: z.number(),
	entries: z.array(UsageHistoryEntrySchema),
}) satisfies z.ZodType<UsageHistory>;

export const ClientUsageSchema = z.object({
	generatedAt: z.number(),
	sinceMs: z.number(),
	clients: z.array(
		z.object({
			installId: z.string(),
			hostname: z.string().optional(),
			firstSeen: z.number(),
			lastSeen: z.number(),
			providers: z.array(
				z.object({
					app: z.string().optional(),
					provider: z.string(),
					requests: z.number(),
					inputTokens: z.number(),
					outputTokens: z.number(),
					cacheReadTokens: z.number(),
					cacheWriteTokens: z.number(),
					costUsd: z.number(),
				}),
			),
		}),
	),
}) satisfies z.ZodType<ClientUsage>;

const aggregatedShape = {
	totalRequests: z.number(),
	successfulRequests: z.number(),
	failedRequests: z.number(),
	errorRate: z.number(),
	totalInputTokens: z.number(),
	totalOutputTokens: z.number(),
	totalCacheReadTokens: z.number(),
	totalCacheWriteTokens: z.number(),
	cacheRate: z.number(),
	cacheSavings: z.number(),
	totalCost: z.number(),
	unpricedRequests: z.number(),
	totalPremiumRequests: z.number(),
	avgDuration: z.number().nullable(),
	avgTtft: z.number().nullable(),
	avgTokensPerSecond: z.number().nullable(),
	firstTimestamp: z.number(),
	lastTimestamp: z.number(),
};

export const UsageStatsSchema = z.object({
	overall: z.object(aggregatedShape) satisfies z.ZodType<AggregatedStats>,
	byModel: z.array(
		z.object({ ...aggregatedShape, model: z.string(), provider: z.string() }) satisfies z.ZodType<ModelStats>,
	),
	byFolder: z.array(z.object({ ...aggregatedShape, folder: z.string() }) satisfies z.ZodType<FolderStats>),
	byAgentType: z.array(
		z.object({
			agentType: z.enum(["main", "subagent", "advisor"]),
			totalRequests: z.number(),
			totalInputTokens: z.number(),
			totalOutputTokens: z.number(),
			totalCacheReadTokens: z.number(),
			totalCacheWriteTokens: z.number(),
			totalCost: z.number(),
		}) satisfies z.ZodType<AgentTypeStats>,
	),
	timeSeries: z.array(
		z.object({
			timestamp: z.number(),
			requests: z.number(),
			errors: z.number(),
			tokens: z.number(),
			cost: z.number(),
		}) satisfies z.ZodType<TimeSeriesPoint>,
	),
	modelSeries: z.array(
		z.object({
			timestamp: z.number(),
			model: z.string(),
			provider: z.string(),
			requests: z.number(),
		}) satisfies z.ZodType<ModelTimeSeriesPoint>,
	),
	modelPerformanceSeries: z.array(
		z.object({
			timestamp: z.number(),
			model: z.string(),
			provider: z.string(),
			requests: z.number(),
			avgTtft: z.number().nullable(),
			avgTokensPerSecond: z.number().nullable(),
		}) satisfies z.ZodType<ModelPerformancePoint>,
	),
	costSeries: z.array(
		z.object({
			timestamp: z.number(),
			model: z.string(),
			provider: z.string(),
			cost: z.number(),
			unpricedRequests: z.number(),
			costInput: z.number(),
			costOutput: z.number(),
			costCacheRead: z.number(),
			costCacheWrite: z.number(),
			requests: z.number(),
		}) satisfies z.ZodType<CostTimeSeriesPoint>,
	),
}) satisfies z.ZodType<UsageStats>;

/**
 * argv for `omp usage` with the shared provider/redact/days flags. Non-positive or non-finite `days`
 * are dropped so omp applies its own default window (7 days).
 */
export function usageArgv(base: string[], options: { provider?: string; redact?: boolean; days?: number }): string[] {
	const argv = [...base];
	if (options.provider) argv.push("--provider", options.provider);
	if (options.redact) argv.push("--redact");
	const { days } = options;
	if (days !== undefined && Number.isFinite(days) && days > 0) argv.push("--days", String(Math.ceil(days)));
	return argv;
}
