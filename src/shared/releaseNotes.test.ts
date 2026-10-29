import { describe, expect, it } from "vitest";
import type { AppReleaseNotes } from "./contracts/updates";
import { releaseNotesForVersions } from "./releaseNotes";

const release = (version: string, body = `Changes in ${version}.`): AppReleaseNotes => ({ version, body, url: `https://github.com/decoy-dev/visual-omp/releases/tag/v${version}`, publishedAt: 1234 });
const bundled = [
	{ version: "0.9.0", date: null, body: "Unpublished future notes." },
	{ version: "0.7.0", date: "2026-10-29", body: "Installed notes." },
	{ version: "0.6.0", date: null, body: "Older notes." },
];

describe("release notes for the pending update and past versions", () => {
	it("includes every published version being installed, newest first, and no future or installed version", () => {
		const notes = releaseNotesForVersions("0.7.0", "0.8.2", [release("0.9.0"), release("0.8.0"), release("0.8.2"), release("0.7.0")], bundled);
		expect(notes.pending.map(entry => entry.version)).toEqual(["0.8.2", "0.8.0"]);
		expect(notes.past.map(entry => entry.version)).toEqual(["0.7.0", "0.6.0"]);
	});

	it("uses GitHub bodies first and bundled notes for installed and older versions with missing bodies", () => {
		const notes = releaseNotesForVersions("0.7.0", "0.8.0", [release("0.8.0", ""), release("v0.7.0", "  "), release("0.6.0", "Published correction.")], bundled);
		expect(notes.pending[0]).toMatchObject({ version: "0.8.0", body: "", source: "github" });
		expect(notes.past[0]).toMatchObject({ version: "0.7.0", body: "Installed notes.", source: "bundled" });
		expect(notes.past[1]).toMatchObject({ version: "0.6.0", body: "Published correction.", source: "github" });
	});

	it("provides offline history without exposing future bundled entries", () => {
		const notes = releaseNotesForVersions("0.7.0", null, [], bundled);
		expect(notes.pending).toEqual([]);
		expect(notes.past.map(entry => entry.version)).toEqual(["0.7.0", "0.6.0"]);
		expect(notes.past.every(entry => entry.source === "bundled")).toBe(true);
	});

	it("keeps stable installations off the prerelease track", () => {
		const releases = [release("0.8.0-beta.1"), release("0.8.0"), release("0.6.0-beta.1"), release("nightly")];
		const stable = releaseNotesForVersions("0.7.0", "0.8.0", releases, bundled);
		expect(stable.pending.map(entry => entry.version)).toEqual(["0.8.0"]);
		expect(stable.past.some(entry => entry.version.includes("beta"))).toBe(false);
		const beta = releaseNotesForVersions("0.8.0-beta.1", "0.8.0", releases, bundled);
		expect(beta.pending.map(entry => entry.version)).toEqual(["0.8.0"]);
		expect(beta.past[0]?.version).toBe("0.8.0-beta.1");
	});

	it("does not offer pending notes for an equal, older or unknown running version", () => {
		expect(releaseNotesForVersions("0.8.0", "0.7.0", [release("0.8.0")], bundled).pending).toEqual([]);
		expect(releaseNotesForVersions("0.8.0", "0.8.0", [release("0.8.0")], bundled).pending).toEqual([]);
		expect(releaseNotesForVersions("development", "0.8.0", [release("0.8.0")], bundled)).toEqual({ pending: [], past: [] });
	});

	it("orders numeric version components instead of sorting strings", () => {
		const notes = releaseNotesForVersions("0.8.0", "0.10.0", [release("0.9.0"), release("0.10.0")], []);
		expect(notes.pending.map(entry => entry.version)).toEqual(["0.10.0", "0.9.0"]);
	});
});
