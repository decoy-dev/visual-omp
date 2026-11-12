# Bash execution visualization

## Status

visual-omp 0.8.0 ships this feature. Pseudo is the default view, with Raw beside it. Both render omp's canonical `ShellVizPresentation`, and replay opens explicitly in the same disclosure. Saved and helper traces are restored from `details.trace` through omp's native `ShellVisualization` API, in one isolated presentation process per window. The app does not implement another shell parser, infer variable values, decode the native syntax archive or replay shell commands.

The minimum supported omp remains 18.15.0. Feature availability follows reported settings, received semantic nodes and native API capability, because a version comparison cannot establish any of them.

The source references below come from omp v18.17.0 (commit `75e7801e247d4e3263439d4cc08ccad60dc64bdd`) and were rechecked against v18.18.3. The sections from "Baseline behavior" to "Risks" record the approved design; "Verification" summarizes what was measured. Static mockups use illustrative data, while the production captures show the shipped components connected to isolated omp.

## Baseline behavior and boundaries

- Before this change, `src/shared/tsp.ts` omitted `shell`, so omp supplied code fallback. Slice 2 adds the kind together with a generic renderer, exact transcript projection and guarded event handling. Older engines continue producing their existing code fallback.
- `src/renderer/src/chat/transcript/ToolCard.tsx` owns disclosure, grouping engagement, timestamps, friendly status and running output. `src/renderer/src/tool-render/tools/bash.tsx:51-105` renders the command, environment prefix, working folder, timeouts, async state, output, images, minimizer note and artifact reference.
- `src/shared/tsp/roles.ts` classifies `omp.tool.*` as replicated transcript content. Slice 2 adds an explicit command-pane projection into the collab-owned row and keeps unmatched shell descendants available through the generic omp screen.
- The host-agnostic renderer contract in `tool-render/types.ts` forbids importing the coding-agent runtime or Node APIs. The app supplies an optional presentation capability through the host boundary; a generic tool renderer remains usable without it.
- `docs/DESIGN.md` sections 3.5, 4.7 and 5.4 remain authoritative. Tool rows stay borderless and 32px high. Expanded content uses the existing output well, typography, token colors, Phosphor icons, spacing and radii. This feature adds no transcript card frame, sidebar mode, toolbar outside the disclosure or independent execution status.
- User `!`/`!!` shell runs, Python/eval visualization, extension transcript presenters, task cancellation and output-recovery changes are separate work. PTY and user-shell paths can lack traces. Their existing readable command and output presentation remains available.

## Data sources and identity

### Live app-hosted bash calls

TSP `shell` carries an engine-produced presentation, rather than a raw `RunTrace` snapshot. The source comment at the top of `wire/src/shell-trace.ts` describes the broader trace path; the actual `TspShellProps` contract is decisive.

`packages/wire/src/tsp.ts:943-959` defines:

| Field | Native app handling |
|---|---|
| `presentation` | Render canonical rows, semantic segments, row annotations, effects, output and timeline. |
| `inspector` | Show replay controls when an inspector is explicitly open. The inline node otherwise offers Raw/Pseudo, display options and Replay. |
| `replayEpoch` | Clear transient execution highlighting after seek, reset or live-mode changes. It is independent of transport generation. |
| `liveOrigin` | Permit live completion treatment only for a mounted call that received an execution-start event. Loading history must not animate it as new work. |
| `cwd`, `lang` | Retain the reported working folder and language. |
| `preview.lines` | Bound the initial command preview, with an explicit show-more control. It does not discard rows and does not apply in the opened inspector. |

The shell child has local key `input`. Its containing `tool` or `card` with role `omp.tool.bash` has `p.key = toolCallId` (`tui/src/chat/tool-execution.ts:1402-1407,1483-1489`; `tui/src/tools/bash.ts:720-742,790-804`). Match using that ancestor, rather than the child's key or command text.

The app's index key is the session/controller identity plus host id, host generation, TSP epoch and tool-call id. The indexed value includes surface id, node id, surface sequence and the current ancestor identity. Equal command strings, adjacent cards, timestamps and tool names are insufficient matches. Parallel calls and repeated identical scripts must remain independent.

Build the index from the current document tree. Ignore hidden ancestors, suspended or unavailable surfaces and obsolete document generations for interactive ownership. Hold an unmatched semantic presentation only within that live document's lifetime: collab and TSP can arrive in either order. A matching collab row adopts it when available. Missing, ambiguous or malformed matches leave the normal bash card readable.

When the app presents a matched shell child, register its exact conditional presentation claim using the existing claim mechanism. Do not claim the complete `omp.tool.*` namespace. Preserve generic omp-screen access for unmatched or unsupported content. The full-screen shell inspector can appear without the transcript ancestor; it belongs to its actual overlay surface and must never be matched to the most recent bash call by guesswork.

### Saved results, helper runs and classic hosts

