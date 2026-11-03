# omp 18.15.0 semantic recordings

These fixtures were recorded on macOS arm64 on 2026-11-02 from the standalone executable `/tmp/omp-18.15/omp-darwin-arm64`, reporting `omp/18.15.0`. The matching upstream release is tag `v18.15.0`, commit `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67` of [oh-my-pi](https://github.com/can1357/oh-my-pi/tree/3fedf8d53267e32a6d7521ce725fdcc4a36fdc67). The version was checked; the executable was not independently reproduced from that commit.

All 37 scenarios from the previous 18.14.0 baseline were re-recorded. `btw-history` replaces the earlier standalone byte capture. `startup-missing-resume` adds a pre-TUI failure, bringing the baseline to 39 recordings. The old baseline and byte capture are removed.

Phase 4d adds `model-switch`, `thinking-cycle`, `switch-typed`, `model-switch-compact` and
`model-switch-compact-error`, bringing the baseline to 44 recordings. The first three configure two scratch-only OpenAI-compatible
models (`fixture/fixture-large`, 128K context, and `fixture/fixture-small`, 32K context) at
`http://127.0.0.1:1/v1`, with a public placeholder key. No server or model request is needed.
They start on the large model with thinking Off. Switching uses omp's session-only picker or
`/switch`; thinking records the complete Off, Auto, Minimal, Low, Medium, High, Extra high,
Off cycle. These captures do not establish collab identity or compaction behavior; consumer
tests inject collab identity separately.

Phase 4a adds thirteen `hook-parity-*` recordings for the positive classic dialog captures.
The combined 4a, 4c, 4d and startup-diagnostics baseline contains 63 raw recordings and 63 integrity
manifests.

The two compaction scenarios use the Phase 3 scripted loopback provider with the same model
definitions. The recorder seeds eight user/assistant pairs with repeated public fixture text and
40,100 reported context tokens, then selects the 32K model. The success capture makes three
summary requests, emits the `omp.working` row with a progress child, replaces old context with
an `omp.compaction` section and confirms the new semantic model label. The failure capture
makes two requests that receive scripted HTTP 400 errors, emits `omp.notice.error` and retains
the large model. No external provider is contacted. Both captures restore the composer and exit.

Phase 3 adds eleven composer input recordings, bringing the baseline to 74 recordings. Their
loopback scripts exercise steer, follow-up delivery, Escape restoration, large text, image
attachment, approval denial, ask ownership and prediction acceptance. Shell and Python scenarios
configure the local model without making a provider request. `image-attach` also attaches a collab guest.

Phase 4b adds three no-model worktree recordings. Each creates a fresh scratch git repository and an initial commit.
`worktree-start-ask` enables `worktree.onStart: ask` and records the creation question without
answering it. The exit scenarios keep startup creation off, create an owned worktree through
`/wt fixture`, modify its tracked `fixture.txt` and submit `/exit` with `worktree.onExit: ask`.
`worktree-exit-ask` activates No (Keep); `worktree-exit-ask-remove` activates Yes (Remove).
Both retain omp's uncommitted-changes risk text and finish natural process exit. These scenarios
configure no model and make no provider request. Hosted chats retain `worktree.onStart: off`.

Phase 4e adds eight command-feedback recordings, bringing the baseline to 85 raw recordings
and 85 integrity manifests. Rename and export preserve omp's literal success message, including
the generated HTML filename. `/compact soft` uses the shared scripted provider with three summary
requests; its error counterpart makes two requests with scripted HTTP 400 responses. Handoff
makes one scripted summary request and records its completed compaction section. These three
scenarios seed eight public fixture user/assistant pairs in scratch profiles, without an external
provider. The cleanse capture records the no-checker panel and local instruction prompt, then
cancels with Escape and waits for the composer to return. Jobs-kill records the explicit
missing-job error. `jobs-kill-running` starts a scripted async `sleep 30` bash job, then cancels
it with `/jobs kill all` and records omp's confirmation. Quiet completion remains a synthetic
consumer test because omp reports this successful cancellation explicitly. A complete
cleanse checker/fix workflow has not been recorded.

Phase 4f adds `tree-navigate` and `tree-navigate-summary`, recorded on 2026-11-03, bringing the
baseline to 87 raw recordings and 87 integrity manifests. Both use the seeded branched session
and the shared loopback provider with an empty response script. No provider request occurs.
The scratch copy gives user entry `00000003` a multiline draft with leading/trailing whitespace,
an accented character and an emoji. The first capture sets `branchSummary.enabled: false`; the
second sets it to `true`, records `Summarize branch?` and activates the observed `No summary` id.
Both open `/tree`, activate entry `00000003` once, wait for `Navigated to selected point` and the
exact restored editor text, then clear all 73 UTF-16 units with a len-checked semantic edit.
Neither capture uses row-order prediction or Ctrl+C. The source fixture remains unchanged.

Phase 4g adds `advisor-apply` and `advisor-apply-project`, bringing the baseline to 89 raw
recordings and 89 integrity manifests. Both run without a model. The user capture opens the
advisor prefs page through semantic `/advisor configure`, selects user scope with its declared
`scope` action, then sends `save` and the built-in prefs `close`. The project capture keeps the
initial scope. Save keeps the fullscreen page open, so its success toast becomes visible after
Close removes that screen surface. Neither recording changes advisor enablement or contacts a
provider. The app's existing main-owned preservation tests cover comments and unknown fields.


## Capture format

Each scenario has five files:

- `<scenario>.raw.bin` contains sanitized PTY output, preserving ordinary terminal controls and TSP framing.
- `<scenario>.jsonl` is omp's `PI_TUI_TSP_RECORD` journal with the same privacy replacements.
- `<scenario>.messages.jsonl` contains messages decoded from the sanitized bytes by `TspStream`.
- `<scenario>.events.jsonl` contains emitted replies and events. A `keys` record identifies raw keys, terminal replies, Ctrl+Q or a bracketed image-path paste. `afterMessage` records the number of program messages received before that input, so replays can check the addressed live document. An edit and the following key or paste can share one writer operation.
- `<scenario>.integrity.json` contains the sanitized byte length, carriage-return count and SHA-256 digest before storage. Git stores fixture `.bin` files as binary, preserving CR bytes across checkout. JSON delimiters remain LF; stringification escapes embedded CR values.
- Scripted scenarios also have `<scenario>.provider.json`, containing sanitized requests to the loopback provider. `image-attach.collab.json` contains the user message observed by an attached collab replica, including omp's processed image.

The recorder uses `TspSession`, including its hello, cumulative acknowledgments and semantic submission. It advertises 45 kinds, including `button`, an empty terminal feature list, two credits, 110 columns, light appearance and reduced motion. Completed scenarios restore the composer and submit `/exit`. Open-only scenarios stop the child after draining its output; omp emits a retained close without a closing toast or answer. The timeout event file is empty because that scenario deliberately sends no reply.

`startup-missing-resume` starts with `--resume <scratch-root>/missing-session.jsonl` and records exit code 1 before any hello or TUI opens. Its journal, decoded messages and emitted events are empty. The recorder creates the empty journal before launch because omp never opens its TSP journal on this path.

## Isolation and sanitization

Every scenario uses a fresh HOME, USERPROFILE, XDG config and cache roots, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, session directory and temporary directory. Only PATH is inherited. No credentials, API keys, provider configuration or owner profile is inherited. Discovery of extensions, skills, rules, context files, LSP and title loading is disabled. Hook and custom-row scenarios explicitly load `../extension/vomp-fixture.mjs` through `-e`, with discovery still disabled. Original menu scenarios make no model request. Scripted input scenarios create a zero-cost local fixture model served only on loopback, with an explicit per-request response list.

`TERM_PROGRAM=tern` enables TSP; `PI_TUI_NATIVE` is omitted. Scratch configuration disables setup, update and changelog checks, marketplace updates, autocomplete, recaps, predictions, automatic graphs and startup worktrees; exit worktrees are kept. Scratch profiles are removed after each recording.

The sanitizer replaces OSC 7 hosts with `localhost` and private home and temporary roots with `/tmp/vomp-fixture`. It decodes base64 OSC payloads, sanitizes and re-encodes them. The same replacements apply to raw bytes, journals and events, then the sanitized raw stream regenerates decoded messages. Generated session identities remain. The privacy test checks plain content and decoded base64 payloads.

## Scenarios

| Scenario | Recorded behavior |
| --- | --- |
| hotkeys | `/hotkeys` opens `omp.overlay.hotkeys`, then Escape dismisses it. |
| jobs | `/jobs` opens `omp.overlay.jobs` with an empty list. |
| usage | `/usage` emits `No usage data available.` as a main-region warning. The empty profile has no usage overlay. |
| session | `/session` opens `omp.overlay.sessionInfo`. |
| changelog | `/changelog` opens `omp.overlay.report` with Recent Changes. |
| tools | `/tools` opens `omp.overlay.report` with Available Tools. |
| model-picker | `/model` opens a roleless data-first picker in `layer`; no model is selected. |
| model-switch | `status.model` on the composer opens the session-only model picker; activating `fixture/fixture-small` closes it and updates the semantic model label. |
| thinking-cycle | Seven `thinking.cycle` actions update the effort node through a complete cycle back to Off. |
| switch-typed | Semantic `/switch fixture/fixture-small` updates the model without opening a picker. |
| model-switch-compact | Selecting the 32K model from a seeded 40K conversation closes the picker, compacts through the scripted provider, emits a summary section and changes the model. |
| model-switch-compact-error | The same switch receives scripted compaction errors and retains the original model. |
| settings-screen | `/settings` opens a second `omp.session` surface in screen mode with a `prefs` node; no settings change. |
| btw-history | `/btw` opens empty `omp.overlay.btwHistory`, then Escape restores the composer. No side question is submitted. |
| exit | Semantic `/exit` emits the closing toast and retained close. |
| exit-with-overlay | `/hotkeys`, Escape and semantic `/exit` preserve that close sequence. |
| startup-no-model | An empty profile emits its startup warning, then exits. |
| startup-missing-resume | A missing `--resume` file prints its quoted path and recovery guidance, then exits with code 1 before the TUI starts. No model is configured. |
| worktree-start-ask | A scratch git checkout with `worktree.onStart: ask` opens the startup Yes/No hook. The recording ends without answering. |
| worktree-exit-ask / worktree-exit-ask-remove | `/wt fixture` creates an owned worktree, a tracked file is changed, and `/exit` opens `Remove worktree?` with the uncommitted-changes description. Activation chooses No (Keep) or Yes (Remove), and omp exits. |
| advisor-apply / advisor-apply-project | `/advisor configure` opens roleless advisor prefs on a screen surface. User scope uses `scope`; `save` and `close` remove the page and expose the matching saved confirmation. No model is configured. |
| notice-error | Text submitted without a model emits `omp.notice.error` without a provider request. |
| extensions | `/extensions` opens a picker, selects the first rule row and closes. The unsupported `expand` action is not used. |
| import-claude | `--from-claude` selects and activates one synthetic imported session, closes the startup surface and negotiates a second hello. |
| restart | `/restart` retains the old close, negotiates a second hello and reuses `s:1`. |
| new | `/new` changes the documents without another hello. |
| resume | `/resume c040d770` resumes the isolated seeded session without another hello. |
| sibling-continuation | A second isolated process persists a title in the seeded file. The first process renames into a sibling file, warning and changing the session-file OSC without another hello. |
| hook-select-open / hook-select / hook-select-cancel | The extension opens a four-item roleless picker. Completion activates item `1`, returning `Second option`; cancellation sends `close` and returns null. |
| hook-confirm-open / hook-confirm / hook-confirm-cancel | The extension opens a Yes/No picker. Completion activates item `0` and returns true; cancellation returns false. |
| hook-input-open / hook-input / hook-input-cancel | A dock input dialog is seeded by a logged edit with `Fixture default value`. Completion replaces it with `Recorded fixture answer`; cancellation returns null. |
| hook-editor-open / hook-editor / hook-editor-cancel | A dock editor opens with a two-line, 38-character prefill. Completion replaces it with three lines; cancellation returns null. |
| extension-rows-open / extension-rows / extension-rows-cancel | A custom component without `describe()` emits a bare dock `rows` node. Raw Enter returns `completed`; raw Escape returns `cancelled`. |
| tree-open / tree-confirm | `/tree` displays six entries and both branches from the seeded session. Completion activates the current entry `00000006` without a model request. |
| tree-navigate / tree-navigate-summary | `/tree` activates earlier user entry `00000003` by id, restores its exact 73-unit draft, clears it with a len-checked edit and exits. The summary variant answers `Summarize branch?` with `No summary` by its observed item id. |
| hook-collab-aware | The selector stays open. Tests inject matching and ambiguous question mirrors; the recording has no attached guest. |
| handshake-timeout | All client replies are withheld. omp withdraws its optimistic surface with `keep: false` and paints classic rows. |
| hook-parity-* | Thirteen positive classic dialog captures are parsed by the recorder and opened through the fixture extension. Each records a complete native answer: described and moved selectors, outlined and twenty-option region lists, both confirms, empty/prefilled input and both editor styles. The two classic non-dialog captures remain negative parser cases. |
| send-busy-steer | A gated first model reply keeps the turn busy while a second semantic send steers it. |
| follow-up-queue | A len-checked edit plus Ctrl+Q produces `omp.queue.item`; releasing the first response delivers the follow-up in the next request. |
| queue-escape-restore | Escape appends queued text to the main editor; an exact semantic edit clears it before exit. |
| shell-bang | Semantic `!` and `!!` sends produce shell execution output without a model turn. |
| python-dollar | Semantic `$ 1+1` produces an eval execution block without a model turn. |
| paste-large | A large multiline message travels through a chunked semantic send. |
| image-attach | The text edit and image path paste share one write, attachment appears in the document, and `action submit` produces an image-bearing user message in collab and the provider request. |
| approval-send-denies | An always-ask bash request opens approval; sending text records a denied tool result and a steering user message. |
| ask-replaces-editor | A scripted ask tool replaces the main dock editor. The recording ends with that question open. |
| prediction-ghost | A second scripted request supplies the semantic editor ghost; Tab inserts it, and a len-checked edit clears it before exit. |
| paste-follow-up | The image paste reflects before follow-up edits. The queued message reaches the next provider request with its attached image intact. |

`../extension/tree-session.jsonl` is a hand-authored version 3 session with three user/assistant pairs, two branches and zero usage. Imported Claude messages are synthetic session input too. The original no-model fixtures do not establish model-backed behavior, populated usage history, populated jobs, collab attachment or guest arbitration.

## Hook identities and input

Ordinary selectors and confirms use the data-first picker path because the app advertises `picker`. The root `k.^picker` has no role, stores items in `p.items`, selects `0` and declares `confirm` and `close`. Activation targets that picker id and its data item id, rather than an `item` child.

Input and editor roots remain columns `k` in `dock`, with `omp.overlay.hook-input` and `omp.overlay.hook-editor`. The focused fields are `n` and `l.input`. `k.actions/cancel` and `k.actions/submit` are native button nodes. The editor's `k.actions/external` button is unused because it opens an external editor. Edits use UTF-16 offsets, `from: 0`, the observed text length for `to` and `len`, and the replacement length for `cursor`. The input API's second argument is a placeholder, so the recorder explicitly edits the initial empty value before capturing or answering it.

Phase 4a re-recorded hook-select, hook-confirm, hook-input, hook-editor, extension-rows and
hook-collab-aware against the same standalone 18.15.0 executable, and added thirteen
`hook-parity-*` counterparts. The region counterparts contain all twenty options even when the
classic capture paints a window or search result. Parity editor descriptions use
`omp.hook-editor.detail`; all new captures use the same sanitizer and integrity manifests.

The custom rows root `k` has no role or document focus. The tree picker `o.^picker` has layout `tree`, focus `list`, null document focus, current entry `00000006` and actions `switch`, `summarize`, `label`, `filter`, `close`. Production callers must derive every id from their current host, surface and protocol epoch; these values describe only the recordings.

The navigation captures use tree picker `n.^picker` on `s:1`. The summary variant replaces it
with roleless rows picker `o.^picker`, title `Summarize branch?`, noun `options`, and choices
`0` (`No summary`), `1` (`Summarize`) and `2` (`Summarize with custom prompt`). Navigation emits
`Navigated to selected point` through `omp.toast.status`. In both captures the editor
`g.line/input` restores the exact string
`"  Add a branch for the alternate fixture answer.\nKeep café 🧭 spacing.  \n"` before the
clear event `{ ev: "edit", from: 0, to: 73, text: "", cursor: 0, len: 73 }`. The next frame
reflects the empty editor before `/exit`. These are recording-specific ids, with no collab
guest attached; production hook arbitration remains covered separately.

## Differences from 18.14.0

Of the 37 existing decoded message streams, 15 match exactly and 22 changed. No recorded action-name or role set changed. The empty jobs scenario does not contain the added populated-job roles `omp.jobs.title` and `omp.jobs.caption`; those registry entries come from upstream source.

- Hotkeys, jobs, session information, changelog, tools and exit-with-overlay now use native Close buttons. Input and editor captures use native Cancel and Submit buttons, and the external-editor action is a button too. Labels and keycaps move from children to `text` and `keys` props. Primary Submit carries `variant: primary`. Action ids and addressed node ids are unchanged.
- Session information reports build 18.15.0. Changelog and tool descriptions contain the release's current text. The model picker adds the Modular provider scope. No model is chosen.
- Tree picker user labels use `accent strong` spans. Entry ids, selection, actions and completion are unchanged.
- The settings preview shows the sanitized scratch-folder name and a changed context estimate (`7.7K/?` rather than `7.6K/?`). Import, sibling continuation, session information and error captures contain fresh generated identities, paths, times or elapsed values.
- Frame batching changes the captured message counts for `usage` (8 to 7), `hook-input-open` (7 to 8), `hook-confirm` and `tree-confirm` (8 to 9), `sibling-continuation` (7 to 8), and `restart` (13 to 12). These counts describe this run without attributing timing differences to a protocol change.
- The new BTW capture has eight messages; the former standalone capture had nine. It uses the same semantic submit and sanitizer pipeline as the other recordings.

Tests now check raw Escape against an open overlay or screen as well as row fallback, because every emitted input has an `afterMessage` boundary. Open-only hook input replay reads its own final pre-close document rather than borrowing another recording's frame count; the seeded value is emitted in a separate frame in this capture. Synthetic tests cover segmented tabs, button states, code `nums` and unclaimed `nativeTail` output, which the no-model menu scenarios do not exercise.

## Re-recording

From the worktree root with Node 24, Bun and the worktree's node-pty dependency:

```sh
node_modules/.bin/esbuild src/main/omp/tsp/record-fixtures.ts --bundle --platform=node --format=esm --external:node-pty --alias:@oh-my-pi/pi-wire=./src/renderer/src/collab/wire/index.ts --alias:@shared=./src/shared "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" --outfile=record-tsp.mjs
OMP_BIN=/absolute/path/to/omp-18.15.0 node record-tsp.mjs
rm record-tsp.mjs
```

Pass scenario names after the bundle path to record a subset. Node must execute the recorder: Bun returned no PTY data with this node-pty build. The bundle stays beside node_modules so Node can resolve that external native dependency. No Electron process starts. `VOMP_TSP_FIXTURE_DIR` can select a scratch comparison directory; `VOMP_TSP_LIVE_FIXTURE_DIR` enables the optional vocabulary comparison test against it.

The recorder currently supports macOS and Linux only, matching the preview transport. Recording roots stay under `/tmp`, within the sanitizer's documented path policy. The version-only preflight uses a separate OS temporary directory and never publishes its paths.

## Plan review scripted-provider captures

`plan-review-execute`, `plan-review-compact`, `plan-review-keep`, `plan-review-refine`,
`plan-review-discard` and `plan-review-save`, bringing the baseline to 63 recordings, use the recorder's isolated loopback provider.
The first scripted response writes `local://fixture-plan.md`, and the second writes the slug
`fixture` to omp's `xd://propose` device. That is omp 18.15.0's plan-submission route.
Each recording then activates the observed option id or cancels through its declared button.
Refine submits a follow-up comment, and Save confirms the default path in omp's path dialog.
The provider returns fixed text for any continuation or compaction request and records sanitized
request bodies in `.provider.json`. No external provider or account is used.
The app's existing permission-config Auto and extension plan-exit transitions are covered by card
tests; these PTY recordings cover their execute and cancel events without those mode changes.
To add a scripted scenario, set `script` to a list of `{ text }` or `{ tool: { name, arguments } }` replies.
A reply can have `delayMs` or a named `gate`; the scenario's `run` callback calls `release(name)`.
The callback receives `session`, `send`, `keys`, `until`, `find`, `requests` and the scratch `root`.
`config` merges scenario-specific settings, `tools` limits the enabled tools, and `collab: true`
attaches the recorder's guest for image transcript evidence. `script: []` configures the local model
without permitting any provider request. No Electron instance is started.
