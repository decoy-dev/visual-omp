import { describe, expect, it } from "vitest";
import type { ReleaseAsset } from "@shared/contracts/updates";
import {
	type GitHubRelease,
	appBundlePath,
	brewCandidates,
	caskroomPath,
	compareSemver,
	detectInstallMethod,
	fetchInstaller,
	installerAsset,
	parseOmpUpdateCheck,
	plistVersion,
	redirectTarget,
	releaseSummary,
	selectLatestRelease,
	trustedCachedStatus,
} from "./updates";

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

const GITHUB = "https://github.com/decoy-dev/visual-omp/releases/download/v0.2.0";
const releaseAssets = [
	"visual-omp-0.2.0-mac-arm64.dmg",
	"visual-omp-0.2.0-mac-arm64.dmg.blockmap",
	"visual-omp-0.2.0-mac-x64.dmg",
	"visual-omp-0.2.0-win-x64.exe",
	"visual-omp-0.2.0-win-x64.exe.blockmap",
].map((name): ReleaseAsset => ({ name, url: `${GITHUB}/${name}`, size: 100 }));
const packaged = { platform: "darwin" as const, arch: "arm64", anyHost: false };

describe("installerAsset", () => {
	it("picks the release workflow's installer for each platform and arch", () => {
		expect(installerAsset(releaseAssets, "v0.2.0", packaged)?.name).toBe("visual-omp-0.2.0-mac-arm64.dmg");
		expect(installerAsset(releaseAssets, "v0.2.0", { ...packaged, arch: "x64" })?.name).toBe("visual-omp-0.2.0-mac-x64.dmg");
		expect(installerAsset(releaseAssets, "v0.2.0", { ...packaged, platform: "win32", arch: "x64" })?.name).toBe("visual-omp-0.2.0-win-x64.exe");
		expect(installerAsset(releaseAssets, "v0.2.0", { ...packaged, platform: "win32", arch: "arm64" })).toBeNull();
	});

	it("rejects a foreign https URL, another release's URL and a non-installer file", () => {
		const renamed = (url: string): ReleaseAsset[] => [{ name: "visual-omp-0.2.0-mac-arm64.dmg", url, size: 100 }];
		expect(installerAsset(renamed("https://evil.test/visual-omp-0.2.0-mac-arm64.dmg"), "v0.2.0", packaged)).toBeNull();
		expect(installerAsset(renamed("https://github.com/someone/visual-omp/releases/download/v0.2.0/visual-omp-0.2.0-mac-arm64.dmg"), "v0.2.0", packaged)).toBeNull();
		expect(installerAsset(renamed("https://github.com/decoy-dev/visual-omp/releases/download/v0.1.0/visual-omp-0.2.0-mac-arm64.dmg"), "v0.2.0", packaged)).toBeNull();
		expect(installerAsset(renamed(`http://github.com/decoy-dev/visual-omp/releases/download/v0.2.0/visual-omp-0.2.0-mac-arm64.dmg`), "v0.2.0", packaged)).toBeNull();
		expect(installerAsset([{ name: "visual-omp-0.2.0-mac-arm64.pkg", url: `${GITHUB}/visual-omp-0.2.0-mac-arm64.pkg`, size: 1 }], "v0.2.0", packaged)).toBeNull();
	});

	it("accepts any http(s) host only for development feeds", () => {
		const local: ReleaseAsset[] = [{ name: "visual-omp-0.2.0-mac-arm64.dmg", url: "http://127.0.0.1:8765/x.dmg", size: 1 }];
		expect(installerAsset(local, "v0.2.0", packaged)).toBeNull();
		expect(installerAsset(local, "v0.2.0", { ...packaged, anyHost: true })?.url).toBe("http://127.0.0.1:8765/x.dmg");
	});
});

describe("fetchInstaller", () => {
	const init = { signal: new AbortController().signal, headers: {}, anyHost: false };
	const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });

	it("follows GitHub's redirect to its release download host", async () => {
		const seen: string[] = [];
		const fake = (async (input: URL) => {
			seen.push(String(input));
			return seen.length === 1 ? redirect("https://release-assets.githubusercontent.com/a?sig=1") : new Response("dmg");
		}) as typeof fetch;
		const response = await fetchInstaller(new URL(`${GITHUB}/visual-omp-0.2.0-mac-arm64.dmg`), init, fake);
		expect(await response.text()).toBe("dmg");
		expect(seen[1]).toBe("https://release-assets.githubusercontent.com/a?sig=1");
	});

	it("refuses a redirect to any other host or to plain http", async () => {
		for (const location of ["https://evil.test/x.dmg", "http://release-assets.githubusercontent.com/a", "https://github.com.evil.test/a"]) {
			const fake = (async () => redirect(location)) as typeof fetch;
			await expect(fetchInstaller(new URL(`${GITHUB}/visual-omp-0.2.0-mac-arm64.dmg`), init, fake)).rejects.toThrow(/not GitHub's release download server/);
		}
		expect(() => redirectTarget(new URL(GITHUB), null, false)).toThrow(/without a valid location/);
	});
});

