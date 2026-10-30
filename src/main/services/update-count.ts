export const UPDATE_COUNT_URL = "https://visual-omp-update-count.chris-216.workers.dev/v1/check";

/** Count a fresh packaged-app update check without delaying it or exposing request failures. */
export function recordUpdateCheck(version: string, isPackaged: boolean): void {
	if (!isPackaged || process.env.NODE_ENV === "test" || process.env.VITEST) return;
	try {
		void fetch(UPDATE_COUNT_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ version, platform: process.platform, arch: process.arch }),
			signal: AbortSignal.timeout(5_000),
			redirect: "error",
			credentials: "omit",
		}).catch(() => {});
	} catch {
		// Counting is optional. A synchronous fetch or timeout error cannot affect updates either.
	}
}
