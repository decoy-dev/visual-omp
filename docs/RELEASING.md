# Releasing visual-omp

Changes are committed to `main` as conventional commits (`feat`, `fix`, `chore`, `docs`, `build`, `ci`, `refactor`, `style`, `test`). A push to `main` runs CI (typecheck, tests and an installer build on macOS and Windows) without publishing application installers. This repository also serves the Homebrew tap and the Scoop bucket, so a push that changes `Casks/visual-omp.rb` or `bucket/visual-omp.json` becomes available to Homebrew users through `brew update` and to Scoop users through `scoop update`, including a change for a version that is already released. New installers are published only when someone pushes a version tag, and the owner approves pushes and releases separately.

## Cutting a release

1. Move the entries under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md) into a new `## [X.Y.Z] - YYYY-MM-DD` section, and leave an empty `## [Unreleased]` heading above it. That section becomes the GitHub release notes word for word, so write it for the people installing the update.
2. Set the version without creating a tag: `npm version X.Y.Z --no-git-tag-version`.
3. Commit `CHANGELOG.md`, `package.json` and `package-lock.json` as `chore(release): vX.Y.Z`. Do not push or tag yet.
4. Give the owner a development build of that release commit: with a clean working tree, start `npm run dev`, which uses its own profile and runs beside an installed copy, and leave it open. Continue only after the owner has tried it and asked for the release. If the release commit changes, restart the development build on the new commit and obtain the owner's approval again.
5. Push `main`, then tag the exact commit the owner tested and push the tag: `git tag vX.Y.Z <tested-commit-sha> && git push origin vX.Y.Z`.

The tag starts [.github/workflows/release.yml](../.github/workflows/release.yml). It stops before building anything if the tag does not match `package.json` or if CHANGELOG.md has no section for the version, and it takes the release notes from the tagged commit, so later changes to `main` cannot alter them. After typecheck and tests pass, it builds the macOS disk images (Apple Silicon and Intel) and the Windows installer and publishes them as a GitHub release with the CHANGELOG section as the notes. For a stable version it also commits the updated Homebrew cask (`Casks/visual-omp.rb`) and Scoop manifest (`bucket/visual-omp.json`) to `main`, each with the SHA-256 checksum of its installer. A file that already offers a newer version is left as it is, with a notice in the run's summary, so a stable tag published after a newer one (a fix on an older line, or a re-run of an old release) still gets its GitHub release but never moves Homebrew or Scoop users back to it. The same version is written again so the cask and manifest use the checksums of the newly published installers. Such a tag also leaves the Latest label on the releases page where it is, because a stable release is marked Latest only when no published stable release is newer (`scripts/make-latest.mjs`). GitHub reads the workflow from the tagged commit, so the Latest rule covers only tags whose commit includes it; the publish job runs the cask and manifest scripts from `main`, so their check also applies when an older release is re-run. A version with a semver prerelease part (`1.2.0-beta.1`, `1.2.0-rc.2`) is published as a GitHub prerelease and leaves the cask and the Scoop manifest alone, so `brew upgrade` and `scoop update` never install it, and the in-app check only offers it to copies that are already running a prerelease.

The Scoop manifest does not run the NSIS installer. Scoop opens the installer with 7-Zip, unpacks the app archive inside it (`$PLUGINSDIR\app-64.7z`) and removes the installer's own files, so the Windows build feeds both install methods. A change to the NSIS packaging that renames or moves that archive also needs a change to `scripts/update-scoop-manifest.mjs`.

## Release workflow security

The release workflow denies token permissions by default. Its verification, macOS and Windows jobs each receive `contents: read`; only the publish job receives `contents: write`. All checkouts use `persist-credentials: false`, so later commands cannot reuse checkout authentication from Git configuration. The stable-channel manifest push supplies a masked HTTP authorization header through environment-only Git configuration for that command, without storing the token in the checkout. Release API calls receive the publish job's token explicitly.

All actions in the release workflow are pinned to full commit SHAs, with version comments identifying the upstream releases. When updating an action, verify its release tag against the upstream repository and update both the SHA and comment.

`npm ci` retains dependency install scripts because Electron downloads its runtime and node-pty installs or builds its native addon through those scripts. Using `--ignore-scripts` would break those prerequisites. The catch is that dependency scripts execute code on the runner, so the lockfile and dependency changes remain part of the release trust boundary. Installation, verification and the electron-vite application build run without the signing secrets. The packaging process still uses the imported signing keychain and rebuilds native dependencies, so its dependencies and signing hook must also be trusted.

