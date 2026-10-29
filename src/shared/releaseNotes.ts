import type { AppReleaseNotes } from "./contracts/updates";
import type { ChangelogSection } from "./changelog";
import { compareSemver, parseSemver } from "./semver";

export interface ReleaseNotesEntry extends AppReleaseNotes {
	source: "github" | "bundled";
}

/** Future notes come only from published releases; bundled notes cover the installed version and its history. */
export function releaseNotesForVersions(
	currentVersion: string,
	pendingVersion: string | null,
	published: readonly AppReleaseNotes[],
	bundled: readonly ChangelogSection[],
): { pending: ReleaseNotesEntry[]; past: ReleaseNotesEntry[] } {
	const current = parseSemver(currentVersion);
	if (!current) return { pending: [], past: [] };
	const includesPrereleases = current.prerelease.length > 0;
	const entries = new Map<string, ReleaseNotesEntry>();
	const eligible = (version: string) => {
		const parsed = parseSemver(version);
		return parsed && (includesPrereleases || parsed.prerelease.length === 0);
	};
	for (const section of bundled) {
		if (!eligible(section.version) || compareSemver(section.version, currentVersion) > 0 || !section.body) continue;
		// CHANGELOG dates are calendar days; parse them as local midnight so time zones west of UTC keep the day.
		entries.set(section.version, { version: section.version, body: section.body, url: null, publishedAt: section.date ? Date.parse(`${section.date}T00:00:00`) : null, source: "bundled" });
	}
	for (const release of published) {
		const version = release.version.replace(/^v/, "");
		if (!eligible(version)) continue;
		const fallback = entries.get(version);
		entries.set(version, {
			...release, version,
			body: release.body.trim() ? release.body : fallback?.body ?? "",
			source: release.body.trim() || !fallback ? "github" : "bundled",
		});
	}
	const sorted = [...entries.values()].sort((a, b) => compareSemver(b.version, a.version));
	return {
		pending: pendingVersion && eligible(pendingVersion) && compareSemver(pendingVersion, currentVersion) > 0
			? sorted.filter(entry => compareSemver(entry.version, currentVersion) > 0 && compareSemver(entry.version, pendingVersion) <= 0)
			: [],
		past: sorted.filter(entry => compareSemver(entry.version, currentVersion) <= 0),
	};
}
