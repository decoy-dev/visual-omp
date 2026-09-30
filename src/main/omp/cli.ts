import { execFile } from "node:child_process";
import type { CliResult } from "@shared/ipc";
import { userEnv } from "../env";
import { ompPath } from "./locate";

/** Run a non-interactive omp subcommand and capture its output. Never rejects on non-zero exit. */
export async function runOmp(argv: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CliResult> {
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
	const { promise, resolve } = Promise.withResolvers<CliResult>();
	execFile(
		bin,
		argv,
		{ cwd: options.cwd, env: { ...env, NO_COLOR: "1" }, timeout: options.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 },
		(error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			resolve({ code, stdout, stderr });
		},
	);
	return promise;
}

/** Run an omp subcommand that prints JSON on stdout; throws with stderr on failure. */
export async function runOmpJson(argv: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<unknown> {
	const result = await runOmp(argv, options);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `omp ${argv.join(" ")} exited with ${result.code}`);
	return JSON.parse(result.stdout);
}
