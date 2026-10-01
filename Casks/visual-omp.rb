cask "visual-omp" do
  version "0.2.0"
  sha256 "6aa1ec54180b852155c8ec7e95c4eafc4eb1d202518c45e867a0c48013a78052"

  url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-arm64.dmg"
  name "visual-omp"
  desc "Desktop app for the omp (oh-my-pi) coding agent"
  homepage "https://github.com/decoy-dev/visual-omp"

  depends_on macos: ">= :monterey"

  app "visual-omp.app"

  on_intel do
    sha256 "718dd0f6415c607af777752d2d5fcb4e235f4a333da6da9d29a69531b5148e85"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
