cask "visual-omp" do
  version "0.6.8"
  sha256 "e56d8df994c26f2ef992d81582736af303c8faad5fe47f3a9b629564a5cc73c9"

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
    sha256 "6d7e5c170c00c6f96b9ba7fad2c7121b885935de18c866ba637202d5f7712fae"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
