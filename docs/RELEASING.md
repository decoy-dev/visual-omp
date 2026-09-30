# Releasing visual-omp

Changes are committed to `main` as conventional commits (`feat`, `fix`, `chore`, `docs`, `build`, `ci`, `refactor`, `style`, `test`), and a push to `main` only runs CI: typecheck, tests and an installer build on macOS and Windows, with nothing published. A release happens only when someone pushes a version tag, so choosing when to publish is a separate decision from merging the work.

## Cutting a release

1. Move the entries under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) into a new `## [X.Y.Z] - YYYY-MM-DD` section, and leave an empty `## [Unreleased]` heading above it. That section becomes the GitHub release notes word for word, so write it for the people installing the update.
2. Set the version without creating a tag: `npm version X.Y.Z --no-git-tag-version`.
3. Commit `CHANGELOG.md`, `package.json` and `package-lock.json` as `chore(release): vX.Y.Z` and push `main`.
4. Tag that commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

The tag starts [.github/workflows/release.yml](../.github/workflows/release.yml). It stops before building anything if the tag does not match `package.json` or if CHANGELOG.md has no section for the version, and it takes the release notes from the tagged commit, so later changes to `main` cannot alter them. After typecheck and tests pass, it builds the macOS disk images (Apple Silicon and Intel) and the Windows installer and publishes them as a GitHub release with the CHANGELOG section as the notes. For a stable version it also commits the updated Homebrew cask (`Casks/visual-omp.rb`) to `main`. A version with a semver prerelease part (`1.2.0-beta.1`, `1.2.0-rc.2`) is published as a GitHub prerelease and leaves the cask alone, so `brew upgrade` never installs it, and the in-app check only offers it to copies that are already running a prerelease.

## How the update reaches users

Installed copies of visual-omp check GitHub for the newest release shortly after launch and every six hours after that, and **Check for updates…** (the app menu on macOS, the Help menu on Windows) checks immediately. When a newer version is published, the app shows a notice with the first sentence of the release notes, and **Settings → About** offers the update. Homebrew is used only when the running app is the copy the cask installed: the app then runs `brew update` and `brew upgrade --cask visual-omp` in a terminal inside the app, confirms that the installed copy has a newer version, and restarts into it. Other macOS installs download the new disk image to Downloads and open it for the drag to Applications. On Windows the app downloads the installer to Downloads, runs it and quits so it can replace the app. Packaged builds download installers only from the release's own `github.com/decoy-dev/visual-omp/releases/download/…` link and GitHub's download servers. Releases publish no checksums, so the app does not verify the file beyond that. The first launch after an in-app update reports whether the new version started. Homebrew users can also upgrade from a terminal with `brew upgrade --cask visual-omp`.

omp updates separately from visual-omp. The app runs `omp update --check` on the same schedule and offers to run `omp update`, and because each open chat keeps the omp version it started with, it then offers to restart those chats.

## Testing the update flow

No release has to exist to exercise these screens. Development builds (`npm run dev`, never a packaged app) read releases from the JSON file named by `VOMP_UPDATE_FEED` instead of GitHub. The file holds `releases` in the GitHub API shape, and optional fields simulate the rest: `method` (`brew`, `dmg`, `nsis` or `manual`), `brewCommand` (a harmless command runs by default), `installedVersion` (what the Homebrew check reads from the app on disk), `ompCheck` (`{ code, stdout, stderr }` in place of `omp update --check`), `ompUpdateCommand` (runs in place of `omp update`) and `ompVersionAfter`. Asset URLs may use plain http so a local server can stand in for GitHub. Set `VOMP_DEV_PROFILE` to a directory name to run this instance beside another development instance.