`packages/wire/src/shell-trace.ts:203-224` defines the persisted `ShellTrace` v1 shape. The tool stores it as `details.trace`. `RunTrace` is the native live owner; the JSON result is a snapshot, rather than a JavaScript `RunTrace` instance.

Important trace fields are `script`, monotonic `seq`, `t_ns`, root `status`, `rootVpid`, compiled `units`, optional ordered `history`, `historyTruncated` and diagnostics. Unit source spans are UTF-8 byte offsets. History is sequence-ordered; concurrently recorded event timestamps can regress within that order. Output identity can include unit/node, virtual process and command tag `{run, vpid, seq}`. `run: 0` is permitted. Missing ownership stays unknown. Multi-producer UTF-8 characters can carry byte-level `contributors`, with no single primary producer.

Saved and helper views already share `watchSessionFile` in `src/renderer/src/state/sessionFiles.ts`. Helper file discovery is through `sessions:helperFile` and `HelperConversation` (`features/panes/helperConversation.ts:144-160`). Reuse these readers and the existing active-branch history. Pass the exact result/tool-call identity into the visualization host capability; do not build another session scanner or copy the complete session into a feature store.

The canonical restore path is `new ShellVisualization(JSON.stringify(snapshot)).present(options)`, declared at `packages/natives/native/index.d.ts:649-656` and implemented in `crates/pi-natives/src/shell.rs:101-124`. `tui/src/tools/shell-viz.ts:20-55` restores once per snapshot, maps a held cursor to `cursorSeq`, decodes the presentation and substitutes ordinary output only while following latest.

All restored-trace computation must execute in a dedicated, isolated omp presentation process, including while an agent host exists. `ShellVisualization` construction and `present()` are synchronous (`crates/pi-natives/src/shell.rs:101-124`); native presentation reduces retained history and serializes its response (`crates/pi-shell/src/bash/trace/viz/mod.rs:203-215`). A damaged or expensive trace must never stall an active agent's event loop. The public package-root mapping includes `@oh-my-pi/pi-natives` (`coding-agent/src/extensibility/plugins/legacy-pi-compat.ts:995-1002`). Probe the dynamic import and constructor/presentation methods inside the isolated process, independently of live host capability.

The presentation process may restore explicitly supplied trace data and return presentation data. It must not resume the saved session, claim its lease, execute the script, load project extensions, access provider credentials or start a model turn. Use the existing executable locator and environment/process infrastructure with a fresh HOME, private agent directory and neutral cwd. Its PID and process lifetime are separate from every agent host and bash run. Cancellation, request timeout, memory refusal and disposal can terminate only this presentation process. They must never call the session host's stop or abort paths.

Every request has a parent-enforced deadline and an independent termination path, because a synchronous native call cannot service its own cancellation. A worker crash fails its pending requests, preserves ordinary output and permits explicit retry in a fresh process. A stale response after cancellation never updates the viewer. The first slice must prove this bootstrap against the installed binary without depending on guessed npm layouts or a second bundled addon. Failure to establish safe canonical access is a hard prerequisite failure and requires an explicit scope decision before further implementation.

Classic hosts have no live TSP shell nodes. Use their trace updates/results through the same canonical restore adapter where present, and keep their terminal handling unchanged. Helper transcripts currently update at complete disk entries, so this design promises settled/helper trace visualization rather than word-by-word helper shell streaming.

### Source precedence and lifecycle

1. A valid, exactly matched current TSP shell presentation controls the live command pane and its engine-owned preferences.
2. When that node disappears or the host exits, use a validated result trace through canonical restoration. Do not preserve a disappearing live node as an interactive endpoint.
3. If collab shrank the trace, recover the exact settled result through the existing saved-file reader when that local source is available. This recovery must preserve session, branch and tool-call identity.
4. When no usable presentation is available, retain the original command, output, images, exit information and artifact notice. A failed visualization request shows a bounded explanation inside the disclosure and can be retried explicitly.

A partial update is never treated as final merely because it has a trace. Background job state follows `details.async.state` and the existing ended-call rules. A late trace update must not return an ended call to active tools or change the chat's working state. Clear interactive indexes, bridge requests and replay state on host replacement, room/session change, branch switch and disposal. Saved snapshots may remain readable without retaining live event authority.

## What omp presents

The following behavior is derived from the v18.17.0 source. It establishes the presentation to reuse, rather than a second specification for shell semantics.

