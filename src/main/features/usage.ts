import type { UsageStats } from "@shared/contracts/usage";
import { handle } from "../ipc";
import { runOmp, runOmpJson } from "../omp/cli";
import { ClientUsageSchema, UsageHistorySchema, UsageLimitsSnapshotSchema, UsageStatsSchema, usageArgv } from "./usage/parse";

/** Provider usage endpoints are network calls; omp's own per-request timeouts are shorter than this. */
const LIMITS_TIMEOUT_MS = 90_000;
const LOCAL_TIMEOUT_MS = 30_000;
/** `omp stats --json` ingests every new session file before reporting; large histories take a while. */
const STATS_TIMEOUT_MS = 5 * 60_000;

let statsInFlight: Promise<UsageStats> | null = null;

export function register(): void {
	handle("usage:limits", async (options = {}) => {
		if (options.refresh) {
			const result = await runOmp(usageArgv(["usage", "invalidate"], { provider: options.provider }), {
				timeoutMs: LOCAL_TIMEOUT_MS,
			});
			if (result.code !== 0) throw new Error(result.stderr.trim() || `omp usage invalidate exited with ${result.code}`);
		}
		const json = await runOmpJson(usageArgv(["usage", "--json"], options), { timeoutMs: LIMITS_TIMEOUT_MS });
		return UsageLimitsSnapshotSchema.parse(json);
	});

	handle("usage:history", async (days, options = {}) => {
		const json = await runOmpJson(usageArgv(["usage", "--history", "--json"], { ...options, days }), {
			timeoutMs: LOCAL_TIMEOUT_MS,
		});
		return UsageHistorySchema.parse(json);
	});

	handle("usage:clients", async days => {
		const json = await runOmpJson(usageArgv(["usage", "clients", "--json"], { days }), { timeoutMs: LIMITS_TIMEOUT_MS });
		return ClientUsageSchema.parse(json);
	});

	handle("usage:stats", () => {
		statsInFlight ??= runOmpJson(["stats", "--json"], { timeoutMs: STATS_TIMEOUT_MS })
			.then(json => UsageStatsSchema.parse(json))
			.finally(() => {
				statsInFlight = null;
			});
		return statsInFlight;
	});
}
