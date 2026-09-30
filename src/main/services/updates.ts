import { delimiter, posix } from "node:path";
import { z } from "zod";
import type { CliResult, Platform } from "@shared/ipc";
import type { AppInstallMethod, AppUpdateStatus, OmpUpdateChannel, ReleaseAsset } from "@shared/contracts/updates";

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

/** The GitHub repository that publishes visual-omp releases. */
export const REPO = "decoy-dev/visual-omp";

/**
 * The installer file electron-builder publishes for this platform/arch (`dmg`/`nsis` artifactName
 * in electron-builder.yml), or null where no installer is built.
 */
export function installerName(version: string, platform: Platform, arch: string): string | null {
	if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `visual-omp-${version}-mac-${arch}.dmg`;
	if (platform === "win32" && arch === "x64") return `visual-omp-${version}-win-${arch}.exe`;
	return null;
}

export interface InstallerTrust {
	platform: Platform;
	arch: string;
	/** Development feeds (`VOMP_UPDATE_FEED`, never packaged builds): any http(s) host is accepted. */
	anyHost: boolean;
}

function parseUrl(raw: string, base?: URL): URL | null {
	try {
		return new URL(raw, base);
	} catch {
		return null;
	}
}

/** `https://github.com/decoy-dev/visual-omp/releases/download/<tag>/<name>`, nothing else. */
function isReleaseDownload(raw: string, tag: string, name: string, anyHost: boolean): boolean {
	const url = parseUrl(raw);
	if (!url) return false;
	if (anyHost) return url.protocol === "https:" || url.protocol === "http:";
	if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search) return false;
	try {
		return decodeURIComponent(url.pathname) === `/${REPO}/releases/download/${tag}/${name}`;
	} catch {
		return false;
	}
}

/**
 * The installer for this computer from release `tag`: only the expected artifact name, and only
 * when its URL is that release's own GitHub download link. Anything else yields null, so the app
 * falls back to the release page.
 */
export function installerAsset(assets: ReleaseAsset[], tag: string, trust: InstallerTrust): ReleaseAsset | null {
	const name = installerName(tag.replace(/^v/, ""), trust.platform, trust.arch);
	const asset = name ? assets.find(candidate => candidate.name === name) : undefined;
	return asset && name && isReleaseDownload(asset.url, tag, name, trust.anyHost) ? asset : null;
}

/** Hosts github.com redirects release downloads to. */
const ASSET_HOSTS: readonly string[] = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const MAX_REDIRECTS = 5;

/** Where a download redirect leads, or an error when it leaves GitHub's release download servers. */
export function redirectTarget(from: URL, location: string | null, anyHost: boolean): URL {
	const next = location ? parseUrl(location, from) : null;
	if (!next) throw new Error("The download server sent a redirect without a valid location.");
	const allowed = anyHost
		? next.protocol === "https:" || next.protocol === "http:"
		: next.protocol === "https:" && ASSET_HOSTS.includes(next.hostname) && !next.username && !next.password;
	if (!allowed) throw new Error(`The download was redirected to ${next.host}, which is not GitHub's release download server.`);
	return next;
}

/** Fetches an installer, following only the redirects {@link redirectTarget} allows. */
export async function fetchInstaller(
	url: URL,
	init: { signal: AbortSignal; headers: Record<string, string>; anyHost: boolean },
	fetchImpl: typeof fetch = fetch,
): Promise<Response> {
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetchImpl(current, { signal: init.signal, headers: init.headers, redirect: "manual" });
		if (response.status < 300 || response.status >= 400) return response;
		await response.body?.cancel();
		current = redirectTarget(current, response.headers.get("location"), init.anyHost);
	}
	throw new Error("The download redirected too many times.");
}

const ReleaseAssetSchema = z.object({ name: z.string(), url: z.string(), size: z.number() });
export const AppUpdateStatusSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	tag: z.string().nullable(),
	releaseName: z.string().nullable(),
	notes: z.string().nullable(),
	releaseUrl: z.string().nullable(),
	publishedAt: z.number().nullable(),
	assets: z.array(ReleaseAssetSchema),
	platformAsset: ReleaseAssetSchema.nullable(),
	summary: z.string().nullable(),
	checkedAt: z.number(),
	fromCache: z.boolean(),
	error: z.string().nullable(),
}) satisfies z.ZodType<AppUpdateStatus>;

/**
 * update-check.json as an earlier check wrote it, or null when it is unreadable, belongs to another
 * app version, or does not match what the release metadata vouches for (installer, versions,
 * release page). The file is plain JSON in the profile, so nothing in it is trusted as written.
 */
