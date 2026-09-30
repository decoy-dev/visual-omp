import { z } from "zod";
import type { CliResult, Platform } from "@shared/ipc";
import type { AppUpdateHint, OmpUpdateChannel, ReleaseAsset } from "@shared/contracts/updates";

interface Semver {
	major: number;
	minor: number;
	patch: number;
	prerelease: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parse `1.2.3`, `v1.2.3-beta.1+build`; null when not semver. */
export function parseSemver(version: string): Semver | null {
	const match = SEMVER.exec(version.trim());
	if (!match) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] ? match[4].split(".") : [],
	};
}

function compareIdentifiers(a: string, b: string): number {
	const numA = /^\d+$/.test(a);
	const numB = /^\d+$/.test(b);
	if (numA && numB) return Number(a) - Number(b);
	if (numA) return -1;
	if (numB) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Semver precedence (build metadata ignored, prereleases sort before their release).
 * Negative when `a < b`, 0 when equal, positive when `a > b`. Unparseable versions sort lowest.
 */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
	const core = pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
	if (core !== 0) return core;
	if (pa.prerelease.length === 0 || pb.prerelease.length === 0) return pb.prerelease.length - pa.prerelease.length;
	const length = Math.max(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < length; i++) {
		const idA = pa.prerelease[i];
		const idB = pb.prerelease[i];
		if (idA === undefined) return -1;
		if (idB === undefined) return 1;
		const diff = compareIdentifiers(idA, idB);
		if (diff !== 0) return diff;
	}
	return 0;
}

const GitHubAsset = z.object({
	name: z.string(),
	browser_download_url: z.string(),
	size: z.number(),
});

export const GitHubRelease = z.object({
	tag_name: z.string(),
	name: z.string().nullable().optional(),
	body: z.string().nullable().optional(),
	html_url: z.string(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	published_at: z.string().nullable().optional(),
	assets: z.array(GitHubAsset).default([]),
});
export type GitHubRelease = z.infer<typeof GitHubRelease>;

export const GitHubReleaseList = z.array(GitHubRelease);

/**
 * The newest non-draft release with a semver tag. Prereleases count only when the running
 * version is itself a prerelease (testers stay on the prerelease track, everyone else does not).
 */
export function selectLatestRelease(releases: GitHubRelease[], currentVersion: string): GitHubRelease | null {
	const includePrereleases = (parseSemver(currentVersion)?.prerelease.length ?? 0) > 0;
	let best: GitHubRelease | null = null;
	for (const release of releases) {
		if (release.draft || (release.prerelease && !includePrereleases) || !parseSemver(release.tag_name)) continue;
		if (!best || compareSemver(release.tag_name, best.tag_name) > 0) best = release;
	}
	return best;
}

export function toAssets(release: GitHubRelease): ReleaseAsset[] {
	return release.assets.map(asset => ({ name: asset.name, url: asset.browser_download_url, size: asset.size }));
}

const ARCH_ALIASES: Record<string, string[]> = {
	arm64: ["arm64", "aarch64"],
	x64: ["x64", "x86_64", "amd64"],
	ia32: ["ia32", "x86", "win32"],
};

/**
 * Pick the installer for this platform/arch: `.dmg` (then `.zip`) on macOS, `.exe` on Windows,
 * `.AppImage`/`.deb` on Linux. Prefers an asset naming this arch, then one naming no arch
 * (universal), never one built for another arch.
 */
export function pickPlatformAsset(assets: ReleaseAsset[], platform: Platform, arch: string): ReleaseAsset | null {
	const extensions = platform === "darwin" ? [".dmg", ".zip"] : platform === "win32" ? [".exe"] : [".appimage", ".deb"];
	const mine = ARCH_ALIASES[arch] ?? [arch];
	const others = Object.entries(ARCH_ALIASES)
		.filter(([key]) => key !== arch)
		.flatMap(([, names]) => names);
	const mentions = (name: string, tokens: string[]) =>
		tokens.some(token => new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`).test(name));
	for (const extension of extensions) {
		const candidates = assets.filter(asset => asset.name.toLowerCase().endsWith(extension));
		const exact = candidates.find(asset => mentions(asset.name.toLowerCase(), mine));
		if (exact) return exact;
		const universal = candidates.find(asset => !mentions(asset.name.toLowerCase(), others));
		if (universal) return universal;
	}
	return null;
}

/** Homebrew cask upgrade command shown on macOS. */
export const BREW_UPGRADE_COMMAND = "brew upgrade --cask visual-omp";

export function updateHint(platform: Platform, releaseUrl: string, asset: ReleaseAsset | null): AppUpdateHint {
	if (platform === "darwin") return { kind: "command", command: BREW_UPGRADE_COMMAND, url: releaseUrl };
	if (platform === "win32" && asset) return { kind: "download", url: asset.url, fileName: asset.name };
	return { kind: "page", url: releaseUrl };
}

export interface OmpUpdateCheck {
	currentVersion: string | null;
	latestVersion: string | null;
	updateAvailable: boolean;
	channel: OmpUpdateChannel;
	packageMovedTo: string | null;
	error: string | null;
}

/**
 * Parse `omp update --check` text output (omp has no JSON mode for it):
 * `Current version: X`, optional `Current channel: canary`, then `New version available: Y`,
 * `Already up to date`, or `Failed to check for updates: …` on stderr with exit 1.
 */
export function parseOmpUpdateCheck(result: CliResult): OmpUpdateCheck {
	const text = `${result.stdout}\n${result.stderr}`;
	const currentVersion = /Current version:\s*(\S+)/.exec(text)?.[1] ?? null;
	const latestVersion = /New version available:\s*(\S+)/.exec(text)?.[1] ?? null;
	const channel: OmpUpdateChannel = /Current channel:\s*canary/.test(text) ? "canary" : "stable";
	const packageMovedTo = /The npm package moved to (\S+?);/.exec(text)?.[1] ?? null;
	let error: string | null = null;
	if (result.code !== 0) {
		error =
			/Failed to check for updates:\s*(.+)/.exec(text)?.[1]?.trim() ||
			result.stderr.trim() ||
			`omp update --check exited with ${result.code}`;
	} else if (!latestVersion && !/Already up to date/.test(text)) {
		error = `Unrecognized omp update output: ${text.trim().slice(0, 200)}`;
	}
	return {
		currentVersion,
		latestVersion: error ? null : latestVersion,
		updateAvailable: !error && latestVersion !== null,
		channel,
		packageMovedTo,
		error,
	};
}
