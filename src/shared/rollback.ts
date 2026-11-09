import type { AppInstallInfo, AppReleaseNotes, AppUpdateStatus } from "./contracts/updates";
import { compareSemver, parseSemver } from "./semver";

/** Published installers that can roll back this copy, newest first. Cached releases remain usable offline. */
export function eligibleRollbackReleases(
	status: AppUpdateStatus | null,
	install: AppInstallInfo | null | undefined,
	target?: string,
): AppReleaseNotes[] {
	if (!status || !install || install.method === "manual") return [];
	const current = parseSemver(status.currentVersion);
	if (!current) return [];
	const managed = install.method === "brew" || install.method === "scoop";
	const selected = target?.replace(/^v/, "");
	return (status.releases ?? []).filter(release => {
		const version = release.version.replace(/^v/, "");
		const parsed = parseSemver(version);
		return parsed && (current.prerelease.length > 0 || parsed.prerelease.length === 0)
			&& compareSemver(version, status.currentVersion) < 0
			&& (selected === undefined || version === selected)
			&& !!release.platformAsset
			&& (!managed || /^sha256:[a-f0-9]{64}$/i.test(release.platformAsset.digest ?? ""));
	}).map(release => ({ ...release, version: release.version.replace(/^v/, "") }))
		.sort((a, b) => compareSemver(b.version, a.version));
}
