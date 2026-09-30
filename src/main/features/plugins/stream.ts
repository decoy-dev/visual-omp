import { spawn } from "node:child_process";
import type { CliResult } from "@shared/ipc";

/** Which pipe a streamed line came from. */
export type OutputStream = "stdout" | "stderr";

export interface RunOptions {
	cwd?: string;
	timeoutMs?: number;
	/** Extra environment variables layered over the user environment for this run only. */
	env?: Record<string, string>;
}

export interface StreamRunOptions extends RunOptions {
	/** Operation id; {@link cancelOperation} kills the process registered under it. */
	opId: string;
	onLine(line: string, stream: OutputStream): void;
}

/**
 * How the plugin/skill services run omp. The Electron feature entry wires this to `runOmp` plus
 * {@link spawnStreaming}; tests and smoke scripts inject their own binary and environment.
 */
export interface OmpRunner {
	/** Buffered run; resolves with the exit code, never rejects on non-zero exit. */
	run(argv: string[], options?: RunOptions): Promise<CliResult>;
	/** Like {@link run}, but reports every output line as it arrives. */
	stream(argv: string[], options: StreamRunOptions): Promise<CliResult>;
	/** The environment omp is spawned with (used to resolve `PI_CODING_AGENT_DIR` and `HOME`). */
	env(): Promise<NodeJS.ProcessEnv>;
}

const DEFAULT_STREAM_TIMEOUT_MS = 15 * 60_000;
// CSI / OSC escape sequences; NO_COLOR covers omp's own output but not every child tool it runs.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

const running = new Map<string, () => void>();

/** Kill the process started under `opId`. Returns false when no such operation is running. */
export function cancelOperation(opId: string): boolean {
	const kill = running.get(opId);
	if (!kill) return false;
	kill();
	return true;
}

/** Split a byte stream into lines; `\r` also ends a line so progress redraws surface as updates. */
function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; flush(): void } {
	let pending = "";
	return {
		push(chunk) {
			pending += chunk;
			const parts = pending.split(/\r\n|\r|\n/);
			pending = parts.pop() ?? "";
			for (const part of parts) emit(part);
		},
		flush() {
			if (pending) emit(pending);
			pending = "";
		},
	};
}

/**
 * Spawn `bin argv` with `NO_COLOR=1`, streaming ANSI-stripped, non-empty lines to `onLine` while
 * also buffering the full output. Never rejects: spawn failures resolve with code 127, timeouts and
 * cancellation kill the process and resolve with its exit status.
 */
export function spawnStreaming(
	bin: string,
	argv: string[],
	env: NodeJS.ProcessEnv,
	options: Partial<StreamRunOptions> = {},
): Promise<CliResult> {
	const { promise, resolve } = Promise.withResolvers<CliResult>();
	const child = spawn(bin, argv, {
		cwd: options.cwd,
		env: { ...env, ...options.env, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	let settled = false;
	const emit = (stream: OutputStream) => (line: string) => {
		const clean = stripAnsi(line).trimEnd();
		if (clean) options.onLine?.(clean, stream);
	};
	const out = lineSplitter(emit("stdout"));
	const err = lineSplitter(emit("stderr"));
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
		out.push(chunk);
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
		err.push(chunk);
	});

	let killedReason: string | null = null;
	const kill = (reason: string) => {
		if (killedReason || settled) return;
		killedReason = reason;
		child.kill("SIGTERM");
		setTimeout(() => {
			if (!settled) child.kill("SIGKILL");
		}, 3000).unref();
	};
	const timer = setTimeout(() => kill("timed out"), options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS);
	if (options.opId) running.set(options.opId, () => kill("cancelled"));

	const finish = (result: CliResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		if (options.opId) running.delete(options.opId);
		out.flush();
		err.flush();
		resolve(result);
	};
	child.on("error", error => finish({ code: 127, stdout, stderr: `${stderr}${error.message}\n` }));
	child.on("close", (code, signal) => {
		const suffix = killedReason ? `omp ${argv.slice(0, 2).join(" ")} ${killedReason}\n` : "";
		finish({ code: code ?? (signal ? 1 : 0), stdout, stderr: `${stderr}${suffix}` });
	});
	return promise;
}
