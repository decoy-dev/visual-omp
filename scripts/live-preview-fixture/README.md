# Live preview fixture

This loopback OpenAI Chat Completions server supplies deterministic streams to omp. It uses omp's `openai-completions` custom provider API through `models.yml`. Node.js 22 or later and omp 18.16.0 on PATH are required. The PNG, sequence and recorded-progress scenarios require Python 3 as `python3`; video and sequence rendering require ffmpeg with libx264, and the ProRes scenario requires prores_ks. The server binds IPv4 loopback only and does not forward requests to a model provider.

## Start the server and save an SVG

Run these commands from the live preview worktree. They create a new scratch directory and wait for the server to finish writing its configuration.

```sh
cd /tmp/vomp-live-preview
export FIXTURE_ROOT="$(mktemp -d /tmp/vomp-preview.XXXXXX)"
node scripts/live-preview-fixture/server.mjs --root "$FIXTURE_ROOT" &
FIXTURE_PID=$!
until test -f "$FIXTURE_ROOT/fixture.json"; do
  kill -0 "$FIXTURE_PID" || break
  sleep 0.1
done
printf 'Fixture root: %s\n' "$FIXTURE_ROOT"
node scripts/live-preview-fixture/run.mjs "$FIXTURE_ROOT" omp \
  --no-extensions --no-skills --no-rules --no-context-files \
  --no-lsp --no-title --no-pty --auto-approve \
  --tools write,bash,generate_image --model fixture/preview --thinking off \
  -p "fixture svg"
```

The output is `$FIXTURE_ROOT/work/poster.svg`: 300 lines and 14,956 bytes. Its arguments arrive in approximately 150 chunks over 15 seconds. The server sends one short text block before the call, then replies with one sentence after the tool result.

Use `fixture html` or `fixture png` in place of `fixture svg` for the other scenarios:

- `fixture html` first writes `style.css` and `image.svg`, then streams `page.html` over about 15 seconds. This lets the streaming page resolve its local assets before the HTML write finishes. The page also includes a remote stylesheet, font and image, a script with `fetch`, a link, a meta refresh and a form. These are test inputs for the preview's network, script and navigation restrictions. Do not open this page outside the restricted preview when checking those restrictions.
- `fixture png` calls `bash` with a Python standard-library script. It writes three different 240 by 160 RGB images to `frames.png`, closes each write and waits one second before the next iteration. Each save prints the absolute path and save number. No Pillow installation is needed.
- `fixture image` streams a `generate_image` request for abort testing. The scratch configuration enables the tool, but supplies no image-provider credentials. Abort before the stream finishes. This scenario does not generate an image.
- `fixture isolation` writes `isolation.html` with an inline script that reports its opaque origin and a button that starts an infinite loop. Scripts remain off without the explicit main-process test launch below. The evidence collector clicks the button; do not click it manually.
- `fixture video` runs a six-second, 320 by 240, 30 fps ffmpeg render to `out.mp4`, with libx264, yuv420p, `-frames:v 180`, `-progress pipe:1`, real-time pacing and a 250 ms progress period. The explicit frame count provides the parser's total. Progress should advance at least three times while the file is incomplete. The hidden candidate player must decode before it replaces the last playable revision.
- `fixture sequence` declares `frames/frame%04d.png`, writes six frames at one-second intervals, and creates `photo1.png`, `photo2.png` and `photo3.png` in the same folder. Expect one sequence chip showing its newest frame and count, plus three separate photo chips.
- `fixture progress` replays the captured Remotion 4.0.391 and manim 0.19.0 logs from `samples/` through two bash functions, over about six seconds each. This checks the output parser without installing those renderers. It creates no rendered media. The samples retain their original version lines, commands, paths and console text; each also records the parser's expected result. ffmpeg 9.0.2 and sequence captures are included for unit tests.
- `fixture prores` creates `unsupported.mov` with the ProRes encoder. Chromium's expected unsupported-codec result must show "This video format cannot play here" and Open in Files.

Stop the server with `kill "$FIXTURE_PID"` when finished. Scratch outputs and agent state remain available for inspection.

## Use the fixture in a visual-omp development build

Keep the server running. From the same shell, run the following command when the integration owner is ready to start the development app:

