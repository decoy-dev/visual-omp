import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "can1357/oh-my-pi";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
const LABEL = "omp-release";

export function normalizeVersion(input) {
	const version = input.replace(/^v/, "");
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid omp version: ${input}`);
	return version;
}

export function issueNamesVersion(issue, version) {
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^0-9A-Za-z.])v?${escaped}(?![0-9A-Za-z.+-])`).test(issue.title);
}

function compareVersions(left, right) {
	const [leftCore, leftPre] = left.split(/-(.*)/s);
	const [rightCore, rightPre] = right.split(/-(.*)/s);
	const a = leftCore.split(".").map(Number);
	const b = rightCore.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	if (leftPre === rightPre) return 0;
	if (leftPre === undefined) return 1;
	if (rightPre === undefined) return -1;
	const ap = leftPre.split(".");
	const bp = rightPre.split(".");
	for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
		if (ap[i] === bp[i]) continue;
		if (ap[i] === undefined) return -1;
		if (bp[i] === undefined) return 1;
		const an = /^\d+$/.test(ap[i]);
		const bn = /^\d+$/.test(bp[i]);
		if (an && bn) return Number(ap[i]) - Number(bp[i]);
		if (an !== bn) return an ? -1 : 1;
		return ap[i] < bp[i] ? -1 : 1;
	}
	return 0;
}

export function pendingReleases(versions, tracked, requestedVersion) {
	const selected = requestedVersion ? [normalizeVersion(requestedVersion)] : versions.map(normalizeVersion)
		.filter(version => compareVersions(version, "18.14.0") >= 0);
	return [...new Set(selected)].filter(version => !tracked.some(issue => issueNamesVersion(issue, version))).sort(compareVersions);
}

export async function prepareRelease({ version, repo, dir }, fetchRelease) {
	const metadata = {
		version: normalizeVersion(version), repo, tagName: `v${normalizeVersion(version)}`,
		url: `https://github.com/${UPSTREAM}/releases/tag/v${normalizeVersion(version)}`, body: "", assets: [],
		metadataStatus: "pending",
	};
	const path = join(dir, "release.json");
	// Preserve the selected npm version before GitHub metadata can fail.
	await writeFile(path, JSON.stringify(metadata, null, 2));
	try {
		const release = await fetchRelease(metadata.tagName);
		if (release.tagName !== metadata.tagName) throw new Error("Upstream release tag does not match the requested version");
		metadata.body = release.body;
		metadata.assets = release.assets;
		metadata.metadataStatus = "success";
	} catch (error) {
		metadata.metadataStatus = "failure";
		metadata.metadataError = error instanceof Error ? error.message : String(error);
	}
	await writeFile(path, JSON.stringify(metadata, null, 2));
	return metadata;
}

export function expectedChecksum(text, name) {
	const matches = text.split(/\r?\n/).flatMap(line => {
		const match = /^([a-fA-F0-9]{64})\s+\*?(.+)$/.exec(line);
		return match?.[2] === name ? [match[1].toLowerCase()] : [];
	});
	if (matches.length !== 1) throw new Error(`Expected one checksum for ${name}, found ${matches.length}`);
	return matches[0];
}

