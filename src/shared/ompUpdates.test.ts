import { describe, expect, it } from "vitest";
import {
	MAX_SUPPORTED_OMP_VERSION,
	isOmpVersionSupportedForUpdate,
	ompUpdateEligibility,
} from "./ompUpdates";

describe("omp update support ceiling", () => {
	it("treats versions up to MAX_SUPPORTED_OMP_VERSION as eligible and fails closed on unparseable versions", () => {
		expect(isOmpVersionSupportedForUpdate(MAX_SUPPORTED_OMP_VERSION)).toBe(true);
		expect(isOmpVersionSupportedForUpdate("19.2.1-canary.1", "19.2.1")).toBe(true);
		expect(isOmpVersionSupportedForUpdate("19.1.1", "19.2.1")).toBe(true);
		expect(isOmpVersionSupportedForUpdate("19.2.2", "19.2.1")).toBe(false);
		expect(isOmpVersionSupportedForUpdate("19.3.0", "19.2.1")).toBe(false);
		expect(isOmpVersionSupportedForUpdate("nightly", "19.2.1")).toBe(false);
		expect(isOmpVersionSupportedForUpdate(null, "19.2.1")).toBe(false);
	});

	it("offers updates only when latestVersion is newer than currentVersion and within the cap", () => {
		expect(
			ompUpdateEligibility({ currentVersion: "19.1.1", latestVersion: "19.2.1", maxSupportedVersion: "19.2.1" }),
		).toEqual({ updateAvailable: true, requiresAppUpdate: false });
		expect(
			ompUpdateEligibility({ currentVersion: "19.1.1", latestVersion: "19.2.1-canary.1", maxSupportedVersion: "19.2.1" }),
		).toEqual({ updateAvailable: true, requiresAppUpdate: false });
	});

	it.each(["19.2.2", "19.3.0", "19.2.2-canary.1", "20.0.0", "nightly"])(
		"suppresses updates and flags requiresAppUpdate for unsupported release %s",
		latestVersion => {
			expect(
				ompUpdateEligibility({ currentVersion: "19.2.1", latestVersion, maxSupportedVersion: "19.2.1" }),
			).toEqual({ updateAvailable: false, requiresAppUpdate: true });
		},
	);

	it("does not flag requiresAppUpdate when the installed version is already at or above latestVersion", () => {
		expect(
			ompUpdateEligibility({ currentVersion: "19.3.0", latestVersion: "19.3.0", maxSupportedVersion: "19.2.1" }),
		).toEqual({ updateAvailable: false, requiresAppUpdate: false });
		expect(
			ompUpdateEligibility({ currentVersion: "19.3.1", latestVersion: "19.3.0", maxSupportedVersion: "19.2.1" }),
		).toEqual({ updateAvailable: false, requiresAppUpdate: false });
	});

	it("returns neither updateAvailable nor requiresAppUpdate for managed installs, errors, or up-to-date checks", () => {
		expect(
			ompUpdateEligibility({ currentVersion: "19.1.1", latestVersion: null, maxSupportedVersion: "19.2.1" }),
		).toEqual({ updateAvailable: false, requiresAppUpdate: false });
		expect(
			ompUpdateEligibility({ currentVersion: "19.1.1", latestVersion: "19.3.0", managedBy: "Homebrew" }),
		).toEqual({ updateAvailable: false, requiresAppUpdate: false });
		expect(
			ompUpdateEligibility({ currentVersion: "19.1.1", latestVersion: "19.3.0", error: "offline" }),
		).toEqual({ updateAvailable: false, requiresAppUpdate: false });
	});
});