```sh
node /tmp/vomp-live-preview/scripts/live-preview-fixture/run.mjs \
  "$FIXTURE_ROOT" --cwd /tmp/vomp-live-preview npm run dev
```

The wrapper starts the app with an explicit environment, so its inherited provider credentials, hooks and config overlays are absent. It sets `HOME` and `USERPROFILE` to `$FIXTURE_ROOT/home`, `PI_CONFIG_DIR=.omp`, `PI_CODING_AGENT_DIR=$FIXTURE_ROOT/home/.omp/agent`, `OMP_PROFILE` to the empty string, scratch XDG directories and temporary directories, and `VOMP_DEV_PROFILE=$FIXTURE_ROOT/app-profile`. `SHELL=/bin/bash` makes the app's login-shell environment lookup use the scratch home on macOS. PATH is copied from the launching environment. Windows also keeps the operating-system paths needed by subprocesses, with `APPDATA` and `LOCALAPPDATA` redirected into the scratch home. The remaining fixed values are listed in `environment.mjs`.

The scratch config selects `fixture/preview` for default, smol and tiny roles and uses `tools.approvalMode: yolo`. If the app shows first-run setup, skip provider login, select the fixture model and finish setup in this scratch profile. Open `$FIXTURE_ROOT/work` as the chat folder, then send one of the fixture prompts. Watch opens Outputs explicitly; automatic opening is off by default. Use a fresh chat when comparing scenarios. The server selects a scenario from the latest user message and stops after its tool result, so a correction such as `Use a blue square instead` produces a short acknowledgment.

This command is for the integration owner. The fixture probes do not launch Electron, the installed visual-omp app or a development app.

## Collect packaged process isolation evidence

Only the integration owner runs the packaged apps. Node.js 22 or later and omp 18.16.0 on PATH are required inside the Windows VM and on the later macOS host run. No model credentials are needed. Keep loopback ports 9229 (main inspector), 9333 (renderer CDP) and 47831 (fixture provider) free. The inspectors grant debugging access to the scratch app; quit it after collection. Normal launches open neither inspector.

`run.mjs <root> --isolation <app>` sets `VOMP_PREVIEW_ISOLATION_TEST=1`, the exact absolute `<root>/work/isolation.html` path and the scratch app profile. Main captures the switch at startup in development and packaged builds. Only prepared saved revisions of that exact file gain inline scripts and `sandbox="allow-scripts"`. No `allow-same-origin` permission is added, the rest of the response CSP stays unchanged, and streaming revisions and all other files keep scripts off. A packaged launch without an absolute scratch profile fails before reading app preferences.

### Build an unpacked Windows app on macOS

Reuse the Windows ARM64 track's isolated native dependency staging procedure. `node_modules` in the worktree is a shared symlink and must remain untouched. Build first, then stage the Windows prebuilds in an app directory inside the worktree, because electron-builder rejects a sibling `/tmp` app directory. The existing packaging hooks copy the target ConPTY files there. This example builds ARM64 for Windows 11 ARM64:

```sh
npx electron-vite build
(
  set -e
  STAGING=.arm64-package
  test ! -e "$STAGING"
  mkdir -p "$STAGING/node_modules"
  trap 'rm -rf "$STAGING"' EXIT
  cp -R out package.json LICENSE NOTICE "$STAGING/"
  cp -R node_modules/node-pty "$STAGING/node_modules/"
  rm -rf "$STAGING/node_modules/node-pty/build"
  mkdir -p "$STAGING/node_modules/node-pty/build/Release"
  cp node_modules/node-pty/prebuilds/win32-arm64/pty.node \
    node_modules/node-pty/prebuilds/win32-arm64/conpty.node \
    node_modules/node-pty/prebuilds/win32-arm64/conpty_console_list.node \
    node_modules/node-pty/prebuilds/win32-arm64/winpty.dll \
    node_modules/node-pty/prebuilds/win32-arm64/winpty-agent.exe \
    "$STAGING/node_modules/node-pty/build/Release/"
  npx electron-builder --win dir --arm64 --publish never \
    -c.npmRebuild=false -c.directories.app="$STAGING" \
    -c.directories.output=/tmp/vomp-isolation-arm64
)
```