| Area | omp behavior and source |
|---|---|
| Default | Pseudo, all five layers enabled, one pane, latest position, paused, normal speed (`tui/src/tools/shell-viz.ts:30-39`). Preferences are per tool call. |
| Raw | Shows original shell syntax with semantic tokenization, runtime execution metadata, actual state and observed setter annotations. Raw remains an execution visualization. Turning off Color affects syntax styling while semantic chips retain meaning (`shell-viz-render.ts:25-42`). |
| Pseudo | Produces Python-like display rows for shell structure, functions and conditions. It can inline values, summarize idioms and unwrap embedded languages. This is a non-executing presentation transformation (`wire/src/shell-viz.ts`; `crates/pi-shell/src/bash/trace/viz/semantic_tests.rs`). Unsupported/unannounced syntax can remain literal shell text. |
| Execution | Pending, running, ok, fail and skipped are distinct engine states. Only actual executing leaves are active. Inactive spans dim while leaves run. Segment failure can remain visible inside a successful pipeline or chain (`shell-viz-render.ts:45-87`; native `viz/runtime.rs:428-479`). |
| Variables | Latest observed values appear at their actual setter rows, including scope and retained-length information. The inspector can show details. Replay changes or removes annotations as setters move through the cursor. Unlocated setters retain the engine's explicit presentation row; no function frame is invented (`wire/src/shell-viz.ts:75-91`; native `viz/printer.rs:350-445`). |
| Effects | Network, write, destructive, secret, privilege and background labels have engine-provided explanations. They are heuristic annotations, with no guarantee of safety or completeness (`wire/src/shell-viz.ts:50-55`). |
| Output | The inline shell node supplies the command pane. A sibling output segment shows ordinary tool output while following latest, and retained replay output while a cursor is held (`tui/src/tools/bash.ts:780-806`). The current semantic presentation exposes combined output, without a structured per-producer output list. |
| Inspection | Explicitly opening the visualizer gives selection, expansion, source/detail text, variable values, effect explanations, Raw/Pseudo, layers and optional Original/Pseudo split. Narrow terminals stack the split (`apps/shell-visualizer.ts:24-165`; `shell-viz-render.ts:115-155`). |
| Replay | Play/pause, one-event step, reset, seek, latest/live and 0.5x/1x/2x/4x speed operate over retained history. Playback follows measured event time on an 80ms engine timer. History replacement remaps a held cursor by sequence. Replay never reruns the command (`chat/tool-execution.ts:617-726`; `tools/shell-trace.ts:27-79`). |

Per-producer output exists in the trace journal (`wire/src/shell-trace.ts:121-200`), but the inspected TUI renderer displays a combined Output section. Do not describe producer grouping as already supplied by TSP. A native app producer selector requires the trace journal or an additional canonical presentation export.

## Proposed app experience

### Inside the existing bash disclosure

Keep the collapsed row unchanged. Opening it shows the intent, then one existing-style command/output well with a compact toolbar. The toolbar contains a Raw/Pseudo `Segmented`, Copy command, Display options and Replay. Pseudo is initially selected, following omp. The setting's absence or a missing trace leaves the current card unchanged and adds no disabled toolbar.

Raw and Pseudo are mutually exclusive. Changes preserve selection and replay position. Copy command always copies the exact original shell source; selection copying retains the visible text. An optional Copy displayed text action must be explicitly labelled. Pseudo has a short first-use explanation: "Pseudo is a display translation." Nothing in this viewer submits the translated text for execution.

Rows render canonical depth and segments as selectable text. Map semantic syntax tokens to existing syntax colors, with a fixed status gutter and a readable status name in the accessibility tree. Running, Failed, Done, Pending and Skipped have distinct shapes or text. The outer tool result keeps its existing status even when a nested command failed and recovery made the tool successful. Unknown state adds no invented success. Source ranges use the presentation's UTF-16 coordinates; raw trace byte offsets never index JavaScript strings directly.

Observed variable annotations appear immediately below their setter when inline width is insufficient. Selecting the statement opens one flat Details section in the well, containing the original source, reported status/metadata, retained value, scope and effect explanations. Long values expand on request and identify upstream truncation using `fullLength`. A complete value that omp did not retain cannot be recovered by this UI. Avoid a detached variable dashboard and avoid a nested card per variable.

Effect labels use existing warning/neutral tokens and named Phosphor icons, with the engine's `label` and `why` available by pointer and keyboard. Their explanation states that annotations can be incomplete. They neither grant approval nor alter existing permission handling. Secret annotations are not a redaction guarantee; values and argv may contain credentials already retained by omp. Do not add trace data to logs, analytics or automatic clipboard actions.

The ordinary output stays below the command and keeps its current images, show-more behavior, minimizer explanation and artifact references. Following latest uses collab/result output. Holding a replay cursor shows canonical retained replay output with a clear "Viewing replay" label and an explicit Original output action. Never silently replace complete final output with the smaller retained journal. Interim `details.replies` remain assistant prose outside the command disclosure.

### Display options and split

The menu exposes omp's Color, Inline values, Idioms, Effects, Unwrap and Original/Pseudo split controls, with checked state from canonical preferences. Use sentence-case labels and keyboard-operable menu items. A layer change changes presentation only. Original/Pseudo split is meaningful in Pseudo; in Raw it remains unavailable with a short explanation. At small disclosure widths the two panes stack and each retains its label. No horizontal page overflow is permitted.

