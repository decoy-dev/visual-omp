# Development scripts

## Release tour

Before tagging a release, the owner tests a development build with ready-made chats for its changes. The integration owner runs the tour from the commit being considered for release:

```sh
npm run tour
```

The default manifest is `tours/0.7.14.mjs`. Select another release with `npm run tour -- --release X.Y.Z` after adding its manifest. The 0.7.13, 0.7.12, 0.7.11 and 0.7.10 patch tours and extended 0.7.9 tour remain available with their release flags. Close any existing development instance first. The tour starts `npm run dev`; subagents must use the headless preparation command instead.

### Requirements

Use Node.js 22 or later, the repository's existing dependencies, omp 18.18.7 for the 0.7.14 tour and Python 3 as `python3`. The 0.7.13 tour needs omp 18.18.6 or later; the 0.7.12 tour needs omp 18.18.3 or later for HTML-form questions; the earlier tours need omp 18.17.0 or later. The 0.7.13 and 0.7.12 tours also require ffmpeg with libx264 for their large-video samples. The small 0.7.14, 0.7.11 and 0.7.10 tours need neither ffmpeg nor LibreOffice. The extended 0.7.9 tour requires ffmpeg with libx264, and LibreOffice is needed for its Office-conversion Quit check. No dependency installation or provider sign-in is part of the tour.

To select a separate omp installation without changing the owner's installation, pass `--omp /absolute/path/to/omp` or set `OMP_FIXTURE_BINARY`. The tour uses that executable for preparation, saves it in `tour.json` and the scratch app profile's omp preference, and prepends its directory to the isolated PATH for generators and the development app. `--resume` reuses the saved executable and PATH selection. Without an absolute executable path, PATH keeps its existing behavior. For the prepared 18.18.7 binary:

```sh
npm run tour -- --prepare-only --omp /tmp/omp-18.18.7-bin/omp
```

### What the command prepares

The command creates a new temporary root and starts the loopback fixture provider on a free port. It runs omp in `rpc-ui` mode against local fixture models to create sessions and outputs. It gives each chat its check title through omp's `set_session_name` RPC command, parses the saved JSONL and checks expected output files. When a manifest includes questions, helpers or recorded tool-card examples, it also prepares their declared fixture data. It writes:

- `tour.json`, containing the release, omp version, chat paths, tools and questions.
- `tour-layout.json`, containing the app's Current chats and each chat's side panel.
- `app-profile/preferences.json`, which skips first-run setup in this disposable profile, enables live previews and disables crash reporting.

The development app reads `VOMP_TOUR_CHATS=<absolute tour-layout.json>` through `app:info`. This startup option is ignored when `app.isPackaged` is true. It requires an absolute `VOMP_DEV_PROFILE`, a matching fixture marker, and seed file, profile, chat and session paths inside the fixture root, with symlinks resolved. Main returns an allowlisted layout whose active project comes from its validated tabs; arbitrary seed fields and expanded project paths are discarded. The renderer reuses its saved-layout parser and session controllers, opens the first chat and puts every tour chat in Current chats. The normal layout then persists through the app's own localStorage. No DevTools connection is required.

### The 0.7.14 tour

| Chat | Checks |
| --- | --- |
| 01 Switching models reports success | Switch between Second fixture, Live preview fixture and Thinking fixture several times, including immediately after Restart omp from the chat menu. Each switch changes the selected model, shows no error toast, closes the model menu and keeps the omp screen closed. |
| 02 Busy helpers stay connected on omp 18.18.7 | Send `fixture helpers` and check that the transcript and Tasks stay current and the chat stays live throughout. After the six helpers finish, send `fixture notes` and check that the chat replies and retains its transcript. |

The extra models use the local provider with no model credits. Preparation creates both saved chats; the owner starts helpers and checks interactions in the app. A backlog resync requires the app to fall behind, for example on a slow machine, so there is nothing extra to trigger by hand. The automated live test verified rejoining on omp 18.18.7 with a deliberately paused receiver and a request flood; its evidence is `~/vomp-checks/collab-backlog/live-18.18.7-count.json`. Ordinary helper activity does not establish that a resync occurred.

### The 0.7.13 tour

