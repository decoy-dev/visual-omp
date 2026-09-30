import { userEnv } from "../../env";
import { runOmp } from "../../omp/cli";
import { ompPath } from "../../omp/locate";
import { type OmpRunner, spawnStreaming } from "./stream";

/**
 * The app's {@link OmpRunner}: `runOmp` for plain runs, {@link spawnStreaming} when a run needs extra
 * environment variables or live output. Imported only by feature entry files (it pulls in Electron).
 */
export const appRunner: OmpRunner = {
	async run(argv, options = {}) {
		if (!options.env) return runOmp(argv, { cwd: options.cwd, timeoutMs: options.timeoutMs });
		const [bin, env] = await Promise.all([ompPath(), userEnv()]);
		return spawnStreaming(bin, argv, env, { ...options, timeoutMs: options.timeoutMs ?? 60_000 });
	},
	async stream(argv, options) {
		const [bin, env] = await Promise.all([ompPath(), userEnv()]);
		return spawnStreaming(bin, argv, env, options);
	},
	env: userEnv,
};