### Replay and producer output

Replay is an explicit disclosure within the open bash body, rather than a separate app modal. It adds Reset, Play/Pause, Previous event, Next event, a labelled seek slider, event count, elapsed time, speed and Latest. Playback is initially paused. The app does not take Space, arrows or letter shortcuts from the composer; shortcuts apply only while focus is within replay controls. Opening or closing the tool body must not abort or restart the bash run.

For a TSP-owned call, send the canonical action vocabulary to the actual shell node. `inspect` opens omp's inspector, whose `inspector: true` shell node must also have a working generic renderer. Recommended inline replay controls can dispatch the same seek/play actions to the original node; the app must respect the inspector prop for the generic omp-screen rendering. Collapsing app replay explicitly pauses engine playback so a hidden timer cannot continue. Preferences remain engine-owned during this path.

For a restored trace, the adapter uses omp's presentation API with the equivalent preferences. It owns the presentation clock and request scheduling, without reducing shell execution events in JavaScript. The playback clock uses prefix-max event times to accommodate native timestamp regressions, while canonical restoration and replay use the unchanged source and `cursorSeq`. Cursor progress cannot be reconstructed from character output or wall-clock transcript timestamps. Late responses for earlier seek positions are discarded.

The output scope initially reads All output. Selected command becomes available only when validated journal provenance can identify the selected execution. Group repeated executions by their full command tag and retain event order; the same AST node can execute many times. Output with no producer appears under Unattributed output. Mixed `contributors` must remain visibly mixed or unattributed unless the canonical adapter supplies a correct mapping. Do not infer a producer from matching text, adjacent events or a shared process id. A missing producer list in TSP keeps All output usable and explains that command-specific output is unavailable until trace data can be read.

The implementation should prefer a canonical producer projection from omp's runtime. If none exists, a narrow adapter may group exact journal tags and return text without interpreting syntax or replay state. Node selection uses the canonical native node identity. Mapping native projection keys to trace unit/node identities needs explicit proof in the first slice; the app must not decode opaque keys to guess that mapping.

A trimmed timeline shows "Earlier replay events were omitted. Only retained history is available." Zero retained events shows "Replay is unavailable for this trace." Latest returns to the most recent state, including updates received while replay was paused. A call that ended remains ended while the user reviews an earlier position. Closing replay preserves the selected view and returns output to latest.

## Controls, events and host integration

Existing TSP event schemas accept string-valued action data, but the main-process allowlist rejects unknown actions (`src/main/omp/tsp/session.ts:290-324`). Add a narrowly validated `shell-viz` action only alongside the renderer and projection. A generic allowlist addition alone is insufficient.

Live events use `{ev: "action", sf, id, act: "shell-viz", value}`. The upstream mapping accepts `view:raw`, `view:pseudo`, `layer:<name>`, `split`, `inspect`, `play`, `pause`, `step`, `reset`, `live`, `seek:<integer>`, `speed:<supported value>`, `select:<opaque node key>` and `expand:<opaque node key>` (`tui/src/tools/shell-trace.ts`). Previous event can use a bounded seek. Validate the exact vocabulary, bounds and current shell target in main at dispatch time. Preserve existing host/generation/epoch, surface, lifecycle, overlay and read-only guards. Rendering an old snapshot never authorizes a new event.

Read-only restoration requests are separate from live TSP actions. A saved or externally owned chat may send local Raw/Pseudo, selection and replay options to the isolated presentation process. These requests cannot write to, send input to, resume or terminate the owning host. They cannot alter the session file or lease. Read-only status prohibits live TSP events to that host; it does not prohibit local inspection of persisted data.

Proposed ownership is deliberately small:

- A shared pure projector indexes matched TSP shell nodes and their ancestors. Extend the vendored wire types and renderer node switch with attribution in NOTICE as required by the existing convention.
- A lazily loaded app visualization component renders canonical rows and the optional inspector, reusing `Segmented`, menu, tooltip, button, disclosure and motion primitives. The existing `ToolCard` supplies exact call identity and its host capability. No omp runtime import enters `tool-render/` or the renderer bundle.
- A main-owned restoration adapter resolves source/result identity and delegates native presentation to omp. A bounded handle identifies a restored trace; later interactions send options and receive presentation, without repeatedly sending the whole trace through renderer IPC.
- The current config service supplies setting value and capability. The existing session/file reader supplies settled traces. No additional trace database, session persistence format or global preference store is introduced.

BoardUI's `segmented-control` and `slider` references were consulted for single-selection, keyboard behavior and controlled seek updates. visual-omp's existing primitives and tokens remain authoritative; no BoardUI package, theme, dependency or agent rule is installed.

## Setting and compatibility