| Chat | Checks |
| --- | --- |
| 01 Switching models keeps the omp screen closed | Choose Second fixture, Live preview fixture and Thinking fixture from the composer's model menu, change Thinking to High, send two short messages and choose Rewind to here on the last one. The omp screen stays closed throughout. Typing /extensions opens it immediately. |
| 02 Helper conversations are clearly marked | Send `fixture helpers` and open TourWorker1's conversation from its Tasks row. Check the teal band names the helper and parent chat, the small Back button's tooltip names the parent chat, the message box says Message helper TourWorker1 and the header says Parent chat: followed by the chat title. Back returns to the chat. |
| 03 File rows and command results | The prepared `fixture bigmedia` reply shows project-relative `Large Media Files/...` file rows that open the side-panel viewer. A second `fixture link` reply contains `[View the revised card](<Client Ads/08-card.png>)` and `[notes](./notes.md)`; clicking each opens its local file in the side-panel viewer. /stats shows the dashboard address with Copy URL and no duplicate Open dashboard line. After Restart omp, Settings > Models & roles should show no unavailable-model warning while the model list loads; repeat if loading finishes too quickly to inspect. |
| 04 Finishing a form question | Send `fixture form` and answer all four questions. The last answer should close the card without a jump, and the ask row should retain the answers. |
| 05 omp questions stay in the chat card | Type /reset-question to show a synthetic saved Claude reset question with a second line of account detail and described Yes and No options. The question stays in the chat card and the omp screen stays closed. Answer Yes and check the result notice. No reset is redeemed and no account preference changes. |

The extra models use the same local provider and zero-cost configuration as `fixture/preview`. Helpers and questions cannot stay interactive across preparation, so their numbered checks ask the owner to start them in the app. Preparation establishes the saved chats and file samples; it does not establish interaction timing or rendering acceptance.

The 0.7.13 manifest writes `reset-question.ts` into the scratch agent directory's `extensions/` folder. Live chats discover it through omp's normal extension loading. Its `/reset-question` command calls `ctx.ui.select` with a multi-line question and option descriptions, then `ctx.ui.notify` with the choice. The account, reset and remaining time are synthetic. This extension makes no provider request and writes no account preference.

### The 0.7.12 tour

| Chat | Checks |
| --- | --- |
| 01 Handoff progress and documents | /handoff shows omp's Generating handoff… label with time and Stop in the working row and header, then a Handed off row that opens to the document with Copy. Stop reports Handoff cancelled. /compact ends with a Context summarized row that opens to its summary. The fixture model streams a handoff over about eight seconds, and the scratch configuration keeps almost no recent context verbatim so a short chat has something to hand off. |
| 02 Helper cards above the composer | Sending `fixture helpers` starts six local helpers. The compact row shows at most four cards with name, time and Stop, a +N overflow and See all tasks, and a brief cue on activity. |
| 03 Roll back to an earlier version | The development build poses as a Homebrew copy. The successful-update notice offers Roll back to v0.7.10+rollback-tour, Settings > About offers Roll back…, and the verified download-only path saves and reveals a 26-byte sample in the scratch profile's Downloads folder. |
| 04 Questions as forms (omp 18.18.3) | Sending `fixture form` asks a radio group, a checkbox group, a text field and a list as one HTML form. The question card asks them in turn with preselected answers and a free-text Other choice, and the ask row shows each recorded answer. `fixture colors` keeps its hex swatches. |
| 05 Large local files in Files | `fixture bigmedia` creates a 60 MB video, a 23 MB PNG padded with a valid private chunk, a 109 MB PDF and a 3.3 MB text file in the chat's `Large Media Files/` subfolder. The final reply names that directory once and lists four bare file names with spaces; click a file name in the reply to open the side-panel viewer. Files plays, shows and opens the media, which the viewer refused before this release, and shows the text file's first 2 MB with a note. |
| 06 Slash command results stay in the chat | /tools, /changelog, /jobs full, /advisor status, /stats, /clear, /ssh list and /cleanse report in the chat as result rows; report commands no longer open the omp screen. The fixture folder has no checker, so /cleanse asks in the omp screen what to detect, and cancelling leaves its No runnable checker outcome in the chat. |
| 07 Large chat: start over with a handoff | The saved chat is padded past 32 MiB with one `custom` extension-state entry (`padBytes`), which omp keeps out of the model's context. Sending a message opens the large-chat dialog; Start new chat with its handoff box checked opens a new chat that writes a handoff from the old one and sends it as a file mention with the message. |

