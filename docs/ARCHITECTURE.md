# visual-omp architecture

## Overview

This document describes the current design. A proposed migration of app-hosted chats from reading omp's painted terminal to omp's Tern Surface Protocol (TSP) is described in [TSP-MIGRATION.md](TSP-MIGRATION.md).

```mermaid
flowchart LR
  subgraph Renderer [Renderer (React)]
    UI[Chat / panes / screens]
    GC[Collab guest client<br/>(AES-GCM, vendored from collab-web)]
    XT[xterm.js terminal sheet]
  end
  subgraph Main [Electron main (Node)]
    SH[SessionHost]
    RL[Loopback relay<br/>127.0.0.1 + ::1, per session]
    CLI[OmpCli / ConfigFiles / Git / Files]
    IDX[SessionsIndex]
  end
  PTY[[omp TUI in node-pty]]
  UI -- IPC --> SH
  SH -- keystrokes --> PTY
  PTY -- screen bytes --> SH -- IPC --> XT
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
layout field by field with zod: a field that is missing or of the wrong type keeps its default and a damaged chat
entry is dropped. The Files pane's viewer tabs, expanded folders and tree width follow the same scope in
`features/panes/files-store.ts` (not persisted, dropped with the chat, and a request from a chat that has closed
writes nothing).

Each SessionHost:

1. Allocates a loopback WebSocket relay on a free port (listening on `127.0.0.1` and `::1` only).
2. Writes a per-session config overlay (`collab.autoStart: control`,
   `collab.relayUrl: ws://localhost:<port>`, `collab.displayName`, plus a fixed status line style:
   `symbolPreset: unicode` and `statusLine` preset `default`, separator `powerline`, thinking level
   as a word) into a private temporary directory and spawns
   `omp --config <overlay> --extension <private bridge> [--resume <file>]` in a node-pty with the project as cwd. Crash recovery uses `--restore <file>` instead. Session tools
   read the model and thinking segment from the painted screen, so the overlay replaces the user's status line
   settings. A theme's symbol overrides still apply after the preset and can change the glyphs
   the parser looks for. The user's own `config.yml` is never modified for this.
   Of the feature pins reviewed for 0.7, table charting and startup worktree creation remain overridden for hosted chats. `tui.autoGraph: "always"` charts tables with
   omp's local rules, which the app draws natively, and avoids the model judge calls of `auto` and
   `smart`, whose chart plans collab does not carry. `worktree.onStart: "off"` stays until omp exposes
   outer input readiness, because a startup worktree question could otherwise meet an early keystroke.
   Interim `out://` replies, SVG, next-message predictions, idle recaps and worktree exit choices follow
   the user's omp settings and appear natively. These are process-only settings.
3. When the omp host connects to the relay (`/r/<roomId>?role=host`), SessionHost resolves the
   room key with `omp collab list --json` + `omp collab link <instanceId> --json`, matching the
   link's room id, and hands the control link to the renderer. The registry pid is not always the
   spawned pid: on Windows, a `bun install -g` omp is Bun's `omp.exe` launcher, and its `bun.exe`
   child hosts the room. So `main/omp/room-host.ts` asks hosts with the spawned pid first, then
   hosts that connected after the spawn, and skips hosts whose link names another relay.
4. The renderer's guest client joins the room and exposes a live snapshot (header, entries,
   streaming message, active tools, subagent progress, model/thinking/context state, pending
   `select`/`editor` UI requests) through `useSyncExternalStore`.
5. **User input is typed into the real TUI** (bracketed paste + Enter), so prompts, `!`/`$`
   prefixes, queue behaviour and the slash commands the app passes through behave as they do in
   a terminal. The guest channel is used for UI-request answers, abort and subagent commands. Slash lines first go
   through `routeSlash` (`session-tools/slash.ts`), which opens the app's own screen for commands
   it covers and refuses the few that would break the hosted session (`/collab` and `/join`).
   The rest go through `sendSlashCommand` (`session-tools/typed.ts`), which types the line and
   turns what omp prints above its editor into a chat result row. The composer's slash menu lists
   omp's `get_available_commands` (a short-lived `omp --mode rpc` in the project folder, cached
   per folder) merged with the builtin catalog in `src/main/services/omp-builtin-commands.ts`.
   omp's generic dialogs are local to its TUI, so `OmpDialogCard` reads them from the painted
   screen and answers with keys; it and the Plan Review card register as native overlays so the
   terminal sheet stays closed for them. `docs/COMMANDS.md` lists every command's handling.
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