`display.shellVisualization` is a boolean, default true (`coding-agent/src/modes/settings.ts:820-829`). The setting changes display, while trace capture can continue. It must not be presented as a way to disable trace storage or fix C28.

Use the effective setting for the chat's folder through the existing config service, including project, global and higher-priority source behavior. Advanced remains the editor in this feature; avoid a second app-owned toggle. A dedicated setting control can be considered separately. Reflect config writes and external config changes using the existing invalidation/watch paths. Live TSP itself remains authoritative for whether omp chooses to emit the visualization. Recheck saved/helper presentation when its effective setting changes.

| Observed capability | Behavior |
|---|---|
| Valid shell node and effective setting enabled | Show canonical live presentation and valid live controls. |
| Setting explicitly false | Immediately remove visualization and stop replay; keep command/output. Do not write a host overlay forcing the setting. |
| Setting missing, unknown or failed to read | Keep the existing card until capability is established. Do not assume an older engine has the setting. |
| Valid trace plus native restore/present capability | Show saved/helper/classic trace presentation while setting is enabled. |
| Trace missing, malformed, unsupported or visibly collab-shrunk | Keep ordinary output; seek an exact local settled result where available and report unavailable replay without fabricating state. |
| Engine has no shell support | Continue its code fallback and current collab card. The app's expanded vocabulary must not change supported 18.15/18.16 behavior. |

Slice 2 advertises `shell` alongside the working generic renderer, transcript projection, event handling and bounded fallback behavior. The minimum supported omp remains 18.15.0.

## Performance and large traces

Upstream bounds are substantial: newest 20,000 semantic/output records, at most 2 MiB retained visible output and 8 MiB retained journal payload (`wire/src/shell-trace.ts:217-222`). These are journal bounds, rather than an 8 MiB ceiling for the entire serialized trace. Script, units, opaque syntax archives and other data add bytes. Adjacent output may coalesce and change sequence; replace the journal on revision instead of appending a guessed delta.

The executor polls at 80ms (`coding-agent/src/exec/bash-executor.ts:162-187`). The app should subscribe at the narrow call/presentation boundary, coalesce multiple source notifications to the latest revision, skip unchanged presentations and render no faster than the source. It must not trigger a complete transcript rebuild for each trace revision or run a second animation timer for command state. Only explicit replay requires a presentation clock.

Slice 1 established the following initial gates. Renderer and main-process integration must enforce them in the later slices:

| Limit | Proposed policy |
|---|---|
| DOM rows | Initially 200 visible command rows and 50 variable/detail entries; explicit paging retains access to all supported content. Long output keeps the existing preview. Never mount 20,000 event rows. |
| Restored native state | At most four open trace handles per window, 32 MiB aggregate source JSON and 512 MiB native-process/job RSS. Windows also has a separate 160 MiB watchdog for its one per-window monitor; either breach stops both, and the combined 672 MiB threshold multiplies across windows. The parent samples RSS every 100ms. An unknown POSIX observation requires one independent OS snapshot before failing closed; each attempt has a 1-second parent deadline, so continued uncertainty can add two sequential query deadlines to detection. These are watchdog thresholds with sampling and termination latency, rather than OS hard-allocation limits. Evict inactive handles before admitting more work; otherwise refuse the new restore with ordinary output retained. |
| Automatic restoration | Up to 16 MiB serialized trace data per request, accounting for script and syntax as well as journal bounds. Larger traces show an explicit limit outcome with ordinary output preserved. This is an app protection limit, rather than an omp schema guarantee. |
| Presentation shape | At most 2 MiB UTF-8 response JSON, 50,000 total segments, 1,024 segments in one row, 64 KiB row-text bytes and 16 KiB per annotation/value. Check before renderer IPC or DOM work. Apply the same shape limits to live TSP projections. Every refusal retains ordinary output. |
| Requests | One computation in flight per isolated process and one queued latest request per handle. Parent deadline: 2 seconds after dispatch, with process termination within 250ms of cancellation/expiry. Startup deadline: 15 seconds. Coalesce slider dragging and reject obsolete responses by request sequence and source revision. |
| Hidden content | Do not restore closed historical disclosures. Pause playback when the card closes, the chat/helper view is hidden, the app backgrounds or the setting turns off. Release handles on disposal and idle expiry. Live ingestion continues through existing host state. |
| Loading | Keep the command/output immediately visible while the lazy component and native adapter initialize. A failed optional load does not replace the transcript with an error boundary. |

Pass thresholds are small-trace seek p95 at most 250ms, retained-history seek p95 at most 1 second and maximum parent heartbeat delay at most 100ms on a 20ms heartbeat. Record native-process baseline/peak RSS separately. These are acceptance gates for four simultaneous handles, oversized live presentations and enormous rows/values. The Verification section records the measured results. UI integration still requires its own input-response and render measurements; the isolated native benchmark does not establish renderer performance.

### C28 and complete output