The rollback samples come from the manifest's `updateFixture`. `{{fixtureHealth}}` in a release becomes the local provider's `/health` URL, whose fixed body matches the declared size and SHA-256, so the app's checksum verification runs without a published installer. `method` and the other optional feed fields pass into the development feed, `ompUpdate: false` reports omp as up to date, and `pendingUpdate` is written to the scratch profile's `update-pending.json` on every launch, including `--resume`, because the app consumes it when it shows the successful-update notice. The brew command in the feed only prints a refusal. A development build started with an absolute `VOMP_DEV_PROFILE`, as every tour is, keeps downloads and exports in that profile's `Downloads` folder, so the sample never reaches your own Downloads. The development build must report 0.7.12 for the notice and About checks; the release commit sets that version.

### The 0.7.11 patch tour

This earlier tour opens one chat for each change:

| Chat | Checks |
| --- | --- |
| 01 Release notes | Settings > About > Read release notes opens the bundled 0.7.11 notes with the two approved headline rows. Older 0.7.9 and 0.7.0 notes exercise category groups, including Changed. Review update opens a clearly labeled 0.7.12 sample with an Important notice, two headlines and shuffled categories that the viewer orders with icons and counts. |
| 02 File mentions | Pick, drag from Finder, Cmd-click in Files and select a palette file result. The project contains a valid ZIP, text files with spaces and a name containing double quotes. Check whole quoted chips and sent-message links. Sending `fixture mentions` with a readable sample produces a local receipt only when omp supplies its marker content. |
| 03 Tool results | The existing `fixture bash-trace` workload creates large settled results. If collab fully omits one, check the neutral mark and Result unavailable label in Verbose view, and the omission notice in Normal view. Shortened or recovered results do not establish this check. The chat names the ToolCard and Transcript regressions when no omission occurs. |

The owner must run the release build versioned 0.7.11 with the approved `## [0.7.11]` CHANGELOG section before checking its installed-version notes. Preparation does not change release files. The sample feed contains only an unpublished 0.7.12 release with no installers; close the viewer without choosing installation. `prepareUpdateFixture` copies the sample's GitHub-shaped body into `update-feed.json`; the app's normal update-check path retains it for This update. The older entries in this tour use bundled notes because `VOMP_UPDATE_FEED` replaces GitHub. Ordinary development runs without that variable prefer published GitHub bodies when available and fall back to bundled notes.

`fixture mentions setup` creates the samples using Python's standard ZIP library. The prepared second message sends a quoted text-file mention and preparation requires the provider's content receipt. Each chat's first message includes numbered owner steps; the file-mention message includes its exact scratch folder path for Finder. omp stores auto-reads as `fileMention` messages, which visual-omp currently does not display as separate Read rows. The receipt confirms file content reached the model request without claiming model-backed interpretation.

### The 0.7.10 patch tour

This earlier tour opens two chats:

| Chat | Checks |
| --- | --- |
| 01 Saved chats | Home's Recent chats and Projects discover the sessions under `$XDG_DATA_HOME/omp`. Reopen from Home, send a marked prompt with the supplied `frames.png` attached, recall it with Up and reopen the saved transcript image. Usage & limits discovers the prepared nonzero token usage at zero estimated cost. |
| 02 Composer and helpers | Replay `fixture helpers`, queue a helper message and retain a main draft. After a replacement room attaches, check input recovery or the five-second Restart omp fallback. If the connection ends, check stopped helpers, a selectable failed message with copy guidance, an explicit Stop error and Restart omp relaunching the chat. |

The scratch environment sets `XDG_DATA_HOME` to `<tour-root>/data` and creates `data/omp` before starting omp. On macOS and Linux, sessions use `data/omp/sessions`, prompt history uses `data/omp/history.db` and image blobs use `data/omp/blobs`; configuration remains in `home/.omp/agent`. Windows retains its agent-directory behavior. The image-capable `fixture/xdg` model accepts the attachment locally without analyzing it or using provider credits. The image and persisted prompt-history checks intentionally ask the owner to send one message through the app so omp records both through its normal input path.

A same-process, same-session, same-epoch room replacement cannot be forced by the fixture, and there is no supported dev or fixture control to end only the chat connection without stopping omp. The app blocks `/collab stop` to protect its hosted room. Do not use Stop omp or kill the process as a substitute. The recovery chat distinguishes ordinary reconnecting from an ended connection, asks the owner to copy a failed helper message before restarting, and checks that old messages are not sent automatically into the replacement helper scope. Checks without a relevant connection change remain unexercised. Live room-replacement evidence comes from `src/main/omp/tsp/semantic-report.live.test.ts`; the helper ended-state and message behavior have focused regression tests. Preparation establishes saved chats and workload input only.

