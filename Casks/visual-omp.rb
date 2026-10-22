cask "visual-omp" do
  version "0.6.2"
  sha256 "b00d47a59e2ebead984dd8de8c5c0404b0ea624632af4536f7007638f3e1c8dd"

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
    sha256 "675921aaf753b6e018c0d3d288273534c25072a49b60fdd5458bdaf4746fa43d"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