For an x64 run, use `.x64-package`, `prebuilds/win32-x64`, `--x64` and `/tmp/vomp-isolation-x64` in the same procedure. When Windows-native target addons are already staged in the app directory, the packaging command is `npx electron-vite build && npx electron-builder --win dir --x64 -c.npmRebuild=false --publish never` (or `--arm64`). Do not use that shorter command against the Mac's native dependency tree. Remove the scratch app directory before another Vite build, including after an interrupted shell.

Copy the entire unpacked app folder from `/tmp/vomp-isolation-arm64/win-arm64-unpacked` to `C:\vomp-a2\app` in the VM. For x64 the folder is `win-unpacked`. Also copy `scripts/live-preview-fixture` from this exact source revision to `C:\vomp-a2\scripts\live-preview-fixture`. Keep the app's `resources`, DLLs and executable together. There is no installer step.

### Collect in Windows PowerShell

In the first VM PowerShell terminal:

```powershell
Set-Location C:\vomp-a2
$root = Join-Path $env:TEMP ("vomp-preview-isolation-" + [guid]::NewGuid())
Set-Content -Path .\fixture-root.txt -Value $root
node .\scripts\live-preview-fixture\server.mjs --root $root
```

Wait for the provider's listening message, then in a second VM terminal:

```powershell
Set-Location C:\vomp-a2
$root = (Get-Content .\fixture-root.txt -Raw).Trim()
node .\scripts\live-preview-fixture\run.mjs $root --isolation C:\vomp-a2\app\visual-omp.exe
```

If first-run setup appears, skip provider sign-in, select `fixture/preview` and finish setup in the scratch profile. Open `<root>\work` as the chat folder and create a fresh chat. Keep its composer empty and close any existing Outputs stage. Confirm that Show visual outputs while omp makes them is on. Leave the app open and start the collector in a third VM terminal:

```powershell
Set-Location C:\vomp-a2
$root = (Get-Content .\fixture-root.txt -Raw).Trim()
node .\scripts\live-preview-fixture\isolation-evidence.mjs $root
```

After the collector prints `Armed`, send `fixture isolation` in that chat and choose Watch to open Outputs. Do not click Start busy loop or interact with the app during collection. Keep the scratch app visible, without minimizing or fully covering it, because the app pauses hidden React views. The collector does not raise or activate windows. Its textarea DOM focus and CDP input stay inside the app renderer. It starts the loop itself, inserts one character about every 200 ms for at least 10 seconds, then clicks the stage's Close button. The generated text remains as an unsent scratch draft.

The collector writes `scripts/live-preview-fixture/evidence/isolation/win32.json` and exits with status 0 only when this packaged platform passes. Copy that file back to the same evidence directory in the integration worktree. Retain failed runs before repeating, using `--output <path>` to write a separate attempt. Quit the scratch app and stop the provider with Ctrl+C. If cleanup reports a remaining loop, quit the scratch app manually.

### Repeat on macOS after hours

Build the packaged app with `npm run dist:mac` in the integration scratch worktree and use its unpacked `.app` under `release/mac-arm64`. Keep the owner's installed app and running development app untouched. Run the provider in one terminal, then the packaged executable in another:

```sh
export FIXTURE_ROOT="$(mktemp -d /tmp/vomp-preview-isolation.XXXXXX)"
printf 'Fixture root: %s\n' "$FIXTURE_ROOT"
node scripts/live-preview-fixture/server.mjs --root "$FIXTURE_ROOT"
# In a second terminal, set FIXTURE_ROOT to the printed scratch root.
node scripts/live-preview-fixture/run.mjs "$FIXTURE_ROOT" --isolation \
  "$PWD/release/mac-arm64/visual-omp.app/Contents/MacOS/visual-omp"
# In a third terminal, after preparing an empty fresh chat in <root>/work:
node scripts/live-preview-fixture/isolation-evidence.mjs "$FIXTURE_ROOT"
```

Follow the same Armed, prompt and Watch sequence. The result is `evidence/isolation/darwin.json`. Copy both platform JSON files into the integration worktree and fill the result table in `docs/LIVE-PREVIEW.md`.

### Decision and recorded measurements

