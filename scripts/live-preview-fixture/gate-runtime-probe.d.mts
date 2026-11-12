export interface GateRuntimeProbeSnapshot {
	timeOrigin: number;
	startedAt: number;
	stoppedAt: number;
	intervalMs: number;
	ticks: number;
	maximumDelayMs: number;
	threadCpuSupported: boolean;
	gaps: { start: number; end: number; intervalMs: number; delayMs: number; threadCpuMs: number | null; activeHash: number | null }[];
	droppedGaps: number;
	recordLimit: number;
	gapRetention: string;
	hashes: { index: number; start: number; end: number; bytes: number; threadCpuMs: number | null }[];
	hashExecutionThread: "worker";
	inheritedEnvironmentKeys: number;
	inheritedExecArgv: string[];
	version?: {
		start: number;
		end: number;
		executionThread: "worker";
		timeoutMs: number;
		maxBuffer: number;
		windowsHide: boolean;
		environmentKeys: number;
		childClosed: boolean;
		timedOut: boolean;
	};
	definition: string;
	terminationExitCode: number;
	threadStopped: boolean;
}
export interface GateRuntimeProbeVersion {
	stdout: string;
	stderr: string;
	error?: Error & { code?: string | number; signal?: string | null; killed?: boolean; errno?: number; syscall?: string };
}
export interface GateRuntimeProbe {
	hash(index: number): Promise<string>;
	version(options: { env: Record<string, string>; cwd: string }): Promise<GateRuntimeProbeVersion>;
	stop(): Promise<GateRuntimeProbeSnapshot>;
	cleanup(): Promise<GateRuntimeProbeSnapshot>;
}
export function createGateRuntimeProbe(files: string[]): Promise<GateRuntimeProbe>;