Host side-channel notices: `main/omp/host-observations.ts` decodes omp's OSC 7501 root status and reads the session's `session_recaps` journal in read-only mode, keeping only the newest non-blank recap. The owning extension publishes `historyDbPath`; it uses omp's injected `getAgentDir()` and the matching 18.14 profile, `PI_CONFIG_DIR` and existing-XDG-data-root rules from the tested `history-path.ts` resolver. Standalone omp does not resolve the public pi-utils package from an extension, so that resolver is embedded rather than imported there. A locked or temporarily unreadable journal retains the last successful notices. Blocked and error records drive chat marks, and their message text is used for the existing question and completion notifications. Startup model-substitution warnings are captured from recognized warning rows above the editor, with painted word wrapping joined and partial paints deduplicated. Input ends that startup capture. `features/host-notices` presents warnings in every transcript view without adding model messages, and the recap only while it is newer than the newest user or assistant message on any branch, including a reply still streaming (`latestMessageAt` in `chat/transcript/notices.ts`).

Worktree shutdown: the host lets omp apply its own keep, remove and ask policy. Only omp's exact startup and exit worktree confirmation shapes open native dialogs, with Keep as the default and omp's risk description retained. Application text, image pastes, image-only Enter, native text-dialog answers and application keys are serialized; closing rejects queued application input before any further write. Native text-dialog answers use `host:paste`; raw `host:write` is reserved for TerminalMirror's intentional terminal-sheet bytes. `withEditorInput` holds the same lock across an exact editor transfer, provides non-reentrant guarded keys and rejects expired transaction access. A failed editor transfer can gate composed text and pastes while leaving recovery and Stop available. An outstanding startup Create decision becomes No when closing supersedes it. Closing tracks an exit request, its painted acknowledgement, the owning extension's teardown event and terminal-status clear. Room presence or closure establishes none of those boundaries. Unacknowledged requests and stalled editor-input drains offer a native Keep waiting or Stop omp now choice after four seconds; later observed phases offer it after fifteen seconds without a phase change. Active worktree confirmations pause that deadline. There is no automatic force-kill: teardown and subsequent worktree removal cannot be safely separated by room closure, so only an explicit Stop omp now can interrupt them. That explicit termination is itself bounded, and an unconfirmed stop keeps the host tracked. A parented native dialog can be dismissed when omp exits concurrently.

Startup readiness remains an omp API gap. A live collab snapshot can precede the editor's submit gate and the outer startup worktree choice. Classic debug values and screen text do not expose that outer readiness flag. Preflight protects a worktree question already painted or being answered; it cannot establish that a later startup question will not appear. The app does not automatically resend an unacknowledged submission. See the parity findings for the source trace.

The developer flag `VOMP_TSP=1` selects Tern Surface Protocol at the launch of an app-hosted
chat on macOS or Linux. Windows ignores the flag, logs that TSP is unsupported and uses the
classic transport until bundled ConPTY transport and packaging are verified. Classic hosts,
terminal-follow and their painted-screen adapters keep their existing behavior. The hidden PTY
still runs the same omp session, private extension and collab relay. The opt-in launch sets
`TERM_PROGRAM=tern`, removes `PI_TUI_NATIVE`, and reads raw PTY bytes. Its incremental splitter
removes only TSP APC messages before the existing non-TSP byte paths. Chunk bodies are joined
as bytes before UTF-8 decoding. Relaunch with `VOMP_TSP` unset to recover the classic controls.

`src/main/omp/tsp/` applies frames with omp 18.14.0's MIT-licensed reference document applier.
Hello advertises all 44 kinds; the semantic renderer covers each kind or its documented fallback.
The terminal feature list remains empty, so blob caching, aside layout and semantic scrolling
are not advertised. The reply grants two credits per surface and an APC body limit of 65,536
bytes. Applied frames receive cumulative acknowledgments, which may coalesce to the newest
applied sequence while the writer is occupied. Ordinary terminal replies, including DA1, follow
the hello reply through the ordered protocol queue. Width, theme and motion are carried in hello
before negotiation and sent as events afterward. All PTY writes use the host's atomic writer.
Protocol housekeeping bypasses the application transaction and closing gates so an editor
transfer or graceful shutdown cannot block credits.

