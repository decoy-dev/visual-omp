import { readFile } from "node:fs/promises";

/** [major, minor, patch] of a stable release version, or null for anything else. Build metadata is ignored, as semver does. */
export function stableCore(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
	return match ? match.slice(1).map(Number) : null;
}

function core(version) {
	const parts = stableCore(version);
	if (!parts) throw new Error(`Expected a stable release version, got "${version}"`);
	return parts;
}

/** Negative when `a` is older than `b`, 0 when they are the same release, positive when newer. */
export function compareStable(a, b) {
	const [x, y] = [core(a), core(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

/**
 * Whether the channel file at `path` already offers a newer stable version than `version`, in which
 * case the caller leaves it alone: publishing an older tag after a newer one (a fix on an older line,
 * a re-run of an old release) must not move `brew` or `scoop` users back to it. The same version is
 * written again, so the file uses the checksums of the newly published installers. A missing file
 * offers nothing; a file whose version can't be read fails the release step for a person to check.
 */
export async function offersNewer(path, version, readVersion) {
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		throw error;
	}
	const offered = readVersion(text);
	if (!offered) throw new Error(`Could not read the version in ${path}`);
	if (compareStable(version, offered) >= 0) return false;
	// A GitHub Actions notice, so the skipped update shows in the run's summary.
	console.log(`::notice title=${path} unchanged::${path} offers ${offered}, newer than ${version}, so it was left as it is.`);
	return true;
}