### The 0.7.9 extended tour

Select `--release 0.7.9` for its 17 chats. Each first message names its checks:

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
| 17 Many helpers | Six helpers produce local output while you check that chats stay current and respond to input. |

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

The tour uses `live-preview-fixture/environment.mjs` for a separate HOME, omp agent directory, XDG folders, temporary folder and visual-omp development profile. It does not copy the owner's `~/.omp`, credentials, rules, skills or extensions. The initial generators explicitly disable context files and extension discovery. Live chats discover the 0.7.13 scratch extension alongside omp's bundled features and the app's native bridge; the owner's extensions remain outside the isolated HOME and chat folders. The scratch models file points to the local provider and sets every configured model role to `fixture/preview`. Fixture replies and their helper replies use no paid model service. Files produced by tools remain under the tour's chat folders.

The command checks its generation inputs and outputs. The owner still checks rendering and interactions before approving the release. The settings chat names checks that need a phone, stored OAuth accounts, a model-backed Auto choice, Windows, packaged builds or a measurement. The tour does not simulate those acceptance results. Phone sharing is started only by the owner and can use the network.

Keep the printed root while reviewing evidence. After the development app and provider have stopped, remove only that disposable directory when it is no longer needed. Nothing in the tour deletes or modifies the installed visual-omp app or the owner's ordinary profile.

### Tests

Run the tour and fixture unit tests without Electron:

```sh
node --test scripts/dev/*.test.mjs scripts/live-preview-fixture/*.test.mjs
npx vitest run src/main/services/release-tour.test.ts
```

These tests cover manifest and argument handling, layout construction, session validation, development-only startup boundaries and fixture calls. Use headless preparation as the integration check against the installed omp binary. UI acceptance belongs to the owner.

## Rollback checks without Electron

Run the opt-in headless check from a worktree with its existing dependencies:

```sh
VOMP_ROLLBACK_CHECK_DIR=/absolute/evidence-folder npx vitest run scripts/dev/rollback/check.test.ts
```

The check starts Chrome with a disposable profile and Vite with a private dependency cache,
then stops both. `CHROME_BIN` can select Chrome. It saves 24 light and dark screenshots covering
About, the successful-update notice, Past versions for installer, Homebrew and Scoop copies,
verified managed downloads, and global Scoop guidance with a retained version.

The fixture preload forwards app update IPC to the production main handlers through a private
loopback server. Main reads a temporary `VOMP_UPDATE_FEED`; its fetch boundary rejects external
network requests. Four flow checks cover a verified download, an existing higher rollback boundary,
a missing published digest, and boundary restoration after a checksum failure. `evidence.json`
records preference transitions, persisted boundaries, download results and shell calls. Installer
reveal is recorded at the Electron shell boundary; installers and package-manager commands never run.
No installed copy, package-manager records or ordinary omp profile is used.

Scoop screenshots use Windows platform data on macOS with the host platform's fixture asset.
Explorer reveal and the published NSIS installer still require Windows checks. The owner reviews
the screenshots and confirms the release's native behavior separately.

## Heavy-chat speed measurement

This is measurement only. It does not change application behavior or start omp. The fixture expands the recorded omp 18.16 collab messages in `src/renderer/src/collab/lib/fixtures/` into a 1,400-entry JSONL chat and four 350-entry helper files under an isolated scratch agent directory. It includes prose, code, thinking, eight tool kinds and five small images. A second 12-entry chat is used for switching.

Run the renderer capture without Electron:

```sh
node scripts/dev/speed/measure.mjs --headless --seconds 30 --output /tmp/vomp-speed-headless.json
```

It starts an isolated headless Chrome and Vite server with a private dependency cache, then stops both. `CHROME_BIN` can select a Chrome executable. Node must support native TypeScript stripping. The app's full renderer and controllers run with a fixture preload; only Electron IPC and helper transcript transport are replaced.

For Electron, close the existing development instance first. Prepare a fresh scratch root, then use the root printed by preparation in two terminals:

```sh
node scripts/dev/speed/scenario.mjs --prepare
node scripts/dev/speed/launch.mjs --root /absolute/printed/root --port 9335 --main-port 9336
```