Every newly negotiated hello starts a protocol epoch, clears the live documents and rejects
input addressed to an earlier epoch, including when omp replaces itself inside the existing PTY.
Collab room generations are separate: a room transition retains protocol documents but invalidates
their input authority. Initial collab attachment may adopt the startup document. Later generations
require a fresh frame for each surface after the new room becomes live; a frame for one surface
cannot promote another retained tree. A protocol close with `keep: true` retains read-only main
content. Snapshots distinguish live, transitioning, failed and exited state. Process exit invalidates
presentation authority even when no protocol close arrived.

Renderer-originated semantic events and raw keys enter the existing application transaction lock.
Main rechecks the host's collab generation and protocol epoch at the writer. Semantic events also
validate their addressed live surface and node. `host:tsp-event` parses a strict typed subset of events;
acknowledgments, resize, theme and motion remain main-owned. Raw fallback keys and Escape use
the guarded `host:keys` route with generation and epoch. Malformed operation tuples and nested
node shapes are rejected before the reference applier. Protocol failures are shown by the omp
screen without replacing collab or OSC as the authority for chat status.

Plain-text submission uses semantic `send` only when omp advertised it and the focused main
editor under `dock` explicitly has `sendable: true`. The inherited composer role is `omp.editor`;
shell variants, modal fields, PTY mode and a subagent-view composer are refused. An open overlay
or screen-mode surface also blocks submission. Main publishes availability and a reason, and the
app composer shows that reason beside its unavailable send control. The writer checks availability
again before sending. omp retains displaced drafts through its own send semantics. Attachments,
application pastes, Ctrl+Q follow-up submission, shell/Python modes and prediction transfer remain
unavailable in this preview. Screen-driven feature controls remain disabled until their TSP
consumers are implemented. Expected refusals do not become persistent chat errors.

TSP shutdown uses the existing native stages and exit records. It sends Escape when an omp
overlay or screen is open, waits for the main editor to become available, then sends `/exit`
through semantic `send`. Acknowledgment is the closing-status toast, closure of the surface
addressed by `/exit`, or process exit. Closing a settings surface alone does not acknowledge
`/exit`. Startup worktree creation remains disabled. Exit questions remain visible in the omp
screen and are subject to the read-only hook-dialog restriction below.

If ten seconds elapse from spawn without a supported hello, main marks the preview failed once
output has been observed. A supported hello starts a separate five-second deadline for the first
surface. Failure sets `tspFailed`, exposes "omp did not start its semantic screen", and offers
Restart. It does not automatically retry, kill omp or switch renderer modes. An explicit restart of
a failed host awaits the existing stop stages, then launches omp again with the saved session file;
the visible history and input recall are retained while the new collab room connects. Stop or
launch errors are shown, and a failed stop prevents relaunch.

`host:tsp-snapshot` and `host:tsp-update` expose complete per-host documents with an ordered
revision, protocol epoch, lifecycle state and send availability. The renderer reconciles replacement
documents, reuses unchanged nodes and supports subscriptions by surface and node id. Shared
view-state derivations identify overlays, screen surfaces, focus, the composer and unclaimed output.
The role/action registry determines claims and interaction overrides. Classic cards claim no TSP
nodes. These channels retain the existing trusted app-window IPC boundary and main-owned host
lookup; they do not introduce per-window host ownership.

For TSP hosts, every existing terminal-sheet entry point opens the lazy-loaded **omp screen**.
The existing sheet frame, expand control and labelled focus region remain. The title includes an
overlay's heading when present. The renderer draws layers, screen-mode surfaces and unclaimed
dock nodes. Unclaimed main content that collab does not replicate appears under "Other omp output";
omp's main transcript and composer are excluded. Lists expose selection semantics, tree row clicks
stay local until confirmation, and forms send typed events. Markdown, code, diffs, JSON and progress
reuse shared renderers. Media remains a placeholder while blobs are unavailable. Rows, ANSI and
unknown content use a readable mono fallback, with guarded raw keys while focused.

