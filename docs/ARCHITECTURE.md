# visual-omp architecture

## Overview

This document describes current behavior. App-hosted chats use omp's Tern Surface Protocol (TSP) by default on macOS and Linux. Windows remains classic unless explicitly enabled. The one-release classic recovery option and the later removal release are tracked in [TSP-MIGRATION.md](TSP-MIGRATION.md); classic adapters are still present.

```mermaid
flowchart LR
  subgraph Renderer [Renderer (React)]
    UI[Chat / panes / screens]
    GC[Collab guest client<br/>(AES-GCM, vendored from collab-web)]
    TS[Semantic omp screen / native controls]
    XT[xterm.js terminal sheet<br/>classic hosts]
  end
  subgraph Main [Electron main (Node)]
    SH[SessionHost]
    RL[Loopback relay<br/>127.0.0.1 + ::1, per session]
    CLI[OmpCli / ConfigFiles / Git / Files]
    IDX[SessionsIndex]
  end
  PTY[[omp in node-pty<br/>TSP or classic]]
  UI -- IPC --> SH
  SH -- TSP events / guarded paste and keys --> PTY
  PTY -- TSP documents --> SH -- IPC --> TS --> UI
  PTY -- classic screen bytes --> SH -- IPC --> XT
  PTY -- collab host ws --> RL -- ws --> GC --> UI
  CLI -- spawn --> OMP[(omp CLI subcommands)]
  IDX -- reads --> FS[(~/.omp/agent/sessions)]
```

Each open chat has a **SessionController**. Open chats are the `tabs` list in
`src/renderer/src/state/app.ts`, kept in order of opening. `shell/Sidebar.tsx` presents this as Current chats and
also lists saved chats in the Projects tree. A controller starts or adopts a **SessionHost** when omp runs for that
chat; viewing saved history alone needs no host. `releaseKeepsNumbers` in `state/chatSelection.ts` decides release:
when the user moves to another chat, a saved chat that was only viewed (no host, no sent input, no draft or
attachments, no open omp terminal) is released unless a chat that was already open appears later in Current chats,
which keeps every ⌘ number stable. A viewed chat whose side panel is open, or was resized, also stays open
(`keepsChatOpen` in `state/dockLayout.ts`), so the panel is there when the user comes back. Closing a saved chat adds it to the
reopen stack with its text draft and side panel layout. Reopen closed chat restores the last eligible entry without
starting omp. `normalizeRestoredChatSelection` in the same file
repairs the persisted layout on launch: it drops chats that can't be restored, keeps a valid split, and keeps the
project last shown (else the focused chat's). The app then always opens on Home (`features/home`), with the open
chats back in the sidebar; pages are not restored. Split view can show two chats, each with its own controller.

New chats without an explicit project use `app:info.defaultChatFolder`, computed in main by the pure
`shared/chatFolder.ts` rule: `/tmp` on macOS and Linux, and `os.tmpdir()` on Windows. The app store loads it
alongside preferences; `newChat()` also requests it when called before initialization finishes. The sidebar
button calls `newChat()` without a project. The `chat.new` command uses its explicit session's folder (the
focused chat for keyboard and menu commands, the originating chat for `/new`), or the visible project
overview's folder. Home and pages use the default. Project actions and split-view creation pass their folder
explicitly. Session grouping uses the header's `cwd`, not the encoded directory name: existing macOS `/tmp`
chats have `cwd: "/tmp"` inside `--private-tmp--`, so the default keeps that spelling.

Home's folder selection is stored with its text and attachments in `useComposerDrafts`. `visitHome` keeps
the folder of an unfinished draft and resets an empty draft to the platform default. The mounted composer
subscribes to Home navigation too, so a quick return during its exit animation follows the same rule.
`sendHome` keeps the draft intact while the leave guard awaits a decision and clears its text, attachments
and chosen folder only after a chat starts. A cancelled or failed start leaves the draft unchanged.
The picker includes the default before it has saved chats and reads its settings through the same
project-scoped configuration calls as other folders. Choosing or registering a folder for the Home draft
leaves `activeProject` unchanged.

Each open chat also has its own side panel layout (open or closed, pane, width), held in `useApp`'s `docks` map keyed
by open-chat id; the rules are defined in `state/dockLayout.ts`. The key is the open-chat id rather than the session
file because a new chat has no file until omp writes one, `/new` and `/resume` change the file of the same chat, and
an id identifies one place in the window. A fork opens as a new chat and starts with its panel closed; a rewind stays
in the same chat and keeps its panel; a saved chat opened from the sidebar is a new open chat with a closed panel,
while Reopen closed chat brings back the panel it closed with; a chat moved to another folder before it sent anything
keeps its panel layout, but not its Files view, which goes with the old id. Home and project overviews share one
layout under a reserved key (`OVERVIEW_DOCK`). `currentDock` and `dockKey` read the layout on show (the focused
chat's); `showPane` and `toggleDock` take the scope a request came from (an open-chat id or `OVERVIEW_DOCK`), and
callers that wait on IPC, such as the terminal starters, fix that scope before awaiting. A toggle closes only a panel
that is on screen and otherwise brings it into view. Only layouts that differ from the default are stored, a chat's
layout is dropped when the chat closes, and `partialize` keeps the layouts of the restored chats and the overview, so
the map holds at most the open chats plus the shared overview entry. On launch `state/savedLayout.ts` reads the saved
layout field by field with explicit type checks: a field that is missing or of the wrong type keeps its default and a damaged chat
entry is dropped. The Files pane's viewer tabs, expanded folders and tree width follow the same scope in
`features/panes/files-store.ts` (not persisted, dropped with the chat, and a request from a chat that has closed
writes nothing).

Live visual previews use `features/live-preview/`, whose tracker loads through `lazyView` and subscribes to every open chat's controller while `livePreview` is enabled. Snapshot callbacks coalesce work at 100 ms; `subjects.ts` derives the current turn's subjects from collab and watcher changes. A small per-tab store keeps selection and final frames independently of Outputs visibility. Format adapters load dynamically, and the stage limits updates to each adapter's `maxFps`. The Outputs badge reads the same store. `livePreviewOpenOutputs` defaults off and opens only the originating chat's panel.

`main/features/preview.ts` registers the `vomp-preview:` protocol and turn-scoped watcher. Per-subject tokens grant a narrow asset root or individually named files in broad folders. The protocol resolves and checks file paths and symlinks, caps reads, serves in-memory partial HTML, and applies a response CSP that blocks scripts and network requests. Before the HTML adapter shows a new revision, `preview:prepare` reads that document once under the same grant, containment and size checks and keeps the copy, which the frame's request for that revision receives; main keeps the two newest prepared revisions per token, so a missing or oversized save keeps the last good frame. Main cancels preview-page navigation and reports HTTP or HTTPS destinations for an explicit browser action. The watcher follows non-broad project roots and named output paths, filters supported visual files, and reports stable saves through `preview:changed`; its final debounced read completes after the turn and its background jobs end. It reports each path in the spelling the renderer gave (for example `/tmp/...` rather than macOS's `/private/tmp/...`), so a save matches the path omp's call named. A named path that does not exist yet is followed from its nearest existing folder, without a recursive watch of a broad folder, until the path appears. Replacing the named paths subscribes to the new ones at once and keeps the retiring ones until their pending reads finish, and on Linux the watcher reads each newly subscribed folder once, so saves made around a subscription change are not lost.

Stop and redirect uses the controller's existing `holdQueue` before `abort`. The renderer waits for `working` to clear, then uses the composer draft API to prepend the correction prefix and focus that tab. Composer send and Escape notifications release the hold; a ten-second stop deadline releases it without modifying the draft.

Each SessionHost:

1. Allocates a loopback WebSocket relay on a free port (listening on `127.0.0.1` and `::1` only).
2. Writes a per-session config overlay (`collab.autoStart: control`,
   `collab.relayUrl: ws://localhost:<port>`, `collab.displayName`, plus a fixed status line style:
   `symbolPreset: unicode` and `statusLine` preset `default`, separator `powerline`, thinking level
   as a word) into a private temporary directory and spawns
   `omp --config <overlay> --extension <private bridge> [--resume <file>]` in a node-pty with the project as cwd. Crash recovery uses `--restore <file>` instead.
   Main selects the presentation at host launch: TSP by default on macOS and Linux, classic with
   hidden `VOMP_TSP=0` for one recovery release, and classic on Windows unless `VOMP_TSP=1`.
   A running host keeps its choice. Classic session tools read the model and thinking segment
   from the painted screen, so the overlay still pins the status line for both presentations.
   Classic hosts also pin `composer.shape: box`; TSP hosts keep the user's composer shape.
   The reader accepts both the boxed composer and omp's default band composer, including narrow bands
   that omit the model segment while leaving the editor usable. A theme's symbol overrides still apply
   after the preset. The user's own `config.yml` is never modified for this. Classic readiness reads a
   fresh non-hidden overlay count from the debug tree and refuses input when that state is unavailable.
   A missing status line without an open overlay reports a read failure. Main logs only a candidate
   status border with composer structure, once per host and at most 2,048 characters. It logs null
   when no composer-context candidate is available, without copying dialog titles or transcript boxes.
   Of the feature pins reviewed for 0.7, table charting and startup worktree creation remain overridden for hosted chats. `tui.autoGraph: "always"` charts tables with
   omp's local rules, which the app draws natively, and avoids the model judge calls of `auto` and
   `smart`, whose chart plans collab does not carry. `worktree.onStart: "off"` stays until omp exposes
   outer input readiness, because a startup worktree question could otherwise meet an early keystroke.
   Interim `out://` replies, SVG, next-message predictions, idle recaps and worktree exit choices follow the user's omp settings and appear natively. Suggestions remain off by default, as in omp. The composer's Suggestions switch writes `composer.predictions` in omp's global config through the same service as Advanced; the app does not inject a prediction overlay or keep a separate preference. omp's own config watcher applies saved changes live in either presentation.
3. When the omp host connects to the relay (`/r/<roomId>?role=host`), SessionHost resolves the
   room key with `omp collab list --json` + `omp collab link <instanceId> --json`, matching the
   link's room id, and hands the control link to the renderer. The registry pid is not always the
   spawned pid: on Windows, a `bun install -g` omp is Bun's `omp.exe` launcher, and its `bun.exe`
   child hosts the room. So `main/omp/room-host.ts` asks hosts with the spawned pid first, then
   hosts that connected after the spawn, and skips hosts whose link names another relay.
4. The renderer's guest client joins the room and exposes a live snapshot (header, entries,
   streaming message, active tools, subagent progress, model/thinking/context state, pending
   `select`/`editor` UI requests) through `useSyncExternalStore`.
5. **Ordinary TSP input uses semantic editor state and actions.** The host sends `send` events
   where supported and uses guarded paste and key paths for attachments and other editor input.
   Shell/Python prefixes, follow-up queueing and pass-through slash commands remain omp-owned.
   Classic input uses bracketed paste and Enter. Both presentations serialize application input
   and reject stale host, generation or surface scope. While an `ask` question waits, user messages
   use the collab prompt path described below.
   Classic image pastes hold the serialized host input boundary until omp's public editor text
   reports a new image token for each escaped path. The trusted extension counts tokens using
   omp's current image symbol; the wrapper does not decode the image. A recognized read failure
   keeps omp's diagnostic and compares the exact editor text before restoring a text-only draft.
   The original message and attachments remain queued for an explicit retry. If an earlier image
   attached, the editor changed unexpectedly or acknowledgement is unavailable, the existing
   stranded-image hold requires recovery because public editor text replacement cannot remove
   pending image payloads. The public editor API does not expose a cursor position to restore.
   Each image adds native-extension editor jobs and classic-debug reads. Editor jobs wait for the
   extension's 250 ms poll after its preceding tick, while pending attachment acknowledgement is
   sampled again after 40 ms with an eight-second deadline per image. Unavailable extension state
   or unsupported token formatting blocks submission, preventing a rejected path from being sent
   as prompt text.
   The standalone classic success captures in `src/main/omp/fixtures/{18.15.0,18.16.0}/` run
   the production helper, private native bridge and debug client with the actual titanium theme.
   Its public image symbol is `📷`; the captured editor tokens are `📷 #1 ` and `📷 #1 📷 #2 `.
   The loopback provider receives one image in the first user message and two distinct images
   in the next user message, alongside the earlier image retained in conversation history.
   The guest channel also carries UI-request answers, abort and subagent commands. Slash lines first go
   through `routeSlash` (`session-tools/slash.ts`), which opens the app's own screen for commands
   it covers and refuses the few that would break the hosted session (`/collab` and `/join`).
   The rest go through `sendSlashCommand` (`session-tools/typed.ts`). TSP hosts submit through
   the semantic editor, collect known command outcomes from fresh document feedback, and retain
   other output as notices. Classic hosts type the line and read results above the painted editor.
   The composer's slash menu lists omp's `get_available_commands` (a short-lived `omp --mode rpc`
   in the project folder, cached per folder) merged with the builtin catalog in
   `src/main/services/omp-builtin-commands.ts`.
   TSP hook dialogs and Plan Review use semantic documents and declared actions; collab-matched
   questions keep their existing chat cards. Unclaimed content opens in the semantic omp screen.
   Classic `OmpDialogCard` reads painted dialogs and answers with keys, keeping the terminal sheet
   closed while a native card handles them. `docs/COMMANDS.md` lists every command's handling.
6. `/restart`, `/new`, `/resume`, branching and forking start a new collab room (new generation);
   SessionHost re-resolves the link and the renderer reconnects.
   omp 18.14 also rotates the room when a conversation continues in a sibling file, so reconnect
   updates the tab's saved file. Same-id folder and worktree moves do not rotate that room: the
   owning extension reports its current cwd, session id and allocated file to the private bridge.
   SessionHost follows that location and exposes a file only after it exists. The controller and
   persisted tab update their folder and file together. Other processes' continuation headers
   never establish this live host's destination.
   A nonzero startup exit can retain recognized diagnostic lines above the editor, bounded to
   eight lines and 1,200 characters. Capture stops when the host connects, input is sent or the
   debug channel reports interactive focus. Live terminal output, composer drafts and status
   chrome are excluded. A startup diagnostic naming the requested missing resume file offers a
   fresh chat in the same folder.
   A nonzero exit without a `session_exit` recorded since the latest room opened offers
   **Continue where omp stopped**. The explicit action starts `omp --restore <file>`; an ordinary
   restart keeps `--resume`. The collab client seeds `agent_start.resumedToolCallIds` from saved
   assistant calls, including events received before the snapshot finishes.

