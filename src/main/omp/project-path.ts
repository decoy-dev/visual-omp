import { realpathSync } from "node:fs";

/**
 * Match omp's getProjectDir(): POSIX process.cwd() resolves symlinks, then
 * packages/utils/src/dirs.ts standardizeMacOSPath strips /private only when
 * both spellings realpath to the same folder (omp 18.17, lines 148-162, 229-253).
 * Windows keeps its spelling; omp's native 8.3 expansion is not exposed here.
 * Missing or inaccessible folders keep their saved spelling.
 */
export function projectPath(input: string): string {
	if (process.platform === "win32") return input;
	let resolved: string;
	try {
		resolved = realpathSync(input);
	} catch {
		return input;
	}
	if (process.platform === "darwin" && resolved.startsWith("/private/")) {
		const stripped = resolved.slice("/private".length);
		try {
			if (realpathSync(resolved) === realpathSync(stripped)) return stripped;
		} catch {}
	}
	return resolved;
}