describe("trustedCachedStatus", () => {
	const cached = {
		currentVersion: "0.1.0",
		latestVersion: "0.2.0",
		updateAvailable: true,
		tag: "v0.2.0",
		releaseName: "v0.2.0",
		notes: null,
		releaseUrl: "https://github.com/decoy-dev/visual-omp/releases/tag/v0.2.0",
		publishedAt: null,
		assets: releaseAssets,
		platformAsset: releaseAssets[0] ?? null,
		summary: null,
		checkedAt: 1,
		fromCache: false,
		error: null,
	};

	it("keeps a cache that matches its release metadata", () => {
		expect(trustedCachedStatus(cached, "0.1.0", packaged)?.platformAsset?.name).toBe("visual-omp-0.2.0-mac-arm64.dmg");
	});

	it("discards a spoofed installer, version or release page, and caches from another version", () => {
		const evil = { name: "visual-omp-0.2.0-mac-arm64.dmg", url: "https://evil.test/visual-omp-0.2.0-mac-arm64.dmg", size: 100 };
		expect(trustedCachedStatus({ ...cached, platformAsset: evil }, "0.1.0", packaged)).toBeNull();
		expect(trustedCachedStatus({ ...cached, assets: [evil], platformAsset: evil }, "0.1.0", packaged)).toBeNull();
		expect(trustedCachedStatus({ ...cached, latestVersion: "9.9.9" }, "0.1.0", packaged)).toBeNull();
		expect(trustedCachedStatus({ ...cached, releaseUrl: "https://evil.test/release" }, "0.1.0", packaged)).toBeNull();
		expect(trustedCachedStatus(cached, "0.1.1", packaged)).toBeNull();
		expect(trustedCachedStatus({ nonsense: true }, "0.1.0", packaged)).toBeNull();
	});
});

describe("detectInstallMethod", () => {
	const mac = { platform: "darwin" as const, isPackaged: true, bundle: "/Applications/visual-omp.app", caskApps: ["/Applications/visual-omp.app"] };

	it("treats the bundle a cask installed as Homebrew, wherever its appdir is", () => {
		expect(detectInstallMethod(mac)).toBe("brew");
		expect(detectInstallMethod({ ...mac, bundle: "/Users/me/Applications/visual-omp.app", caskApps: ["/Users/me/Applications/visual-omp.app"] })).toBe("brew");
	});

	it("uses the disk image for any other copy, including one beside a cask install", () => {
		expect(detectInstallMethod({ ...mac, caskApps: [] })).toBe("dmg");
		expect(detectInstallMethod({ ...mac, bundle: "/Users/me/Applications/visual-omp.app" })).toBe("dmg");
		expect(detectInstallMethod({ ...mac, bundle: "/Volumes/visual-omp 0.1.0/visual-omp.app" })).toBe("dmg");
	});

	it("uses the installer on Windows and the release page for development builds", () => {
		expect(detectInstallMethod({ ...mac, platform: "win32", bundle: null })).toBe("nsis");
		expect(detectInstallMethod({ ...mac, isPackaged: false })).toBe("manual");
		expect(detectInstallMethod({ ...mac, bundle: null })).toBe("manual");
		expect(detectInstallMethod({ ...mac, platform: "linux" })).toBe("manual");
	});
});

describe("Homebrew locations", () => {
	it("finds the bundle that contains the executable", () => {
		expect(appBundlePath("/Applications/visual-omp.app/Contents/MacOS/visual-omp")).toBe("/Applications/visual-omp.app");
		expect(appBundlePath("/usr/local/bin/electron")).toBeNull();
	});

	it("checks PATH first, then the default prefixes, once each", () => {
		expect(brewCandidates("/Users/me/homebrew/bin:/usr/bin:relative", "/Users/me")).toEqual([
			"/Users/me/homebrew/bin/brew",
			"/usr/bin/brew",
			"/opt/homebrew/bin/brew",
			"/usr/local/bin/brew",
		]);
	});

	it("maps a brew binary to its prefix's Caskroom without resolving symlinks", () => {
		expect(caskroomPath("/opt/homebrew/bin/brew")).toBe("/opt/homebrew/Caskroom/visual-omp");
		expect(caskroomPath("/usr/local/bin/brew")).toBe("/usr/local/Caskroom/visual-omp");
		expect(caskroomPath("/Users/me/homebrew/bin/brew")).toBe("/Users/me/homebrew/Caskroom/visual-omp");
	});

	it("reads the version from an electron-builder Info.plist", () => {
		const xml = "<dict>\n    <key>CFBundleShortVersionString</key>\n    <string>0.2.0</string>\n</dict>";
		expect(plistVersion(xml)).toBe("0.2.0");
		expect(plistVersion("<dict></dict>")).toBeNull();
	});
});

describe("releaseSummary", () => {
	it("takes the first sentence of the opening paragraph (the CHANGELOG format)", () => {
		const notes = [
			"The first release build of visual-omp. It needs omp 18.4 or later.",
			"",
			"- Each chat runs a full omp session.",
		].join("\n");
		expect(releaseSummary(notes)).toBe("The first release build of visual-omp.");
	});

	it("falls back to the first bullet and strips Markdown", () => {
		expect(releaseSummary("### Fixed\n- **Diff pane** keeps `git` [links](https://x.test) working. More.")).toBe(
			"Diff pane keeps git links working.",
		);
		expect(releaseSummary("")).toBeNull();
		expect(releaseSummary("## Only a heading")).toBeNull();
	});

	it("cuts long sentences at a word boundary", () => {
		const summary = releaseSummary(`${"word ".repeat(60)}end.`);
		expect(summary?.length).toBeLessThanOrEqual(140);
		expect(summary?.endsWith("word…")).toBe(true);
	});
});