Large saved chats: before `SessionController.#start()` launches omp on a saved file, it asks main for the
file's size (`sessions:size`, a `stat` that returns null when the file can't be read). At
`LARGE_RESUME_BYTES` (32 MiB, `registry/guards.ts`) or more, it waits on the resume guard that
`features/session-tools/index.ts` installs. The guard and the global dialog host dynamically import
`largeResume.tsx`, which queues one question at a time and holds the dialog, so none of it is in the
initial renderer chunk. The threshold is a precautionary heuristic, not an omp limit.
A declined question throws `ResumeDeclinedError`: the controller stays in its saved view, `reportFailure`,
the command runner and the composer drop it without an error, the omp screen closes, and a window
`unhandledrejection` listener (installed with the first question) drops it for fire-and-forget callers.
`routeSlash` starts omp before the app commands that need it (`/restart`, `/plan`, `/vibe`, `/export` and the
`/goal` actions) in a chat without a running omp, so a decline rejects to the composer and the typed line
comes back. A controller that saw its omp live or adopted a running host, and a file approved earlier in
this renderer, skip the question. The ownership check and the question are repeated until both hold for the
same file, so an approval never covers a linked copy it did not name, and closing the chat aborts a pending
question before `dispose` waits for the start. In-process restarts, `/resume` typed to omp, the fork and
rename RPC processes and `sessions:read` are outside the check.

Ask interruption: `pendingAsk` in `state/session.ts` requires a live writable mirror and a request matching
a running ask's question, options and sentinels, or its custom-answer editor. Enter, Send now and queued-row
Send now send those messages through `GuestClient.sendPrompt`, in both classic and TSP chats. omp 18.15
attributes guest prompts to the user and aborts only the ask dialog with steering reason `user`; IRC and
background completions leave the dialog open. The app waits for `ui-request-end` and the tool result instead
of answering or cancelling the request locally. Prompts retain their original ask routing intent and connection
identity across asynchronous writes. The socket validates that identity again after encryption, immediately
before sending; a prompt is never buffered or replayed across reconnect. A refused send restores its draft
and images together, or preserves the failed message in the app queue when a newer draft occupies the composer.
Classic image attachments reuse `panes:readFile`, whose image reader opens one handle, checks its size and
reads at most that size plus one byte. Growth is refused and pathname replacement cannot switch the content.
The original raster blocks travel with the prompt, so no paste enters the selector's search field. Only the
app guest's matching `collab-prompt` text acknowledges that send. Other extension dialogs retain guarded
answers; classic approvals keep their existing sending-denies path and TSP approvals remain guarded.
The exact ask result `Ask interrupted by message` has a neutral Closed mark.

Ordinary host submissions carry a per-message id until their outcome is known. The controller
keeps the original text, images and acknowledgement scope until collab supplies positive delivery
evidence or main reports an explicit rejection. Main arms the trusted extension's public `input`
observer before writing, so a repainted old error cannot establish ownership by itself.
Missing-model and missing-credential errors require the exact restored draft before it is cleared.
Expanded image markers are matched only with the observed submission's exact attachment count,
numbered leading markers and unchanged authored text. Classic diagnostics may pass through only
those owned, numbered preview cards immediately above the editor.
Classic recovery uses the public editor API's synchronous compare, clear and verification; TSP
recovery uses a scoped, observed-length edit and waits for its semantic echo. An empty ordinary
editor, elapsed time or an unrelated error never establishes rejection. The `.` and `c` shortcuts
can report `Nothing to resume` with an empty editor only after a fresh public SDK observation
established an idle, empty branch with no pending messages.

The controller keeps an explicitly rejected message as one queue row with its original images and
omp's diagnostic. Only that submission's acknowledgement hold is released; other sends and newer
composer drafts remain unchanged. The row waits for an explicit retry or removal. Main retains
failure receipts until the controller acknowledges retaining them, including replayed host state.
A changed or unreadable editor stays untouched. Until an exact restored draft establishes ownership,
main retains the submission's acknowledgement hold and publishes no rejection receipt. A failed
compare/clear after that exact match retains the relaunch-required input hold. Native input-watch
expiry only removes observation state; it does not reject input.
The 18.15 path, which leaves no restored ordinary draft, does not gain a fabricated rejection.
A rejected classic prompt with already attached image payloads also requires relaunch: the public
text API cannot discard those payloads. The message and original app attachments remain queued;
clearing their display tokens alone would risk sending the old images with a later message.

Every classic submission checks the exact hidden draft. It permits only an empty editor or the exact
image tokens staged by that host's application paste in the current generation. For tracked sends,
one native-extension job reads the editor, arms its scoped input observer and reads the editor again,
without yielding inside omp. This replaces three sequential bridge jobs with one bridge cycle.
The extension polls 250 ms after its preceding tick finishes, so a send can wait up to that interval
plus any in-flight tick and loopback HTTP work. Main has no existing push channel to wake that timer.
The standalone gate's five fresh-host classic samples on 2026-11-03 measured median submission-to-input
receipt time decreasing from 762.42 to 260.64 ms on omp 18.16.0 and from 773.43 to 255.44 ms on
18.15.0. That interval includes controller/main work, polling, PTY input handling and the matching
public input notification's HTTP return to main; it excludes startup and provider request latency.
These observations measure the complete guarded send path rather than isolating CPU cost.
Arming has a five-second deadline; exact recovery editor requests have a ten-second deadline, and
TSP clear confirmation has an eight-second deadline. These deadlines never establish a rejection.
Unavailable observation blocks the write and returns the original ordinary message to its app draft
for a later attempt. If images were already staged when arming fails, relaunch is required because
the public text API cannot discard their pending payloads. No fallback sends unobserved text.
The safeguard itself makes zero provider requests; rejection phases in the opt-in standalone gate
also make zero provider requests. Successful retries use the gate's scripted loopback provider.
Classic Close and Quit check the hidden editor too: nonempty or unreadable editor state selects
SDK shutdown rather than appending `/exit`.

Composer compaction: the context popover calls `SessionController.send("/compact")`. While omp works,
the line joins the visible app queue and follows the same slash delivery as a typed queued command.
The app does not send Ctrl+Q or depend on omp's separate queued-compaction state.

Host side-channel notices: `main/omp/host-observations.ts` decodes omp's OSC 7501 root status and reads the session's `session_recaps` journal in read-only mode, keeping only the newest non-blank recap. The owning extension publishes `historyDbPath`; it uses omp's injected `getAgentDir()` and the matching 18.14 profile, `PI_CONFIG_DIR` and existing-XDG-data-root rules from the tested `history-path.ts` resolver. Standalone omp does not resolve the public pi-utils package from an extension, so that resolver is embedded rather than imported there. A locked or temporarily unreadable journal retains the last successful notices. Blocked and error records drive chat marks, and their message text is used for the existing question and completion notifications. Startup model-substitution warnings are captured from recognized warning rows above the editor, with painted word wrapping joined and partial paints deduplicated. Input ends that startup capture. `features/host-notices` presents warnings in every transcript view without adding model messages, and the recap only while it is newer than the newest user or assistant message on any branch, including a reply still streaming (`latestMessageAt` in `chat/transcript/notices.ts`).

Worktree shutdown: the host lets omp apply its own keep, remove and ask policy. Only omp's exact startup and exit worktree confirmation shapes open native dialogs, with Keep as the default and omp's risk description retained. Application text, image pastes, image-only Enter, native text-dialog answers and application keys are serialized; closing rejects queued application input before any further write. Native text-dialog answers use `host:paste`; raw `host:write` is reserved for TerminalMirror's intentional terminal-sheet bytes. `withEditorInput` holds the same lock across an exact editor transfer, provides non-reentrant guarded keys and rejects expired transaction access. A failed editor transfer can gate composed text and pastes while leaving recovery and Stop available. An outstanding startup Create decision becomes No when closing supersedes it. Closing tracks an exit request, its painted acknowledgement, the owning extension's teardown event and terminal-status clear. Room presence or closure establishes none of those boundaries. Unacknowledged requests and stalled editor-input drains offer a native Keep waiting or Stop omp now choice after four seconds; later observed phases offer it after fifteen seconds without a phase change. Active worktree confirmations pause that deadline. There is no automatic force-kill: teardown and subsequent worktree removal cannot be safely separated by room closure, so only an explicit Stop omp now can interrupt them. That explicit termination is itself bounded, and an unconfirmed stop keeps the host tracked. A parented native dialog can be dismissed when omp exits concurrently.

Startup readiness remains an omp API gap. A live collab snapshot can precede the editor's submit gate and the outer startup worktree choice. Classic debug values and screen text do not expose that outer readiness flag. Preflight protects a worktree question already painted or being answered; it cannot establish that a later startup question will not appear. The app does not automatically resend an unacknowledged submission. See the parity findings for the source trace.

TSP is the default presentation for app-hosted chats on macOS and Linux. Main reads `VOMP_TSP`
at host launch; hidden `VOMP_TSP=0` retains classic recovery for one release under decision D3.
Windows stays classic unless `VOMP_TSP=1`, pending Phase 6 manual criteria 5 and 6. Windows TSP
hosts alone set node-pty's `useConptyDll: true`. Transport, packaged exchanges and repeated-host
cleanup have CI evidence; installed-build process/handle checks and Defender/SmartScreen checks
remain open. Classic hosts, terminal-follow and painted-screen adapters remain available until
the later removal release. Changing the environment never switches an existing host.

Both presentations run the same omp session, private extension and collab relay in a hidden PTY.
A TSP launch sets `TERM_PROGRAM=tern`, removes `PI_TUI_NATIVE`, and reads raw PTY bytes. Its
incremental splitter removes only TSP APC messages before the existing non-TSP byte paths.
Chunk bodies are joined as bytes before UTF-8 decoding. To recover classic controls on macOS
or Linux during this release, relaunch the app with `VOMP_TSP=0` and launch the host again.

Before its first surface opens, a TSP host captures recognized startup failures directly from the
non-TSP byte path. Incremental UTF-8 decoding preserves split characters; escape parsing discards
CSI controls and OSC, DCS and APC payloads without retaining them. Failure text is bounded to
eight lines and 1,200 characters. The first surface, collab connection or application input ends
capture. TSP startup diagnostics and warnings never inspect painted rows: post-surface warnings
use the notice projection below. Classic screen diagnostics and raw TSP failures share the same
recognition and exact requested-resume-file comparison, including omp 18.15.0's quoted missing
session message. That classification preserves Start a fresh chat in the same folder; other
startup failures retain Start omp again. The credential-free `startup-missing-resume` recording
contains only pre-TUI error bytes, with an empty TSP journal and no emitted input.

`src/main/omp/tsp/` applies frames with omp 18.15.0's MIT-licensed reference document applier,
unchanged upstream since 18.14.0. Hello advertises all 45 kinds, including `button`; the semantic renderer covers each kind or its documented fallback.
The terminal feature list remains empty, so blob caching, aside layout and semantic scrolling
are not advertised. The reply grants two credits per surface and an APC body limit of 65,536
bytes. Applied frames receive cumulative acknowledgments, which may coalesce to the newest
applied sequence while the writer is occupied. Ordinary terminal replies, including DA1, follow
the hello reply through the ordered protocol queue. Width, theme and motion are carried in hello
before negotiation and sent as events afterward. All PTY writes use the host's atomic writer.
Protocol housekeeping bypasses the application transaction and closing gates so an editor
transfer or graceful shutdown cannot block credits.

Native buttons reuse the app's Button and IconButton, including keycaps, pressed state,
disabled reasons and busy indicators. Only registered click actions are sent; disabled and busy
buttons remain inert. Segmented tabs reuse the app's segmented control. Code `nums` preserves
non-contiguous source numbering with gap rows and falls back to `start` when invalid.
The recording baseline is `src/main/omp/tsp/fixtures/18.15.0/`, recorded with the standalone release
in scratch profiles and protected by byte/CR/SHA-256 integrity manifests. Model-dependent input
recordings opt into the recorder's per-scenario loopback OpenAI script. The image scenario also
records an attached collab replica's user message; no owner profile or provider credentials are read.
Deferred shell and eval runs arrive in `main` through omp's `nativeTail`; their unclaimed
`omp.bash` and `omp.eval` blocks appear under Other omp output rather than in the dock.

Every newly negotiated hello starts a protocol epoch, clears the live documents and rejects
input addressed to an earlier epoch, including when omp replaces itself inside the existing PTY.
Collab room generations are separate: a room transition retains protocol documents but invalidates
their input authority. Initial collab attachment may adopt the startup document. Later generations
require a fresh frame for each surface after the new room becomes live; a frame for one surface
cannot promote another retained tree. A protocol close with `keep: true` retains read-only main
content. Snapshots distinguish live, transitioning, failed and exited state. Process exit invalidates
presentation authority even when no protocol close arrived.

