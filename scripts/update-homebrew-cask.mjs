import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const [version, arm64Sha, x64Sha] = process.argv.slice(2);
if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error("Expected a safe release version");
for (const [arch, sha] of [["arm64", arm64Sha], ["x64", x64Sha]]) {
	if (!sha || !/^[a-f0-9]{64}$/i.test(sha)) throw new Error(`Expected a SHA-256 checksum for ${arch}`);
}

const cask = `cask "visual-omp" do
  version "${version}"
  sha256 "${arm64Sha.toLowerCase()}"

  url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-arm64.dmg"
  name "visual-omp"
  desc "Desktop app for the omp (oh-my-pi) coding agent"
  homepage "https://github.com/decoy-dev/visual-omp"

  depends_on macos: ">= :monterey"

  app "visual-omp.app"

  # visual-omp is ad-hoc signed without notarization, and macOS can reject a quarantined copy as
  # damaged with no way to approve it. Clearing the quarantine attribute lets the installed app open.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/visual-omp.app"]
  end

  on_intel do
    sha256 "${x64Sha.toLowerCase()}"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
`;

const output = join(process.cwd(), "Casks", "visual-omp.rb");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, cask, "utf8");