Semantic overlays and screen surfaces open the sheet without a painting delay. Their closure
closes an automatically opened sheet; a manually opened sheet remains open. Escape dismisses an
open omp overlay or screen through the guarded key route. With neither open, Escape closes the
sheet. Closing the sheet itself does not answer omp, and focus returns to that chat's composer.
"Show raw outline" discloses the read-only developer inspector below the semantic content.

`src/shared/tsp/question-match.ts` now provides conservative question arbitration diagnostics.
The renderer mirrors all pending collab requests, including locally answered requests awaiting
`ui-request-end`, through `host:tsp-questions`. Main validates the host, protocol epoch, room
generation and monotonically increasing mirror revision. Matching authority is scoped to the guest
client, its connection identity and the host generation and epoch observed for each request.
Disconnect and welcome invalidate matching authority. Room rotation and protocol epoch changes
exclude requests observed in an earlier scope without clearing the visible collab question or queue.
A transient disconnect preserves those visible requests until welcome, following the existing
collab lifecycle. If a delayed TSP snapshot makes a request's epoch uncertain, diagnostic matching
stays unavailable while the original collab `reqId` answer path remains available. Matching requires
mutual uniqueness of title, field and option data. A matched node remains in settling state until
both its request and node have ended. Snapshots expose `questionMatches`.

Phase 2 is not complete. Hook dialogs remain visible and read-only while arbitration is diagnostic.
The interactive writer recheck, hook completion controls and live channel-ordering evidence remain
required before local hook answering can be enabled. Collab questions retain their existing controls.
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
Full overlay workflow replay, live hook and extension-fallback recordings, sharing parity,
packaged checks and the remaining manual acceptance criteria still gate the complete Phase 2
preview. There is no new user setting and no replacement of the transcript or collaboration channel.



Composer assistance: `main/omp/predict.ts` keeps one lazy no-session RPC child per retained folder for `predict_word` and `predict_word_feedback`, using the id-correlated transport in `main/omp/rpc.ts`. Mounted composers retain their folder separately, so split composers share one child and the last release closes it. Settings changes close children without dropping those owners; closing the last window or quitting closes all children and clears ownership. Auto resolves to local n-grams; SmolLM and Apple remain omp-owned local choices. No word-completion request sends a provider prompt. Both word and dictation children apply the shared MCP-discovery isolation as the final temporary overlay, disable extension/context/rule/skill loading and scrub inherited execution and host-control environment variables.

Dictation: `main/omp/dictation.ts` allows one microphone capture across the app. It lazily starts a no-session RPC child for the explicit microphone action, with a private temporary `stt.enabled: true` overlay before the mandatory isolation overlay. It forwards `dictation_state`, `dictation_transcript` and `dictation_end` frames by capture id, and sends `dictation_stop` while startup is pending or recording is active. The child closes when the capture ends or the app quits, and the overlays are removed. Unexpected transport termination publishes one terminal error and releases the capture, including after the start response has completed. The renderer waits for `recording`, treats a stop during startup as cancellation, and preserves available non-cancelled text even when omp also reports an error. The former keybinding-write, chat-restart and TUI-editor polling path is removed.

Next-message predictions remain opt-in and billed by omp. Painted ghost text only identifies the displayed offer. `prediction-transfer.ts` holds the host's serialized application-input transaction, checks fresh overlays, generation and the exact empty draft, then registers recovery state before sending Tab. The trusted extension reads the complete draft through `ctx.ui.getEditorText()`; main retains that exact string before requesting a synchronous compare, clear and verification through `ctx.ui.setEditorText()`. No painted-row reconstruction or Ctrl+C participates. Ambiguous Tab acknowledgements, failed reads or clears block composed input until exact recovery confirms the editor is clear. Captures remain in main until acknowledged, and the renderer persists saved copies for explicit insertion or dismissal when its draft, mode or room changes. Hosted chats no longer pin `composer.predictions`, so the user's omp setting decides whether predictions run.

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

Ownership: `main/omp/elsewhere.ts` reads omp 18.14's machine-global session-id lease under `run/session-owners`, including the shared XDG state root when present. macOS observes the persistent flock sidecar's open descriptor; Linux reads the abstract socket registry; Windows opens the existing global mutex without creating or waiting on it. Linux and Windows names use pi-natives' two seeded xxh64 hashes of the absolute sidecar path. A missing or unreadable header or lease uses the existing descriptor and terminal-breadcrumb fallback; Windows reports unknown when its mutex check cannot be completed. A header id makes file aliases meet the same lease, but a matching app host id alone never establishes ownership. macOS excludes an app host only when its PID is the observed holder. omp owns the final write-time decision and creates a continuation if another process claimed the lease meanwhile.

