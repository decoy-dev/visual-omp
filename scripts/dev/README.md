# Development scripts

## Release tour

Before tagging a release, the owner tests a development build with ready-made chats for its changes. The integration owner runs the tour from the commit being considered for release:

```sh
npm run tour
```

The default manifest is `tours/0.7.8.mjs`. Select another release with `npm run tour -- --release X.Y.Z` after adding its manifest. Close any existing development instance first. The tour starts `npm run dev`; subagents must use the headless preparation command instead.

### Requirements

Use Node.js 22 or later, the repository's existing dependencies, omp 18.16.0 or later on PATH, Python 3 as `python3`, and ffmpeg with libx264. The current manifest does not require LibreOffice. To select a different omp executable, pass `--omp /absolute/path/to/omp` or set `OMP_FIXTURE_BINARY`. An absolute path also becomes the scratch app profile's omp preference. No dependency installation or provider sign-in is part of the tour.

### What the command prepares

The command creates a new temporary root and starts the loopback fixture provider on a free port. It runs omp in `rpc-ui` mode against `fixture/preview` to create sessions and outputs. It answers the color question during generation, gives each chat its check title through omp's `set_session_name` RPC command, parses the saved JSONL, checks expected output files, and records the nested helper transcript. It writes:

- `tour.json`, containing the release, omp version, chat paths, tools and questions.
- `tour-layout.json`, containing the app's Current chats and each chat's side panel.
- `app-profile/preferences.json`, which skips first-run setup in this disposable profile, enables live previews and disables crash reporting.

The development app reads `VOMP_TOUR_CHATS=<absolute tour-layout.json>` through `app:info`. This startup option is ignored when `app.isPackaged` is true. It requires an absolute `VOMP_DEV_PROFILE`, a matching fixture marker, and seed file, profile, chat and session paths inside the fixture root, with symlinks resolved. Main returns an allowlisted layout whose active project comes from its validated tabs; arbitrary seed fields and expanded project paths are discarded. The renderer reuses its saved-layout parser and session controllers, opens the first chat and puts every tour chat in Current chats. The normal layout then persists through the app's own localStorage. No DevTools connection is required.

The 0.7.8 tour includes video playback and render progress, DOCX and XLSX revision checks, HTML Watch and Files previews, hex swatches and a hex-option question, a task helper, grouped image sequences, a supervised process-exit replay check, and a settings and commands checklist in a folder with spaces. Each chat's first message explains what to check, including first-use transcript and helper loading. DOCX and XLSX record a truncated-save run, then restore a complete file for startup. To check retention across a truncated save and subject reselection, keep Outputs open, send `fixture docx` or `fixture xlsx` again, select another output or chat and return. Headless preparation cannot establish the result of that rendering check. The commands chat explains the LibreOffice prerequisite and the two-slide and truncated-save checks for PPTX.

Questions and helpers cannot remain interactive across a generator process exit. Send `fixture colors` or `fixture helper` again in the app to inspect the question or open a live helper conversation from Tasks. Send `fixture video`, `fixture html` or `fixture sequence` again for their live updates. The provider remains available until the development build exits. Quit the development app when finished; the runner closes its server and keeps the scratch files for inspection.

The process-exit chat uses `fixture process` to start a named Python process which becomes ready and exits with code 1. A second command keeps omp running long enough to record that exit. Restart omp in the saved chat and send `fixture notes`: the historical exit row should remain, without a repeated new failure notice below the chat.

### Prepare without Electron

```sh
npm run tour -- --prepare-only
```

Preparation exits after saving and checking the tour. It prints the exact command to restart its local provider and open that prepared profile:

```sh
npm run tour -- --resume /absolute/path/to/printed-tour-root
```

Resume uses the original provider port and retains the scratch configuration and app preferences. If that port is occupied, stop its earlier tour first. Resume restores the manifest's initial Current chats and side panels; changes made while reviewing remain in their session files. It does not regenerate output files. To regenerate, run the command without `--resume` for a fresh root.

### Isolation and acceptance

The tour uses `live-preview-fixture/environment.mjs` for a separate HOME, omp agent directory, XDG folders, temporary folder and visual-omp development profile. It does not copy the owner's `~/.omp`, credentials, rules, skills or extensions. The initial generators explicitly disable context files and extensions. The scratch models file points to the local provider and sets every configured model role to `fixture/preview`. Fixture replies and their helper replies use no paid model service. Files produced by tools remain under the tour's chat folders.

The command checks its generation inputs and outputs. The owner still checks rendering and interactions before approving the release. The settings chat names checks that need a phone, stored OAuth accounts, a model-backed Auto choice, Windows, packaged builds or a measurement. The tour does not simulate those acceptance results. Phone sharing is started only by the owner and can use the network.

Keep the printed root while reviewing evidence. After the development app and provider have stopped, remove only that disposable directory when it is no longer needed. Nothing in the tour deletes or modifies the installed visual-omp app or the owner's ordinary profile.

### Tests

Run the tour and fixture unit tests without Electron:

```sh
node --test scripts/dev/release-tour.test.mjs scripts/live-preview-fixture/server.test.mjs scripts/live-preview-fixture/office.test.mjs
npx vitest run src/main/services/release-tour.test.ts
```

These tests cover manifest and argument handling, layout construction, session validation, development-only startup boundaries and fixture calls. Use headless preparation as the integration check against the installed omp binary. UI acceptance belongs to the owner.
