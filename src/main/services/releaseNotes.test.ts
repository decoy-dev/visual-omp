import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseChangelog } from "@shared/changelog";
import { releaseNotesForVersions } from "@shared/releaseNotes";
import { describe, expect, it } from "vitest";
import { AppUpdateStatusSchema, fetchReleaseHistory, GitHubRelease, RELEASES_PAGE_SIZE, toReleaseNotes, trustedCachedStatus } from "./updates";

const release = (tag: string, extra: Record<string, unknown> = {}) => GitHubRelease.parse({
	tag_name: tag,
	html_url: `https://github.com/decoy-dev/visual-omp/releases/tag/${tag}`,
	draft: false,
	prerelease: false,
	...extra,
});

it("retains GitHub release Markdown and publication dates without another fetch", () => {
	const body = "A short overview.\n\n### Highlights\n\n- **New:** Read release notes.\n\n### Detailed changes\n\n- Full detail.";
	expect(toReleaseNotes([release("v0.8.0", { body, published_at: "2026-11-01T12:00:00Z" })], "0.7.0")).toEqual([{
		version: "0.8.0", body,
		url: "https://github.com/decoy-dev/visual-omp/releases/tag/v0.8.0",
		publishedAt: Date.parse("2026-11-01T12:00:00Z"),
	}]);
});

it("excludes drafts, unversioned tags and prereleases on the stable track", () => {
	const releases = [release("v0.8.0"), release("v0.9.0", { draft: true }), release("v0.8.1-beta.1", { prerelease: true }), release("nightly")];
	expect(toReleaseNotes(releases, "0.7.0").map(entry => entry.version)).toEqual(["0.8.0"]);
	expect(toReleaseNotes(releases, "0.8.0-beta.1").map(entry => entry.version)).toEqual(["0.8.0", "0.8.1-beta.1"]);
});

describe("older cached update results", () => {
	it("defaults a missing release history to an empty list", () => {
		const status = AppUpdateStatusSchema.parse({
			currentVersion: "0.7.0", latestVersion: null, updateAvailable: false,
			tag: null, releaseName: null, notes: null, releaseUrl: null, publishedAt: null,
			assets: [], platformAsset: null, summary: null, checkedAt: 0, fromCache: true, error: null,
		});
		expect(status.releases).toEqual([]);
	});
});

it("prints the full tagged body used by the GitHub workflow", () => {
	const source = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
	const section = parseChangelog(source).find(section => section.version === "0.6.7")!;
	const output = execFileSync(process.execPath, ["scripts/release-notes.mjs", "v0.6.7"], { encoding: "utf8" });
	expect(output).toBe(`${section.body}\n`);
});

describe("paginated release history", () => {
	it("keeps every intermediate version across pages containing drafts and prereleases, including in the offline cache", async () => {
		const feed = [
			release("v0.1.0", { draft: true }),
			release("v0.2.0-beta.1", { prerelease: true }),
			...Array.from({ length: 42 }, (_, index) => release(`v0.${42 - index}.0`, { body: `Changes in release ${42 - index}.` })),
		];
		const pages: number[] = [];
		const history = await fetchReleaseHistory(async page => {
			pages.push(page);
			return feed.slice((page - 1) * RELEASES_PAGE_SIZE, page * RELEASES_PAGE_SIZE);
		});
		expect(pages).toEqual([1, 2]);
		const status = {
			currentVersion: "0.10.0", latestVersion: "0.42.0", updateAvailable: true,
			tag: "v0.42.0", releaseName: null, notes: feed[2]!.body,
			releaseUrl: feed[2]!.html_url, publishedAt: null,
			releases: toReleaseNotes(history, "0.10.0"),
			assets: [], platformAsset: null, summary: null, checkedAt: 123, fromCache: false, error: null,
		};
		const restored = trustedCachedStatus(JSON.parse(JSON.stringify(status)), "0.10.0", { platform: "darwin", arch: "arm64", anyHost: false });
		expect(restored).not.toBeNull();
		const offline = releaseNotesForVersions("0.10.0", "0.42.0", restored!.releases!, []);
		expect(offline.pending.map(entry => entry.version)).toEqual(Array.from({ length: 32 }, (_, index) => `0.${42 - index}.0`));
		expect(offline.past[0]?.version).toBe("0.10.0");
		expect(restored!.releases).toHaveLength(42);
	});

	it("reads intermediate releases on a later page after an old maintenance release on the first page", async () => {
		const pages: number[] = [];
		const first = [
			release("v0.1.0"),
			release("v0.42.0"),
			...Array.from({ length: 28 }, (_, index) => release(`v0.1.${index + 1}`)),
		];
		const history = await fetchReleaseHistory(async page => {
			pages.push(page);
			return page === 1 ? first : [release("v0.41.0"), release("v0.40.0")];
		});
		expect(pages).toEqual([1, 2]);
		const notes = releaseNotesForVersions("0.10.0", "0.42.0", toReleaseNotes(history, "0.10.0"), []);
		expect(notes.pending.map(entry => entry.version)).toEqual(["0.42.0", "0.41.0", "0.40.0"]);
	});

	it("continues to the end when the installed version predates every published version", async () => {
		const pages: number[] = [];
		const history = await fetchReleaseHistory(async page => {
			pages.push(page);
			return page === 1 ? Array.from({ length: RELEASES_PAGE_SIZE }, (_, index) => release(`v1.0.${index}`)) : [];
		});
		expect(pages).toEqual([1, 2]);
		expect(history).toHaveLength(RELEASES_PAGE_SIZE);
	});

	it("rejects a later-page failure instead of presenting incomplete intermediate notes", async () => {
		await expect(fetchReleaseHistory(async page => {
			if (page > 1) throw new Error("GitHub rate limit reached.");
			return Array.from({ length: RELEASES_PAGE_SIZE }, (_, index) => release(`v1.0.${index}`));
		})).rejects.toThrow("GitHub rate limit reached.");
	});
});
