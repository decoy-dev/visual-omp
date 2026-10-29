import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { GitHubRelease, toAssets, verifyInstallerDigest } from "./updates";

const hash = createHash("sha256").update("installer bytes").digest("hex");

it("retains the GitHub SHA256 digest in the selected release metadata", () => {
	const release = GitHubRelease.parse({
		tag_name: "v1.0.0", html_url: "https://github.com/decoy-dev/visual-omp/releases/tag/v1.0.0", draft: false, prerelease: false,
		assets: [{ name: "installer.dmg", browser_download_url: "https://example.com/installer.dmg", size: 15, digest: `sha256:${hash}` }],
	});
	expect(toAssets(release)[0]?.digest).toBe(`sha256:${hash}`);
});

it("accepts a matching SHA256 digest and assets without published digests", () => {
	expect(() => verifyInstallerDigest(hash, `sha256:${hash}`)).not.toThrow();
	expect(() => verifyInstallerDigest(hash, `sha256:${hash.toUpperCase()}`)).not.toThrow();
	expect(() => verifyInstallerDigest(hash, null)).not.toThrow();
	expect(() => verifyInstallerDigest(hash, undefined)).not.toThrow();
});

it("rejects mismatches and malformed or unsupported supplied digests", () => {
	expect(() => verifyInstallerDigest(hash, `sha256:${"0".repeat(64)}`)).toThrow("did not match");
	expect(() => verifyInstallerDigest(hash, "sha256:1234")).toThrow("unsupported");
	expect(() => verifyInstallerDigest(hash, `md5:${hash}`)).toThrow("unsupported");
	expect(() => verifyInstallerDigest(hash, "")).toThrow("unsupported");
});
