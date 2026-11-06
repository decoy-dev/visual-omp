# Development scripts

## Release tour

Before tagging a release, the owner tests a development build with ready-made chats for its changes. The integration owner runs the tour from the commit being considered for release:

```sh
npm run tour
```

The default manifest is `tours/0.7.9.mjs`. Select another release with `npm run tour -- --release X.Y.Z` after adding its manifest. Close any existing development instance first. The tour starts `npm run dev`; subagents must use the headless preparation command instead.

### Requirements

Use Node.js 22 or later, the repository's existing dependencies, omp 18.17.0 or later on PATH, Python 3 as `python3`, and ffmpeg with libx264. LibreOffice is needed for the Office-conversion Quit check; without it, that chat explains the missing prerequisite. To select a different omp executable, pass `--omp /absolute/path/to/omp` or set `OMP_FIXTURE_BINARY`. An absolute path also becomes the scratch app profile's omp preference. No dependency installation or provider sign-in is part of the tour.

### What the command prepares

The command creates a new temporary root and starts the loopback fixture provider on a free port. It runs omp in `rpc-ui` mode against local fixture models to create sessions and outputs. It answers the color question during generation, gives each chat its check title through omp's `set_session_name` RPC command, parses the saved JSONL, checks expected output files, and records the nested helper transcript. Recorded tool-card examples are appended after their generator exits and checked for matching calls, results and details. It writes:

- `tour.json`, containing the release, omp version, chat paths, tools and questions.
- `tour-layout.json`, containing the app's Current chats and each chat's side panel.
- `app-profile/preferences.json`, which skips first-run setup in this disposable profile, enables live previews and disables crash reporting.

The development app reads `VOMP_TOUR_CHATS=<absolute tour-layout.json>` through `app:info`. This startup option is ignored when `app.isPackaged` is true. It requires an absolute `VOMP_DEV_PROFILE`, a matching fixture marker, and seed file, profile, chat and session paths inside the fixture root, with symlinks resolved. Main returns an allowlisted layout whose active project comes from its validated tabs; arbitrary seed fields and expanded project paths are discarded. The renderer reuses its saved-layout parser and session controllers, opens the first chat and puts every tour chat in Current chats. The normal layout then persists through the app's own localStorage. No DevTools connection is required.

The 0.7.9 tour opens 16 chats. Each first message names its checks:

| Chat | Checks |
| --- | --- |
| 01 Video | Two renders replace `out.mp4`; live frames advance during a render. Every second render flips the test pattern horizontally so replacement is visible. Compare video, the tall poster, the frame sequence and Word in short and tall Outputs panes. Compact previews end after their content, with saved outputs directly below; saved image and PDF viewers replace the stage and return with Back or Escape. |
| 02 Word | Page proportions, margins, pane resizing and complete-preview retention during truncated saves. |
| 03 Spreadsheet | The workbook fills its pane and keeps sheet tabs visible while the large grid scrolls. |
| 04 HTML | Fit width, 100%, Phone, Pause following and Show latest, plus Files preview isolation. |
| 05 Helper | The main transcript stays pinned as the helper card changes; scrolling up stops following. The helper reply streams over 15 seconds. Tasks offers one conversation button per helper row, with messaging inside that view and a separate Stop action while running. Before a messageable helper's file exists, its conversation says "No conversation yet. You can still send a message." |
| 06 Composer | Compact settings, Suggestions, `/unpin`, `^fixture/reasoner:` effort completion and keyword highlights, tooltips and disabling. |
| 07 Prompt cache | Enable the status item, send `fixture cache` twice, inspect a hit, then wait fifteen seconds for an expired miss with resend size. |
| 08 Tool cards | Recorded omp 18.17 LSP source context, diagnostic counts and server failures, plus failed search providers. |
| 09 Bash | Large saved output recovery, artifact instructions and the Load saved output fallback. |
| 10 Settings | Manual-only skill patterns, omp automatic updates, What's new in omp, an installed-update notice and a safe installer-contention retry. |
| 11 Office Quit | Cancel and confirm Quit during PPTX conversion. Run this last; confirming Quit ends the tour. |
| 12-15 Retained checks | Hex swatches and questions, image sequences, saved process exits and the previous command checklist. |
| 16 Timestamps | Three 45-second bash calls give a collapsed tool group a first-to-latest time range, full times on hover or focus and each call's own time when expanded. |

