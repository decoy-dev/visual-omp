# Live preview fixture

This loopback OpenAI Chat Completions server supplies deterministic streams to omp. It uses omp's `openai-completions` custom provider API through `models.yml`. Node.js 22 or later, omp 18.16.0 on PATH and Python 3 for the PNG scenario are required. The server binds IPv4 loopback only and does not forward requests to a model provider.

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

Stop the server with `kill "$FIXTURE_PID"` when finished. Scratch outputs and agent state remain available for inspection.

## Use the fixture in a visual-omp development build

Keep the server running. From the same shell, run the following command when the integration owner is ready to start the development app:

```sh
node /tmp/vomp-live-preview/scripts/live-preview-fixture/run.mjs \
  "$FIXTURE_ROOT" --cwd /tmp/vomp-live-preview npm run dev
```

The wrapper starts the app with an explicit environment, so its inherited provider credentials, hooks and config overlays are absent. It sets `HOME` and `USERPROFILE` to `$FIXTURE_ROOT/home`, `PI_CONFIG_DIR=.omp`, `PI_CODING_AGENT_DIR=$FIXTURE_ROOT/home/.omp/agent`, `OMP_PROFILE` to the empty string, scratch XDG directories and temporary directories, and `VOMP_DEV_PROFILE=$FIXTURE_ROOT/app-profile`. `SHELL=/bin/bash` makes the app's login-shell environment lookup use the scratch home. PATH is the only value copied from the launching environment. The remaining fixed values are listed in `environment.mjs`.

The scratch config selects `fixture/preview` for default, smol and tiny roles and uses `tools.approvalMode: yolo`. If the app shows first-run setup, skip provider login, select the fixture model and finish setup in this scratch profile. Open `$FIXTURE_ROOT/work` as the chat folder, then send one of the fixture prompts. Watch opens Outputs explicitly; automatic opening is off by default. Use a fresh chat when comparing scenarios. The server selects a scenario from the latest user message and stops after its tool result, so a correction such as `Use a blue square instead` produces a short acknowledgment.

This command is for the integration owner. The fixture probes do not launch Electron, the installed visual-omp app or a development app.

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
