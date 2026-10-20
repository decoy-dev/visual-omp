cask "visual-omp" do
  version "0.5.7"
  sha256 "005e6f9b0c4cb9ab537cb5af5fd60693d04b51d8c77326ef846a169ce2b4572f"

  url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-arm64.dmg"
  name "visual-omp"
  desc "Desktop app for the omp (oh-my-pi) coding agent"
  homepage "https://github.com/decoy-dev/visual-omp"

  depends_on macos: :monterey

  app "visual-omp.app"

  # visual-omp is ad-hoc signed without notarization, and macOS can reject a quarantined copy as
  # damaged with no way to approve it. Clearing the quarantine attribute lets the installed app open.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/visual-omp.app"]
  end

  on_intel do
    sha256 "01653797e22e89fa000cb75f1c4b1f0a0ff1a931c63bd7546a90237dac351c5e"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
