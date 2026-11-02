# omp 18.14.0 no-model recordings

These fixtures were recorded on macOS arm64 on 2026-10-30 from the installed executable reporting `omp/18.14.0`. The corresponding upstream release is tag `v18.14.0`, commit `31147f9d1a76608549821c3759f8487b4d66c72d` of [oh-my-pi](https://github.com/can1357/oh-my-pi/tree/31147f9d1a76608549821c3759f8487b4d66c72d). The executable's release version was checked; its binary was not independently reproduced from that commit.

The hook, custom-row and tree recordings were added on 2026-11-02 with the same installed release and isolation policy. `../extension/vomp-fixture.mjs` is the explicitly loaded fixture extension. `../extension/tree-session.jsonl` is a hand-authored version 3 session containing three user/assistant pairs and two branches. The assistant messages and zero usage values are synthetic session input, so displaying the tree requires no provider request.

The gate recordings added later on 2026-11-02 include startup warnings, an error without a model, extension selection, startup import, restart and session transitions. The import source contains two synthetic Claude JSONL messages under the scratch HOME. The sibling-continuation probe starts a second isolated omp on the seeded session, persists a title there, then renames from the first process. No owner session or profile participates.

## Capture format

Each scenario has four capture files:

- `<scenario>.raw.bin` contains PTY output with the privacy replacements below; ordinary terminal controls and TSP framing are preserved.
- `<scenario>.jsonl` is omp's own `PI_TUI_TSP_RECORD` journal with the same privacy replacements.
- `<scenario>.messages.jsonl` contains the messages decoded from those bytes by the app's `TspStream`.
- `<scenario>.events.jsonl` contains the app's emitted semantic replies and events. A `{ "keys": "\u001b" }` record identifies an Escape input between semantic events. Custom-row completion uses `{ "keys": "\r" }`. Ordinary terminal replies are absent from this semantic event log; they are handled by the same writer.

New recordings also include `<scenario>.integrity.json`, containing the sanitized raw stream's byte length, carriage-return count and SHA-256 digest before storage. The integrity test detects altered bytes after checkout. Git stores fixture `.bin` files as binary so CR bytes are preserved. JSON journals keep LF file delimiters; JSON stringification escapes CR characters within recorded values, so text normalization does not alter those values.

The recorder uses the app's `TspSession`, including its hello reply, cumulative acknowledgments and semantic `send` submission. Completed hook and custom-row scenarios report the extension's answer as an `omp.toast.status`, restore the composer and submit `/exit`. The exit-with-overlay scenario specifically records Escape before the semantic `/exit` send. Open-only scenarios capture the open UI and stop the child with `kill()`. omp responds with a retained surface close, without a closing-status toast or an answer notice. These captures preserve the open document immediately before that close.

New event records include `afterMessage`, the number of decoded program messages received before the event was written. A replay can present messages through that boundary and check the next application event against the document at that point. The tests check live target ids, declared actions and picker item ids, observed full edit lengths, exact interaction sequences and answer notices. They also compare the full decoded stream with the committed message file. Hook probe events use the observed wire shapes directly; this recorder does not establish the production host's collab arbitration or input authority.

## Isolation and configuration

Every scenario used a fresh HOME, USERPROFILE, XDG config and cache roots, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, session directory and temporary directory. Only PATH was inherited. No credential, API key, token or provider configuration variables were inherited. Discovery of extensions, skills, rules, context files, LSP and title loading was disabled with omp's launch flags. Hook and custom-row scenarios explicitly load the fixture extension with `-e`; `--no-extensions` still disables discovery. No model turn was submitted. The model picker can list credential-free local and web providers without invoking them.

`TERM_PROGRAM=tern` enabled TSP. `PI_TUI_NATIVE` was omitted. The recorder advertised the app's 44 supported kinds with an empty terminal feature list, two credits, 110 columns, light appearance and reduced motion. Its scratch config disabled setup, update and changelog checks, marketplace updates, autocomplete, recaps, predictions, automatic graphs and startup worktrees; exit worktrees were kept. The first hotkeys and jobs recordings used the operating system's temporary directory; later recordings used `/tmp`. All scratch profiles were removed after recording.

Before publication, OSC 7 file URL hosts are replaced with `localhost`, and private home and temporary roots are replaced with `/tmp/vomp-fixture`. Base64 OSC payloads are decoded, sanitized with the same replacements and re-encoded. The recorder applies these replacements to raw output, journals and emitted events, then decodes the sanitized raw output to regenerate the message files. APC framing and unrelated bytes remain unchanged. Generated session identities remain. A recursive privacy test checks plain content and decoded base64 OSC payloads.

## Observed scenarios

| Scenario | Command and observed presentation |
| --- | --- |
| hotkeys | `/hotkeys` opened `omp.overlay.hotkeys`. |
| jobs | `/jobs` opened `omp.overlay.jobs` with an empty job list. |
| usage | `/usage` emitted the main-region warning `No usage data available.` An empty, credential-free profile has no usage overlay to record. This fixture preserves that response rather than inventing usage history. |
| session | `/session` opened `omp.overlay.sessionInfo`. |
| changelog | `/changelog` opened `omp.overlay.report` with the Recent Changes heading. |
| tools | `/tools` opened `omp.overlay.report` with the Available Tools heading. |
| model-picker | `/model` opened a data-first `picker` directly in `layer`, without an overlay wrapper or role. It was dismissed without choosing a model. |
| settings-screen | `/settings` opened a second `omp.session` surface with `mode: screen` and a `prefs` node. It was dismissed without changing settings. |
| exit | Semantic `/exit` produced the closing status toast and closed the surface. |
| exit-with-overlay | `/hotkeys`, Escape and semantic `/exit` produced the closing status toast and closed the surface. |
| hook-select-open | `/vomp-fixture-select` opened a roleless data-first picker in `layer`. Its four items include descriptions and a long label. |
| hook-select | Activated item `1` on the picker and recorded `Fixture select answer: "Second option"`. |
| hook-select-cancel | Sent the picker's declared `close` action and recorded the null answer. |
| hook-input-open | `/vomp-fixture-input` opened `omp.overlay.hook-input` in `dock`, then a recorded `edit` supplied `Fixture default value`. |
| hook-input | Replaced the default with `Recorded fixture answer`, submitted through the declared button and recorded that answer. |
| hook-input-cancel | Sent the declared `cancel` action after seeding the default and recorded the null answer. |
| hook-editor-open | `/vomp-fixture-editor` opened `omp.overlay.hook-editor` with a two-line prefill. |
| hook-editor | Replaced the whole observed 38-character prefill with three lines, submitted through the declared button and recorded the answer. |
| hook-editor-cancel | Sent the declared `cancel` action and recorded the null answer. |
| hook-confirm-open | `/vomp-fixture-confirm` opened a roleless picker with Yes and No items. |
| hook-confirm | Activated item `0` (Yes) and recorded the true answer. |
| hook-confirm-cancel | Sent the picker's declared `close` action and recorded the false answer. |
| extension-rows-open | `/vomp-fixture-rows` opened a custom component with no `describe()` method. omp emitted a bare `rows` node in `dock`. |
| extension-rows | Sent raw Enter and recorded the completed answer. |
| extension-rows-cancel | Sent raw Escape and recorded the cancelled answer. |
| tree-open | Started omp with the crafted session through `--session`, then opened `/tree`. The roleless `picker` has `layout: tree`, six entry items and both branches. No navigation event was sent. |
| tree-confirm | Opened the same seeded tree and activated its current entry. The picker closed without a model request, then `/exit` closed the session. |
| extensions | Opened `/extensions`, selected the first rule row, then sent the picker's declared `close` action. No toggle or configuration write was requested. Its `expand` action remains unsupported by the app; known selection and Close stay interactive. |
| import-claude | Started with `--from-claude`, selected and activated the single synthetic session in the startup screen, observed retained close followed by a second hello, then exited the imported session. |
| startup-no-model | Recorded the one startup warning from an empty profile, then exited. |
| notice-error | Submitted text without a configured model and recorded `omp.notice.error`, without making a provider request. |
| restart | `/restart` closed the old surface with `keep: true`, negotiated a second hello on the same PTY and reused `s:1`. |
| new | `/new` changed the current session's documents without another hello. |
| resume | `/resume c040d770` selected the seeded session by id from the isolated session directory, without another hello. |
| sibling-continuation | A competing process persisted a title in the seeded file. The first process's rename continued in a new sibling file, with a warning and changed `omp_session_file` OSC value, without another hello. |
| hook-collab-aware | Recorded the open collab-aware selector. Tests inject matching and ambiguous collab request mirrors against this document; the capture itself runs without a guest. |
| handshake-timeout | Withheld every client reply and acknowledgment. omp withdrew its optimistic surface with `keep: false` and painted classic rows. The event file is intentionally empty because nothing was sent. |

Populated usage history and model-backed workflows remain outside these recordings. Collab room changes and question requests are injected by the host and screen replay tests; they are not observations of an attached live guest.

## Hook and fallback observations

The extension uses the public `registerCommand` and `ctx.ui.select`, `input`, `editor`, `confirm`, `custom` and `notify` APIs from omp 18.14.0. It has no imports, discovery dependencies, tools or model calls. Each command awaits its UI result and then emits a JSON-encoded answer notice, including cancellation.

Because the app advertises `picker`, ordinary selectors and confirms use the upstream data-first picker path. There is no `omp.overlay.hook-select` role on this path. The opened picker is `k.^picker` with items stored in `p.items` (ids `0` through `3` for select, `0` and `1` for confirm), selected `0`, and declared actions `confirm` and `close`. Global document focus is null. Activation targets the picker id and sends the item's data id. It does not target an `item` child node.

Input and editor dialogs remain columns in `dock`, with roles `omp.overlay.hook-input` and `omp.overlay.hook-editor` on root `k`. The input field `n` is focused. The editor field `l.input` is focused. Both expose `k.actions/cancel` and `k.actions/submit`, with `p.actions.click` naming their action. The editor also exposes `k.actions/external`, which was left unused to avoid launching an external editor. Edits use UTF-16 offsets, `from: 0`, the observed text length for both `to` and `len`, and the replacement length for `cursor`.

The public input API accepts a placeholder but has no default-value argument. Passing its second argument leaves `p.text` empty. The recorder therefore seeds the visible default with an explicit, logged `edit` of length zero before capturing or answering it. The editor API supports its two-line prefill directly.

The custom component renders two lines and handles raw Enter or Escape. It emits `rows` id `k`, `cols: 110`, no role and null document focus, with no semantic action declarations. Completion demonstrates that omp receives the raw key despite the null semantic focus. The actual sheet replay now verifies Enter and guarded Escape from this fallback.

The tree picker is `o.^picker`, with null document focus and `p.focus: list`. Its selected and current entry is `00000006`. It declares `switch`, `summarize`, `label`, `filter` and `close`. `tree-open` preserves opening alone; `tree-confirm` records activation of the current entry. The screen replay verifies that pointer selection emits nothing before confirmation.

These ids are observed recording values. The root `k`, field/action ids and restored composer `g.line/input` recur across separate scenarios. Production callers must obtain ids from the current document and scope them to the current host, surface and protocol epoch.

## Re-recording

Run from the worktree root with Node 24, Bun available as the TypeScript bundler and the worktree's node-pty dependency:

```sh
bun build src/main/omp/tsp/record-fixtures.ts --target=node --format=esm --external=node-pty --outfile=record-tsp.mjs
OMP_BIN=/absolute/path/to/omp node record-tsp.mjs
rm record-tsp.mjs
```

Pass scenario names after `record-tsp.mjs` to record only those scenarios. Node must execute the recorder: the installed Bun runtime returned no PTY data with this node-pty build. The generated bundle stays beside the worktree's node_modules so Node can resolve the external native dependency. No Electron process is started.

Set `VOMP_TSP_FIXTURE_DIR` to a scratch directory to compare a new recording without replacing the committed files:

```sh
OMP_BIN=/absolute/path/to/omp VOMP_TSP_FIXTURE_DIR=/tmp/vomp-tsp-comparison node record-tsp.mjs
OMP_BIN=/absolute/path/to/omp VOMP_TSP_LIVE_FIXTURE_DIR=/tmp/vomp-tsp-comparison npm test -- src/main/omp/tsp/fixture-vocabulary.test.ts
```

On 2026-11-02, the installed executable reported `omp/18.14.0`, and a separate no-model re-recording of all overlay, hook and transition scenarios used names recognized by the registry. The original committed captures were left unchanged. Among the first 36 comparisons, 28 decoded message streams matched exactly and all role/action sets were identical. `usage`, `session`, `tree-confirm`, `notice-error` and `restart` had frame-batching or transient-state timing differences; `settings-screen` had a generated scratch-folder display span; `import-claude` and `sibling-continuation` had generated identity, path or time differences. The later timeout capture included the already-registered `omp.notice.warning` before fallback, while the original timed out before emitting it. Its actions were unchanged. The comparison test reports vocabulary differences and rejects names absent from the registry.
