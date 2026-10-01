cask "visual-omp" do
  version "0.3.0"
  sha256 "c9b717906e0fc5f29d6d9467489184f8d1da0d43f1a51cf2087f57f6025823a2"

  url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-arm64.dmg"
  name "visual-omp"
  desc "Desktop app for the omp (oh-my-pi) coding agent"
  homepage "https://github.com/decoy-dev/visual-omp"

  depends_on macos: ">= :monterey"

  app "visual-omp.app"

  on_intel do
    sha256 "c5835150b532ca83d16954ac29c61c1ee7777b4fbb91f279fe4372f31a4b3de8"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
