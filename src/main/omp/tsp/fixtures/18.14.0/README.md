# omp 18.14.0 no-model recordings

These fixtures were recorded on macOS arm64 on 2026-10-30 from the installed executable reporting `omp/18.14.0`. The corresponding upstream release is tag `v18.14.0`, commit `31147f9d1a76608549821c3759f8487b4d66c72d` of [oh-my-pi](https://github.com/can1357/oh-my-pi/tree/31147f9d1a76608549821c3759f8487b4d66c72d). The executable's release version was checked; its binary was not independently reproduced from that commit.

## Capture format

Each scenario has four files:

- `<scenario>.raw.bin` contains PTY output with the privacy replacements below; ordinary terminal controls and TSP framing are preserved.
- `<scenario>.jsonl` is omp's own `PI_TUI_TSP_RECORD` journal with the same privacy replacements.
- `<scenario>.messages.jsonl` contains the messages decoded from those bytes by the app's `TspStream`.
- `<scenario>.events.jsonl` contains the app's emitted semantic replies and events. A `{ "keys": "\u001b" }` record identifies an Escape input between semantic events. Ordinary terminal replies are absent from this semantic event log; they are handled by the same writer.

The recorder uses the app's `TspSession`, including its hello reply, cumulative acknowledgments and semantic `send` submission. It opens each command, waits for its semantic response, dismisses any overlay or screen with Escape and submits `/exit`. The exit-with-overlay scenario specifically records Escape before the semantic `/exit` send. The fixture has no automatic process kill on the successful path.

## Isolation and configuration

Every scenario used a fresh HOME, USERPROFILE, XDG config and cache roots, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, session directory and temporary directory. Only PATH was inherited. No credential, API key, token or provider configuration variables were inherited. Extensions, skills, rules, context files, LSP and title loading were disabled with omp's launch flags. No model was selected and no model turn was submitted. The model picker can list credential-free local and web providers without invoking them.

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

The usage overlay with populated history, model-backed workflows, hook dialogs and collab question arbitration are outside these recordings.

## Re-recording

Run from the worktree root with Node 24, Bun available as the TypeScript bundler and the worktree's node-pty dependency:

```sh
bun build src/main/omp/tsp/record-fixtures.ts --target=node --format=esm --external=node-pty --outfile=record-tsp.mjs
OMP_BIN=/absolute/path/to/omp node record-tsp.mjs
rm record-tsp.mjs
```

Pass scenario names after `record-tsp.mjs` to record only those scenarios. Node must execute the recorder: the installed Bun runtime returned no PTY data with this node-pty build. The generated bundle stays beside the worktree's node_modules so Node can resolve the external native dependency. No Electron process is started.