## Release-notes format

Start each version section with a one-line overview of the update's value. Follow it with `### Highlights` and short bullets grouped by bold category names, such as `New`, `Improved` and `Fixed`. Use only categories that apply. Follow those highlights with `### Detailed changes` and the complete entries under fourth-level category headings. Write complete sentences, including in bullets, and keep technical detail in the detailed entries.

Use this exact hierarchy. The version heading identifies the CHANGELOG section and is omitted from the GitHub release body. Everything below it, including the overview, highlights and detailed headings, is preserved by `scripts/release-notes.mjs`. The release workflow uploads that output as `release-notes.md` and publishes the downloaded artifact at `release-notes/release-notes.md`.

```markdown
## [0.8.0] - 2026-11-01

This update lets you review release notes before installing a new version.

### Highlights

- **New:** Read the available update's changes inside visual-omp.
- **Improved:** Browse earlier releases from Settings → About.
- **Fixed:** Previously fetched notes remain readable when GitHub is unavailable.

### Detailed changes

#### New

- The update notice opens a release-notes window with an explicit update action.

#### Improved

- Settings → About provides a version selector for the installed version and earlier releases.

#### Fixed

- The bundled changelog supplies installed and older release notes when a GitHub body is unavailable.
```

Use headings for the detailed part. GitHub supports `<details>` disclosures, but the app deliberately escapes raw HTML in release Markdown, so `<details>` would appear as text and could hide Markdown structure inside the HTML block. Headings render consistently on GitHub and in the app, remain searchable and work without an HTML allowlist. Do not put raw HTML, images or essential information behind a disclosure in release notes.

The update check fetches all GitHub release pages, 30 entries at a time. GitHub's ordering does not follow semantic versions, so encountering an older maintenance release cannot safely end the check. This can require additional requests during an update check; opening cached notes makes no network request. The fetched published bodies are saved with the update-check result for offline use; a failed later page keeps the previous complete result rather than presenting a partial update history. **Review update** opens notes for published versions newer than the installed version through the offered update. **Past versions** lists the installed version and earlier releases, using the bundled CHANGELOG sections where GitHub notes are missing. Unreleased entries and bundled sections newer than the installed version are excluded. Stable installations exclude prerelease notes. Release links use the app's external-link handler, Markdown images are displayed as alternative text without loading the image, and tables use the app's horizontally scrolling table frame.

## macOS signing certificate

macOS keeps the permissions a person grants an app, such as App Management (which the in-app Homebrew update needs), against the app's code signature. An ad hoc signature names a hash of that one build, so every update looked like a new app and the permissions reset. Releases are therefore signed with the project's own self-signed code signing certificate, "visual-omp code signing" (SHA-1 `078ca0c88536695e0c46e2b61b43f565783af802`, valid until 2046). Each release then carries the same designated requirement, `identifier "ltd.decoy.visualomp" and certificate root = H"078ca0c8…"`, which is meant to let macOS treat it as the same app and keep its permissions; this has not yet been confirmed through an installed update. The certificate is not issued by Apple and the app is not notarized, so Gatekeeper still rejects a quarantined copy. The Homebrew cask still clears the quarantine attribute. Whether a downloaded disk image signed with the certificate offers **Open Anyway** has not been checked.

- **Certificate storage:** the `MAC_SIGNING_P12` repository secret holds the base64 PKCS #12 file and `MAC_SIGNING_P12_PASSWORD` its password. Only the macOS packaging and signing step receives them, after `npm ci` and the separate `npm run build` step have finished. It imports the decoded file into a temporary keychain, unsets both secret variables, removes the PKCS #12 file and then invokes electron-builder directly, without repeating the electron-vite build. The keychain is added to the user search list and passed as `CSC_KEYCHAIN`. When the step ends, including on failure, it restores the original search list and deletes the keychain and temporary files. Before packaging, the step stops unless `security find-identity` lists the certificate's SHA-1 in that keychain. `VOMP_MAC_IDENTITY` holds the certificate's SHA-1, which codesign accepts in place of its name. electron-builder's own `CSC_LINK` import is not used. The step stops if either secret is missing and checks that each signed app names the certificate above, so a release is never ad hoc signed by accident. The owner keeps a backup of the file and its password.
- **How it is applied:** `electron-builder.yml` keeps `mac.identity: "-"`, because electron-builder only selects identities that macOS trusts. Its `mac.sign` hook, `scripts/sign-mac.mjs`, signs with the certificate when `VOMP_MAC_IDENTITY` is set and ad hoc otherwise, so local and CI builds work without it.
- **Keep it unchanged:** a release signed with another certificate, or ad hoc, would get a new designated requirement and reset the permissions for everyone who updates to it. Replacing the certificate also means updating `VOMP_MAC_IDENTITY` and `VOMP_MAC_CERT_SHA1` in the release workflow.
- **Local check:** on the owner's Mac (macOS 27.2), `CSC_KEYCHAIN=<keychain> VOMP_MAC_IDENTITY=078ca0c88536695e0c46e2b61b43f565783af802 npx electron-builder --mac dir --arm64 --publish never` signed with the certificate even with the keychain off the search list, and `codesign -dr -` showed the certificate root. The first v0.6.7 run on GitHub's macOS 26 runner did not find the identity that way, so CI adds the keychain to the search list.

