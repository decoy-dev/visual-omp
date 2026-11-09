import { describe, expect, it } from "vitest";
import type { AppInstallInfo, AppReleaseNotes, AppUpdateStatus } from "./contracts/updates";
import { eligibleRollbackReleases } from "./rollback";

const install: AppInstallInfo = { method: "dmg", appPath: null, command: null, scoopGlobal: false };
const release = (version: string, digest?: string | null): AppReleaseNotes => ({
	version, body: "Published notes", url: null, publishedAt: 1,
	platformAsset: { name: "visual-omp.dmg", url: "https://github.com/decoy-dev/visual-omp/releases/download/v0.7.9/visual-omp.dmg", size: 12, digest },
});
const status = (releases: AppReleaseNotes[]): AppUpdateStatus => ({
	currentVersion: "0.7.12", latestVersion: "0.7.12", updateAvailable: false,
	tag: "v0.7.12", releaseName: null, notes: null, releases, releaseUrl: null,
	publishedAt: 1, assets: [], platformAsset: null, summary: null,
	checkedAt: 1, fromCache: true, error: null,
});

describe("rollback entry eligibility", () => {
	it("selects the highest earlier published platform installer without changing feed order", () => {
		const feed = status([release("0.7.2"), release("v0.7.11"), release("0.7.12"), release("0.7.10"), release("0.8.0")]);
		expect(eligibleRollbackReleases(feed, install).map(item => item.version)).toEqual(["0.7.11", "0.7.10", "0.7.2"]);
		expect(feed.releases?.[1]?.version).toBe("v0.7.11");
		expect(eligibleRollbackReleases(feed, install, "v0.7.10").map(item => item.version)).toEqual(["0.7.10"]);
		expect(eligibleRollbackReleases(feed, install, "0.7.9")).toEqual([]);
	});
	it("requires cached publication metadata, an installer and a supported installation", () => {
		expect(eligibleRollbackReleases(null, install)).toEqual([]);
		expect(eligibleRollbackReleases(status([]), install)).toEqual([]);
		expect(eligibleRollbackReleases(status([release("0.7.11")]), null)).toEqual([]);
		expect(eligibleRollbackReleases(status([release("0.7.11")]), { ...install, method: "manual" })).toEqual([]);
		expect(eligibleRollbackReleases(status([{ ...release("0.7.11"), platformAsset: null }]), install)).toEqual([]);
	});
	it.each(["brew", "scoop"] as const)("requires a complete published SHA-256 digest for %s", method => {
		const feed = status([release("0.7.11"), release("0.7.10", "sha256:bad"), release("0.7.9", `sha256:${"a".repeat(64)}`)]);
		expect(eligibleRollbackReleases(feed, { ...install, method }).map(item => item.version)).toEqual(["0.7.9"]);
		expect(eligibleRollbackReleases(feed, install)).toHaveLength(3);
	});
	it("keeps cached installers available offline and excludes prereleases for a stable copy", () => {
		const feed = { ...status([release("0.7.11"), release("0.7.12-beta.1"), release("invalid")]), error: "Offline" };
		expect(eligibleRollbackReleases(feed, install).map(item => item.version)).toEqual(["0.7.11"]);
		expect(eligibleRollbackReleases({ ...feed, currentVersion: "0.7.12-beta.2" }, install).map(item => item.version)).toEqual(["0.7.12-beta.1", "0.7.11"]);
	});
});