Forks: `main/omp/fork.ts` resolves the current continuation, starts a short-lived RPC process with `--resume`, calls `fork(entryId?)`, then reads that process's new session identity with `get_state`. It waits for confirmed process termination before handing the copy to the renderer, so the snapshot process has released its lease. Shutdown escalates after three seconds and refuses the handoff after five seconds if exit remains unconfirmed. The renderer opens the copied session without typing `/fork`, `/resume` or `/tree` into the source host. The isolated 18.14 fixture tests preserve the live source's bytes and nanosecond mtime for whole-session, user-message and assistant-message forks. The source keeps its original lease. Extensions, tools, skills, rules, context files and title generation are disabled in the snapshot process.

Transcript file references use `fs:resolveRefs` (`main/services/fileRefs.ts`). Exact paths take precedence.
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

Narration: `ThinkingContent.narration` is optional because ordinary thinking blocks carry no narration flag, including in saved chats. `replyText` in `chat/transcript/turns.ts` classifies flagged thinking as reply text for Markdown, file links, pacing, tool-group boundaries, helper conversations, the live activity label and completed-reply announcements. Unmarked thinking keeps its existing disclosure. omp 18.14's collab serializer preserves the complete message shape, so the flag survives replication.

Interim replies: `chat/friendly.ts` classifies `write` calls to `out://` and reads `details.replies` from foreground tool frames and saved results. `replyText` presents write content as assistant prose while its arguments grow. The transcript presents shell replies outside command disclosures, includes both transports in reply playout and file-reference resolution, and leaves reply writes out of step groups, their counts and completed-turn file summaries. `helperTranscript.ts` applies the same history classification. `AnnouncementTracker` announces complete write replies and each new foreground reply once; repeated frames, saved copies, loaded history and reconnect snapshots stay silent. Main's file-reference resolver and tool context targets refuse `out://` destinations. omp 18.14's `serializeReplicatedEvent` preserves partial `arguments.content`, and the collab guest keeps the cumulative message unchanged.


Model fallbacks: `collab/lib/modelFallback.ts` reads the displayed branch's `model_change.resolvedModelIsFallback === true`. omp 18.13.3's `session-manager.appendModelChange` writes that flag for retry-chain and usage-preflight changes. The `fallback` role alone is insufficient because omp also uses it when returning to the primary model. Manual choices, missing flags, account rotation and nearby limit errors do not establish a fallback. `chat/transcript/ModelFallbackNotice.tsx` shows the warning at the entry, and the composer derives its marker from the latest choice, keeping the original model through a fallback chain. A manual choice or primary restoration clears it. Live collab state supplies the selected model; saved entries supply it without a running omp.

omp's retry controller persists `retryRecovery` on failed assistant messages. When the first assistant message after a flagged change explicitly records `recovery: "model"` and its `supersededBy` provider/model matches the destination, the warning quotes that error and uses its source model. Other nearby errors remain separate. The quoted error retains any reset or retry information as historical text; the app computes no reset countdown. Provider-reported assistant content of type `fallback`, with `from.model` and `to.model`, gets its own warning within the reply. The composer shows that response's serving model until a later ordinary response or model choice replaces it.

The composer returns selected and displayed identities separately. `ModelList` compares against the selected identity, so a provider fallback displayed as the serving model can still be chosen explicitly. A provider fallback is displayed only while its source identity matches live selection. Retry-chain tracking distinguishes an unknown original from a chain that has not started.

`chat/transcript/announcements.ts` tracks new fallback entries and provider blocks for `ReplyAnnouncer`, the existing polite live channel. The initial snapshot and the first snapshot after reconnect are silent. Provider blocks use response timestamp, block position and source/destination for deduplication across streaming and saved messages. New fallbacks and the latest reply received together share one announcement. The transcript remains `aria-live="off"`.