export function trustedCachedStatus(raw: unknown, currentVersion: string, trust: InstallerTrust): AppUpdateStatus | null {
	const parsed = AppUpdateStatusSchema.safeParse(raw);
	if (!parsed.success) return null;
	const status = parsed.data;
	if (status.currentVersion !== currentVersion) return null;
	const latest = status.tag ? status.tag.replace(/^v/, "") : null;
	if (status.latestVersion !== latest) return null;
	if (status.updateAvailable !== (latest !== null && compareSemver(latest, currentVersion) > 0)) return null;
	const expected = status.tag ? installerAsset(status.assets, status.tag, trust) : null;
	const cached = status.platformAsset;
	if (expected?.url !== cached?.url || expected?.name !== cached?.name || expected?.size !== cached?.size) return null;
	const page = status.releaseUrl ? parseUrl(status.releaseUrl) : null;
	if (status.releaseUrl && !trust.anyHost && (page?.protocol !== "https:" || page.hostname !== "github.com" || !page.pathname.startsWith(`/${REPO}/releases/`))) {
		return null;
	}
	return status;
}

/** Cask token the release workflow publishes (`decoy-dev/tap/visual-omp`). */
export const CASK = "visual-omp";

/** The `.app` bundle that contains `exePath` (`…/visual-omp.app/Contents/MacOS/visual-omp`), or null. */
export function appBundlePath(exePath: string): string | null {
	const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(exePath);
	return match?.[1] ?? null;
}

/** Where brew may be: every PATH entry, then the default prefixes (Apple Silicon, Intel, `~/homebrew`). */
export function brewCandidates(pathValue: string, home: string): string[] {
	const dirs = [...pathValue.split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", posix.join(home, "homebrew", "bin")];
	return [...new Set(dirs.filter(dir => dir.startsWith("/")).map(dir => posix.join(dir, "brew")))];
}

/** `<prefix>/Caskroom/visual-omp` for a brew binary at `<prefix>/bin/brew` (symlinks not resolved on purpose). */
export function caskroomPath(brewPath: string): string {
	return posix.join(posix.dirname(posix.dirname(brewPath)), "Caskroom", CASK);
}

export interface InstallProbe {
	platform: Platform;
	isPackaged: boolean;
	/** The running `.app` bundle with symlinks resolved; null when the executable is not inside one. */
	bundle: string | null;
	/**
	 * Where installed casks put visual-omp: the resolved targets of the `.app` links brew keeps in
	 * `<prefix>/Caskroom/visual-omp/<version>/` for every brew on this machine.
	 */
	caskApps: readonly string[];
}

/**
 * How this copy was installed, which decides how it updates:
 * - `brew`: a packaged macOS app whose bundle is the one a visual-omp cask installed (`brew upgrade --cask`).
 * - `dmg`: any other packaged macOS app, including a second copy beside a cask install.
 * - `nsis`: packaged Windows app (download and run the installer).
 * - `manual`: development builds and other platforms (open the release page).
 */
export function detectInstallMethod(probe: InstallProbe): AppInstallMethod {
	if (!probe.isPackaged) return "manual";
	if (probe.platform === "win32") return "nsis";
	if (probe.platform !== "darwin" || !probe.bundle) return "manual";
	return probe.caskApps.includes(probe.bundle) ? "brew" : "dmg";
}

/**
 * Refresh taps first: `brew upgrade` only auto-updates when its last update is older than
 * HOMEBREW_AUTO_UPDATE_SECS, so a release published an hour ago can be invisible to it.
 * The upgrade still runs if `brew update` fails.
 */
export function brewUpgradeCommand(brewPath: string): string {
	const brew = `'${brewPath.replaceAll("'", `'\\''`)}'`;
	return `${brew} update; HOMEBREW_NO_AUTO_UPDATE=1 ${brew} upgrade --cask ${CASK}`;
}

/** `CFBundleShortVersionString` from an Info.plist in XML form (what electron-builder writes). */
export function plistVersion(xml: string): string | null {
	return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]?.trim() ?? null;
}

const SUMMARY_MAX = 140;

/**
 * One line for the update toast: the first sentence of the notes' first prose paragraph (the
 * CHANGELOG section opens with one), else the first bullet. Markdown links, emphasis and code
 * marks are stripped; long lines are cut at a word boundary.
 */
export function releaseSummary(notes: string | null): string | null {
	if (!notes) return null;
	const lines = notes.split(/\r?\n/).map(line => line.trim());
	const isBullet = (line: string) => /^([-*+]|\d+\.)\s+/.test(line);
	const prose = lines.find(line => line && !line.startsWith("#") && !isBullet(line) && !line.startsWith(">") && !line.startsWith("|"));
	const raw = prose ?? lines.find(isBullet)?.replace(/^([-*+]|\d+\.)\s+/, "");
	if (!raw) return null;
	const plain = raw
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|\*|`)(.+?)\1/g, "$2")
		.replace(/\s+/g, " ")
		.trim();
	const sentence = /^.+?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain;
	if (sentence.length <= SUMMARY_MAX) return sentence;
	const cut = sentence.slice(0, SUMMARY_MAX - 1);
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), SUMMARY_MAX / 2)).replace(/[,;:]$/, "")}…`;
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