The JSON includes `webFrameMain` identifiers and `osProcessId` for the preview and app main frame, `app.getAppMetrics()` before and after loading and during the loop, the exact CSP and opaque origin, every composer echo's upper-bound latency, stage-close timing and post-close CPU samples. It records the preview PID's peak busy CPU value without assuming the host's core count. Closing passes only when the stage closes without terminating JavaScript first. Idle means that PID disappears or stays at or below 1 percent CPU for three consecutive one-second samples, within 10 samples.

The collector requires that explicit fixture root. It checks the root marker, the inspected main process's agent directory and fixture path, and the app's actual scratch profile before connecting to renderer CDP. A random challenge written through that verified process's `webContents.executeJavaScript` must be readable from the selected CDP target before any input, clicks or cleanup commands are permitted. A mismatch writes failed evidence without interacting with the page.


The collector continues collecting responsiveness evidence when process IDs match, so one run records the failure and its consequences. If Close cannot run, it first records that failure, then requests `Runtime.terminateExecution` for cleanup and retries Close. Recovery never converts the failed close into a pass. Errors and partial runs write JSON and fail closed.

Script-enabled iframes are permitted for slice F only if both packaged Windows and macOS runs have different app and preview OS process IDs, every echo sample is at most 100 ms for the full 10 seconds, and close and idle checks pass. Otherwise slice F uses the approved WebContentsView fallback. These A2 runs do not establish the A3 network-channel guarantees.


## Why this does not use the owner's omp configuration

`PI_CODING_AGENT_DIR` is a full path override for the default profile. It does not redirect all of omp's generic config discovery by itself. Named profiles also inherit default keybindings and leave foreign-tool config discovery under home. The fixture therefore changes HOME as well, uses the default profile explicitly and creates the native agent directory inside that scratch home.

`PI_CONFIG_DIR` is a directory name under HOME. An absolute value is unsuitable here. The fixture uses the supported name `.omp` and checks the resulting location with the installed binary:

```sh
node scripts/live-preview-fixture/run.mjs "$FIXTURE_ROOT" omp config path
```

The recorded `configPath` equals `expectedConfigPath` in `evidence/results.json`, both ending in `/home/.omp/agent`. Recorded RPC `get_state.sessionFile` values are under that directory's `sessions` tree. The fixture precreates `data/omp`, `state/omp` and `cache/omp` under its scratch root because omp uses XDG overrides only when their target exists. No `~/.omp` file is copied, read for credentials or modified by these scripts.

## Repeat the RPC probes

```sh
cd /tmp/vomp-live-preview
node scripts/live-preview-fixture/probe.mjs
```

The probe starts its own server on an available port, creates another isolated scratch root, runs the six scenarios and prints the evidence directory. To refresh the checked-in capture deliberately, use:

```sh
node scripts/live-preview-fixture/probe.mjs \
  --output scripts/live-preview-fixture/evidence
```

Set `OMP_FIXTURE_BINARY` to an absolute omp executable if PATH selects another installation. The child environment still excludes the caller's provider credentials. The interruption is sent after a partial tool call's parsed arguments exceed 900 characters, while the server is still streaming, rather than after a fixed delay.

Each capture contains:

- `<scenario>.events.jsonl.gz`, with every RPC event and elapsed milliseconds, including full partial arguments and `get_state` responses.
- `<scenario>.session.jsonl.gz`, with the saved session's complete original text.
- `<scenario>.inputs.json`, with exact RPC commands and their send times.
- `results.json`, with event runs, assistant stop reasons, tool results, session entry types, observed files and environment resolution.

For example, `gzip -dc scripts/live-preview-fixture/evidence/svg-aborted.events.jsonl.gz` prints the raw event capture. Repeated events remain present in this file; only `results.json` groups adjacent event types for readability. Paths and timestamps identify disposable scratch runs and will change when the capture is refreshed.

## Probe results from omp 18.16.0

These results are observations of the installed `omp/18.16.0`. The readable source beside the installed bundle reports an older version and cannot establish the runtime result by itself.

### Abort during the SVG arguments