The installed omp's `retry_fallback_applied` session event includes `from`, `to`, `role` and `reason`, and the TUI prints its warning. However, 18.13.3's collab host event allowlist excludes that event, and `model_change` saves no reason. Consequently a live warning can name the fallback without explaining why, including a preflight quota switch with no failed request. The wrapper does not read provider APIs, classify a manual switch by timing, or invent a usage-limit cause. An omp improvement would replicate this existing event and persist its source, reason and optional structured reset time on the model-change entry. Existing unopened-result and notification rules remain tied to turn completion and questions.


Helper views: `features/panes/derive.ts` holds `stripAssignmentPreamble` and `activityOf`, shared by the Tasks pane and the task tool card (`tool-render/tools/task.tsx`). The helper's own `stage` takes precedence over tool intents, and its `completionPercent` is labelled as a self-estimate. `features/panes/helperTranscript.ts` classifies a helper's session into assignment, messages, one-line notices, plain prompts, replies and displayed notices. The visible Tasks pane incrementally fetches these same helper files over collab through `helperJobs.ts` to derive their background jobs, including folded helpers; branches with running jobs remain visible. The fold keeps its hidden count while expanded, so Show fewer remains available. A terminal transcript error stops that helper's reader and shows Background jobs unavailable; transient null responses remain retryable. Child jobs have no Stop control. `tool-render/tools/task.tsx` derives a task row's mark from its helpers, using the `neutral` value of `ToolStatus` (`chat/friendly.ts`) for stopped helpers.

Helper definitions: `main/features/agents/parse.ts` follows omp 18.11's declaration rules. Only absent or null `tools` selects defaults; an empty or malformed value selects an empty built-in allowlist, with a warning for malformed declarations. The parser normalizes declared tools without adding `yield`, and preserves explicit `yield`, `structured` and `output` through reads, form edits and Duplicate. The editor's simple **Return structured results** switch changes only `structured`; output schemas remain unchanged. This avoids introducing a schema editor for an opaque omp-owned format. omp can add support tools and extension tools independently of the built-in allowlist.

Project discovery: `main/omp/project-discovery.ts` shares omp's home and temporary-root ceilings between helper discovery and the skills registry walk. Walks stop before home, `os.tmpdir()`, and, on POSIX, `/tmp` and `/var/tmp`, without inspecting their ancestors. Nested project folders remain eligible. A chat directly at a ceiling has no project helper destination or skills registry destination, and project creation/install choices are disabled with an explanation. Main also refuses those writes. Skill diagnostics omit ceiling-level project roots while retaining user roots and explicitly configured skill directories.

Running work: `ompRunning` in `derive.ts` says whether an omp process may still run the chat's helpers and jobs: this tab's omp starting, live or reconnecting, or another process during a read-only follow whose ownership is elsewhere or unknown. A follow that found the file free does not count, because the tab stays read-only until Continue here while no other process writes it. Unless progress or lifecycle reports a different outcome, `helpersOf` maps a helper omp keeps after its turn (registry `idle` or `parked`) to `done` with `messageable` set, so it shows Done and retains its Message action; it lists running helpers first and finished ones newest first, and `foldHelpers` picks the ones the Tasks pane shows before "Show earlier helpers". `transcriptHelperStates` reads each helper's last recorded state from task results, `job` and `wait` results and async-result deliveries, and marks work still running at an omp `session_exit` entry as stopped; `settleHelper` turns a working helper into stopped and clears `messageable` when omp is not running. `backgroundJobs(entries, ompLive, activeTools?)` applies the same rule to background jobs and returns each job's command, the intent from its call (omp records it on the tool call, and the model sends it as the `i` argument), its start time, omp's reported run time from a delivery or job snapshot, and the exit code from omp's closing "Command exited with code N" line, running jobs first. A delivery after a poll has settled a job keeps the poll's outcome and adds the final output, run time and exit code. `commandSummary` picks the first top-level step of a command that does something, using a small shell scanner that respects quotes, substitutions and here-documents and falls back to the first line when the quoting does not parse; job rows in the Tasks pane and job notices in the chat use it. `SessionHeader.tsx`, `TasksPane.tsx` and `Transcript.tsx` all pass `ompRunning(view)`, so the header chip, the Tasks pane and the transcript's task rows and helper cards agree.

