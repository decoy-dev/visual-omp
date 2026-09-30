import type { McpServerEntry, McpTestResult } from "@shared/contracts/mcp";
import type { Status } from "@/ui";

/** A connection check started from this sheet; cached for as long as the sheet stays open. */
export type McpCheck = { state: "running" } | { state: "done"; result: McpTestResult };

/** A server that answered but took longer than this to list its tools reads as "slow". */
export const SLOW_TEST_MS = 5000;

export type McpRowStatusKind =
	| "off"
	| "invalid"
	| "unused"
	| "checking"
	| "connected"
	| "slow"
	| "noTools"
	| "needsSignIn"
	| "failed"
	| "unchecked";

export interface McpRowStatus {
	kind: McpRowStatusKind;
	dot: Status;
}

/** Row status: omp's own verdict first (off / invalid / not used), then this sheet's connection check. */
export function rowStatus(entry: McpServerEntry, check: McpCheck | undefined): McpRowStatus {
	if (!entry.enabled) return { kind: "off", dot: "idle" };
	if (entry.status === "invalid") return { kind: "invalid", dot: "err" };
	if (entry.status !== "active") return { kind: "unused", dot: "warn" };
	if (!check) return { kind: "unchecked", dot: "idle" };
	if (check.state === "running") return { kind: "checking", dot: "live" };
	const { result } = check;
	if (!result.ok) return result.authRequired ? { kind: "needsSignIn", dot: "warn" } : { kind: "failed", dot: "err" };
	if (result.tools.length === 0) return { kind: "noTools", dot: "warn" };
	if (result.durationMs > SLOW_TEST_MS) return { kind: "slow", dot: "warn" };
	return { kind: "connected", dot: "ok" };
}
