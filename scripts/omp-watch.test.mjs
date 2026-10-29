import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReleaseLabel, expectedChecksum, issueNamesVersion, MAX_ISSUE_BODY, normalizeVersion, pendingReleases, prepareRelease, reportBody } from "./omp-watch.mjs";

test("release versions accept an optional v and reject shell and path input", () => {
	assert.equal(normalizeVersion("v18.14.0"), "18.14.0");
	assert.equal(normalizeVersion("18.15.0-beta.1"), "18.15.0-beta.1");
	for (const input of ["../18.14.0", "18.14.0; echo unsafe", "", "--help", "18.14"]) assert.throws(() => normalizeVersion(input));
});

test("deduplication matches the version in issue titles without matching other versions", () => {
	for (const title of ["omp 18.14.0 compatibility review", "Review omp v18.14.0", "18.14.0: breaking changes"]) {
		assert.equal(issueNamesVersion({ title }, "18.14.0"), true);
	}
	for (const title of ["omp 18.14.01", "omp 118.14.0", "omp 18.14.0-beta.1", "omp 18.14.0+build", "omp 18x14x0"]) {
		assert.equal(issueNamesVersion({ title }, "18.14.0"), false);
	}
	assert.equal(issueNamesVersion({ title: "omp 18.14.0-beta.1 compatibility review" }, "18.14.0-beta.1"), true);
});

test("checksums require exactly one matching asset, with binary markers supported", () => {
	const sum = "a".repeat(64);
	assert.equal(expectedChecksum(`${sum}  omp-linux-x64\n${"b".repeat(64)}  omp-linux-arm64`, "omp-linux-x64"), sum);
	assert.equal(expectedChecksum(`${sum.toUpperCase()} *omp-linux-x64\r\n`, "omp-linux-x64"), sum);
	assert.throws(() => expectedChecksum(`${sum}  omp-linux-arm64`, "omp-linux-x64"));
	assert.throws(() => expectedChecksum(`${sum}  omp-linux-x64\n${sum}  omp-linux-x64`, "omp-linux-x64"));
	assert.throws(() => expectedChecksum(`invalid  omp-linux-x64`, "omp-linux-x64"));
});