The collab replication ceiling is 1 MiB per payload. Generic shrink passes shorten strings and arrays together, progressing through 64/16/4 KiB string limits and smaller budgets; an irreducible entry becomes `collab-entry-too-large` (`coding-agent/src/collab/replication-shrink.ts:49-110,331-386`). Trace data shares this budget with ordinary content. A trace can therefore be malformed or incomplete after replication, and ordinary output can be shortened as a side effect.

C28's dedicated fixture and any recorded reproduction belong to that workstream. This Phase 1 document did not rerun it or establish a new runtime result. The feature must consume the output-preservation fix if available and test against it. Disabling visualization cannot establish complete output, because capture and display are separate paths.

Recovery order is the exact persisted tool result, then the current readable collab result with its existing loss notice. Do not treat a collab-elision string inside a value or history record as valid execution data. A retained valid TSP presentation may continue to show live commands while the collab trace is unusable, but its combined output is not proof that all original output was retained. Missing remote/local files remain explicit loss cases. Artifact references retain the existing plain-text behavior until a separate artifact viewer exists.

## Accessibility and motion

- Raw/Pseudo uses one labelled, single-select control with arrow-key navigation and a persistent focus indicator. The selected state is available to assistive technology.
- Source and values remain selectable text in document order. Use bidirectional isolation for paths and untrusted values. Long lines scroll within the well or wrap at safe boundaries; larger app text sizes must remain usable in split chats.
- Row selection uses a roving keyboard focus target and accessible state names. Details remain reachable without pointer hover. Avoid one Tab stop per syntax token.
- The replay slider reports event position and elapsed time with `aria-valuetext`, supports arrows and Home/End, and has adjacent Previous/Next controls. Playback controls have stable labels and names. Numeric time and event count use tabular numerals.
- Use glyph plus text for failures and execution status. Dimming never makes readable text fail contrast. Effect meaning remains available with color disabled.
- Preserve the transcript's `aria-live="off"` behavior. Do not announce every command event, variable assignment, timer tick or seek drag. Announce an explicitly chosen replay position or unavailable state once, politely. Existing completed-reply announcements remain unchanged.
- All motion follows `ui/motion.tsx` and reduced-motion preferences. Reduced motion removes pulsing and completion trails, while retaining actual state and manually requested replay. Loaded history has no live execution entrance. Playback never starts automatically.
- Preserve focus when rows update. Removing a selected row after source replacement moves focus to Details or the toolbar. Closing replay returns focus to Replay; closing the tool returns focus to its existing row toggle.

## Implementation slices and acceptance tests

Approval of this document authorizes planning of the following slices. Each slice must retain existing card behavior until its capability works end to end. Full C16 completion requires all slices, including saved/helper behavior and the large-trace release gate.

### Slice 1: prove canonical runtime access and identity

Establish an isolated fixture using the installed omp, fresh HOME and `PI_CODING_AGENT_DIR`, explicit environment allowlist and the existing loopback provider infrastructure. Prove the dedicated presentation process's dynamic import, restore and present APIs without resuming a user session. Use a separate isolated agent host only to capture actual TSP/collab identity and the native live-owner reference presentations. No restored trace is computed in that host. Capture Raw and Pseudo for the same completed trace, establish selection-to-producer mapping or record the required upstream projection, and record numeric performance pass thresholds before proceeding.

Acceptance tests:

1. A real loopback bash call yields a shell descendant whose ancestor key matches the collab call id; two identical parallel commands remain distinct.
2. Restoration returns the same canonical rows, annotations, states and replay output as the live native owner for selected cursor positions, including non-ASCII source and an embedded function body.
3. The helper and saved-only adapter performs zero model requests and leaves the source session file and lease untouched. It has no provider credentials and loads no ambient project extension.
4. A missing native export on supported older omp returns an unavailable capability. No dependency installation or minimum-version increase occurs.
5. Cancellation during native work, parent-enforced timeout and presentation-process crash preserve ordinary output, reject stale responses and permit a fresh retry. Their termination path cannot affect the separate agent host or any actual bash run.
6. A saved or externally owned chat supports local Raw/Pseudo and replay with no owning-host event, model request, source-file change or lease change.
7. Four simultaneous handles, one enormous row/value and an oversized live presentation exercise measured memory, response-shape and responsiveness limits. Record explicit pass thresholds and results, including seek p95 and maximum parent heartbeat delay.

### Slice 2: live command pane and guarded controls

Add the shell wire shapes, pure projector, generic shell renderer, lazy transcript integration and narrowly guarded action path together. Then advertise the kind.

Acceptance tests:

