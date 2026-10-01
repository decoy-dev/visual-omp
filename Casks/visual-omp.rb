cask "visual-omp" do
  version "0.2.1"
  sha256 "312b7d8ddb90b0dac8c06776197bb449b09cacb38c88b609ac7fa81a538af0b1"

  url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-arm64.dmg"
  name "visual-omp"
  desc "Desktop app for the omp (oh-my-pi) coding agent"
  homepage "https://github.com/decoy-dev/visual-omp"

  depends_on macos: ">= :monterey"

  app "visual-omp.app"

  on_intel do
    sha256 "9401e954c0278f01cad7fd4b9d67000672e4a7ca68e3f781616f7202b73aa2be"
    url "https://github.com/decoy-dev/visual-omp/releases/download/v#{version}/visual-omp-#{version}-mac-x64.dmg"
  end
end