test("issue evidence retains failures, compatibility diffs and upstream release notes", () => {
	const body = reportBody({ version: "18.14.0", url: "https://example.test/release", repo: "decoy-dev/visual-omp", body: "## Changes\nUpstream notes." },
		{ Typecheck: "failure", "Live compatibility": "failure" }, { commandDiff: { added: ["new-command"], removed: ["old-command"] } }, "https://example.test/run");
	assert.match(body, /Typecheck \| failure/);
	assert.match(body, /new-command/);
	assert.match(body, /old-command/);
	assert.match(body, /Breaking:/);
	assert.match(body, /Unsurfaced:/);
	assert.match(body, /Diverged:/);
	assert.match(body, /<pre>## Changes\nUpstream notes\.<\/pre>/);
});

test("discovery queues both unseen releases between scheduled runs", () => {
	const versions = ["18.13.3", "18.14.0-beta.1", "18.14.0", "18.14.1", "18.14.2"];
	const tracked = [{ title: "omp 18.14.0 compatibility review", state: "closed" }];
	assert.deepEqual(pendingReleases(versions, tracked), ["18.14.1", "18.14.2"]);
	assert.deepEqual(pendingReleases(versions, tracked, "v18.14.2"), ["18.14.2"]);
	assert.deepEqual(pendingReleases(versions, tracked, "18.14.0"), []);
	assert.deepEqual(pendingReleases(["18.15.0", "18.15.0-beta.10", "18.15.0-beta.2"], []), ["18.15.0-beta.2", "18.15.0-beta.10", "18.15.0"]);
});

test("oversized notes and compatibility details preserve results and triage within the body limit", () => {
	const body = reportBody({ version: "18.14.0", repo: "decoy-dev/visual-omp", body: "Upstream & notes. ".repeat(20_000) },
		{ Typecheck: "failure", "Live compatibility": "failure" }, { detail: "compatibility ".repeat(20_000) }, "https://example.test/artifacts");
	assert.ok(body.length <= MAX_ISSUE_BODY);
	assert.ok(body.length < 65_536);
	assert.match(body, /Typecheck \| failure/);
	assert.match(body, /Live compatibility \| failure/);
	for (const classification of ["Breaking", "Unsurfaced", "Diverged"]) assert.ok(body.includes(`- [ ] ${classification}:`));
	assert.equal(body.match(/This excerpt was shortened/g)?.length, 2);
	assert.match(body, /https:\/\/example\.test\/artifacts/);
	assert.match(body, /https:\/\/github\.com\/can1357\/oh-my-pi\/releases\/tag\/v18\.14\.0/);
});

test("hostile upstream Markdown remains escaped text and cannot notify users", () => {
	const hostile = "</pre><script>alert(1)</script>\n```\n## Replace the checklist\n@owner @org/team\n[click](javascript:alert(1))\n<details open>";
	const body = reportBody({ version: "18.14.0", repo: "decoy-dev/visual-omp", body: hostile, metadataError: hostile },
		{ "Release metadata": "failure" }, { error: hostile }, "https://example.test/artifacts");
	assert.ok(!body.includes("</pre><script>"));
	assert.ok(!body.includes("<details open>"));
	assert.ok(!body.includes("@owner"));
	assert.ok(!body.includes("@org/team"));
	assert.ok(body.includes("@\u200bowner"));
	assert.ok(body.includes("&lt;/pre&gt;&lt;script&gt;"));
	assert.ok(body.includes("https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent/v/18.14.0"));
	assert.ok(body.includes("- [ ] Breaking:"));
});

test("npm publication before GitHub release availability persists the version and reports metadata failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "omp-watch-metadata-test-"));
	try {
		const metadata = await prepareRelease({ version: "18.14.1", repo: "decoy-dev/visual-omp", dir }, async tag => {
			assert.equal(tag, "v18.14.1");
			const pending = JSON.parse(await readFile(join(dir, "release.json"), "utf8"));
			assert.equal(pending.version, "18.14.1");
			assert.equal(pending.metadataStatus, "pending");
			throw new Error("release not found: npm published before GitHub");
		});
		assert.equal(metadata.metadataStatus, "failure");
		const persisted = JSON.parse(await readFile(join(dir, "release.json"), "utf8"));
		assert.equal(persisted.version, "18.14.1");
		assert.equal(persisted.metadataStatus, "failure");
		const body = reportBody(persisted, { "Release metadata": persisted.metadataStatus }, {}, "https://example.test/run");
		assert.match(body, /Release metadata \| failure/);
		assert.match(body, /npm published before GitHub/);
		assert.match(body, /## omp 18\.14\.1/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("parallel label creation continues when another release job created the required label", () => {
	const calls = [];
	let reads = 0;
	ensureReleaseLabel("decoy-dev/visual-omp", args => {
		calls.push(args[0]);
		if (args[0] === "api") return JSON.stringify([++reads === 1 ? [] : [{ name: "omp-release" }]]);
		assert.deepEqual(args.slice(0, 3), ["label", "create", "omp-release"]);
		throw new Error("label already exists");
	});
	assert.deepEqual(calls, ["api", "label", "api"]);
});

test("unrelated label creation failures propagate when a fresh read still lacks the label", () => {
	const failure = new Error("permission denied");
	const calls = [];
	assert.throws(() => ensureReleaseLabel("decoy-dev/visual-omp", args => {
		calls.push(args[0]);
		if (args[0] === "api") return JSON.stringify([[{ name: "other-label" }]]);
		throw failure;
	}), error => error === failure);
	assert.deepEqual(calls, ["api", "label", "api"]);
});