Late background output: the collab client retains ended tool-call ids, including ids from saved results and idle reconciliation. Later updates enter `backgroundTools` instead of `activeTools`, so they cannot restore a foreground working indicator. `backgroundJobs` reads both maps and uses `partialResult.details.async.state`; a saved settled poll or delivery takes precedence over an older live frame. The Tasks pane, its badge and the header chip share this derivation. Cancelled bash badges use the neutral treatment.

Job controls and widgets: the Tasks pane sends Stop and Stop all through `sendSlashCommand` with Send now, so omp handles `/jobs kill <id>` and `/jobs kill all` while a turn is busy. A job's folder comes from its bash call or session header. `jobWidgets.ts` reads the rendered widget snapshot retained in job/wait results and updates, and `JobWidget.tsx` renders its headline, stage, meters, values, status grid and text. Spark and bar blocks use the shared full `Chart`, with every sample and target preserved. The chart-data disclosure includes target labels and numeric values, and trend arrows retain Up or Down text for screen readers.

Background waits: the collab host forwards `agent_end.awaitingAsyncWork` without removing the field. `GuestClient` retains it separately from foreground `working`; an idle state frame does not clear the wait. `SessionController` keeps the request working across that wait, so the sidebar stays active, the queue stays held and no finished notification or unopened-result mark appears until the wait ends. The chat header and working row say Waiting for background jobs, and Stop waiting sends collab's abort. A new run, a terminal settle or an abort clears the flag. omp's welcome/state snapshot has no equivalent field, so reconnect cannot recover a wait that started before the guest joined.

Durations: `fmtDuration` in `collab/lib/format.ts` formats job notice rows (`NoticeRow.tsx`), background job tool rows (`tool-render/tools/job.tsx`) and helper cards (`task.tsx`). `parseOmpDuration` in `notices.ts` reads omp's compact duration text from a task result ("2m41s") when omp gives no millisecond value.

Approval settings: `config:approval` offers the four known omp 18.14 modes without capability probing. A recognized mode has its typed value; an unknown value has `mode: null` and is retained in `rawMode`, without rewriting config or substituting a permission policy. `config:approval:forget` invokes only `/forget-approvals` in a short-lived no-session RPC process and requires `command_output` plus `agentInvoked: false`. The command clears omp's persisted file and folder grants for all projects; another process's in-memory session grants remain until that process restarts. The Permissions page edits restricted-folder arrays in the selected scope and writes `computer.control` as one literal policy key.

Configuration layers: `main/features/config.ts` reads the global and project layers through `omp config list --scope global|project --json`. These reads include omp's project settings sources and retain raw path-scoped values; YAML remains only the comment-preserving write path. `parseConfigLayer` rebuilds the dotted registry paths while preserving record keys and withholding credentials.

Model compaction: Models & roles requests window metadata explicitly. Main lists omp's models under two private, temporary config overlays, with `extendedContext` off and on and model thresholds disabled, so omp resolves standard and extended windows without catalog heuristics or changes to the owner's config. Ordinary model-list callers make no extra policy reads. Both catalogs and their enriched result share the existing config-invalidated cache. The renderer mirrors omp 18.14's base, fixed, percentage and reserve calculation for previews and confirms larger windows before writing the selected scope's model threshold entry. A plan records whether it applies only after per-model limits are enabled, so the preview, confirmation and pricing warning identify that future behavior.

Project instructions: `project:instructions` reads `contextFiles.extra` through omp, adds those project-root filenames alongside the built-in candidates and marks their content additive. The write handler re-reads the configured allowlist before editing, so a removed filename or arbitrary path is refused. The Instructions page can add filenames to this project's config while retaining inherited names and uses its existing editor and leave guard for the additional files. `shared/instructionFiles.ts` supplies the filename rules to its inline form validation and the main-process candidate validator; `config:set` validates `contextFiles.extra` before invoking the config writer.

## Renderer loading and packaging

`src/renderer/src/registry/lazy.tsx` wraps dynamic imports for pages, Settings sections, views and sheets. Feature entry points register lazy components; registry slots render these chunks on demand. Idle preloading and explicit `preload()` calls load components before they are opened when possible. Usage, Settings sections, xterm, KaTeX and other heavier features have separate chunks. In the v0.5.0 build, the uncompressed initial renderer entry chunk is approximately 1.56 MB, xterm approximately 331 KB and KaTeX approximately 262 KB. These figures are uncompressed build-output sizes of individual chunks.

