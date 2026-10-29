import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

function comparisonPath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** omp 18.11+ stops project discovery before home and shared temporary roots. */
export function projectDiscoveryCeilings(home = homedir()): ReadonlySet<string> {
	return new Set(
		[home, tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp", "/var/tmp"])].map(comparisonPath),
	);
}

export function isProjectDiscoveryCeiling(cwd: string, home?: string): boolean {
	return projectDiscoveryCeilings(home).has(comparisonPath(cwd));
}

/** Never inspect a ceiling or continue to its ancestors. Subfolders remain project eligible. */
export function* projectAncestorDirs(cwd: string, home?: string): Generator<string> {
	const ceilings = projectDiscoveryCeilings(home);
	let dir = resolve(cwd);
	while (!ceilings.has(comparisonPath(dir))) {
		yield dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
