import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { offersNewer } from "./stable-channel.mjs";

const [version, x64Sha, arm64Sha] = process.argv.slice(2);
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Expected a safe release version");

const bucket = "bucket/visual-omp.json";
if (await offersNewer(bucket, version, (text) => JSON.parse(text).version)) process.exit(0);
const current = await readFile(bucket, "utf8").then(JSON.parse).catch(error => {
	if (error.code === "ENOENT") return null;
	throw error;
});
// The current x64-only release can be republished before any ARM64 asset exists.
const retainFlat = arm64Sha === undefined && current?.version === version &&
	current.architecture === undefined && typeof current.url === "string";
for (const [arch, sha] of retainFlat ? [["x64", x64Sha]] : [["x64", x64Sha], ["arm64", arm64Sha]]) {
	if (!sha || !/^[a-f0-9]{64}$/i.test(sha)) throw new Error(`Expected a SHA-256 checksum for the Windows ${arch} installer`);
}

// Scoop does not run the NSIS installer, so no setup wizard appears. 7-Zip opens the installer as
// an archive (`#/dl.7z`), then extracts the architecture's app archive inside it. Installer files
// are removed afterwards. Each update unpacks into a new version folder that `current` points to.
const x64 = {
	url: `https://github.com/decoy-dev/visual-omp/releases/download/v${version}/visual-omp-${version}-win-x64.exe#/dl.7z`,
	hash: x64Sha.toLowerCase(),
	pre_install: 'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-64.7z" "$dir"',
};
const manifest = {
	version,
	description: "Desktop app for the omp (oh-my-pi) coding agent",
	homepage: "https://github.com/decoy-dev/visual-omp",
	license: "MIT",
	...(retainFlat ? x64 : { architecture: {
		"64bit": x64,
		arm64: {
			url: `https://github.com/decoy-dev/visual-omp/releases/download/v${version}/visual-omp-${version}-win-arm64.exe#/dl.7z`,
			hash: arm64Sha.toLowerCase(),
			pre_install: 'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-arm64.7z" "$dir"',
		},
	} }),
	post_install: 'Remove-Item "$dir\\`$PLUGINSDIR", "$dir\\`$R0" -Force -Recurse',
	shortcuts: [["visual-omp.exe", "visual-omp"]],
};

const output = join(process.cwd(), bucket);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