## How the update reaches users

Installed copies of visual-omp check GitHub for the newest release about ten seconds after they open and every 30 minutes while they stay open, and **Check for updates…** (the app menu on macOS, the Help menu on Windows) checks immediately. A result saved by an earlier session never stands in for the check at launch; within a session, Settings → About reuses a result younger than 30 minutes. Scheduled checks run about twice an hour per running copy, fetching one request per release page, plus checks at launch and on request. GitHub's unauthenticated limit is 60 requests an hour per IP address, shared with other clients. When a newer version is published, the app shows a notice with the first sentence of the release notes, and **Settings → About** offers the update. Homebrew is used only when the running app is the copy the cask installed: the app then runs `brew update` and `brew upgrade --cask visual-omp` in a terminal inside the app, confirms that the installed copy has a newer version, and restarts into it. The upgrade runs with `HOMEBREW_NO_ASK=1`, because Homebrew 6 and later otherwise stops at a `[y/n]` question in that terminal (its plan names the cask as `decoy-dev/tap/visual-omp`), and the click that started the update is the user's confirmation. Other macOS installs download the new disk image to Downloads and open it for the drag to Applications. On Windows, a copy that Scoop installed for the current user (its folder is `<scoop>\apps\visual-omp\…` with Scoop's install record beside the executable) quits and starts a PowerShell window. Scoop refuses to update an app while it runs, so that window waits for visual-omp to exit, runs `scoop update` and `scoop update visual-omp`, and opens visual-omp again. It stays open when Scoop did not install a version newer than the one that quit, or when visual-omp could not start, so the person can read what went wrong. A copy Scoop installed for all users (`--global`, found through `SCOOP_GLOBAL`, Scoop's `global_path` setting or `%ProgramData%\scoop`) needs an administrator to update, and visual-omp never asks for administrator rights, so its update window shows `scoop update visual-omp --global` to run instead. Any other Windows copy downloads the installer to Downloads, runs it and quits so it can replace the app, and its update window suggests switching to Scoop. Packaged builds download installers only from the release's own `github.com/decoy-dev/visual-omp/releases/download/…` link and GitHub's download servers, and check each download against the SHA-256 digest GitHub publishes for the asset when one is present. Homebrew and Scoop check their downloads against the checksums in the cask and the manifest. The first launch after an in-app update reports whether the new version started. Homebrew and Scoop users can also update from a terminal with `brew upgrade --cask visual-omp` or `scoop update visual-omp`, after quitting visual-omp in Scoop's case.

omp updates separately from visual-omp. The app runs `omp update --check` on the same schedule and offers to run `omp update`, and because each open chat keeps the omp version it started with, it then offers to restart those chats.

## Testing the update flow

No release has to exist to exercise these screens. Development builds (`npm run dev`, never a packaged app) read releases from the JSON file named by `VOMP_UPDATE_FEED` instead of GitHub. The file holds `releases` in the GitHub API shape, and optional fields simulate the rest: `method` (`brew`, `dmg`, `scoop`, `nsis` or `manual`), `brewCommand` (a harmless command runs by default), `installedVersion` (what the Homebrew check reads from the app on disk), `scoopGlobal` (a Scoop install for all users), `ompCheck` (`{ code, stdout, stderr }` in place of `omp update --check`), `ompUpdateCommand` (runs in place of `omp update`) and `ompVersionAfter`. Asset URLs may use plain http so a local server can stand in for GitHub. Development builds never restart themselves, so the Scoop restart itself can only be tested with packaged builds. Set `VOMP_DEV_PROFILE` to a directory name to run this instance beside another development instance.

