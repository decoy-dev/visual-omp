import { compareSemver, parseSemver } from "./semver";

/** Newest omp version verified and offered for in-app updates by this visual-omp release. */
export const MAX_SUPPORTED_OMP_VERSION = "19.2.1";

/** True when `version` parses as semver and does not exceed `maxSupportedVersion`. */
export function isOmpVersionSupportedForUpdate(
	version: string | null | undefined,
	maxSupportedVersion = MAX_SUPPORTED_OMP_VERSION,
): boolean {
	if (!version || !parseSemver(version) || !parseSemver(maxSupportedVersion)) return false;
	return compareSemver(version, maxSupportedVersion) <= 0;
}

/**
 * Decides whether `omp update --check` can offer an in-app omp upgrade, or whether the newest
 * upstream omp release requires a newer visual-omp release first.
 */
export function ompUpdateEligibility(input: {
	currentVersion: string | null;
	latestVersion: string | null;
	maxSupportedVersion?: string | null;
	managedBy?: string | null;
	error?: string | null;
}): { updateAvailable: boolean; requiresAppUpdate: boolean } {
	if (input.error || input.managedBy || !input.latestVersion) {
		return { updateAvailable: false, requiresAppUpdate: false };
	}
	if (
		input.currentVersion &&
		parseSemver(input.currentVersion) &&
		parseSemver(input.latestVersion) &&
		compareSemver(input.latestVersion, input.currentVersion) <= 0
	) {
		return { updateAvailable: false, requiresAppUpdate: false };
	}
	const cap = input.maxSupportedVersion ?? MAX_SUPPORTED_OMP_VERSION;
	if (isOmpVersionSupportedForUpdate(input.latestVersion, cap)) {
		return { updateAvailable: true, requiresAppUpdate: false };
	}
	return { updateAvailable: false, requiresAppUpdate: true };
}
