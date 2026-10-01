cask "visual-omp" do
  version "0.3.1"
  sha256 "1eb4bb7a2aad07659d0c603a5da7bd5b31fc80aaf69d572af75a5d0e6469509a"

  url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-arm64.dmg"
  name "visual-omp"
  desc "Desktop app for the omp (oh-my-pi) coding agent"
  homepage "https://github.com/decoy-dev/visual-omp"

  depends_on macos: ">= :monterey"

  app "visual-omp.app"

  on_intel do
    sha256 "b4f0ba50c15fc60f687414babeca54462817ed520b3b4079246955ae44980ccb"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