function run(command, args) {
	return execFileSync(command, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

function gh(args) {
	return run("gh", args);
}

function issues(repo) {
	return JSON.parse(gh(["api", `repos/${repo}/issues?labels=${LABEL}&state=all&per_page=100`, "--paginate", "--slurp"]))
		.flat().filter(issue => !issue.pull_request);
}

export function ensureReleaseLabel(repo, client = gh) {
	const exists = () => JSON.parse(client(["api", `repos/${repo}/labels?per_page=100`, "--paginate", "--slurp"]))
		.flat().some(label => label.name === LABEL);
	if (exists()) return;
	try {
		client(["label", "create", LABEL, "--repo", repo, "--color", "5319e7", "--description", "Review compatibility with an upstream omp release"]);
	} catch (error) {
		// Another release job may have created the label after our first read.
		// Continue only when a fresh read proves the required label now exists.
		if (!exists()) throw error;
	}
}

export const MAX_ISSUE_BODY = 60_000;

function safeExcerpt(value, limit, fullUrl) {
	// Upstream Markdown and CLI text are data. HTML-escape them inside a pre block so
	// headings, links, closing fences and mentions cannot become issue instructions.
	const escaped = value.replace(/@/g, "@\u200b").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const truncated = escaped.length > limit;
	return `<pre>${escaped.slice(0, limit)}</pre>\n\n` +
		(truncated ? "This excerpt was shortened. " : "") +
		`[Read the complete source](${fullUrl}).\n`;
}

export function reportBody(metadata, results, compat, runUrl) {
	const releaseUrl = `https://github.com/${UPSTREAM}/releases/tag/v${metadata.version}`;
	const evidenceUrl = runUrl || releaseUrl;
	const statusRows = Object.entries(results).map(([name, status]) => `| ${name} | ${status} |`).join("\n");
	const body = `## omp ${metadata.version}\n\n` +
		`[Upstream release and complete notes](${releaseUrl}) | [npm package](https://www.npmjs.com/package/${PACKAGE}/v/${metadata.version})` +
		(runUrl ? ` | [Workflow results and complete evidence artifacts](${runUrl})` : "") + "\n\n" +
		"The watcher checks CLI output and the app's parsers without signing in or sending a model request. Passing checks still require a release-note review.\n\n" +
		"## Test results\n\n| Check | Result |\n|---|---|\n" + statusRows + "\n\n" +
		(metadata.metadataError ? "### Release metadata failure\n\n" + safeExcerpt(metadata.metadataError, 2_000, evidenceUrl) + "\n" : "") +
		"### Live compatibility details\n\n" + safeExcerpt(JSON.stringify(compat, null, 2), 12_000, evidenceUrl) + "\n" +
		"## Triage\n\n" +
		"Use the [parity audit](https://github.com/" + metadata.repo + "/blob/main/docs/context/2026-10-29-omp-parity-audit.md) to classify each relevant change.\n\n" +
		"- [ ] Review failed checks and confirm whether CLI output or a protocol changed.\n" +
		"- [ ] Breaking: identify changes that stop supported app behavior or make it misleading.\n" +
		"- [ ] Unsurfaced: identify user-facing omp additions that need native app handling.\n" +
		"- [ ] Diverged: identify existing app behavior that differs from omp.\n" +
		"- [ ] Record changes requiring no app work, API gaps and any follow-up fixes.\n" +
		"- [ ] Decide whether the minimum supported omp version needs to change.\n\n" +
		"## Upstream release notes\n\n" + safeExcerpt(metadata.body || "This release has no release-note body.", 36_000, releaseUrl);
	if (body.length > MAX_ISSUE_BODY) throw new Error("The fixed issue summary exceeds the issue-body safety limit");
	return body;
}

async function readJson(path, fallback) {
	try { return JSON.parse(await readFile(path, "utf8")); }
	catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}

async function main() {
	const [command, ...args] = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	let requestedVersion;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--version") requestedVersion = args[++i];
		else if (args[i] !== "--dry-run") throw new Error(`Unknown argument: ${args[i]}`);
	}
	const dir = resolve(process.env.OMP_WATCH_DIR || join(tmpdir(), "omp-watch"));
	await mkdir(dir, { recursive: true });
	const metadataPath = join(dir, "release.json");
	const repo = process.env.GITHUB_REPOSITORY || "decoy-dev/visual-omp";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository name");
	if (command === "discover") {
		const published = requestedVersion ? [] : JSON.parse(run("npm", ["view", PACKAGE, "versions", "--json"]));
		const versions = pendingReleases(published, issues(repo), requestedVersion);
		if (versions.length > 256) throw new Error("More than 256 unreviewed releases exceed GitHub's matrix limit. Review selected versions through manual dispatch.");
		await writeFile(join(dir, "queue.json"), JSON.stringify({ baseline: "18.14.0", versions }, null, 2));
		if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `needed=${versions.length > 0}\nversions=${JSON.stringify(versions)}\n`);
		console.log(JSON.stringify({ versions, needed: versions.length > 0, dryRun }, null, 2));
		return;
	}
	if (command === "prepare") {
		if (!requestedVersion) throw new Error("prepare requires --version X.Y.Z");
		const metadata = await prepareRelease({ version: requestedVersion, repo, dir }, tag =>
			JSON.parse(gh(["release", "view", tag, "--repo", UPSTREAM, "--json", "tagName,url,body,assets"])));
		console.log(JSON.stringify({ version: metadata.version, metadataStatus: metadata.metadataStatus, metadataError: metadata.metadataError, dryRun }, null, 2));
		if (metadata.metadataStatus !== "success") process.exitCode = 1;
		return;
	}
	const metadata = await readJson(metadataPath);
	if (command === "download") {
		if (metadata.metadataStatus !== "success") throw new Error(`Release metadata is unavailable: ${metadata.metadataError || metadata.metadataStatus}`);
		const name = "omp-linux-x64";
		for (const required of [name, "SHA256SUMS.txt"]) {
			if (!metadata.assets.some(asset => asset.name === required)) throw new Error(`Release is missing ${required}`);
		}
		gh(["release", "download", metadata.tagName, "--repo", UPSTREAM, "--pattern", name, "--pattern", "SHA256SUMS.txt", "--dir", dir, "--clobber"]);
		const expected = expectedChecksum(await readFile(join(dir, "SHA256SUMS.txt"), "utf8"), name);
		const actual = createHash("sha256").update(await readFile(join(dir, name))).digest("hex");
		if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, received ${actual}`);
		await chmod(join(dir, name), 0o700);
		const source = JSON.parse(gh(["api", `repos/${UPSTREAM}/contents/packages/wire/src/index.ts?ref=${metadata.tagName}`]));
		if (source.encoding !== "base64" || typeof source.content !== "string") throw new Error("Upstream wire source is unavailable");
		await writeFile(join(dir, "wire.ts"), Buffer.from(source.content, "base64"));
		await writeFile(join(dir, "checksum.json"), JSON.stringify({ asset: name, sha256: actual, verified: true }, null, 2));
		console.log(`Verified ${name} for omp ${metadata.version}: ${actual}${dryRun ? " (dry run, no issue writes)" : ""}`);
		return;
	}
	if (command !== "report") throw new Error("Usage: node scripts/omp-watch.mjs discover|prepare|download|report [--version X.Y.Z] [--dry-run]");
	const results = {
		"Release metadata": metadata.metadataStatus || "not run",
		"Binary and checksum": process.env.WATCH_DOWNLOAD || "not run",
		"npm ci": process.env.WATCH_INSTALL || "not run",
		Typecheck: process.env.WATCH_TYPECHECK || "not run",
		"Full Vitest suite": process.env.WATCH_TESTS || "not run",
		"Live compatibility": process.env.WATCH_COMPAT || "not run",
	};
	const compat = await readJson(join(dir, "compat.json"), { status: "No live compatibility report was produced. See the workflow logs." });
	const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${metadata.repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
	const body = reportBody(metadata, results, compat, runUrl);
	const bodyFile = join(dir, "issue.md");
	await writeFile(bodyFile, body);
	if (dryRun) { console.log(`Dry run: issue preview written to ${bodyFile}. No label or issue was created.`); return; }
	// Recheck after tests, including closed issues, so a retried workflow cannot create a second issue.
	const existing = issues(metadata.repo).find(issue => issueNamesVersion(issue, metadata.version));
	if (existing) { console.log(`Already tracked: ${existing.html_url}`); return; }
	ensureReleaseLabel(metadata.repo);
	console.log(gh(["issue", "create", "--repo", metadata.repo, "--title", `omp ${metadata.version} compatibility review`, "--label", LABEL, "--body-file", bodyFile]).trim());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