Startup import menus can open before omp creates its first collab room. Main assigns framed
documents in that state to generation zero and permits their ordinary semantic controls.
The semantic sheet uses that snapshot authority while the collab-backed session mode is still
`starting`; its separate followed/read-only flag continues to disable input. The classic terminal
mirror retains its existing live-session mode gate.
The first relay `onHostOpen` callback permanently ends that startup allowance for the host,
before link resolution completes. A protocol restart before that callback retains the allowance;
a later restart or room reconnect does not restore it. The input lock checks the same lifetime
condition immediately before writing. Hook dialogs remain display-only until a connected mirror
can arbitrate them. omp installs its collab host before the relay connects, retains collab-aware
pending requests and replays them to a writable guest on join. Input and confirm hooks without a
replicated request become locally answerable once a connected empty mirror can arbitrate
([controller](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/controller.ts#L88-L107),
[retention](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/host.ts#L344-L391),
[join replay](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/host.ts#L842-L852)).

Renderer-originated semantic events and raw keys enter the existing application transaction lock.
Main rechecks the host's collab generation and protocol epoch at the writer. Semantic events also
validate their addressed live surface and node. `host:tsp-event` parses a strict typed subset of events.
Unknown action names are refused again at the serialized TSP writer before any action bytes are sent.
The writer also rechecks that model and thinking targets still declare their requested click
action, and that an activated picker item still exists and is enabled.
Acknowledgments, resize, theme and motion remain main-owned. Raw fallback keys and Escape use
the guarded `host:keys` route with generation and epoch. Malformed operation tuples and nested
node shapes are rejected before the reference applier. Protocol failures are shown by the omp
screen without replacing collab or OSC as the authority for chat status.

TSP submission uses semantic `send` only when omp advertised it and the main editor under `dock`
explicitly has `sendable: true`. `src/main/omp/tsp/composer.ts` projects exact text, UTF-16 cursor,
ghost text, editor/surface ids, omp queue pills and ask/approval/panel ownership. `SessionHost`
publishes these facts on the existing snapshot channel and host state. Shell and Python prefixes
travel unchanged through `send`, including `!!`; large messages use the protocol's chunk encoder.
Non-sendable editors, open menus, screen-mode surfaces and stale targets have distinct refusal reasons.

A rich ask replaces the editor with `omp.editor.ask` or `omp.editor.ask.hidden`. The existing
`ask-editor` availability and matched-hook `questionReqId` permit only that current collab ask's
prompt path. Lifecycle, closing and transfer guards still apply before those exceptions.
An approval is identified by `omp.approval.choices`; ordinary messages submit through omp's
composer so it denies the request and steers. Slash commands and model/thinking actions refuse
while approval waits. Other hook dialogs retain the guarded answer path and D10 policy.

Follow-up submission writes one len-checked `edit` and Ctrl+Q through the same atomic writer.
Images clear the editor and paste bracketed image paths one at a time, waiting for each new image
node under `omp.composer.chips`, then append the prompt text and submit in one atomic write.
This keeps omp's image markers before the text, with its own separating space. `send` is excluded
because omp omits staged images. Protocol credits continue during each attachment wait.
When omp reports a rejected image paste, a public len-checked `edit` restores the pre-send text
and UTF-16 cursor, removes pasted path text and its autocomplete, and confirms the original image
count. `TspImageSubmissionError` distinguishes confirmed restoration from recovery still required;
its message retains that classification across IPC and quotes omp's failure text. Confirmed failures
remain in the app queue with text and images for an explicit action, without automatic retry or a
stranded-image notice. An uncertain paste, changed editor or unconfirmed restoration retains the
stranded-image gate.
Application pastes retain the bracketed-paste path. `EditorInputTransaction.edit` provides exact
semantic edits under the same host lock; all transaction access expires when the callback returns.

The app queue also waits for omp's `omp.queue.item` nodes and editor ownership. Escape pins the
original editor and waits for omp to append queued text. Main retains an identified restoration record
before the len-checked clear and publishes it through the semantic snapshot and host state. The
renderer inserts it with a persisted per-draft receipt and acknowledges once clear confirmation arrives.
Failures retain the exact text with a retry action, and replacements are left unchanged. Application
pastes hold the host input lock until reflected; follow-up preserves attached image markers. Undo sends
the advertised `undo` event. Classic input retains its original paste, key and exact-transfer paths.
Hosted controls use their specific semantic consumers and the generic omp screen for unclaimed
documents. Expected refusals do not become persistent chat errors.
TSP queue busy/drain decisions ignore cached classic overlay counts and use semantic queue,
editor ownership and availability facts exclusively. A classic overlay hold also releases when
a ready TSP host replaces it, preventing stale debug state from stopping queued delivery.

TSP Go here opens omp's session tree and activates the current selector with the exact session
entry id. The main writer rechecks selector identity, item presence, disabled state, current filter,
room generation and protocol epoch immediately before the event. A mounted, busy TreeSheet claims
only that selector while its pinned scope remains current. Other callers retain the generic omp
screen. The optional branch-summary hook chooses No summary through guarded local answering,
or through collab when the question is replicated. Ambiguous questions stay unanswered.
Navigation requires fresh success feedback, selector departure and the restored editor. Its exact
text uses the same retained transfer and persisted composer receipt as Escape restoration before
a length-checked semantic clear. Existing app drafts are preserved. Tree navigation reads no
painted rows and sends no Ctrl+C. Classic tree row prediction and key delivery are unchanged.
The pinned `tree-navigate` and `tree-navigate-summary` recordings include the branched tree,
optional summary question, whitespace and Unicode draft restoration, clear and clean exit.

The TSP composer model menu retains the shared provider, family and version tree. Selecting a
version opens omp's session-only picker with `status.model`, then activates the exact
`provider/model` item. Success requires both the addressed picker to close and collab to report
that provider and model id. If the composer has no model action, or the picker lacks the exact
item, the app uses semantic `/switch <selector>` after safely closing its own picker. Disabled
items are refused. Ordinary confirmation waits eight seconds. A live `omp.working` row containing
a progress node holds the operation until compaction ends, reports an error or loses its host,
room or epoch scope, regardless of duration. After compaction ends, collab has a bounded
eight-second confirmation interval. New semantic error rows end the wait.
Thinking reads the composer's effort `level`, including Auto, and sends one `thinking.cycle`
action at a time until the requested level appears. Repeating a level ends the cycle with an
unsupported-level explanation. Both controls refuse pending approvals with a distinct message,
and document waits stop after a host, room generation or protocol epoch change. Classic model
switching and Shift+Tab cycling retain their existing paths.

The Advisor sheet applies project and user files for TSP chats through semantic
`/advisor configure`. omp 18.15.0 describes roleless advisor prefs on a screen surface when
prefs is advertised; the registered `omp.overlay.advisor` list route is also supported.
`host:tsp-advisor` binds the prepared scope and current declared actions at the serialized
writer, alongside host, room generation, epoch, surface, question and approval checks.
Save and Close share one write. The app waits for physical page departure and a fresh
scope-matching saved status before finishing the unchanged main-owned preservation transaction.
Only the active apply driver claims that exact advisor page. Roleless prefs recognition requires
a screen surface without an explicit role, the recorded title and file section, and complete
file-action declarations. Active editors, malformed shapes and duplicate candidates stay
unclaimed. Manual pages and unrelated screen content remain available in the omp screen.
Fresh advisor errors and timeouts finalize preservation once and release claims and subscriptions,
including when Close is refused. No advisor TSP path reads painted rows. The no-model
`advisor-apply` and `advisor-apply-project` recordings capture both scopes; consumer and
main-writer replays cover application, failure and stale-scope behavior.

The shared session-tools status source polls painted screens only for classic hosts. A TSP host
gets an initial native mode snapshot and `native:changed` updates, preserving Goal status and the
permission button's work-mode label without the 1-second or 450 ms screen timer. Approval policy
continues to use its existing config source. Explicit refreshes also use native mode facts, and the
painted read helper refuses TSP locally before IPC. Lifecycle revisions cancel old polling and
discard in-flight painted results across reconnect and transport round trips.
A classic readiness read that resolves after TSP host replacement refuses before requesting
debug focus from the replacement. Direct TSP status-read errors also refuse locally.

Phase 4j also enforces the read boundary in main. `SessionHost.screenReadAttempts()` returns
the lifetime list of refused painted-screen or debug reads for a TSP host, including attempts
after exit. The public screen, buffer, focus, paint and debug-value readers record before
refusing. The debug client checks the same guard before connecting or sending `info`, `tree`,
`text` or `values`, so an internal call cannot bypass the audit. Direct xterm buffer readers
for classic startup and shutdown carry the guard too. TSP still feeds non-protocol bytes to
xterm for OSC status and terminal-probe replies; parsing those bytes does not inspect painted
rows. The existing 500 ms main timer updates native session location, recaps and appearance,
with its debug-focus branch restricted to classic hosts.

`tsp/retire.live.test.ts` is the installed-omp retirement gate, enabled by `OMP_BIN` on macOS
and Linux. It retains one production host, PTY and collab guest through startup, a scripted
message, a slash overlay, a hook answer, tree navigation, model/thinking changes, Plan Review
and shutdown, checking the attempted-read ledger throughout. Its loopback provider is shared
with the fixture recorder. The release watcher runs this gate with compatibility checks.
The live host test does not mount the renderer. `ComposerPolling.test.ts` separately mounts
the renderer consumers and checks that neither classic screen-poll timer starts over
60 simulated seconds, including when stale classic overlay counts are present.

TSP Plan Review uses `src/shared/tsp/plan-review.ts` to project the live overlay's title, complete
Markdown body, option ids, disabled choices and execution tiers into the existing native card.
Decisions activate `omp.plan.options`; tier changes select `omp.plan.strategy`. The card stays
disabled through omp's committed spinner, including compaction. Refine restores the app's comment
draft only after the review leaves. Auto retains `config:approval:setMode`, and leaving plan mode
retains the extension's session-mode control.
The Plan pane and badge use the same documents; Approve activates the execute option, and See all
options opens the omp screen, which releases the card's presentation claim. Save opens omp's
unclaimed path dialog, where its Save action finishes the operation. Claims are scoped to a mounted,
visible consumer's host, epoch, surface and node; hidden pages and split panes release them.
Annotation choosers and unfamiliar interactive states stay in the omp screen. Writes re-read
the enabled option after an awaited permission change. Completion tracks physical node departure;
covered or temporarily unsupported reviews keep waiting, while scope or lifecycle invalidation
cancels the operation without a success message, comment focus or extension plan exit.
Classic review detection, plan-file reading and key delivery remain unchanged.
The native hook card also reads TSP documents; other unclaimed omp UI remains available in the omp screen.

TSP `/btw` is a native Side questions pane. `src/main/omp/btw-history.ts` reads omp's
`<session artifacts>/btw-history/entry-<id>.json` and optional `.title` files, including focused
helper histories under `btw-history/sessions/<owning-session-id>/`. The watcher handles missing
and recreated directories without creating them and logs malformed records before skipping them.
The app never writes a sidecar. The shared `tsp/btw.ts` projection reads the live overlay's
questions, turns, streaming Markdown, status labels, physical list ids and declared actions.
`btw-state.ts` reconciles those frames with durable ids, titles and timestamps, assigns `live:N`
where a lone topic omits its id and retains an alias while its sidecar becomes visible. Old running
checkpoints read at process resume show Interrupted. A current side answer never completes on a
quiet timer.
Record identity includes both `scope` and `id`, because a main record and a focused helper record
may have the same id. Main/helper view ownership and a unique document/record match establish
the current overlay's history scope. Ambiguous records remain separate. Aliases retain the
complete scoped identity, and only topics established as part of that overlay can select a
physical item or invoke its follow-up, stop or steering controls. Other helper histories remain
readable and copyable.

`btw:list` and `btw:changed` carry revisioned host/room/epoch snapshots. Ask, select, follow-up,
stop, close and optional inject operations run under SessionHost's application-input lock.
Every mutating request carries the renderer's room generation and protocol epoch; main repeats
those checks after acquiring the input lock and before each protocol write.
Topic mutations also carry the selected `{ scope, id }`. Main repeats topic ownership before
each action, so a reused raw id cannot redirect an in-flight request to another helper.
`btw-driver.ts` uses Phase 3 `send` and len-checked `edit`, waits for each document transition
and consults Phase 4e command outcomes for explicit failures. Follow-up retries retain their draft;
main input remains refused while omp's overlay owns it. Side Stop sends stop and close, while
main-turn Stop remains an independent collab abort with no side action. Both the 18.15.0 and
installed 18.16.0 scripted main-abort recordings left the side answer running until its scripted
response completed. The pane describes the current published status.

The pane claims only the exact supported overlay while visibly displaying its selected scoped
topic. A new overlay or topic selects its current answer; reading another topic releases the claim.
The pane registers eagerly, and slash routing flushes its mount before asking omp. Pane transitions
enter Side questions immediately, including the expanded narrow layout, while keeping the shared
motion presets. Shared `PresenceSwap` replacement entry takes exiting content out of layout
until its exit finishes, so it cannot divide the panel or main area. Other destinations retain
their existing wait transition. If the document arrives before its history snapshot, a read-only document preview
owns that exact supported overlay until the scoped native controls are ready. This prevents the
generic screen from opening between the document and history IPC events.
Interactive history and composer controls remain in a lazy chunk; its read-only fallback also
claims the supported topic it displays, so chunk loading cannot open the generic screen.
Hidden panes and covering screens also release it, and unfamiliar controls remain in the omp screen.
A supported empty history also registers ownership while the pane shows its empty state and
question field. Reading a different saved topic leaves that empty native overlay unclaimed.
Hiding the pane releases both active ownership and consumer availability, restoring the generic
screen. `BtwEmptyComposition.test.ts` covers these transitions with the recorded empty overlay,
the actual app store, native pane, OverlayWatcher and semantic sheet.
The optional 18.16.0 `omp.btw.inject` block displays a steering prompt. Inject into main is
available only when the overlay declares it, and the writer checks that declaration again.
The pane has no delete action. Classic `/btw` retains its terminal-sheet route.
Renderer drafts are retained under their original host, room generation, epoch and scoped topic.
Displaced drafts are readable in Saved drafts and can be copied explicitly. Operation ownership
prevents late completions from clearing newer draft state, and history mutation stays disabled
until the operation finishes. Replay feeds sidecar checkpoints with recorded frames through the
production state controller; terminal projection assertions run before completed records are merged.
The main composer names the side-question blocker and offers explicit Put away, retaining its draft.
Send never dismisses the side overlay automatically.

The composer does not start its 600 ms painted next-message prediction poll for TSP hosts.
It displays the published editor `ghost` and accepts Tab through the existing exact extension
capture, compare, clear and recovery path. Main waits for the semantic editor to reflect Tab before
reading the trusted draft. Transport changes hide stale offers. Independent word completion remains
available. The prediction recording covers ghost, Tab insertion and clear. The manual Electron and
IME gate remains unverified.

omp 18.16.0's optional `composer.predictionAlternatives` keeps the existing transfer contract:
the first Tab inserts one exact message, and the extension clear removes it before another Tab
can open the alternatives list. The opt-in `prediction-transfer.live.test.ts` uses production
`SessionHost`, its overlay and native bridge against an isolated scripted provider, covering
classic and TSP transfers, repeated capture, second-Tab selection and upstream TSP prefix filtering.
Run it with `OMP_BIN` and `VOMP_PREDICTION_ALTERNATIVES_LIVE=1` against 18.16.0 or later.
The supported minimum and committed recording baseline remain 18.15.0.

The 18.16 editor node still publishes only the current `ghost`; neither its props nor its debug
values contain the full prediction array. After insertion, its ghost becomes a `Tab N more`
hint over a nonempty draft, which the transfer's empty-editor guard excludes. A second Tab
exposes an `omp.autocomplete` overlay containing `omp.select`, a list and complete item labels.
Those nodes remain unclaimed and use the generic omp screen. Native alternatives UI would need
a separate transaction: retain the inserted draft, open that list, select an observed item id,
wait for the list to close, then capture and clear the exact replacement through the bridge.
It must not resend Tab after an ambiguous acknowledgement or reconstruct choices from ghost text.
An upstream editor-props array would let the app filter choices before insertion without opening
omp's list. The app continues offering the first prediction only; filtering across the other choices
and an alternatives picker are not implemented.

Pass-through slash commands use the same semantic submission path for immediate and queued delivery.
Their readiness checks main's published send availability and document-owned overlays or screen
surfaces. A per-command document subscription holds the queue while omp owns the editor, then
releases it when the main editor is available again or a turn starts. Host exit, room generation
changes and protocol epochs end the old hold. An unchanged sendable editor settles after 600 ms,
allowing omp to publish a command's overlay after submission. Unrelated updates do not restart this
timer. It releases input ownership without asserting command success or answer completion.
Readiness waits up to eight seconds for a sendable editor and preserves main's refusal reason.
An editor-back hold also ends if its initial snapshot is unavailable. OverlayWatcher opens the omp screen.
Known command feedback uses `src/shared/tsp/command-result.ts`: a local transaction pins host,
room generation, protocol epoch and each surface's sequence before semantic submission, then
accepts only semantic content changes in status toasts, error notices and completed compaction
sections. Style, TTL, collapsed state and descendant ids do not establish new feedback.
Compaction completion requires a matching completed heading, a nonempty summary and omp's
settled marker. Subscriptions start before the send call, including feedback delivered during
its IPC response. Command-specific patterns distinguish success, failure and cancellation;
jobs-kill feedback is bound to its requested job. Quiet jobs-kill may complete after 1.5 seconds.
A command without matching output ends without asserting success after five seconds unless
omp still publishes a working row or loader. Scope changes cancel the old result.
Typed outcomes use the existing literal result row and its classic shaping. Completed summaries
stay in collab's transcript row; separate later status messages remain notices. Native results
carry semantic status independently of their text prefix. Their presentation callback confirms
display before notice consumption; native export displays failures and preserves the complete
printed path in its Show action. A missing consumer returns the feedback to notices.
Cleanse dialogs keep their semantic screen and input ownership until answered. Unrecognized slash commands retain
the generic editor watch and notices. Classic result parsing is unchanged. Direct TSP slash lines
sent through the session controller use slash delivery, so commands without a collab user entry
or turn never enter message acknowledgement. Security commands continue to use notices.

TSP shutdown uses the existing native stages and exit records. It sends Escape for an open omp
overlay or screen only when no live hook node exists, waits for the main editor to become
available, then sends `/exit` through semantic `send`. Acknowledgment is the closing-status toast,
closure of the addressed surface, or process exit. Closing a settings surface alone does not
acknowledge `/exit`. A live hook, regardless of arbitration state or region, blocks shutdown's raw
Escape and preserves the existing deadline and native force-stop decision.

Startup worktree creation remains disabled. During application-driven shutdown, renderer hook
controls remain unavailable with "This chat is closing." Main recognizes the exact live exit
worktree confirm through `tsp/worktree.ts`, reusing the shared hook projection and activation
helpers. The existing operating-system dialog preserves omp's risk text verbatim, with Keep as
the default and cancel choice. Keep activates No; Remove activates Yes. This narrow main-owned
answer path revalidates the question's full shape and detail, current host, generation and protocol
epoch inside the serialized writer. The shared question arbitrator guards both dialog opening and
the final activation, then records the answer in the same ownership set used by ordinary hook
answers. Matched, ambiguous, settling and already-answering questions remain excluded, including
retained remote ownership across disconnect. Only an otherwise unowned exact exit question gets
the narrow disconnected-shutdown allowance. It waits for physical node departure before continuing.
Time spent in that native dialog does not advance the shutdown deadline, and a written answer
is never automatically retried. Other hooks retain the no-raw-Escape rule and native force-stop
decision. A typed `/exit` during a live session keeps the ordinary arbitrated native hook card;
only application-driven shutdown authorizes the operating-system dialog.
The no-model `worktree-exit-ask` and `worktree-exit-ask-remove` recordings create owned worktrees
in isolated scratch git repositories, dirty a tracked file and complete both choices with
`activate`. `worktree-start-ask` records startup evidence without changing the hosted override.

If ten seconds elapse from spawn without a supported hello, main marks the TSP host failed once
output has been observed. A supported hello starts a separate five-second deadline for the first
surface, including after an optimistic surface is withdrawn and omp falls back to classic rows.
Failure sets `tspFailed`, exposes "omp did not start its semantic screen", and offers
Restart omp. It does not automatically retry, kill omp or switch renderer modes. An explicit restart of
a failed host awaits the existing stop stages, then launches omp again with the saved session file;
the visible history and input recall are retained while the new collab room connects. Stop or
launch errors are shown, and a failed stop prevents relaunch.

TSP Restart first asks main to prepare the current host generation and protocol epoch. A live menu with an enabled declared Close or Cancel action is dismissed through that exact semantic control, then main waits for the editor to become available before the controller types `/restart`. Autocomplete without a declared dismissal and failed protocols use the existing explicit stop and saved-session relaunch path. Hook and approval controls are never answered by generic restart preparation. A failed stop prevents relaunch; host, generation and epoch changes refuse stale preparation.

Classic image failures that require recovery also use explicit stop and saved-session relaunch, since typing `/restart` could append it to the rejected path or partially staged input. Main latches this state when its attachment helper fails, so ordinary Close and Quit also avoid editor submission. The private bridge requests the public SDK `ctx.shutdown()` path, which reaches omp's normal shutdown and worktree-exit planning without pressing Enter or writing `/exit`. Missing acknowledgement or stalled shutdown retains the existing explicit native stop decision. The fallback resumes the saved session and retains the app queue. Confirmed text-only restoration keeps the normal classic restart path.

`host:tsp-snapshot` returns the complete per-host documents main last published, with an ordered
revision, protocol epoch, lifecycle state and send availability. Later changes arrive as
`host:tsp-patch` events (`shared/tsp/patch.ts`): every snapshot field in full, and for each surface
only the nodes whose kind, props or child order changed since the previous revision. Main finds them
by identity against its previous publish. That comparison is cheap because the vendored applier
caches each node's export and clears only the changed path, so successive snapshots share unchanged
subtrees. Frame publishes wait in a 16 ms batching window and leave as one patch; any other update
publishes at once with the waiting frames, and `host:tsp-snapshot` publishes waiting frames before it
answers. TSP publication sends `host:state` only when its TSP fields change; other host changes still
send it as before. The reason is size: omp's document holds the whole transcript (about 1.6 MB for a
chat of about 1,400 entries), and sending it whole for each streamed update kept the renderer
saturated. A streamed update to one text node now sends that node.

In the renderer, `state/tsp/hosts.ts` keeps one document store per host, fed by one IPC listener
for all hosts. A host's store reads the published snapshot when first subscribed, applies patches by
rebuilding only the changed nodes and their ancestors (other nodes keep their identity), and reads
again when a patch does not follow its revision. A read's result and the patches that arrived during
it reach subscribers as one update. A copy that a failed read leaves missing or behind is hidden and
reported through `failed()`; two timed retries follow, and the next patch or subscriber reads again.
The store is released a microtask after its last subscriber leaves. `useTsp`, the notice and question
controllers, command watches, the BTW drawer and the inspector all read that store. Shared view-state
derivations identify overlays, screen surfaces, focus, the composer and unclaimed output.
The role/action registry declares consumer capabilities and interaction overrides. Mounted visible
renderer consumers acquire exact host/epoch/surface/node presentation claims through
`state/tsp/presentation-claims.tsx`. Hidden chat pages, hidden split panes, modal sheets and
unmounted consumers release their claims, restoring the generic omp screen with its existing
arbitration restrictions. Notice projections and always-present composer model/effort consumers retain static claims.
These channels retain the trusted app-window IPC boundary and main-owned host lookup.

For TSP hosts, every existing terminal-sheet entry point opens the lazy-loaded **omp screen**.
The palette title and hint, status menu and tree fallback action use omp screen wording for TSP;
classic chats keep terminal wording. The existing sheet frame, expand control and labelled focus
region remain. The title includes an overlay's heading when present, and semantic overlays expose
dialogs named by that heading. Opening the sheet focuses its content region; closing returns focus
to that chat's composer. Its neutral subtitle is "View omp menus and settings for this chat."
When omp has no readable unclaimed output, the sheet explains that no menu is open and how to
open one, while retaining the raw outline disclosure.
The renderer draws layers, screen-mode surfaces and unclaimed dock nodes. Unclaimed main content
that collab does not replicate appears under "Other omp output"; omp's main transcript and composer
are excluded. Lists expose selection semantics, tree row clicks stay local until confirmation,
and forms send typed events. Markdown, code, diffs, JSON and progress
reuse shared renderers. Media remains a placeholder while blobs are unavailable. Known kinds keep
their renderer when a role is unknown, so form and layout containers show their children normally.
Unknown actions disable only their own control, with an explanatory tooltip and one log entry.
Known picker actions, selection, preference controls and descendants remain available. Rows, ANSI
and genuinely unknown kinds use a readable mono fallback with guarded raw keys while focused.
Escape from a focused fallback also reaches omp through the guarded key route.
Rows and ANSI keep browser keyboard focus without emitting a semantic `focus` event: omp already
owns their raw-key target. Ordinary semantic input/editor controls retain their protocol focus events.
The normal view never dumps node props as JSON;
the raw outline disclosure contains that developer metadata. Hook input omits omp's inherited
`> ` terminal prefix because the native app field already supplies its own chrome.

Semantic overlays, dock forms and screen surfaces open the sheet without a painting delay.
Supported hook dialogs are claimed while a mounted visible native `OmpDialogCard` presents them,
with the same public props and presentation as classic. Matched hooks use the visible collab
question card's exact request ownership. Without an active presentation claim, the generic omp
screen retains the hook and its arbitration restrictions. Disabled options remain inert under
pointer and double-click input, and keyboard navigation skips them. Other uncertain arbitration
states remain display-only in the native card. A local answer sends one guarded transaction:
item-id activation, full-range UTF-16 edit followed by submit, or declared cancel/close with Escape
fallback. The card stays busy until its addressed node leaves. Losing answers whose node already
closed receive the existing calm completion message. Full lists retain every item, without a hidden
options notice or terminal offer. Local dialogs do not alter chat status.
The shared pure helpers in `src/shared/tsp/dialogs.ts` expose role lookup, event construction,
hook facts and node-departure predicates. `ompDialogTsp.ts` adapts presentation and provides the
generation/epoch-scoped document-subscription completion wait. Presentation claims never remove
input ownership: main availability, shutdown and slash watches query physical overlays with
`openOverlay(surfaces, true)`. The normal projection omits claimed nodes.
An available-consumer registration is separate from active suppression. A sheet covering a native
hook card reveals the generic hook, but Escape closes the sheet without cancelling that hook.
When no native consumer is available, the generic guarded cancellation path remains unchanged.
Availability is scoped to the same exact target, releases on hidden ancestors or unmount, and
grants no input authority.
Automatic sheet opening uses native-consumer availability as well as active presentation claims.
That availability remains stable while a sheet covers a hook or plan card, so automatic opening
cannot release the very ownership that decides whether to open it. The watcher re-reads current
registrations at the passive-effect decision, after sibling layout effects register consumers.
Dock rows and ANSI fallbacks still open the generic sheet; ordinary HUD status does not trigger automatic opening.
Other overlays and focused raw fallbacks keep their guarded Escape handling.
With no open omp overlay, screen or focused raw fallback, Escape closes the sheet.
Closing the sheet itself does not answer omp, and focus returns to that chat's composer.
"Show raw outline" discloses read-only document diagnostics below the semantic content; normal
screen controls remain available above it. Failed and exited TSP hosts offer Restart omp.

`src/shared/tsp/question-match.ts` provides conservative question arbitration.
The renderer mirrors all pending collab requests, including locally answered requests awaiting
`ui-request-end`, through `host:tsp-questions`. Main validates the host, protocol epoch, room
generation and monotonically increasing mirror revision. Matching authority is scoped to the guest
client, its connection identity and the host generation and epoch observed for each request.
Disconnect and welcome invalidate matching authority while preserving existing completion guards. Room rotation and protocol epoch changes
exclude requests observed in an earlier scope without clearing the visible collab question or queue.
A transient disconnect preserves those visible requests until welcome, following the existing
collab lifecycle. If a delayed TSP snapshot makes a request's epoch uncertain, diagnostic matching
stays unavailable while the original collab `reqId` answer path remains available. Matching requires
mutual uniqueness of title, field and option data. A matched node remains in settling state until
both its request and node have ended. Snapshots expose `questionMatches`, including diagnostic
`nodeFirstSeenMs` and, once matched, `requestFirstSeenMs`. Both use main's single monotonic clock
and retain first observations through completion; they do not establish input authority.

While the chat is open, native hook dialogs are answerable only with a connected,
current-host, current-epoch, current-generation collab mirror reporting no pending request, a
unique live dialog target and an `unmatched` arbitration result. Matched dialogs direct the reader to the chat's question card;
ambiguous, unavailable and settling dialogs remain display-only with their reason. omp 18.14.0
omits the hook role from its ordinary selector and confirm picker, so the registry also recognizes
its roleless `options` picker with row layout and exactly the declared `confirm` and `close` actions.
Recorded non-hook workflows guard that classifier.

D10 was decided by the owner on 2026-11-02. Main refuses local input once a request is mirrored as
matched or ambiguous. Before that mirror arrives, local input remains permitted by the owner's
decision, and upstream arbitration decides which result completes the question. The accepted
trade-off is that the app can briefly offer both answer controls when channel delivery is delayed;
omp's `#raceCollabDialog` accepts the first result and aborts the other branch. Consequences can
include a chat question card that appears and closes at once, or a losing submission or cancellation
error. This is weaker than an exactly-one-answer-path guarantee. A local submission that finds its
node already gone shows a calm completion message while the screen updates.

Main recorded manual Electron evidence on 2026-11-02 using this worktree with `VOMP_TSP=1` and
the fixture extension in a scratch project:
- Hook input from the omp screen delivered the exact text `café ✓ answer`.
- Hook confirm answered No from the omp screen and delivered `false`.
- A collab-aware select request reached main 1.7 ms before its node. It was matched with display-only
  omp screen controls; Escape did not cancel the question, and the chat card delivered `Second option`.
- An editor request reached main 1.3 ms before its node, was matched, and delivered an unchanged
  card answer containing a newline.
- With collab delivery deliberately delayed by 4 seconds, the node was first and unmatched. omp
  accepted the local `Fourth option` answer. The late request appeared as a card until the delayed
  `ui-request-end`, which carried the same delivery delay, removed it.
- Dropping collab while a matched select was open produced unavailable arbitration and disabled
  controls. Reconnection re-sent the same `reqId`, restored the match and delivered the card answer.
- A separate browser guest was not covered. Across three naturally ordered runs, requests preceded
  nodes by 1.3 to 2.5 ms. These observations preserve D10's documented limitations.

`host:tsp-answer` enters the existing application-input lock, then derives native events from the
current document at the serialized writer. Main rechecks generation, epoch, live surface, node
presence and unmatched arbitration immediately before writing. A choice activates its item id;
a text response replaces the observed UTF-16 range with `edit`, then submits using omp's declared
button. Both text events share one writer operation. Cancel uses omp's declared cancel or close
action, or Escape when neither exists. Raw fallback keys and generic semantic events remain
blocked while a hook dialog is open. Escape for a unique local dialog uses the guarded answer path.
A local response stays in answering state until its node leaves. Matched responses wait for both
collab settlement and node departure; neither path offers a second answer while completion waits.
Hook picker search is visibly unavailable while raw-key question input is blocked; the option list
remains selectable.
Collab questions retain their existing controls. Classic hosts are unchanged.

At the Phase 2 checkpoint, local hook answering and recorded workflow replay were implemented;
live ordering, sharing, packaged and manual acceptance were still open. That historical record
does not establish completion of the later FLIP release checks.
TSP-only warning/error rows and status toasts are projected by each chat's controller-owned
subscription into existing transcript notice rows with literal, whitespace-preserving text. After
the current room's collab snapshot is synchronized, new notices use its displayed branch and leaf
for the anchor and user-prompt turn. Notices received during snapshot download wait for that
attribution. Reused toast nodes update their existing row without moving an assigned anchor.
Displayed custom messages are matched through their parent ancestry; collab notice events use
the displayed turn when received. Matching text suppresses the projection within that attributed
turn. Status notices whose exact text announces that the app's own guest name joined or left the
collab session are omitted; other guests' notices remain visible. Epochs clear rows; room and session changes also discard pending attribution and retain
observed node text to avoid repeating unchanged notices. These behaviors have recorded startup/
usage and synthetic ordering, rewind and literal-rendering coverage. Disposing the controller removes its subscription. The role registry claims
these notice nodes, keeping the generic omp screen from duplicating them.
Command feedback is held provisionally with its arrival-time anchor. Only the first matching
outcome is reserved. The typed result row or native presentation callback commits consumption
after displaying it. Rejection, supersession or cancelled collection releases undisplayed rows,
without moving their original anchor. Additional matching feedback after the first outcome
uses the ordinary notice path, including while the editor hold is still pending.
The Phase 2 preview acceptance record, including full overlay replay, live hook and
extension-fallback recordings, sharing parity, packaged checks and manual criteria, remains in
`TSP-MIGRATION.md`. The FLIP changes the launch default without asserting new acceptance
evidence. There is no new user setting and no replacement of the transcript or collaboration channel.



Composer assistance: `main/omp/predict.ts` keeps one lazy no-session RPC child per retained folder for `predict_word` and `predict_word_feedback`, using the id-correlated transport in `main/omp/rpc.ts`. Mounted composers retain their folder separately, so split composers share one child and the last release closes it. Settings changes close children without dropping those owners; closing the last window or quitting closes all children and clears ownership. Auto resolves to local n-grams; SmolLM and Apple remain omp-owned local choices. No word-completion request sends a provider prompt. Both word and dictation children apply the shared MCP-discovery isolation as the final temporary overlay, disable extension/context/rule/skill loading and scrub inherited execution and host-control environment variables.

Dictation: `main/omp/dictation.ts` allows one microphone capture across the app. It lazily starts a no-session RPC child for the explicit microphone action, with a private temporary `stt.enabled: true` overlay before the mandatory isolation overlay. It forwards `dictation_state`, `dictation_transcript` and `dictation_end` frames by capture id, and sends `dictation_stop` while startup is pending or recording is active. The child closes when the capture ends or the app quits, and the overlays are removed. Unexpected transport termination publishes one terminal error and releases the capture, including after the start response has completed. The renderer waits for `recording`, treats a stop during startup as cancellation, and preserves available non-cancelled text even when omp also reports an error. The former keybinding-write, chat-restart and TUI-editor polling path is removed.

Next-message predictions remain opt-in and make an extra model request that counts toward usage. Painted ghost text only identifies the displayed offer. `prediction-transfer.ts` holds the host's serialized application-input transaction, checks fresh overlays, generation and the exact empty draft, then registers recovery state before sending Tab. The trusted extension reads the complete draft through `ctx.ui.getEditorText()`; main retains that exact string before requesting a synchronous compare, clear and verification through `ctx.ui.setEditorText()`. No painted-row reconstruction or Ctrl+C participates. Ambiguous Tab acknowledgements, failed reads or clears block composed input until exact recovery confirms the editor is clear. Captures remain in main until acknowledged, and the renderer persists saved copies for explicit insertion or dismissal when its draft, mode or room changes. The user's omp setting determines whether predictions run.

File-side commands are resolved on demand inside the already-running hosted omp. The trusted native extension calls the public `discoverSlashCommands` SDK with the active cwd, preserving enabled providers, user/project toggles, nested bare names, namespace aliases and source precedence. Runtime extension, custom and skill commands retain precedence through `pi.getCommands()`, and the app excludes its builtin catalog's names and aliases. The private bridge carries this read separately from mode changes; failure preserves the submitted draft rather than guessing from a filesystem scan.

The host writes `native-extension.ts` into its private temporary directory and loads it only with the app-hosted omp's `--extension` flag. `native-bridge.ts` binds an authenticated HTTP endpoint to IPv4 loopback, rejects browser origins, validates snapshots and accepts explicit mode requests. The extension reads `ctx.sessionModes.getState()`, reports `mode_changed`, and calls `ctx.sessionModes.set()` without submitting a model prompt. omp's disabled, conflict and busy responses remain authoritative. Helpers cannot report into this bridge. The bridge URL is removed from the tool environment during the main session and restored at shutdown for omp's spawn-based restart.

The same extension reads named theme JSON through the public `@oh-my-pi/pi-tui/theme/loader` export, which the 18.14 binary resolves from its compiled module map. omp's `resolveVarRefs` and `ansi256ToHex` resolve the terminal section before it reaches main. This covers bundled themes as well as custom themes, without a second theme catalog. The terminal mirror uses the section's background, foreground and ANSI palette. Missing fields use the active TUI colours. In-memory themes and an ambiguous preview without a readable name have no terminal section available.

`features/advisor.ts` edits the same repo-root or user `WATCHDOG.yml`/`.yaml` files as omp's configuration editor. Raw instructions and explicit tool lists round-trip; stale or malformed files refuse writes. The native Advisor sheet applies a saved roster by opening omp's configuration editor, choosing the requested scope and invoking Save & apply, so omp performs discovery and rebuilds its own advisors without a restart or an enablement toggle. The app confirms omp's saved message before reporting application success.

Advisor application uses a main-owned preservation transaction. It reserves the configuration path against other app saves, records the original bytes, and recognizes omp's intervening write only when its complete comment-free data matches the known canonical projection. A second read checks for intervening changes before atomic restoration. Unexplained edits retain the current file and require Reload. A lone explicit `default` advisor temporarily receives its existing turn cadence so omp cannot mistake it for a synthetic, roster-less default. Multiline CRLF normalization is recognized while the original bytes are retained. The sheet receives the refreshed authoritative baseline after application.

Terminal-theme extraction failures retain the last usable palette or active TUI colours. They cannot prevent mode/location publication or mode-request processing. Pending Advisor application is held per controller and scope, so closing the sheet or switching scope does not lose its Apply action. Reload uses the same discard confirmation as closing.

The native bridge is not a same-user process isolation boundary. A leaked URL token can consume queued requests, forge their results and publish false mode or location snapshots. HTTP has no route for enqueueing a mode transition; enqueueing remains main-process IPC authority. `OMP_TUI_DEBUG` remains an unresolved keystroke-authority exposure to inherited tool and MCP environments. Removing it currently breaks omp's TUI stop/start and restart paths; scoped environment filtering requires an omp change.

## Process boundaries
- **Main** owns every subprocess, file system access and network socket. Renderer is sandboxed,
  context-isolated, and reaches main only through the typed preload API (`window.vomp`).
- Model/Markdown content is rendered without Node access; links open externally via main.
- One writer per session: a session live in another omp process opens read-only (from its JSONL).

IPC requests are accepted only from the app's configured main-frame document. Browser permission handlers deny all requests except audio capture from that document, and Preview cannot open popup windows. Packaged builds ignore `ELECTRON_RENDERER_URL`. The loopback relay accepts origin-free omp connections and browser connections from the app's exact origin, limits frames to 16 MiB and never reopens an ended room. omp 18.14 normalizes relay URLs to an origin, so it cannot carry a private path token without an upstream protocol change.

Sharing retains omp's project-before-global endpoint precedence. Before publishing through a relay or browser client other than the default `my.omp.sh` endpoints, main shows both endpoint URLs in a native confirmation dialog. Cancellation leaves the room private. Installer downloads retain GitHub's asset digest and validate supplied SHA256 checksums before renaming the partial file or reporting completion. Each response chunk is written completely, and a zero-progress disk write fails the download. Older assets without a digest retain their existing HTTPS trust checks.

Executable selection: `main/services/executable.ts` resolves app-selected tools before spawning them. PATH discovery considers fully absolute directories and regular executable files, so an empty or relative PATH entry cannot select a program from the project folder. POSIX checks execute permission. Windows uses case-insensitive environment keys, native `.com` and `.exe` suffixes plus exact extensionless files, and rejects drive-relative and root-relative search paths. Symlinked installations remain supported. The terminal resolves its shell executable separately and passes the user's requested shell command through unchanged. An explicit omp path keeps its normalized absolute identity across version detection and later project commands.

Ownership: `main/omp/elsewhere.ts` reads omp 18.14's machine-global session-id lease under `run/session-owners`, including the shared XDG state root when present. macOS observes the persistent flock sidecar's open descriptor; Linux reads the abstract socket registry; Windows opens the existing global mutex without creating or waiting on it. Linux and Windows names use pi-natives' two seeded xxh64 hashes of the absolute sidecar path. A missing or unreadable header or lease uses the existing descriptor and terminal-breadcrumb fallback; Windows reports unknown when its mutex check cannot be completed. A header id makes file aliases meet the same lease, but a matching app host id alone never establishes ownership. macOS excludes an app host only when its PID is the observed holder. omp owns the final write-time decision and creates a continuation if another process claimed the lease meanwhile. omp's public lease CLI and RPC report `held` and `unknown` without identifying the holder, so they cannot yet replace this detector's own-host attribution.

Forks: `main/omp/fork.ts` resolves the current continuation, starts a short-lived RPC process with `--resume`, calls `fork(entryId?)`, then reads that process's new session identity with `get_state`. It waits for confirmed process termination before handing the copy to the renderer, so the snapshot process has released its lease. Shutdown escalates after three seconds and refuses the handoff after five seconds if exit remains unconfirmed. The renderer opens the copied session without typing `/fork`, `/resume` or `/tree` into the source host. The isolated 18.14 fixture tests preserve the live source's bytes and nanosecond mtime for whole-session, user-message and assistant-message forks. The source keeps its original lease. Extensions, tools, skills, rules, context files and title generation are disabled in the snapshot process.

Transcript file references use `fs:resolveRefs` (`main/services/fileRefs.ts`). Exact paths take precedence.
A relative reference whose first component repeats a candidate parent's own name is tried in that parent
without the repeated name, only after every exact candidate and never when the rest contains `..`. Only
Windows splits that reference on backslashes.
For an abbreviated final component containing U+2026, main lists only the existing candidate parents:
folders named earlier in the reply, latest first, then the chat and output bases, or the single parent
of an absolute or home-relative path. The first eligible folder with matches must contain exactly one
matching regular file or folder. Bounded directory handles skip hidden entries and symlinks, discard
oversized or incomplete listings, never recurse and never read file contents. `FILE_REF_LIMITS` caps
folder entries and total directory reads. The renderer retains the abbreviated label and uses the
resolved absolute path for opening, its tooltip and Copy path.

Git review: `features/panes/git-store.ts` shares live `git:status` between the Changes pane and its uncommitted-only badge. Working diffs follow `git:changed`; `commit-history.ts` retains loaded history across clean/dirty views and commit selection, and refreshes it only when status reports a new HEAD. `git:log` accepts a folder, optional `limit` (default 30, maximum 100), `skip`, and a verified hexadecimal `head` snapshot, returning history with full and short SHAs, subjects, bodies, author names, ISO author dates and first-parent change totals. Every renderer page requests 30 commits against the same immutable SHA, so a commit between requests cannot shift the page boundary. A new HEAD refreshes the previously loaded window through bounded pages; unchanged-HEAD file events reuse existing rows without recomputing statistics. Main uses NUL-framed metadata plus `--shortstat`, preserving separators in commit messages; an unborn HEAD returns an empty list. `git:diff` retains its work-tree behavior unless `commit` is supplied. Main accepts 7-64 hexadecimal characters and verifies the object as a commit with `rev-parse --verify --end-of-options`, supporting SHA-1, SHA-256 and detached HEAD. It compares the commit with its first parent or the repository's empty tree. Historical diffs reuse `GitDiff` and the renderer's existing file viewer, with Discard, comments and Review code unavailable. Commit metadata wraps in a bounded scrolling region while Back remains visible. Initial line tokenization and emphasis use only the displayed line budget; Show all lines expands that budget.


## Source layout
```
src/
  shared/        IPC contract types shared by main, preload and renderer
  main/          Electron main: app lifecycle, windows, menu, quit guard, services
    omp/         locator, session host, relay, CLI wrappers, config files, sessions index
  preload/       contextBridge API
  renderer/src/  React app
    collab/      vendored omp collab guest client + wire contracts (MIT, see NOTICE)
    tool-render/ tool call renderers (friendly summary + details)
    shell/       window frame: title bar, sidebar, floating side panel, status bar
    chat/        session header, transcript, composer, tool summaries and turn summaries
    features/    panes, pages (Settings, Usage & limits, Help, project pages) and other features
    registry/    feature registries and lazy component loaders for commands, pages, panes, sheets and status items
    state/       app store, session controllers, navigation, dock visibility and leave guard
    ui/          component library, including PageFrame, menus, motion and page navigation slots
    i18n/        locale files
    theme/       design tokens (light default, dark, ink chrome regions)
```

Tool details: `tool-render/tools/eval.tsx` replaces exact, ordered output spans from `details.cells[].views` with tables, lazy JSON field trees or the shared Markdown renderer. Views absent from truncated output keep no separate preview. The Submit Result renderer uses accepted `details.data` and `details.type` when available and retains the submitted fields with omp's rejection text on failure. Live tool cards pass structured partial results to their renderer while the explicit running state remains authoritative. MCP progress comes from `details.progress` or eval `statusEvents` with `op: "mcp_progress"`; counters without totals are never treated as percentages. Read-card paths separate jq query selectors from the file reference and preserve percent-decoded `+` operators.

`ui/Page.tsx` owns the page-navigation slot store. `PageFrame` portals Back into the slot rendered by `shell/Sidebar.tsx`; pages with section navigation, including Settings, portal the rail there and set nav mode, which hides the chat lists while keeping them mounted. Pages with Back only use back mode and keep the lists visible. With the sidebar hidden, Back and the rail render inline. Page and section focus moves to the title after lazy content mounts unless the reader moves focus first.

omp notices: `chat/transcript/notices.ts` parses displayed `custom_message` entries into typed notices (background jobs, IRC messages, process exits, advisor notes, skill use, other). It reads omp's structured `details` first and strips omp's wrapper markup only as a fallback, caching the result per entry. `chat/transcript/NoticeRow.tsx` renders them in the transcript and in the helper conversation dialog, and `features/session-tools/tree.ts` uses `noticeSummary` for the session tree.

User executions: the collab wire union includes omp's `bashExecution` and `pythonExecution` messages. `chat/transcript/RunRow.tsx` presents their source as user-entered code, their result as the shared tool-style disclosure and their entry time through `TranscriptTime`. omp 18.15.0's shell and Python runners defer results completed while streaming; `AgentSession.prompt` flushes those results before a later prompt, and collab broadcasts them from `SessionManager.onEntryAppended`. Classic receives the persisted result at that boundary. TSP additionally publishes these components through `nativeTail` in the main document, including the deferred interval.

`chat/transcript/localRuns.ts` projects only current-generation data-first `omp.bash` and `omp.eval` nodes, outside replicated assistant subtrees. It matches saved occurrences by execution kind, source, exclusion flag, normalized output and outcome, consuming each saved occurrence once so repeated commands remain distinct. `NativeRunRows.tsx` retains the semantic result body and uses host/epoch/surface/node presentation claims. A saved replacement holds that claim only while its entry belongs to the rendered transcript window. The visibility provider, document visibility and covering omp screen release presentation ownership, leaving the generic screen available. Native run frames report elapsed time rather than wall-clock timestamps, so the shared timestamp appears only after an entry supplies one.

The generic main projection preserves `omp.tool.*` command and output children beneath user-run roots. Those child roles are reused execution details; treating them as replicated assistant calls would remove the fallback's readable source and result when a native claim is released.

Collab can append a result before the next native paint changes its row from Running. The transcript retains a committed occurrence ledger scoped to the host, generation and protocol epoch, with exact surface/node assignments. Entries already present when an unmatched node is observed running cannot replace that occurrence after it finishes. Established saved-entry assignments stay reserved when native nodes reorder or disappear, preventing another node from taking an earlier result. New assignments require a unique match in both directions; ambiguous results remain visible as native rows. A newly appended result can replace its running node before the final paint, and later document revisions retain that assignment.

Narration: `ThinkingContent.narration` is optional because ordinary thinking blocks carry no narration flag, including in saved chats. `replyText` in `chat/transcript/turns.ts` classifies flagged thinking as reply text for Markdown, file links, pacing, tool-group boundaries, helper conversations, the live activity label and completed-reply announcements. Unmarked thinking keeps its existing disclosure. omp 18.14's collab serializer preserves the complete message shape, so the flag survives replication.

Interim replies: `chat/friendly.ts` classifies `write` calls to `out://` and reads `details.replies` from foreground tool frames and saved results. `replyText` presents write content as assistant prose while its arguments grow. The transcript presents shell replies outside command disclosures, includes both transports in reply playout and file-reference resolution, and leaves reply writes out of step groups, their counts and completed-turn file summaries. `helperTranscript.ts` applies the same history classification. `AnnouncementTracker` announces complete write replies and each new foreground reply once; repeated frames, saved copies, loaded history and reconnect snapshots stay silent. Main's file-reference resolver and tool context targets refuse `out://` destinations. omp 18.14's `serializeReplicatedEvent` preserves partial `arguments.content`, and the collab guest keeps the cumulative message unchanged.


Model fallbacks: `collab/lib/modelFallback.ts` reads the displayed branch's `model_change.resolvedModelIsFallback === true`. omp 18.13.3's `session-manager.appendModelChange` writes that flag for retry-chain and usage-preflight changes. The `fallback` role alone is insufficient because omp also uses it when returning to the primary model. Manual choices, missing flags, account rotation and nearby limit errors do not establish a fallback. `chat/transcript/ModelFallbackNotice.tsx` shows the warning at the entry, and the composer derives its marker from the latest choice, keeping the original model through a fallback chain. A manual choice or primary restoration clears it. Live collab state supplies the selected model; saved entries supply it without a running omp.

omp's retry controller persists `retryRecovery` on failed assistant messages. When the first assistant message after a flagged change explicitly records `recovery: "model"` and its `supersededBy` provider/model matches the destination, the warning quotes that error and uses its source model. Other nearby errors remain separate. The quoted error retains any reset or retry information as historical text; the app computes no reset countdown. Provider-reported assistant content of type `fallback`, with `from.model` and `to.model`, gets its own warning within the reply. The composer shows that response's serving model until a later ordinary response or model choice replaces it.

The composer returns selected and displayed identities separately. `ModelList` compares against the selected identity, so a provider fallback displayed as the serving model can still be chosen explicitly. A provider fallback is displayed only while its source identity matches live selection. Retry-chain tracking distinguishes an unknown original from a chain that has not started.

`session-tools/modelTree.ts` derives the shared model menu's provider, family and version hierarchy from the available catalog. Its bounded Claude, GPT and Gemini naming rules require compatible identifiers, numeric versions and display names; unknown/custom names and singleton families remain direct model leaves. Only the OpenRouter host normalizes known upstream id namespaces, following omp's v18.15.0 bundled catalog. Host providers and catalog selectors are never rewritten. Aliases, dated snapshots and context-window variants remain separate leaves. Settings' role selector keeps its existing layout.

The shared `ModelList` in chat, Home and the advisor editor uses a combobox controlling a nested ARIA tree. It opens the selected identity's ancestors, searches provider/name/id across all descendants, and expands matching paths. Navigation tracks stable node keys rather than filtered indices; changing the query resets navigation and search-only disclosure, preserving the unfiltered disclosure state for clearing search. Collapsing a branch moves the active descendant to that branch. Home/End reach the first/last visible row. Only an explicit leaf applies a model. Group activation expands versions without choosing a default, and asynchronous switching retains its confirmation/refusal path. Completion uses the latest callback and does not run after the picker unmounts.

`chat/transcript/announcements.ts` tracks new fallback entries and provider blocks for `ReplyAnnouncer`, the existing polite live channel. The initial snapshot and the first snapshot after reconnect are silent. Provider blocks use response timestamp, block position and source/destination for deduplication across streaming and saved messages. New fallbacks and the latest reply received together share one announcement. The transcript remains `aria-live="off"`.

The installed omp's `retry_fallback_applied` session event includes `from`, `to`, `role` and `reason`, and the TUI prints its warning. However, 18.13.3's collab host event allowlist excludes that event, and `model_change` saves no reason. Consequently a live warning can name the fallback without explaining why, including a preflight quota switch with no failed request. The wrapper does not read provider APIs, classify a manual switch by timing, or invent a usage-limit cause. An omp improvement would replicate this existing event and persist its source, reason and optional structured reset time on the model-change entry. Existing unopened-result and notification rules remain tied to turn completion and questions.


Helper views: `features/panes/derive.ts` holds `stripAssignmentPreamble` and `activityOf`, shared by the Tasks pane and the task tool card (`tool-render/tools/task.tsx`). The helper's own `stage` takes precedence over tool intents, and its `completionPercent` is labelled as a self-estimate. `features/panes/helperTranscript.ts` classifies a helper's session into assignment, messages, one-line notices, plain prompts, replies and displayed notices. The visible Tasks pane incrementally fetches these same helper files over collab through `helperJobs.ts` to derive their background jobs, including folded helpers; branches with running jobs remain visible. The fold keeps its hidden count while expanded, so Show fewer remains available. A terminal transcript error stops that helper's reader and shows Background jobs unavailable; transient null responses remain retryable. Child jobs have no Stop control. `tool-render/tools/task.tsx` derives a task row's mark from its helpers, using the `neutral` value of `ToolStatus` (`chat/friendly.ts`) for stopped helpers.

Helper definitions: `main/features/agents/parse.ts` follows omp 18.11's declaration rules. Only absent or null `tools` selects defaults; an empty or malformed value selects an empty built-in allowlist, with a warning for malformed declarations. The parser normalizes declared tools without adding `yield`, and preserves explicit `yield`, `structured` and `output` through reads, form edits and Duplicate. The editor's simple **Return structured results** switch changes only `structured`; output schemas remain unchanged. This avoids introducing a schema editor for an opaque omp-owned format. omp can add support tools and extension tools independently of the built-in allowlist.

Project discovery: `main/omp/project-discovery.ts` shares omp's home and temporary-root ceilings between helper discovery and the skills registry walk. Walks stop before home, `os.tmpdir()`, and, on POSIX, `/tmp` and `/var/tmp`, without inspecting their ancestors. Nested project folders remain eligible. A chat directly at a ceiling has no project helper destination or skills registry destination, and project creation/install choices are disabled with an explanation. Main also refuses those writes. Skill diagnostics omit ceiling-level project roots while retaining user roots and explicitly configured skill directories.

Running work: `ompRunning` in `derive.ts` says whether an omp process may still run the chat's helpers and jobs: this tab's omp starting, live or reconnecting, or another process during a read-only follow whose ownership is elsewhere or unknown. A follow that found the file free does not count, because the tab stays read-only until Continue here while no other process writes it. Unless progress or lifecycle reports a different outcome, `helpersOf` maps a helper omp keeps after its turn (registry `idle` or `parked`) to `done` with `messageable` set, so it shows Done and retains its Message action; it lists running helpers first and finished ones newest first, and `foldHelpers` picks the ones the Tasks pane shows before "Show earlier helpers". `transcriptHelperStates` reads each helper's last recorded state from task results, `job` and `wait` results and async-result deliveries, and marks work still running at an omp `session_exit` entry as stopped; `settleHelper` turns a working helper into stopped and clears `messageable` when omp is not running. `backgroundJobs(entries, ompLive, activeTools?)` applies the same rule to background jobs and returns each job's command, the intent from its call (omp records it on the tool call, and the model sends it as the `i` argument), its start time, omp's reported run time from a delivery or job snapshot, and the exit code from omp's closing "Command exited with code N" line, running jobs first. A delivery after a poll has settled a job keeps the poll's outcome and adds the final output, run time and exit code. `commandSummary` picks the first top-level step of a command that does something, using a small shell scanner that respects quotes, substitutions and here-documents and falls back to the first line when the quoting does not parse; job rows in the Tasks pane and job notices in the chat use it. `SessionHeader.tsx`, `TasksPane.tsx` and `Transcript.tsx` all pass `ompRunning(view)`, so the header chip, the Tasks pane and the transcript's task rows and helper cards agree.

Late background output: the collab client retains ended tool-call ids, including ids from saved results and idle reconciliation. Later updates enter `backgroundTools` instead of `activeTools`, so they cannot restore a foreground working indicator. `backgroundJobs` reads both maps and uses `partialResult.details.async.state`; a saved settled poll or delivery takes precedence over an older live frame. The Tasks pane, its badge and the header chip share this derivation. Cancelled bash badges use the neutral treatment.

Job controls and widgets: the Tasks pane sends Stop and Stop all through `sendSlashCommand` with Send now, so omp handles `/jobs kill <id>` and `/jobs kill all` while a turn is busy. A job's folder comes from its bash call or session header. `jobWidgets.ts` reads the rendered widget snapshot retained in job/wait results and updates, and `JobWidget.tsx` renders its headline, stage, meters, values, status grid and text. Spark and bar blocks use the shared full `Chart`, with every sample and target preserved. The chart-data disclosure includes target labels and numeric values, and trend arrows retain Up or Down text for screen readers.

Job purposes and captions: `job` and `wait` rows prefer omp's `intent` over the command label, with the command as secondary text. `backgroundJobs` retains that purpose for bash and eval jobs first seen in a saved report or live partial result, including eval's automatic background frames and delivery-only results. The private extension reads `ctx.getAsyncJobSnapshot()` on its existing tick and sends only running jobs' ids, intents and captions, capped at 100 jobs and 24,000 encoded characters. It neither requests captions nor starts widget model calls; captions follow omp's `async.widgets` setting. The bridge issues a metadata epoch through its existing request poll and rotates it on teardown and before a new host generation. Obsolete snapshots cannot restore jobs or replace the current location. The Tasks pane reads this metadata once on mount and follows native change events, displaying a matching running job's caption in muted text. It accepts only metadata stamped for its live host generation and session; ignored old events cannot suppress the initial read.

Background waits: the collab host forwards `agent_end.awaitingAsyncWork` without removing the field. `GuestClient` retains it separately from foreground `working`; an idle state frame does not clear the wait. `SessionController` keeps the request working across that wait, so the sidebar stays active, the queue stays held and no finished notification or unopened-result mark appears until the wait ends. The chat header and working row say Waiting for background jobs, and Stop waiting sends collab's abort. A new run, a terminal settle or an abort clears the flag. While waiting, the controller requests fresh owner-scoped SDK samples through the private native bridge, including running jobs and queued or in-flight result deliveries. It clears the wait when omp is idle with neither background work nor queued messages, releasing the app queue after cancellation or quiet completion. Checks are scoped to the host generation and wait revision; cached job metadata and late results cannot end a later wait. Missing SDK data retains the wait. omp's welcome/state snapshot has no equivalent field, so reconnect cannot recover a wait that started before the guest joined.

Durations: `fmtDuration` in `collab/lib/format.ts` formats job notice rows (`NoticeRow.tsx`), background job tool rows (`tool-render/tools/job.tsx`) and helper cards (`task.tsx`). `parseOmpDuration` in `notices.ts` reads omp's compact duration text from a task result ("2m41s") when omp gives no millisecond value.

Approval settings: `config:approval` offers the four known omp 18.14 modes without capability probing. A recognized mode has its typed value; an unknown value has `mode: null` and is retained in `rawMode`, without rewriting config or substituting a permission policy. `config:approval:forget` invokes only `/forget-approvals` in a short-lived no-session RPC process and requires `command_output` plus `agentInvoked: false`. The command clears omp's persisted file and folder grants for all projects; another process's in-memory session grants remain until that process restarts. The Permissions page edits restricted-folder arrays in the selected scope and writes `computer.control` as one literal policy key.

Configuration layers: `main/features/config.ts` reads the global and project layers through `omp config list --scope global|project --json`. These reads include omp's project settings sources and retain raw path-scoped values; YAML remains only the comment-preserving write path. `parseConfigLayer` rebuilds the dotted registry paths while preserving record keys and withholding credentials.

Model fallbacks: Models & roles reads `retry.fallbackChains` and the three behavior settings from the existing `omp config list --json` snapshot, including its global and project layers. Editors and dirty comparisons use the selected target layer; inherited or overriding effective chains remain visible in a separate read-only notice. Behavior controls show the selected layer's own or inherited value and identify any different effective value. `config:roles` also includes custom role keys that appear only in fallback chains. `config:roles:fallbacks` writes one role entry through the serialized, comment-preserving YAML transaction in the selected scope, defaulting to `modelRoleStorage` for callers that omit scope. Project config supports chains independently of that role-storage preference. The handler never copies the effective record into a file, so model-keyed chains, other scopes, malformed sibling entries and comments remain unchanged. Empty edits remove the key, matching omp's model hub; a null edit writes an explicit empty chain for any role, suppressing Default inheritance for chat roles or built-in fallback order for model-kind roles. Malformed parent mappings refuse writes. The renderer preserves unresolved selectors and malformed chains read-only, and stores a bare selector for inherited thinking or a suffixed selector for explicit effort. Existing `:auto` suffixes are preserved; new Auto picks remain absent, matching omp's model hub because retry fallback application treats Auto as inheritance. The behavior controls use `config:set` for `retry.modelFallback`, `retry.fallbackOn` and `retry.fallbackRevertPolicy`, filtering choices by omp's enum metadata. Web-role filtering shares the existing catalog limitation: omp's model JSON omits `webSearch`, so the wrapper cannot distinguish grounded-chat-capable models from other chat models and does not claim exact Web eligibility.

Model compaction: Models & roles requests window metadata explicitly. Main lists omp's models under two private, temporary config overlays, with `extendedContext` off and on and model thresholds disabled, so omp resolves standard and extended windows without catalog heuristics or changes to the owner's config. Ordinary model-list callers make no extra policy reads. Both catalogs and their enriched result share the existing config-invalidated cache. The renderer mirrors omp 18.14's base, fixed, percentage and reserve calculation for previews and confirms larger windows before writing the selected scope's model threshold entry. A plan records whether it applies only after per-model limits are enabled, so the preview, confirmation and pricing warning identify that future behavior.

Project instructions: `project:instructions` reads `contextFiles.extra` through omp, adds those project-root filenames alongside the built-in candidates and marks their content additive. The write handler re-reads the configured allowlist before editing, so a removed filename or arbitrary path is refused. The Instructions page can add filenames to this project's config while retaining inherited names and uses its existing editor and leave guard for the additional files. `shared/instructionFiles.ts` supplies the filename rules to its inline form validation and the main-process candidate validator; `config:set` validates `contextFiles.extra` before invoking the config writer.

## Renderer loading and packaging

`src/renderer/src/registry/lazy.tsx` wraps dynamic imports for pages, Settings sections, views and sheets. Feature entry points register lazy components; registry slots render these chunks on demand. Idle preloading and explicit `preload()` calls load components before they are opened when possible. Usage, Settings sections, xterm, KaTeX and other heavier features have separate chunks. In the v0.5.0 build, the uncompressed initial renderer entry chunk is approximately 1.56 MB, xterm approximately 331 KB and KaTeX approximately 262 KB. These figures are uncompressed build-output sizes of individual chunks.

Every side panel pane (Changes, Files, Preview, Outputs, Tasks, Plan, Terminal and the TSP side chat) loads from its own chunk, on demand or during idle preloading, while the badges (`features/panes/badges.tsx`) load with the app so the pane selector can show counts before a pane opens. The plan badge and the Plan pane share `usePlanReviewPending` from `features/panes/plan-review.ts`. The pinned helper strip loads the helper transcript dialog the same way, so it does not keep the Tasks pane in the entry chunk.

The release notes sheet loads in two stages, on first open or during idle preloading. The sheet itself comes with the update sheets chunk (`features/onboarding/UpdateSheets.tsx`) and shows nothing until that chunk loads. The release notes viewer, the bundled `CHANGELOG.md` text and its Markdown helpers come from a second chunk; until it loads, the sheet shows the notes dialog's frame with a skeleton, and closing it still reports the exit to the sheet host. The build guard rejects the changelog anywhere in the entry's static import closure, because the changelog grows with every release and would otherwise count against the entry allowance.

Screens, pages and sheets that most launches do not show register through `lazyView` or `lazyPage` too: the setup wizard, Help, the app and omp update sheets, the project overview, the folder chooser with its folder browser, and the session mode dialogs (`features/session-tools/ModeSheets.tsx`). When the first window opens on one of them (the setup wizard on a first run, or a restored project overview), its fallback shows until the chunk loads: a blank window in the chrome color for the setup wizard, and a skeleton in the overview's scroll column for the project overview. Pages show their frame, back link and skeleton while they load. The Settings page and its rail stay in the entry, because its sections already load from their own chunks and a lazy page would open without its rail. Home, composer tools, status items, notices and the global hosts (tour, quit, palette, terminal sheet) stay in the entry because they render with the first window. Small shared hooks are defined in separate modules so eager code does not import a lazy screen; for example `useHomeDir` is defined in `features/projects/folders/homeDir.ts` rather than the folder browser.

The Phosphor build transform retains `regular` for every icon definition and only the extra
weights named per definition in `scripts/phosphor-weights.ts`. `Name` and `NameIcon` exports
share a definition. `scripts/phosphor-weights.test.ts` checks production renderer `.ts` and
`.tsx` files, excluding tests and declarations, against an icon-authoring convention. Extra
weights must be explicit JSX props on imported icons or statically resolved const aliases,
using literals or conditional literal branches. The check rejects missing and unused
allowances, extra weights forwarded through props or React element constructors, and
unresolved icon props. Computed keys and getters cannot supply icon props. Context defaults
must be static, unmodified objects with an explicit regular weight; each nested provider
and const provider alias is checked. Ordinary chart objects with numeric weights are outside
the icon-construction checks. This is a source convention check, without arbitrary runtime
or cross-module dataflow inference. Keep extra-weight rendering local and explicit.
The check names four non-icon dynamic targets by file and exact expression: `adapter.Frame`
in `features/live-preview/Stage.tsx`, and `loaded ?? use(preload())`, `Fallback` and `Failure` in
`registry/lazy.tsx`. These existing preview and lazy-view boundaries may receive unresolved
ordinary props, but explicit or statically known weight-bearing props remain prohibited.
An unused boundary declaration fails the check.

TSP input validators are separate `shared/tsp-host.schema.ts` and `shared/tsp/*.schema.ts`
modules used by main. Shared renderer types derive from these schemas through type-only imports,
while document helpers remain free of runtime validation dependencies. Main's question mirror
uses `shared/tsp/question-arbitrator.ts` and retains the same zod validation. Startup notice
metadata, saved suggestion captures and saved window layouts use explicit field checks with
their existing fallback rules. The saved session-tree parser still uses zod in its lazy chunk;
zod is absent from the initial renderer entry and its static imports.

Translation namespaces used by startup code remain synchronous, including command titles, Settings rail
labels, pane badges, page-loading titles and folder-picker messages. The larger Settings section bodies,
context-tool editors and project detail screens use the deferred `settings`, `context` and `projectDetails`
namespaces. `i18n/index.ts` supplies these through a non-eager glob-backed i18next backend and queues
them with the import-free `registry/idle` scheduler. Their `useDeferredTranslation(namespace)` hooks
read the deferred namespace, then the eager namespace it was split from, and suspend within the
existing lazy-view boundary until loading settles. Pages and Settings sections show skeletons; project
dialogs have no loading frame and appear once ready. Deferred keys and their eager fallback keys are
disjoint. The i18n tests check that rule and verify translated first commits on successful loads.

i18next records a failed namespace load and does not load that namespace again, so `i18n/index.ts`
tracks failed loads itself and `useDeferredTranslation` throws a `LoadError` (`registry/loadError.ts`)
while its namespace is failed. `lazyView` turns a chunk that does not load into the same error. A
`LoadBoundary` (`registry/lazy.tsx`) catches only `LoadError` and shows its surface's failure state:
Settings sections show "Couldn't load this part of visual-omp" with Try again in place of their content,
and pages show it inside their frame with the back link. The side panel (`shell/Dock.tsx`) wraps the pane on
show in a boundary keyed by chat and pane, so a pane that does not load shows the same inline state while the
panel header still switches and closes panes. `SheetHost` (`shell/SheetHost.tsx`) wraps every sheet opened
through `openSheet` in a boundary that shows the message as a small dialog with Close (`LoadFailedDialog`).
That dialog takes part in sheet presence, so it closes and returns focus at once even when the failed sheet
had claimed presence before a nested part of it failed (`DialogLoadFailed`). The sidebar's Change icon and Rename
chat dialogs and the omp update dialog (also shown inline by setup) pass `DialogLoadFailed` as their `lazyView`
failure state, and the pinned helper strip's transcript dialog passes `LoadFailedDialog`. The terminal sheet's omp
screen and xterm view, the setup wizard (on its ink cover, in chrome colors) and the project overview show the
inline state in their own frames. The side questions drawer follows its availability and keeps omp's side question
readable above a compact notice; its put-away needs the failed chunk, so "Show omp terminal" hands the question to
omp's own screen and releases the drawer's explicit request, leaving the drawer open only while omp presents the
question. Transcript node views and the inline terminals of setup, sign-in and updates show a compact
`LoadFailedNotice`, and the native question and plan cards keep the document readable above that notice. Parts with
nothing of their own to show use `LoadFailedSilently`: the live preview tracker (live previews do not start) and a
tool card's Watch action (the card works without it). The large saved chat questions and their host load with the
app (`features/session-tools/largeResume.tsx`); only the dialog loads from its own chunk, and if it does not load,
the failure dialog's Close answers no, so the chat never waits on a question it cannot show. Try again loads each
failed namespace through the app's own loader, adds it
with `addResourceBundle`, and renders the surface again; `lazyView` tries a failed chunk again on that render. Other
errors pass through the boundary. `App` wraps the window in a last `LoadBoundary` that fills it with the failure
state, so a future lazy view without a failure state cannot blank the window.
Registry consumers without an explicit namespace default to the already loaded `shell` namespace.

The FLIP build guard checks the initial renderer entry and its static import closure for any
`features/tsp/` modules. The semantic screen remains lazy; shared subscriptions, presentation
claims, labels and notice state use `state/tsp/` so ordinary chat state does not import its UI.
The native plan-review and omp-dialog cards also load through the existing lazy slot boundary.
Their synchronous `NativeCardPresentation` slots retain exact presentation ownership while the
interactive chunk loads and establishes its document subscription. A display-only fallback shows
the current title, body and choices without moving focus or submitting answers.
Rollup membership is recorded after writing the build, with sizes read from the emitted files.
`npm run build` and both distribution paths emit `out/renderer/renderer-chunks.json` and
`renderer-bundle-size.json`, and enforce at most 20,000 bytes of entry-chunk growth over the
last classic release, v0.7.4 (`233c28252a211081e30202d4b0a41e02f45cad97`, 2,017,581 bytes).
`scripts/renderer-classic-baseline.json` records the baseline and its reproduction commands.
These are guard requirements and historical baseline evidence; each build's report
provides its measured size when verification runs.
On 2026-11-03, the owner accepted a measured entry ceiling of 2,041,903 bytes for 0.7.5: Side questions
first-frame presentation and put-away on close (`/btw` opens and closes the pane without the omp screen),
the Suggestions switch below the composer and open-by-default shell and Python output.
On 2026-11-04, the owner accepted 2,044,096 bytes for the large saved chat warning: the resume check in
`state/session.ts`, its decline handling and its strings stay in the entry, and the dialog loads lazily.
The baseline file records the current exception in `acceptedGrowth` with its reason and acceptance date;
the 20,000-byte default and the refusal of eager TSP view modules remain enforced.

`electron.vite.config.ts` bundles main and preload dependencies other than externalized packages. Pure-JavaScript main-process packages are devDependencies and are bundled into `out`; native `node-pty` remains a runtime dependency and is selectively included by `electron-builder.yml`. `electronLanguages` retains `en` and `en-US`; source maps are excluded from packaged output. `node-pty`'s package contents are trimmed to runtime files.

Windows packaging stages node-pty's bundled `conpty.dll` and `OpenConsole.exe` from the sole
`third_party/conpty/<version>/win10-<arch>` directory into `build/Release/conpty`. The
`scripts/stage-conpty.mjs` hook runs in `beforePack` and `afterExtract`: electron-builder 26.15.3
calls `beforePack` before native rebuild, so the second call restores the files after rebuild and
before the app copy. macOS targets do nothing. After packaging, `scripts/after-pack.mjs` requires
both files in `resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty` and checks
their PE machine fields against the target x64 or arm64 architecture before changing fuses.

Windows CI runs the no-model TSP transport probe with the Node-built addon before packaging,
then checks x64 and arm64 package layouts. The x64 smoke probe runs `visual-omp.exe` with
`ELECTRON_RUN_AS_NODE=1` and explicitly loads the unpacked, Electron-rebuilt node-pty. It repeats
hello, acknowledgments and chunked Unicode edit/send through APC and OSC 877. System ConPTY is
recorded separately regardless of whether it drops APC. Each framing runs in an independent child,
so an APC timeout cannot skip OSC. Initial and pre-cleanup snapshots and appended traffic journals
retain available evidence when setup, transport or cleanup fails; the coordinator records child
timeouts and saves each result separately. Download and layout failures have bounded diagnostic
JSON. Successfully written listings, hashes, diagnostics and byte captures are uploaded as the
`windows-conpty-evidence` artifact after ordinary step failures. Disk failures, runner loss or job
cancellation can prevent final evidence or upload. APC remains selected because both APC and
OSC 877 completed the recorded Node and packaged exchanges. These headless
checks do not establish installed UI behavior, child-process cleanup or Defender/SmartScreen
acceptance; those remain Windows-machine criteria in `docs/TSP-MIGRATION.md`.

Windows host exit now releases node-pty 1.1.0's retained JS transport through
`main/omp/windows-pty-cleanup.ts`. After the public PTY exit event, it destroys input/output
sockets and awaits the conout worker's termination. This guarded private adapter covers bundled
TSP and system-ConPTY classic hosts; it never calls native kill a second time. Upstream issues
887 and 947 document the worker/input-pipe gaps, and issue 983 documents native double-close.
The latest published 1.2.0 beta retains the worker gap, so the dependency remains 1.1.0.
The lifecycle CI recorder runs six production hosts per presentation in separate processes,
asserts no per-cycle MessagePort/worker growth, and requires natural recorder exit. Thread and
total handle counts remain evidence for review; the adapter does not claim to fix upstream's
separate native HPCON lifetime issue or replace installed-build process and pipe-handle checks.

`scripts/after-pack.mjs` flips Electron fuses before the existing macOS signing hook. Node-mode startup is disabled on macOS. Windows retains it because node-pty's existing console cleanup forks a Node-mode child with `ELECTRON_RUN_AS_NODE`; changing its PTY backend requires Windows testing. Node environment options and CLI inspection are disabled on both platforms; node-pty's cleanup fork supplies neither. App startup is restricted to ASAR and the embedded archive integrity check is enabled. Native node-pty files remain unpacked and outside the archive integrity check. The main bundle compiles out ws's optional `bufferutil` and `utf-8-validate` loaders, and packaging fails if either bare require is emitted. The macOS hardened runtime remains disabled under the existing signing policy.

Rich reply rendering: `ui/rich-content.ts` hydrates escaped SVG and Mermaid fence slots in saved, linked and streaming Markdown. `ui/DiagramPreview.tsx` provides the same renderer for SVG and MMD write previews. SVG passes through a static element and attribute allowlist, removes scripts, animation, foreign objects and external references, resolves omp's figure colors against the containing surface, and is displayed as an isolated image. Incomplete SVG fences use omp's unmodified partial-source repair before sanitization. The outer image exposes authored SVG names and descriptions, including Mermaid's accessibility references; generic names apply only when metadata and a caller label are absent. Figures retain natural pixel dimensions in named, keyboard-focusable horizontal scrollers. Mermaid loads on demand with HTML labels disabled. Before the engine sees source, `ui/mermaid-source.ts` removes configuration directives and rejects image shapes, embedded image markup and resource-bearing style declarations. Metadata uses the same `js-yaml` loader and `JSON_SCHEMA` as Mermaid's `addVertex`, with the same inline versus multiline wrapping, so escaped keys, escaped values and aliases are checked after decoding. Ordinary diagrams, textual URLs and link declarations remain eligible. Refused diagrams retain their source with an explanation. Mermaid performs layout inside its own temporary sandboxed iframe; the app decodes its returned data wrapper without inserting that HTML, sanitizes the extracted SVG, and displays only an isolated SVG image. Its stylesheet retains static drawing declarations. Theme changes redraw the images. This still depends on Mermaid's parser, sandbox implementation and browser layout engine; source rejection, the SVG sanitizer and the image context provide additional boundaries.

Table charts load in a separate chunk. `ui/charts/vendor/omp/` preserves the unmodified MIT chart and SVG source modules from `@oh-my-pi/pi-tui` 18.15.0, with their source paths, license and provenance beside them. `ui/charts/table-chart.ts` uses the same numeric analysis, local plan and usefulness gate as omp's `always` mode, including all 22 chart kinds. Derived ratio and speedup columns are excluded when the table's values establish that they divide two other measures. The separate `render-chart.ts` adapter replaces the upstream line-chart gradient with a flat theme fill. The original accessible table remains above its named chart. A table at the end of a streaming reply waits until prose follows or the reply finishes. The reusable `ui/Chart.tsx` accepts omp's `ChartSpec` for job widgets. Its optional `domain` prop invokes the local line/bar adapter, which preserves widget bounds and includes reference marks beyond the observed samples without adding fabricated data points.

The catch is that omp's `smart` mode refines chart kind, columns, naming and meaning through its private TUI judge callback; `auto` uses that callback only when a native judge is available and otherwise keeps the local guess (`interactive-mode.ts`, `applyAutoGraphSetting`). Neither the selected chart plan nor the judge callback is replicated through collab. The app therefore uses local qualification only and performs no hidden model calls. Hosted chats must pin `tui.autoGraph` to `always`, which enables the prompt's chart guidance while bypassing the TUI judge, until omp replicates the selected chart plan or exposes a non-generative chart-planning API.

Remote Markdown images: the shared `transcript/render.ts` image renderer emits inert placeholders containing the alt text, host and Load image button for HTTP(S) and network-path sources. `ui/remote-images.ts` creates one image only when that placeholder's button is activated, with `referrerPolicy="no-referrer"`; other placeholders remain unloaded. Relative assets and trusted image data URLs keep their existing image rendering. Unsupported active schemes render only alt text. The CSP retains `img-src https:` for this explicit renderer-only load path; it does not grant automatic image loading to Markdown. HTTP image loads remain blocked by the existing CSP.

## Data sources
| Need | Source |
|---|---|
| Live chat state | collab guest snapshot |
| Session history | `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl` (256-byte title slot, header, entry tree) |
| Settings | `omp config list/get/set --json` |
| Model roles, presets | `config.yml` `modelRoles` / `modelPresets` |
| Models | `omp models --json` |
| Agents | `~/.omp/agent/agents/*.md`, `<project>/.omp/agents/*.md`, bundled via `omp agents` |
| MCP | Saved definitions are read without project file/env substitutions or project settings initialization. Automatic checks resolve fresh user-source IDs in main, ignore renderer-supplied config and use neutral cwd. A project check requires a per-server click and native confirmation naming its scope, folder and destination. Only that server's substitutions resolve after approval. Sign-in re-reads the exact native scope, confirms before project settings or subprocesses, then runs omp's builtin in the selected folder with extensions, tools, LSP, skills, rules and context disabled. A root `disabledProviders` overlay excludes every MCP discovery provider registered in omp 18.14; direct native lookup still authorizes the chosen server and preserves omp's credential writes. |
| Usage/limits | `omp usage --json` supplies per-account limits and optional routing policy. Saved resets use `omp usage reset --json` and `omp usage reset <provider>/<credentialId>`; the CLI exit code determines success (`main/features/usage/resets.ts`). Structured account and organization identities select a unique target. Recorded usage comes from local session and subagent JSONL files through `main/features/extensions.ts` (`extensions:spend`, up to 371 days for the activity grid), with serialized scans and a shared parsed-transcript cache. `features/extensions/usage/limitsStore.ts` shares limits with the status bar. Stats reads omp's printed URL and reuses only its owned running process. It accepts credential-free HTTP URLs on localhost, 127.0.0.1 or [::1]; invalid output stops the child. |
| Working state | `SessionController` snapshots expose `workingSince`; tool elapsed time is shown only when a call has known start and result times. |
| App CPU and RAM | `app:metrics` uses the validated IPC handler and Electron `app.getAppMetrics()` for app processes only. `main/services/app-metrics.ts` computes cumulative CPU-second deltas over monotonic elapsed seconds divided by the logical CPU count (0% to 100% of total capacity), avoiding the unspecified core normalization of `percentCPUUsage`. It sums working-set KiB as bytes; shared pages may count more than once. Missing fields, process-set changes and first samples leave CPU unavailable. |
| Dock visibility | `state/app.ts` exports `useDockVisible()`, which accounts for pages and narrow layouts where chat takes precedence over the open dock, and `currentDock()`, the focused chat's panel layout. |
| Git | `git`, `gh` |
| App update metadata and installers | Main calls the official `decoy-dev/visual-omp` GitHub release API and trusted GitHub asset hosts. |
| Update-check counts | Main posts version, platform and architecture to `https://visual-omp-update-count.chris-216.workers.dev/v1/check` once per fresh packaged-app check. |

App resource polling belongs to `shell/useAppMetrics.ts`, which runs one polling loop every two seconds while mounted and visible. Each loop waits for its previous reply; visibility changes invalidate that loop's late replies and start a fresh generation. The native handler is synchronous. Hidden or minimized windows stop renderer polling through Electron's document visibility state; main also refuses native sampling while no window is visible and restored. Visibility resume resets the CPU baseline and history, and delayed polling after sleep starts a fresh interval. Main has no metrics timer. Only CPU and byte aggregates cross IPC, with no process IDs or command lines, persistence, network reporting, omp engine/tool inspection or whole-machine load collection. The renderer retains at most 30 entries younger than 60 seconds and preserves unavailable gaps in its trend. Electron's [CPUUsage](https://www.electronjs.org/docs/latest/api/structures/cpu-usage) and [MemoryInfo](https://www.electronjs.org/docs/latest/api/structures/memory-info) definitions document the native units; installed Electron 44.5.1 types expose cumulative CPU seconds as optional.

Provider identities: `main/features/providers.ts` creates connected rows only from a provider's own models, accounts or disabled credentials. Provider models, usage and login-method discovery run in `NEUTRAL_CWD` with extensions disabled, so background Settings reads omit extension-contributed methods and selected-project configuration. Explicit terminal sign-in retains the selected project. `get_login_providers` inherits an alias's authenticated flag but omits `storeCredentialsAs` (omp 18.14, `modes/rpc/rpc-mode.ts`), so exact alias-to-base grouping remains blocked on upstream metadata. Authenticated login entries without independent provider evidence remain sign-in methods instead of duplicate connected rows.

Sign-in transfer uses `omp auth export` and `omp auth import <file>` in `NEUTRAL_CWD` unconditionally, with no project argument in IPC. Native file dialogs run in main. Export stdout is written through a private sibling directory to a new file with mode 0600 where supported and renamed into place; credentials never cross IPC or enter logs. Both actions warn about plaintext secrets and refresh-token rotation before the picker opens. Import delegates validation and merging to omp, reports exit status without echoing sensitive output and invalidates provider/model caches. Auth-broker users must transfer on their broker host.

Saved and followed history resolve the active leaf with omp's replay rule in `state/history.ts`: the last entry's optional `activeLeafId` restores the branch interrupted by a late result or usage entry, and null clears the branch. The live mirror and Outputs use the same branch function, with an explicit tree selection taking precedence. A captured leaf omitted from collab is resolved through saved ancestry to its nearest carried ancestor. If the captured leaf is unavailable in both sources, the newest entry that selects itself is used. The session tree uses that resolver for its current marker and keyboard navigation order. The session index skips symlinked project buckets so an alias cannot list the same chats twice.

Saved conversation identity: `main/omp/sessions.ts` follows sibling `continuationOf` links keyed by their directory and session id, folding superseded files into the newest linked copy for sidebar, Home, project and search listings. A copy supersedes its predecessor only when it contains that predecessor's newest conversation entry, so an original that kept writing remains separate. Comparison ignores exit records and idle eval-state snapshots. Saved history, saved tree views, fork and export resolve old file paths through those links. Live room ids and live-host tree navigation retain the host's exact physical file, because another process's sibling does not establish this host's destination. Summary aliases associate an already open predecessor with its listed continuation without opening another tab.

Conversation deletion: `main/omp/session-trash.ts` first stops this app's hosts for the complete retained file set, then checks ownership of every transcript. Any external or unverified owner refuses the whole deletion before any file moves. Otherwise the newest file, every retained predecessor and each artifacts directory go individually to Electron's `shell.trashItem`. The files remain recoverable through the operating system's trash with their original restore paths. A partial filesystem failure identifies every path that could not be moved, while the remaining calls still run. Restoring the original files makes the session index fold the conversation again; there is no separate in-app restore store. Tests simulate restoration to those paths and do not establish native Finder Put Back behavior.

Session pins: `main/omp/session-pins.ts` reads the agent directory's `session-pins.json`; pin changes run the consumed `/pin <id>` builtin through a no-session RPC process. omp owns its shared cross-process file lock and atomic replacement. The app accepts only confirmed builtin output with `agentInvoked: false`, watches external pin-file changes and migrates existing app preference pins once without toggling already migrated ids. A failed migration retains its old preference data. Consolidated conversations retain pins on their older copies, and Unpin clears each retained pinned id.

Saved rename: `main/omp/session-rename.ts` refuses an app-owned or externally owned saved chat before starting a short-lived `--resume` RPC process. An initial `get_state` must match the requested file and id before `set_session_name` can run. omp writes the 256-byte `source: "user"` title slot, title-change entry and title index. A final `get_state`, the resulting saved summary and confirmed child termination establish the returned title, file and id. A write-time continuation returns its changed destination explicitly, and the dialog warns with that path. No model request or model override is selected. omp initialization failures remain visible, including a missing configured default model. The dialog does not open a chat tab.

## App updates, rollback and reinstall

`main/features/updates.ts` owns update checks, install-method detection and installer downloads.
`main/services/updates.ts` provides the pure release selection, semver skip and installer-trust
rules. Release-note entries can include their original GitHub `tag` and a `platformAsset` selected
with the same expected filename, platform, architecture and release-download URL checks as a
regular update. Drafts and unversioned tags are excluded; prereleases remain visible only when
the running version is itself a prerelease.

`main/services/update-count.ts` sends the update-check count without awaiting it, with a five-second
timeout and contained failures. Cached status reads, release-note fetches, development builds and
tests send no count. `workers/update-count` deploys the collector separately from Electron and its
TypeScript project. It validates a JSON body of at most 1 KiB, returns 204 and schedules a D1 upsert
through `ctx.waitUntil`. The `visual-omp-update-count` database stores only UTC day, version,
platform, architecture and count in `daily_counts`; optional channel input is validated and discarded.
Worker logs, invocation logs, traces and Logpush are disabled, and the code emits no request logs.
These totals measure checks, so they cannot identify unique installations. See
`workers/update-count/README.md` for deployment and the last-30-days query.

`updates:app:reinstallInfo` takes no arguments and returns `AppReinstallInfo` with the running
`version`, `available`, `reason` and `command`. Main fetches fresh official release metadata;
cached update availability cannot authorize a reinstall. The pure
`reinstallAvailability(releases, currentVersion, trust, isPackaged, method)` excludes development
builds (`development`) and manual installations (`unsupported`), then requires the exact current
version on the existing prerelease track (`missing-release`) and its trusted platform installer
(`missing-installer`). Drafts remain excluded. Main reports failed release lookups as `offline`.
Available results have a null reason. Direct installers have a null command; main supplies
commands for detected Homebrew and Scoop installations.

`updates:app:download` takes an optional version. A strictly earlier version or the exact running version causes main to fetch
official GitHub release metadata again, find the requested published release on the running
version's release track, and select its trusted matching installer. The renderer cannot supply
an installer URL. Rollback and reinstall reuse the existing download, trusted redirect, byte-count
verification, optional supplied SHA256 digest validation and installer execution path. A supplied
digest must be supported and match; an absent digest remains compatible with older releases.
The renderer offers these targeted downloads only for disk-image and NSIS installations. The viewer
explains package-manager downgrade or reinstall steps instead. macOS still requires a manual
copy from the disk image and app restart, and Windows runs the installer after closing the app.

Package-manager reinstall instructions preserve the existing package-manager installation
records. Homebrew's `brew reinstall --cask visual-omp` uses the currently published cask.
Scoop's `scoop update visual-omp --force` uses the bucket's current manifest; global installations
add `--global` and require an administrator PowerShell. Both commands may install a newer version
than the running app, so their dialog uses a generic reinstall heading and explicitly describes
that possibility. Saved chats and omp settings remain available. A replacement newer than
`appUpdateSkipThrough` clears that skip through the usual startup rule.

Same-version installer execution does not normalize or write the rollback boundary. It also
does not create a pending upgrade outcome, because a version comparison cannot establish whether
the same-version replacement completed.

The main-only stored preference `appUpdateSkipThrough: string | null` defaults to null. A confirmed
rollback persists the version being left before the installer is opened. `flushPrefs()` awaits
queued preference writes so an installer-triggered exit cannot discard that choice. Preferences
preserve unknown JSON fields when an earlier app version writes a known field. This permits a
rollback to retain newer preferences, although code before 0.7.1 does not honor the skip and can
still offer the version being left. Those versions require a user action to install an update.

`effectiveUpdateSkip(currentVersion, skippedThroughVersion)` clears the effective skip only when
the running semver is strictly newer than the stored ceiling. Equal versions, including differing
build metadata, retain it. `updateIsAvailable(latestVersion, currentVersion, skippedThroughVersion)`
requires a version newer than both the running version and any effective skip. The cached status
validator checks availability against the current skip, so a cache written before a rollback
cannot restore a suppressed update notice.

`updates:app:check` accepts `[force?, includeSkipped?]`. Background and default checks honor the
skip; the explicit **Check for updates** action sets `includeSkipped` to true without clearing the
stored choice. `AppUpdateStatus.skippedThroughVersion` exposes that choice for the About page and
release viewer. Before beginning a regular update, the renderer calls `updates:app:resume` with no
arguments to clear the skip explicitly. Direct current-version reinstall never calls this
operation and leaves the stored skip unchanged through download and installer execution. The
renderer retains both the target version and operation kind so the shared installer sheet keeps
reinstall labels and retries the same version after an error.

## Compatibility
The collab wire protocol is versioned (`COLLAB_PROTO`). On launch the app reads `omp --version` and
compares it with `MIN_OMP_VERSION` (`src/main/omp/locate.ts`), currently 18.15.0. Older binaries are
refused by the setup screen and by `ompPath`; only update checks and `omp update` may run them.
Executable discovery ignores relative PATH entries and normalizes an explicit override to an
absolute path before checking its version. Subsequent commands retain that checked absolute path,
so changing a child process's project folder cannot select another project-local omp executable.
The setup wizard uses the existing installer IPC for missing binaries and the About update dialog
for unsupported versions. It streams output and refreshes the detected version on completion;
managed installations name the application responsible for updating omp. Existing users whose
omp is missing, unsupported or refused receive only this install step. There is no upper bound.

Native first-run setup is renderer-owned, gated on loaded omp status and app preferences.
Fresh preferences set `setupCompleted: false`; an existing preferences file without the field
loads it as true. Explicit requests from Help or the command palette reopen the full wizard.
The sequence is welcome, conditional install or update, providers, default chat model,
permissions, app appearance and a done summary. Providers reuse omp discovery and `omp login`
in an inline terminal, with Skip until a provider connects and Continue afterward. The model
and permission choices use omp's global configuration path. The permission step keeps an
explicitly chosen mode, suggests Ask me first only while omp is on its default, and writes only a
changed mode; an unrecognized mode blocks Continue so it cannot be overwritten.
`SetupWizard` keeps `MiniShell` mounted between steps and feeds it current install, provider,
model, permission and appearance state. Welcome and Done are ink covers; content steps use a
split layout that becomes a single column below 900px. Appearance updates its local miniature
immediately and the control theme 240ms later. The transient `useSetup.handoff` flag lets `App`
mount `Shell` behind the existing wizard while its miniature scales to the viewport and fades.
After 700ms (140ms without transforms under reduced motion), the wizard unmounts. Finishing,
Exit setup or Esc persists
`setupCompleted: true` and dismisses setup. The existing tour waits until setup is completed,
no longer needed and a supported omp is available. Setup never writes omp's `setupVersion`,
so terminal glyph, composer and theme setup remain available. `ensureNewUserApproval`
remains the fresh-profile approval fallback when omp has no configured mode.