## Watching omp releases

[Watch omp releases](../.github/workflows/omp-watch.yml) checks npm's published `@oh-my-pi/pi-coding-agent` versions daily at 08:23 UTC. It reviews every untracked version from 18.14.0 onward, so several releases between runs receive separate checks and issues. A manual run can select a version through the workflow's `version` input. The watcher searches open and closed issues labelled `omp-release`; an issue whose title names the exact version prevents another review issue for that version. Keep the version in the title when renaming an issue.

For each unreviewed release, the watcher downloads `omp-linux-x64` from `can1357/oh-my-pi` and verifies it against that release's `SHA256SUMS.txt`. It runs `npm ci`, typecheck, the watcher regressions, the full Vitest suite and the gated live compatibility tests. Checks run independently where their prerequisites succeeded, so a typecheck failure does not prevent the compatibility test. Separate release jobs continue if another version fails. The selected version is saved before GitHub release metadata is fetched; if npm publishes first, the issue explicitly reports the missing GitHub metadata. A failed download or check is reported too.
 
The issue preserves the results and breaking, unsurfaced and diverged triage checklist. Upstream notes from `gh release view` and compatibility details are included as bounded, escaped text with mentions neutralized. Links provide the complete upstream notes and workflow artifacts. The body stays below 60,000 characters, and complete metadata and compatibility reports are retained as workflow artifacts for 30 days. The discovery queue is retained too.

The workflow has `contents: read` and `issues: write` permissions, with its actions pinned to full commit revisions. It creates the `omp-release` label if needed and opens a review issue. It never pushes commits, creates tags or publishes releases. Its token is passed only to discovery, release metadata, download and issue creation; the compatibility subprocess receives an explicit environment allowlist without credentials.

### Running the checks locally

Run the live tests with an absolute executable path:

```sh
OMP_BIN=/path/to/omp npx vitest run src/main/omp/compat.live.test.ts
```

Without `OMP_BIN`, those tests are skipped. Each run creates a temporary home and agent directory, disables extensions and skills for RPC, and removes its temporary profile afterwards. No sign-in or model request is sent. RPC needs a selected model to initialize without credentials, so the test selects a bundled model and sends only `get_available_commands`. The tests check the minimum version, settings and model output through the app's parsers, the app's RPC transport and protocol-1 readiness, and added, removed or uncatalogued RPC builtins. Terminal-only commands are recorded separately because omp does not list them through RPC. An empty model catalog is valid without credentials on Linux.

`omp update --check` can read release metadata from the network but does not install an update. A recognized network failure is retained in the evidence. Unknown output fails the test. The collab protocol is read from the matching release's wire source because RPC does not expose it; this comparison does not establish a live collab handshake. Set `OMP_WIRE_SOURCE` to that source file to include the comparison locally. The scheduled workflow always provides it. Set `OMP_EXPECTED_VERSION` to verify the selected binary's release, and `OMP_COMPAT_REPORT` to save a JSON report.

The script's dry run performs discovery and verified downloads without creating labels or issues:

```sh
export OMP_WATCH_DIR=/tmp/omp-watch
node scripts/omp-watch.mjs discover --version 18.14.0 --dry-run
node scripts/omp-watch.mjs prepare --version 18.14.0 --dry-run
node scripts/omp-watch.mjs download --dry-run
OMP_BIN=/path/to/omp OMP_EXPECTED_VERSION=18.14.0 \
  OMP_WIRE_SOURCE="$OMP_WATCH_DIR/wire.ts" \
  OMP_COMPAT_REPORT="$OMP_WATCH_DIR/compat.json" \
  npx vitest run src/main/omp/compat.live.test.ts
node scripts/omp-watch.mjs report --dry-run
node --test scripts/omp-watch.test.mjs
```

Discovery, preparation and download require `gh` access to GitHub. Omitting `--version` during discovery queues every untracked npm version from 18.14.0 onward; `prepare` selects one version from that queue. More than 256 untracked versions exceed GitHub's matrix limit and stop discovery with instructions to review selected versions manually. The report preview is written to `$OMP_WATCH_DIR/issue.md`; local checks are marked as not run unless their results are supplied through `WATCH_DOWNLOAD`, `WATCH_INSTALL`, `WATCH_TYPECHECK`, `WATCH_TESTS` and `WATCH_COMPAT`. Release-note review remains necessary after passing automated checks.
