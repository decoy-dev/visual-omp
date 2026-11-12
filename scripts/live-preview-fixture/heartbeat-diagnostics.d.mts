export interface HeartbeatSyncSpan {
	id: number;
	label: string;
	start: number;
	end?: number;
	durationMs?: number;
	mainThreadCpuMs?: number | null;
	[key: string]: unknown;
}
export interface HeartbeatCallback {
	id: number;
	asyncId: number;
	resourceKind: string;
	start: number;
	end: number;
	durationMs: number;
	mainThreadCpuMs: number | null;
	stage?: string;
	case?: string;
	incomplete?: boolean;
}
export interface HeartbeatCallbackCounts {
	started: number;
	completed: number;
	significant: number;
	belowThreshold: number;
	unknownResourceKind: number;
	depthOmitted: number;
	unmatchedAfter: number;
	incomplete: number;
}
export interface HeartbeatLimits {
	syncSpans: number;
	callbacks: number;
	gaps: number;
	gc: number;
	resources: number;
	callbackDepth: number;
	worstGaps: number;
	spansPerWorstGap: number;
}
export interface HeartbeatGap {
	start: number;
	end: number;
	intervalMs: number;
	delayMs: number;
	exceeded: boolean;
	mainThreadCpuMs: number | null;
	wallMinusMainThreadCpuMs: number | null;
	syncOverlaps: { id: number; overlapMs: number }[];
	callbackOverlaps: { id: number; resourceKind: string; overlapMs: number }[];
	gcOverlaps: { start: number; durationMs: number; overlapMs: number }[];
	observedWorkMs: number;
	unattributedIntervalMs: number;
	attribution: string;
	[key: string]: unknown;
}
export interface HeartbeatSnapshot {
	intervalMs: number;
	thresholdMs: number;
	startedAt: number;
	stoppedAt?: number;
	ticks: number;
	maxDelayMs: number;
	maxIntervalMs: number;
	exceededIntervals: number;
	support: { gc: boolean; eventLoopDelay: boolean; asyncHooks: boolean; threadCpuUsage: boolean };
	mainThreadCpuMs: number | null;
	threadCpuUnavailableReason: string | null;
	cpuDefinition: string;
	attributionDefinition: string;
	syncSpans: HeartbeatSyncSpan[];
	callbacks: HeartbeatCallback[];
	callbackCounts: HeartbeatCallbackCounts;
	significantCallbackMs: number;
	retention: {
		limits: HeartbeatLimits;
		policy: string;
		omittedSyncSpans: number;
		omittedCallbacks: number;
		omittedGaps: number;
		omittedGcEntries: number;
		belowThresholdCallbacks: number;
		resourceEvictions: number;
		trackedResources: number;
		depthOmittedCallbacks: number;
		preservedWorstGaps: { start: number; end: number; delayMs: number; omittedSyncSpans: number; omittedCallbacks: number; omittedGcEntries: number }[];
	};
	gc: { start: number; end: number; durationMs: number; kind?: number }[];
	gaps: HeartbeatGap[];
	eventLoopDelay: { count: number; minMs: number; maxMs: number; meanMs: number; p50Ms: number; p99Ms: number } | null;
}
export interface HeartbeatDiagnostics {
	begin(label: string, metadata?: Record<string, unknown>): (extra?: Record<string, unknown>) => void;
	sync<T>(label: string, callback: () => T, metadata?: Record<string, unknown>): T;
	beat(): void;
	snapshot(): HeartbeatSnapshot;
	stop(): HeartbeatSnapshot;
}
// Only identifiers and kind are exposed to the collector, never the resource argument.
export interface HeartbeatHookCallbacks {
	init(asyncId: number, type: string): void;
	before(asyncId: number): void;
	after(asyncId: number): void;
	destroy(asyncId: number): void;
}
export function createHeartbeatDiagnostics(options?: {
	intervalMs?: number;
	thresholdMs?: number;
	now?: () => number;
	context?: () => Record<string, unknown>;
	runtime?: boolean;
	timers?: boolean;
	asyncHooks?: boolean;
	hookFactory?: (callbacks: HeartbeatHookCallbacks) => { enable(): unknown; disable(): unknown };
	threadCpuUsage?: (() => { user: number; system: number }) | null;
	significantCallbackMs?: number;
	limits?: Partial<HeartbeatLimits>;
}): HeartbeatDiagnostics;