1. A foreground command visibly transitions through reported leaf states, displays observed variable values and preserves the ordinary output, minimizer note, images and artifact reference.
2. Raw/Pseudo and every display layer update the same call; Copy command retains original source. Split remains readable at narrow width and large text size.
3. A failing pipeline leaf remains visibly failed when the overall tool succeeds. Skipped branches do not become Done. PTY/no-trace commands retain existing rendering.
4. TSP-before-collab and collab-before-TSP produce one tool row. Unmatched, duplicate, hidden and old-generation nodes do not hijack another card or suppress fallback content.
5. Stale actions, wrong targets, unsupported values and read-only views cannot send live TSP events to an owning host. Local restored-trace Raw/Pseudo and replay remain available in saved and externally owned views through the isolated presentation process, without changing the owning host, session file or lease. Opening omp's own inspector also renders correctly.

### Slice 3: saved, helper and background continuity

Attach canonical restore to existing saved-file/helper readers and exact tool-result identity. Handle current trace revisions, source switching, configuration and background completion without duplicating transcript state.

Acceptance tests:

1. Closing and reopening the app preserves readable saved visualization through the persisted trace. Helper focus uses the same component and shows completed file-backed trace updates.
2. Background trace updates continue in their original card without reactivating ended tools or changing chat working state; late job completion preserves existing status rules.
3. Turning `display.shellVisualization` off removes visualization and stops replay in live, saved and helper views. A project override wins according to omp's effective config. Missing setting retains the old presentation.
4. Malformed, unsupported, collab-shrunk and absent traces keep command/output usable. Exact local saved data recovers only its matching result and branch.

### Slice 4: replay, selection and attributed output

Add explicit replay controls, native restoration options, measured scheduling and provenance-backed output filtering.

Acceptance tests:

1. Reset, previous/next, seek, play/pause, supported speeds and Latest show canonical state, variables and output for the chosen position. They do not invoke a shell or submit a model prompt.
2. A changing live trace remaps a paused cursor by sequence, including coalesced output and trimmed history. An old asynchronous seek response cannot replace a newer one.
3. Repeated loop executions, concurrent producers, `run: 0`, unknown producers, merged descriptors and multi-producer UTF-8 contributors retain exact ownership or an explicit unattributed state. All output remains available.
4. Hiding the chat, closing the disclosure, changing the setting or disposing the session stops playback and releases runtime resources. Reopening starts paused.
5. Screen-reader and keyboard use reaches the view switch, row Details, replay slider, speed and Latest without composer shortcut interception or per-event announcement spam.

### Slice 5: performance and release evidence

Exercise valid multi-megabyte traces and C28's reduced/omitted result fixtures. Record source bytes, maximum retained handles, DOM rows, seek latency and main/renderer responsiveness. Verify the stated budgets and complete output behavior. Headless Chrome screenshots cover light/dark, 760px transcript width, minimum split-chat width, larger text, trimmed history and disabled setting. Stop Vite afterwards; never launch Electron from a worker.

Run typecheck, the affected consumer-visible suites, then `npx electron-vite build && node scripts/guard-renderer-bundle.mjs` once after implementation integration. Report renderer entry bytes and lazy chunk boundaries. No native code, opaque syntax data or heavy restoration dependency may enter the initial renderer chunk. Existing supported-version transport fixtures must continue to exercise 18.15 and 18.16 fallback behavior.

## Risks and decisions requiring evidence

| Risk | Decision or mitigation |
|---|---|
| Installed omp export or safe saved-only bootstrap differs from source | Prove it first in Slice 1. A wrapper-local shell interpreter is excluded. Report an upstream prerequisite if safe canonical access is unavailable. |
| Opaque native node identity cannot be mapped to producer tags | Request or use canonical producer projection. Keep exact journal attribution and combined output, and do not claim selected-command filtering until mapping is proven. |
| TSP and collab disagree after reconnect or trimming | Match exact scoped identity, retain source provenance and switch atomically to a validated settled trace. Outer transcript state stays collab-owned. |
| Multi-megabyte traces amplify parse, IPC and native restoration work | Lazy handles, source revision caching, bounded concurrency, explicit resource limits and large-trace acceptance measurements. |
| C28 shortens content or removes a result | Reuse its authoritative saved-result recovery and loss presentation; a visualizer cannot establish missing output. |
| Native restore of old or damaged syntax archives fails | Treat the archive as opaque and report unavailable visualization while retaining command/output. Preserve the source data for an explicit retry with compatible omp. |
| Effects or Pseudo imply more certainty than they provide | Label display translation, retain original source, expose reported explanations and keep permission decisions independent. |
| Secrets already appear in traces | No extra logging, telemetry or automatic copying. Existing sharing/anonymization policies still apply; a secret effect does not certify redaction. |
| Background or hidden replay continues consuming CPU | Explicit pause/disposal at every visibility and lifecycle boundary, with stale replies ignored. |
| Saved/helper scope quietly becomes a future task | Treat canonical restoration as required for C16 completion. Any reduction requires an explicit owner decision. |

All five slices are implemented. Producer filtering remains unavailable until omp offers a canonical mapping from presentation rows to producer tags.

## Verification

