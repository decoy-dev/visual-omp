import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";

const script = resolve("scripts/update-scoop-manifest.mjs");
const roots: string[] = [];
const x64Sha = "A".repeat(64);
const arm64Sha = "B".repeat(64);

async function fixture(existing?: object) {
	const root = await mkdtemp(join(tmpdir(), "vomp-scoop-manifest-"));
	roots.push(root);
	if (existing) {
		await mkdir(join(root, "bucket"));
		await writeFile(join(root, "bucket/visual-omp.json"), JSON.stringify(existing));
	}
	return root;
}

function generate(cwd: string, ...args: string[]) {
	return execFileSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", stdio: "pipe" });
}

async function manifest(root: string) {
	return JSON.parse(await readFile(join(root, "bucket/visual-omp.json"), "utf8"));
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("writes both Windows architectures with their own checksum and NSIS archive", async () => {
	const root = await fixture();
	generate(root, "0.7.8", x64Sha, arm64Sha);
	const result = await manifest(root);
	expect(result.version).toBe("0.7.8");
	expect(result.url).toBeUndefined();
	expect(result.hash).toBeUndefined();
	expect(result.pre_install).toBeUndefined();
	expect(result.architecture).toEqual({
		"64bit": {
			url: "https://github.com/decoy-dev/visual-omp/releases/download/v0.7.8/visual-omp-0.7.8-win-x64.exe#/dl.7z",
			hash: x64Sha.toLowerCase(),
			pre_install: 'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-64.7z" "$dir"',
		},
		arm64: {
			url: "https://github.com/decoy-dev/visual-omp/releases/download/v0.7.8/visual-omp-0.7.8-win-arm64.exe#/dl.7z",
			hash: arm64Sha.toLowerCase(),
			pre_install: 'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-arm64.7z" "$dir"',
		},
	});
	expect(result.post_install).toBe('Remove-Item "$dir\\`$PLUGINSDIR", "$dir\\`$R0" -Force -Recurse');
	expect(result.shortcuts).toEqual([["visual-omp.exe", "visual-omp"]]);
});

it("replaces the existing flat bucket shape only when publishing its next stable release", async () => {
	const current = JSON.parse(await readFile(resolve("bucket/visual-omp.json"), "utf8"));
	const root = await fixture(current);
	generate(root, "999.0.0", x64Sha, arm64Sha);
	const result = await manifest(root);
	expect(Object.keys(result.architecture)).toEqual(["64bit", "arm64"]);
	expect(result.url).toBeUndefined();
	expect(result.architecture["64bit"].url).toContain("win-x64.exe#/dl.7z");
	expect(result.architecture.arm64.url).toContain("win-arm64.exe#/dl.7z");
});

it("keeps a newer bucket version unchanged", async () => {
	const existing = { version: "0.8.0", architecture: { arm64: { hash: "existing" } } };
	const root = await fixture(existing);
	generate(root, "0.7.8", x64Sha, arm64Sha);
	expect(await manifest(root)).toEqual(existing);
});

it("skips an older tag from the x64-only release workflow before requiring an ARM64 checksum", async () => {
	const existing = { version: "0.8.0", architecture: { arm64: { hash: "existing" } } };
	const root = await fixture(existing);
	generate(root, "0.7.7", x64Sha);
	expect(await manifest(root)).toEqual(existing);
});

it("refreshes the equal-version flat x64 manifest without inventing an ARM64 asset", async () => {
	const current = {
		version: "0.7.7",
		description: "Desktop app for the omp (oh-my-pi) coding agent",
		homepage: "https://github.com/decoy-dev/visual-omp",
		license: "MIT",
		url: "https://github.com/decoy-dev/visual-omp/releases/download/v0.7.7/visual-omp-0.7.7-win-x64.exe#/dl.7z",
		hash: "c".repeat(64),
		pre_install: 'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-64.7z" "$dir"',
		post_install: 'Remove-Item "$dir\\`$PLUGINSDIR", "$dir\\`$R0" -Force -Recurse',
		shortcuts: [["visual-omp.exe", "visual-omp"]],
	};
	const root = await fixture(current);
	generate(root, current.version, x64Sha);
	expect(await manifest(root)).toEqual({ ...current, hash: x64Sha.toLowerCase() });
});

it("requires both hashes to refresh an architecture-shaped manifest at the same version", async () => {
	const existing = { version: "0.7.8", architecture: { "64bit": { hash: "existing" }, arm64: { hash: "existing" } } };
	const root = await fixture(existing);
	expect(() => generate(root, "0.7.8", x64Sha)).toThrow();
	expect(await manifest(root)).toEqual(existing);
});

it.each([
	["0.7.8", x64Sha],
	["0.7.8", "invalid", arm64Sha],
	["0.7.8", x64Sha, "invalid"],
	["../0.7.8", x64Sha, arm64Sha],
])("rejects missing or invalid release inputs: %s", async (...args) => {
	const root = await fixture();
	expect(() => generate(root, ...args)).toThrow();
	await expect(readFile(join(root, "bucket/visual-omp.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("packages separate NSIS downloads for both architectures and publishes both checksums", async () => {
	const config = parse(await readFile(resolve("electron-builder.yml"), "utf8"));
	expect(config.win.target).toEqual([{ target: "nsis", arch: ["x64", "arm64"] }]);
	expect(config.nsis.buildUniversalInstaller).toBe(false);
	expect(config.nsis.artifactName).toBe("visual-omp-${version}-win-${arch}.${ext}");
	const workflow = await readFile(resolve(".github/workflows/release.yml"), "utf8");
	expect(workflow).toContain('release-assets/visual-omp-${version}-win-arm64.exe');
	expect(workflow).toContain('node scripts/update-scoop-manifest.mjs "$version" "$win_x64_sha" "$win_arm64_sha"');
	const pkg = JSON.parse(await readFile(resolve("package.json"), "utf8"));
	expect(pkg.scripts["dist:win"]).toContain("--win nsis --x64 --arm64 --publish never");
});
