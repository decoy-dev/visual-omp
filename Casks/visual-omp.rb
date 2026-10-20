cask "visual-omp" do
  version "0.5.8"
  sha256 "02b696ca103eaac2ec7826fe69b2b9f19b9a46444a356e22d002737409af68c3"

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
    sha256 "170a0d4d5948c300f15fb33b7f36c701593052302c70cfd9025d5c41943e3c02"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