The event sequence includes `agent_start`, `turn_start`, the user message, assistant `message_start`, `message_update` events with `text_start`, `text_delta`, `text_end`, `toolcall_start` and repeated `toolcall_delta`, followed by assistant `message_end`, `turn_end` and `agent_end`. No `toolcall_end` or `tool_execution_start`, `tool_execution_update` or `tool_execution_end` follows the abort.

The assistant ends with `stopReason: "aborted"` and `errorMessage: "Interrupted by user"`. The saved assistant message retains the text prefix and drops the incomplete tool call. The session records title/session metadata, model and thinking changes, custom entries, a user message and the aborted assistant message. There is no `toolResult` entry. `poster.svg` is absent both when abort is sent and after the agent ends. The exact events and saved entries are in `svg-aborted.*`.

### Steer during the SVG arguments

The installed version does **not** skip this write. It accepts `{"type":"steer","message":"Use a blue square instead. Do not write the poster."}` during `toolcall_delta` events, reports `queue_update` with that steering text and `liveSteered: 0`, then continues streaming the remaining arguments. `get_state` reports `interruptMode: "immediate"`.

After `toolcall_end`, the assistant ends with `stopReason: "toolUse"`. The event sequence then includes `tool_execution_start`, `tool_execution_update` and `tool_execution_end`. The exact result is:

```json
{
  "content": [{ "type": "text", "text": "Successfully wrote 14956 bytes to poster.svg" }],
  "details": { "resolvedPath": "<scratch scenario directory>/poster.svg" }
}
```

The original absolute `resolvedPath` is preserved in the raw capture and `results.json`. `isError` is `false`. The saved session contains the complete assistant call, the successful `toolResult`, the steering user message, then an assistant acknowledgment with `stopReason: "stop"`. The file exists. There is no skipped result text and no synthetic skipped-result details in this scenario.

This contradicts the plan's inference that a steer during a streaming write discards the write. Send now should not promise to prevent a pending write on the strength of that inference. The observed abort behavior supports Stop and redirect for that purpose. RPC was exercised here; a TSP or collab transport equivalence claim requires its own runtime check.

### Abort during the image request

With `generate_image.enabled` left at its default, omp rejects `--tools generate_image` before RPC readiness. The exact diagnostic is in `image-tool-disabled.txt`. The fixture enables the setting so the final probe can stream the registered tool's arguments without supplying image-provider credentials.

The captured `get_state.dumpTools` schema requires `subject` and accepts optional `model`, `aspect_ratio`, `image_size`, `action`, `scene`, `composition`, `lighting`, `style`, `text`, `changes` and `input`. It has no `provider`, `prompt`, `size`, `count` or `n` argument. This differs from the older bundled documentation's provider selector. `generateImageSchema` in `results.json` preserves the installed tool's schema.

The image abort follows the same sequence as the SVG abort: partial `toolcall_delta` events, assistant `message_end` with `stopReason: "aborted"` and `errorMessage: "Interrupted by user"`, then `turn_end` and `agent_end`. There is no tool execution or tool result and no output file. The saved assistant entry drops the incomplete call. No image-generation request is made by the fixture server. This confirms cancellation before tool dispatch in the scratch run; cancellation after dispatch and behavior at an image provider are outside this probe.

### Completed outputs

The uninterrupted SVG scenario writes `poster.svg` and ends with `toolUse`, then `stop`. The PNG scenario reports three saves in its bash output, saves `frames.png` and ends with `toolUse`, then `stop`. The HTML scenario saves both local assets before the slow page stream, saves `page.html` and ends with two `toolUse` assistant messages, then `stop`.

The documented wrapper and print command were also run against a standalone fixture server. omp exited with status 0, and `wc -lc` reported 300 lines and 14,956 bytes for the saved SVG. `print-command.txt` preserves the commands and output.

These probes establish omp's stream and file behavior. They do not establish the renderer's latency, watcher delivery, preview security or screenshot acceptance criteria; those require the integration checks described in `docs/LIVE-PREVIEW.md`.

## Verify video in Windows 11 ARM64 Electron

These steps are for the integration owner in the Windows VM. They have not been run on the owner's Mac, and no Electron window is needed for unit or headless checks.

