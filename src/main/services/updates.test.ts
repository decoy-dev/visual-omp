import { describe, expect, it } from "vitest";
import type { ReleaseAsset } from "@shared/contracts/updates";
import { type GitHubRelease, compareSemver, parseOmpUpdateCheck, pickPlatformAsset, selectLatestRelease } from "./updates";

describe("compareSemver", () => {
	it("orders by numeric components, not lexically", () => {
		expect(compareSemver("0.10.0", "0.9.9")).toBeGreaterThan(0);
		expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
		expect(compareSemver("1.2.3+build.5", "1.2.3")).toBe(0);
	});

	it("sorts prereleases before their release and by identifier rules", () => {
		const ordered = [
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-alpha.beta",
			"1.0.0-beta",
			"1.0.0-beta.2",
			"1.0.0-beta.11",
			"1.0.0-rc.1",
			"1.0.0",
		];
		for (let i = 1; i < ordered.length; i++) {
			expect(compareSemver(ordered[i]!, ordered[i - 1]!)).toBeGreaterThan(0);
			expect(compareSemver(ordered[i - 1]!, ordered[i]!)).toBeLessThan(0);
		}
	});

	it("ranks unparseable versions lowest", () => {
		expect(compareSemver("nightly", "0.0.1")).toBeLessThan(0);
	});
});

function release(tag: string, extra: Partial<GitHubRelease> = {}): GitHubRelease {
	return { tag_name: tag, html_url: `https://example.test/${tag}`, draft: false, prerelease: false, assets: [], ...extra };
}

describe("selectLatestRelease", () => {
	const releases = [
		release("v0.3.0", { draft: true }),
		release("v0.2.1-beta.1", { prerelease: true }),
		release("v0.10.0"),
		release("v0.9.0"),
		release("latest-build"),
	];

	it("picks the highest non-draft stable release regardless of list order", () => {
		expect(selectLatestRelease(releases, "0.1.0")?.tag_name).toBe("v0.10.0");
	});

	it("offers prereleases only to prerelease users", () => {
		const list = [release("v0.2.0"), release("v0.3.0-beta.1", { prerelease: true })];
		expect(selectLatestRelease(list, "0.2.0")?.tag_name).toBe("v0.2.0");
		expect(selectLatestRelease(list, "0.3.0-beta.0")?.tag_name).toBe("v0.3.0-beta.1");
	});

	it("returns null when nothing is published", () => {
		expect(selectLatestRelease([], "0.1.0")).toBeNull();
	});
});

describe("pickPlatformAsset", () => {
	const asset = (name: string): ReleaseAsset => ({ name, url: `https://dl.test/${name}`, size: 1 });
	const assets = [
		asset("visual-omp-0.2.0-arm64.dmg"),
		asset("visual-omp-0.2.0-x64.dmg"),
		asset("visual-omp-0.2.0-arm64-mac.zip"),
		asset("visual-omp-Setup-0.2.0.exe"),
		asset("visual-omp-Setup-0.2.0.exe.blockmap"),
		asset("latest-mac.yml"),
	];

	it("matches the running arch on macOS", () => {
		expect(pickPlatformAsset(assets, "darwin", "arm64")?.name).toBe("visual-omp-0.2.0-arm64.dmg");
		expect(pickPlatformAsset(assets, "darwin", "x64")?.name).toBe("visual-omp-0.2.0-x64.dmg");
	});

	it("uses an arch-less installer but never another arch's", () => {
		expect(pickPlatformAsset(assets, "win32", "x64")?.name).toBe("visual-omp-Setup-0.2.0.exe");
		expect(pickPlatformAsset([asset("app-x64.dmg")], "darwin", "arm64")).toBeNull();
		expect(pickPlatformAsset([asset("app-universal.dmg")], "darwin", "arm64")?.name).toBe("app-universal.dmg");
	});
});

describe("parseOmpUpdateCheck", () => {
	it("reads an up-to-date check (real omp 18.4.4 output)", () => {
		const parsed = parseOmpUpdateCheck({ code: 0, stdout: "Current version: 18.4.4\n✔ Already up to date\n", stderr: "" });
		expect(parsed).toEqual({
			currentVersion: "18.4.4",
			latestVersion: null,
			updateAvailable: false,
			channel: "stable",
			packageMovedTo: null,
			error: null,
		});
	});

	it("reads an available update on the canary channel with a package rename", () => {
		const stdout = [
			"Current version: 18.4.4",
			"Current channel: canary",
			"New version available: 18.5.0-canary.3",
			"The npm package moved to @oh-my-pi/omp; updating migrates this install.",
		].join("\n");
		const parsed = parseOmpUpdateCheck({ code: 0, stdout, stderr: "" });
		expect(parsed.updateAvailable).toBe(true);
		expect(parsed.latestVersion).toBe("18.5.0-canary.3");
		expect(parsed.channel).toBe("canary");
		expect(parsed.packageMovedTo).toBe("@oh-my-pi/omp");
	});

	it("surfaces the failure reason", () => {
		const parsed = parseOmpUpdateCheck({
			code: 1,
			stdout: "Current version: 18.4.4\n",
			stderr: "Failed to check for updates: Error: GitHub rate limit exceeded\n",
		});
		expect(parsed.updateAvailable).toBe(false);
		expect(parsed.error).toBe("Error: GitHub rate limit exceeded");
		expect(parsed.currentVersion).toBe("18.4.4");
	});
});