Every slice was exercised on macOS against isolated omp 18.17 and 18.18 installations, with loopback providers, scratch profiles and no owner credentials:

- Restoration through the presentation process matched omp's own `RunTrace.present()` for Raw, Pseudo and replay positions. A damaged trace was refused by native deserialization while the process stayed available.
- With four simultaneous handles over 14 MB of trace source, retained-history seek p95 was 8.40 ms and small-trace seek p95 1.49 ms. A fifth handle was refused, peak native RSS was 507,854,848 bytes and the worst parent heartbeat delay was 44.64 ms. The memory watchdog stopped the complete process group about 100 ms after the threshold was crossed.
- Cancellation, timeout and crash termination finished within 97 ms, and source files, session leases and model-request counts were unchanged by restoration.
- Saved, helper and read-only views, project setting overrides, the disabled setting, retained-history notices and complete ordinary output passed in the production components. Replay kept its cursor across source revisions, released playback when a card closed, its chat was hidden or the setting turned off, and left the composer's keyboard shortcuts working.
- In six synthetic canonical-shaped renderer cases with 200 mounted rows per viewer, programmatic input to committed DOM and paint had a p95 of 67 ms. That figure excludes OS input and IPC delivery, so it is not an end-to-end responsiveness measurement.

The integrated 0.8.0 build was checked in the development app with omp 18.19.0. Saved traces restored through the presentation process in Pseudo and Raw, with recorded values, a failed pipeline command, a skipped branch and replay, and a live run showed omp's shell nodes for the same script. That check found that the preload bridge refused the viewer's original `shell-viz:*` channel names, which crashed the window when a saved call opened; the channels are now `shellviz:*`, a type check rejects channel names the bridge would refuse, and a boundary keeps a viewer's rendering or lifecycle failure inside its card.

Production-component captures: [light](assets/bash-visualization/saved-080-light.png), [dark](assets/bash-visualization/saved-080-dark.png), [760px transcript](assets/bash-visualization/saved-080-transcript-760.png), [360px at 130%](assets/bash-visualization/saved-080-split-360-130.png), [disabled setting](assets/bash-visualization/saved-080-disabled-setting.png), [trimmed history](assets/bash-visualization/saved-080-trimmed-history.png), [trimmed 360px at 130%](assets/bash-visualization/saved-080-trimmed-360-130.png) and [settled helper](assets/bash-visualization/saved-080-helper-settled.png).

### Windows

On Windows, one PowerShell monitor per window owns omp in a kill-on-close Job Object, samples the job's working sets natively and stops the tree through the job handle. The last VM gate ran on 2026-11-10 with omp 18.18.7, on Windows 11 for ARM64 under Parallels, with five native cases on two omp builds:

| Check | x64 omp (under emulation) | ARM64 omp |
|---|---|---|
| Direct, descendant-tree and abort closes | Pass | Pass |
| Memory watchdog | Pass | Monitor exit 89.14 ms after a 16.16 ms empty-job acknowledgement |
| Startup cancellation and unrelated-process protection | Pass | Pass |
| Worst parent heartbeat delay (100 ms budget) | 70.48 ms | 101.91 ms |

The owner accepted both ARM64 results on 2026-11-12 and chose not to rerun the gate before release. The monitor's exit now counts against the same 250 ms close window as the acknowledgement, and the total bound is unchanged. The recorded memory case closed in 105.30 ms, which meets that criterion, but the revised implementation itself has not run on Windows. The heartbeat overrun occurred during worker startup with no app callback, synchronous call or garbage collection recorded in that interval, and the x64 run in the same VM passed, so the owner accepted it as VM scheduling. The gate's 100 ms threshold is unchanged.

Physical x64 hardware was not measured. visual-omp publishes no Windows ARM64 build, so ARM64 Windows runs the x64 app. Two Windows trace cases remain open: corrected `/?` help probes were prepared but not run, and one earlier x64 trace case lost its job before capture finished. The raw VM evidence is kept outside the repository with the private release notes.

## Design mockups

These static mockups reuse the token stylesheet and local Geist font packages, and were captured through headless Chrome from an isolated Vite server. They illustrate composition and controls only; the sample row text is illustrative rather than an asserted native translation.

- [Pseudo during execution](assets/bash-visualization/pseudo-live.png) shows the selected view, inline setter value, effects and ordinary output.
- [Raw during execution](assets/bash-visualization/raw-live.png) shows syntax-styled original source and observed setter annotations with the same toolbar and output section.
- [Replay at minimum width in dark mode](assets/bash-visualization/replay-narrow-dark.png) shows a 360px chat column at enlarged text, wrapping replay rows with Previous event, Next event, a labelled slider, Original output and a retained-history warning.

The reusable live fixtures are under `features/shell-visualization/testing/`, and the identity probe supports `VOMP_SHELL_UI_KEEPALIVE=1` for headless interaction against an isolated runtime.