1. In the integrated worktree, install the project's existing dependencies and have Node.js 22 or later, npm, omp 18.16.0, Git for Windows and ffmpeg available on PATH. Confirm `ffmpeg -encoders` lists `libx264` and `prores_ks`. For the sequence and recorded-progress scenarios, `python3 --version` must resolve to Python 3. A native ARM64 ffmpeg build is suitable; the app does not install it.
2. Run the affected protocol, watcher, subject and adapter tests in PowerShell:

   ```powershell
   npm run typecheck
   npx vitest run src/main/services/preview-protocol.test.ts src/main/services/preview-watch.test.ts src/renderer/src/features/live-preview
   node --test scripts/live-preview-fixture/server.test.mjs
   ```

3. Start the isolated provider from the repository root in PowerShell:

   ```powershell
   $Repo = (Get-Location).Path
   $FixtureRoot = Join-Path $env:TEMP ("vomp-preview-video-" + [guid]::NewGuid().ToString("N"))
   $env:VOMP_FIXTURE_SHELL = Join-Path $env:ProgramFiles "Git\bin\bash.exe"
   if (!(Test-Path $env:VOMP_FIXTURE_SHELL)) { throw "Set VOMP_FIXTURE_SHELL to Git for Windows bash.exe." }
   $Server = Start-Process -FilePath (Get-Command node).Source -NoNewWindow -PassThru `
     -WorkingDirectory $Repo -ArgumentList @("scripts/live-preview-fixture/server.mjs", "--root", "`"$FixtureRoot`"")
   while (!(Test-Path (Join-Path $FixtureRoot "fixture.json"))) {
     if ($Server.HasExited) { throw "The fixture server exited before initialization." }
     Start-Sleep -Milliseconds 100
   }
   node scripts/live-preview-fixture/run.mjs "$FixtureRoot" --cwd "$Repo" "$env:ComSpec" /d /s /c "npm run dev"
   ```

   `VOMP_FIXTURE_SHELL` selects Git Bash for fixture bash calls. On Windows the integrated fixture environment also retains the operating-system variables needed to spawn programs and redirects application data into the scratch home. Provider credentials and the owner's omp configuration remain outside this environment.

4. In that one development window, open `$FixtureRoot\work` as the chat folder. Keep "Show visual outputs while omp makes them" on. Open Outputs before sending `fixture video`, or use Watch on its bash card. Record at least three increasing "frame N of 180" values while `out.mp4` is incomplete. The file can exist from the first update; a player must appear only once it decodes. After completion, press Play, seek to approximately three seconds and near the end, then pause.
5. Open DevTools with Ctrl+Shift+I, choose Network and enable Preserve log before repeating the render in a fresh chat. Filter for `vomp-preview`. Record the request's Range and the `206`, `Content-Range`, `Content-Length` and `Accept-Ranges: bytes` response headers. An open-ended response must be at most 8 MiB. This small clip may be shorter than that limit; the protocol tests exercise larger explicit, suffix, open-ended and un-ranged streams, HEAD, `416` responses, abort, response cancellation and revocation, including closed descriptors.
6. Wait for six key-frame tiles, click the middle and final tiles, and confirm the player seeks. Start another `fixture video` in the same chat, then switch chips and close the stage during loading. No stale player or contact sheet may replace the selected newer revision. Repeat with the panel at 320 px and Settings > Appearance's largest text size. Stop must remain visible; progress wraps, native video controls fit the player, and the tiles use two columns with usable keyboard focus.
7. In fresh chats, run `fixture sequence`, `fixture progress` and `fixture prores`. Confirm the sequence and unrelated-photo counts described above, advancing captured progress, and the unsupported-codec note with working Open in Files. Before checking ProRes, confirm the ffmpeg call succeeded, so an encoder error is not mistaken for the expected player error.
8. Close the development app, then stop only this fixture server:

   ```powershell
   if (!$Server.HasExited) { Stop-Process -Id $Server.Id }
   Remove-Item Env:VOMP_FIXTURE_SHELL
   ```

Keep `$FixtureRoot` and the DevTools HAR or screenshots until the integration owner records the result. Generated clips and frame images belong in that scratch directory and must not be committed. Report Electron's version, Windows build, ffmpeg version, observed progress values, range headers, seeking, codec result and the narrow-layout result separately from unit-test results.