`electron.vite.config.ts` bundles main and preload dependencies other than externalized packages. Pure-JavaScript main-process packages are devDependencies and are bundled into `out`; native `node-pty` remains a runtime dependency and is selectively included by `electron-builder.yml`. `electronLanguages` retains `en` and `en-US`; source maps are excluded from packaged output. `node-pty`'s package contents are trimmed to runtime files.

`scripts/after-pack.mjs` flips Electron fuses before the existing macOS signing hook. Node-mode startup is disabled on macOS. Windows retains it because node-pty's existing console cleanup forks a Node-mode child with `ELECTRON_RUN_AS_NODE`; changing its PTY backend requires Windows testing. Node environment options and CLI inspection are disabled on both platforms; node-pty's cleanup fork supplies neither. App startup is restricted to ASAR and the embedded archive integrity check is enabled. Native node-pty files remain unpacked and outside the archive integrity check. The main bundle compiles out ws's optional `bufferutil` and `utf-8-validate` loaders, and packaging fails if either bare require is emitted. The macOS hardened runtime remains disabled under the existing signing policy.

Rich reply rendering: `ui/rich-content.ts` hydrates escaped SVG and Mermaid fence slots in saved, linked and streaming Markdown. `ui/DiagramPreview.tsx` provides the same renderer for SVG and MMD write previews. SVG passes through a static element and attribute allowlist, removes scripts, animation, foreign objects and external references, resolves omp's figure colors against the containing surface, and is displayed as an isolated image. Incomplete SVG fences use omp's unmodified partial-source repair before sanitization. The outer image exposes authored SVG names and descriptions, including Mermaid's accessibility references; generic names apply only when metadata and a caller label are absent. Figures retain natural pixel dimensions in named, keyboard-focusable horizontal scrollers. Mermaid loads on demand with HTML labels disabled. Before the engine sees source, `ui/mermaid-source.ts` removes configuration directives and rejects image shapes, embedded image markup and resource-bearing style declarations. Metadata uses the same `js-yaml` loader and `JSON_SCHEMA` as Mermaid's `addVertex`, with the same inline versus multiline wrapping, so escaped keys, escaped values and aliases are checked after decoding. Ordinary diagrams, textual URLs and link declarations remain eligible. Refused diagrams retain their source with an explanation. Mermaid performs layout inside its own temporary sandboxed iframe; the app decodes its returned data wrapper without inserting that HTML, sanitizes the extracted SVG, and displays only an isolated SVG image. Its stylesheet retains static drawing declarations. Theme changes redraw the images. This still depends on Mermaid's parser, sandbox implementation and browser layout engine; source rejection, the SVG sanitizer and the image context provide additional boundaries.

Table charts load in a separate chunk. `ui/charts/vendor/omp/` preserves the unmodified MIT chart and SVG source modules from `@oh-my-pi/pi-tui` 18.14.0, with their source paths, license and provenance beside them. `ui/charts/table-chart.ts` uses the same numeric analysis, local plan and usefulness gate as omp's `always` mode, including all 22 chart kinds. The separate `render-chart.ts` adapter replaces the upstream line-chart gradient with a flat theme fill. The original accessible table remains above its named chart. A table at the end of a streaming reply waits until prose follows or the reply finishes. The reusable `ui/Chart.tsx` accepts omp's `ChartSpec` for job widgets. Its optional `domain` prop invokes the local line/bar adapter, which preserves widget bounds and includes reference marks beyond the observed samples without adding fabricated data points.

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
| Dock visibility | `state/app.ts` exports `useDockVisible()`, which accounts for pages and narrow layouts where chat takes precedence over the open dock, and `currentDock()`, the focused chat's panel layout. |
| Git | `git`, `gh` |
| App update metadata and installers | Main calls the official `decoy-dev/visual-omp` GitHub release API and trusted GitHub asset hosts. |
| Update-check counts | Main posts version, platform and architecture to `https://visual-omp-update-count.chris-216.workers.dev/v1/check` once per fresh packaged-app check. |

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
compares it with `MIN_OMP_VERSION` (`src/main/omp/locate.ts`), currently 18.14.0. Older binaries are
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
