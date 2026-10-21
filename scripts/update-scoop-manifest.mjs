import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [version, sha] = process.argv.slice(2);
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Expected a safe release version");
if (!sha || !/^[a-f0-9]{64}$/i.test(sha)) throw new Error("Expected a SHA-256 checksum for the Windows installer");

// Scoop does not run the NSIS installer, so no setup wizard appears. 7-Zip opens the installer as
// an archive (`#/dl.7z`), the app itself is the app-64.7z inside it, and the installer's own files
// are removed afterwards. Each update unpacks into a new version folder that `current` points to.
const manifest = {
	version,
	description: "Desktop app for the omp (oh-my-pi) coding agent",
	homepage: "https://github.com/decoy-dev/visual-omp",
	license: "MIT",
	url: `https://github.com/decoy-dev/visual-omp/releases/download/v${version}/visual-omp-${version}-win-x64.exe#/dl.7z`,
	hash: sha.toLowerCase(),
	pre_install: 'Expand-7zipArchive "$dir\\`$PLUGINSDIR\\app-64.7z" "$dir"',
	post_install: 'Remove-Item "$dir\\`$PLUGINSDIR", "$dir\\`$R0" -Force -Recurse',
	shortcuts: [["visual-omp.exe", "visual-omp"]],
};

const output = join(process.cwd(), "bucket", "visual-omp.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 4)}\n`, "utf8");