DOCX and XLSX record a truncated-save run, then restore a complete file for startup. To check retention, keep Outputs open, send `fixture docx` or `fixture xlsx` again, select another output or chat and return. Headless preparation cannot establish rendering acceptance.

The video chat also creates `frames.png` and a dependency-free `sample.pdf` for saved-viewer checks. Select `frames.png` from the live stage's chips to inspect compact sizing, then open it from the saved output tiles to replace the stage. Back returns to its tile. Open the PDF tile and use Escape to return. The helper's pre-file state can be brief; the tour describes checking it when the conversation opens before omp supplies its file, and does not claim preparation establishes that timing.

The tour's scratch models include `fixture/reasoner` with low, medium, high and max efforts, and `fixture/cache` with a twelve-second cache lifetime. Cache warming is off. The loopback provider reports deterministic usage with 10,000 cache-read tokens on the second send. The running omp process owns the prediction and expiry timer; repeat the sends in the app because preparation exits its generators.

The tool-card chat identifies its examples as recorded. Their text and details follow omp 18.17's `lsp/tool.ts` and `web/search/index.ts` formats and the renderer's LSP and search tests. Preparation validates the appended JSONL and its call/result pairs. It starts no language server and makes no web request. Local source files are not generated for these illustrative targets.

Two fixture skills are created only under the scratch agent directory. `tour-manual-*` initially hides `tour-manual-review` from the model catalog. The settings chat asks you to add and remove `tour-catalog-*` for the other skill. Generators disable skills; restarted app chats use the scratch catalog.

The disposable app preferences seed a previous observed omp version of 18.16.0. Startup with the required 18.17 or later uses the normal installed-version notice path. This does not replace omp.

The runner sets the development-only `VOMP_UPDATE_FEED` to the scratch `update-feed.json`, including simulated `ompCheck` output and an `ompUpdateCommand` that invokes only `simulate-omp-update.mjs` in that root. App release checks return an empty release list. The script writes a local marker and updates its own feed; it never invokes omp, an installer or a network command.

To check installer contention on macOS or Linux:

1. In Settings > About, choose Check for updates, then Update omp. The feed reports a simulated next patch version.
2. The first attempt prints `Another omp update is already running; try again once it finishes.` and exits with code 1. Confirm the dialog explains another installer is running and offers Try again without reporting success.
3. Choose Try again. The script succeeds, the busy explanation clears and the engine's installed version stays unchanged. The following simulated check reports it is up to date.

Resume preserves the marker and feed so it does not repeat the refusal after success. A fresh preparation resets the two-attempt check. The current development hook invokes `/bin/sh`, so this simulation is a macOS/Linux check. Automatic installation and notices after replacing a running engine still need separate checks.

Multiple stored OAuth accounts, model-backed Auto effort selection, phone sharing, Windows conversion cleanup, packaged installers and performance measurements still require their own checks. The account-name check is explicit in the composer chat. The Office chat requires LibreOffice and asks you to repeat if conversion finishes too quickly; macOS Quit and Cancel do not establish the Windows working-folder result.

### Extending this tour

Keep new checks with their existing area in `tours/0.7.9.mjs`: Outputs stage-height checks go in video, Word, spreadsheet and HTML; transcript timestamp checks go in timestamps; rendering-speed comparisons go in the retained commands chat with a separate measured result; bash visualization goes in bash-trace. Add a separate chat only for a separate area. Release-only models, skills, configuration and app preferences are declared at the top of the manifest. `tour-fixtures.mjs` prepares those additions and records offline tool results; it does not change the ordinary fixture profile. The timestamp chat has a three-minute generation timeout for its two-minute-fifteen-second local run.

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
node --test scripts/dev/*.test.mjs scripts/live-preview-fixture/*.test.mjs
npx vitest run src/main/services/release-tour.test.ts
```

These tests cover manifest and argument handling, layout construction, session validation, development-only startup boundaries and fixture calls. Use headless preparation as the integration check against the installed omp binary. UI acceptance belongs to the owner.