```sh
node scripts/dev/speed/measure.mjs --root /absolute/printed/root --port 9335 --main-port 9336 --seconds 30 --output /tmp/vomp-speed-electron.json
```

Keep the fixture window visible and unoccluded. The measurement never launches or raises Electron. It checks the main process's isolated agent directory, profile and `VOMP_SPEED=1`, and binds the renderer inspector to that process with a challenge before loading the replay. Do not send messages in these synthetic chats. Quit the scratch development app when finished. Use a fresh preparation for another capture.

The identical replay feeds host-shaped frames through the real `GuestClient.applyFrameForTest` and `SessionController.attach` paths: a text update every 20 ms for the requested duration, four helper progress frames every 250 ms, and a new main entry every two seconds while text arrives. Helper transcripts grow every two seconds through the later phases. A dedicated worker owns the producer clock, so renderer saturation does not silently lower the offered rate. Text production stops independently at 30 seconds by default; the capture waits for that burst to drain, then scrolls and switches chats with helpers still updating. JSON and the summary distinguish offered duration from capture wall time. Delivery lag and applied-frame counts expose backlog. This isolates renderer costs; it excludes websocket encryption, omp, disk and main-process IPC CPU. Helper reads retain the real incremental reader and parser, with an in-memory byte-sliced transport. Tasks remains open for ten seconds so repeated growing-file reads occur.

Output includes JSON, a short `.txt` summary, a final Tasks screenshot and streaming, scrolling and Tasks `.cpuprofile` files. Each phase records CDP main-thread task, script, layout and style durations; frame intervals; long tasks; React commits; component render counts; collab update counts; notifications per update; and probe callback overhead. Actual React `Profiler` boundaries wrap ChatView, SessionHeader, Composer, Transcript, TranscriptBody, TasksPane, HelperList and HelperRow only in the opt-in serve transform. Their `actualDuration` measures each subtree per commit. These inclusive timings overlap and must not be added together. Render counts include StrictMode's development double invocation and cover only these named components. The injected DevTools hook records root commits without walking stale fibers. Function timers cover the backlog's helper derivation, whole-chat layout and helper-file parsing suspects.

`VOMP_SPEED=1` enables the serve-only Vite transform. No probe call, replay import or Profiler wrapper is emitted into the application's production module graph. The replay module is loaded only by CDP and refuses production builds. A normal dev run does not collect data. Production bundle limits remain unchanged. The first-paint measurement starts on activating the already-loaded heavy chat, not on disk read or application startup. Timings come from development React with StrictMode and a CPU sampler, not a production build.

### Production renderer comparison

```sh
node scripts/dev/speed/measure.mjs --headless --production --seconds 30 --output /tmp/vomp-speed-production.json
```

`--production` builds and serves an isolated, minified production-React measurement renderer without StrictMode. Build output, source maps and the dependency cache stay in a unique temporary directory, outside `out/`. The dedicated measurement entry imports the replay and overrides its development guard only within that harness graph; shipping builds never import it. React Profiler durations, component render counts and subscriber metrics are unavailable and omitted, not reported as zero. CDP CPU profiles, root commits, frame intervals, long tasks and replay statistics remain available.

`--source-root /absolute/frozen/source` selects a preserved copy containing `src/renderer`, `src/shared` and `CHANGELOG.md`; dependencies resolve from the existing checkout without copying node_modules. JSON records React's version, renderer bundle type and root mode to establish the production/no-StrictMode boundary. Do not overlap captures with builds or other CPU measurements.

### Live omp pacing capability

```sh
node scripts/dev/speed/pace-probe.mjs --seconds 30 --repeats 2 --output /tmp/vomp-pace/evidence.json
```

This starts isolated omp processes, not Electron. It compares the app's actual TSP hello `features: []` with `features: ["pace"]` in ABBA order through the production SessionHost, encrypted collab and development app renderer. It counts provider content deltas, native frames, collab updates and visible text changes, and records CPU windows and screenshots. `--omp` selects an executable; `--source` selects a frozen renderer source copy. Its default source sends 140-character bursts every 600 ms, exposing omp's native reveal work between provider bursts.

The recorded omp 18.17 comparison reduced native frames and CPU, with unchanged source/collab counts and typical 16.8 ms visible-change gaps. One pace trial contained a 683 ms visible stall coincident with delayed source/collab delivery. The cause was not established, so the application continues to advertise no pacing capability. This probe is evidence for a future decision, not an opt-in or a subjective display-smoothness guarantee.
