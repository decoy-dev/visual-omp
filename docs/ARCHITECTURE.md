# visual-omp architecture

## Overview

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
   `omp --config <overlay> [--resume <file>]` in a node-pty with the project as cwd. Session tools
   read the status line from the painted screen, so the overlay replaces the user's status line
   settings. A theme's symbol overrides still apply after the preset and can change the glyphs
   the parser looks for. The user's own `config.yml` is never modified for this.
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
   it covers and refuses the few that would break the hosted session (`/collab`, `/move`, `/wt`).
   The rest go through `sendSlashCommand` (`session-tools/typed.ts`), which types the line and
   turns what omp prints above its editor into a chat result row. The composer's slash menu lists
   omp's `get_available_commands` (a short-lived `omp --mode rpc` in the project folder, cached
   per folder) merged with the builtin catalog in `src/main/services/omp-builtin-commands.ts`.
   omp's generic dialogs are local to its TUI, so `OmpDialogCard` reads them from the painted
   screen and answers with keys; it and the Plan Review card register as native overlays so the
   terminal sheet stays closed for them. `docs/COMMANDS.md` lists every command's handling.
6. `/restart`, `/new`, `/resume`, branching and forking start a new collab room (new generation);
   SessionHost re-resolves the link and the renderer reconnects.

## Process boundaries
- **Main** owns every subprocess, file system access and network socket. Renderer is sandboxed,
  context-isolated, and reaches main only through the typed preload API (`window.vomp`).
- Model/Markdown content is rendered without Node access; links open externally via main.
- One writer per session: a session live in another omp process opens read-only (from its JSONL).

Transcript file references use `fs:resolveRefs` (`main/services/fileRefs.ts`). Exact paths take precedence.
For an abbreviated final component containing U+2026, main lists only the existing candidate parents:
folders named earlier in the reply, latest first, then the chat and output bases, or the single parent
of an absolute or home-relative path. The first eligible folder with matches must contain exactly one
matching regular file or folder. Bounded directory handles skip hidden entries and symlinks, discard
oversized or incomplete listings, never recurse and never read file contents. `FILE_REF_LIMITS` caps
folder entries and total directory reads. The renderer retains the abbreviated label and uses the
resolved absolute path for opening, its tooltip and Copy path.

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

`ui/Page.tsx` owns the page-navigation slot store. `PageFrame` portals Back into the slot rendered by `shell/Sidebar.tsx`; pages with section navigation, including Settings, portal the rail there and set nav mode, which hides the chat lists while keeping them mounted. Pages with Back only use back mode and keep the lists visible. With the sidebar hidden, Back and the rail render inline. Page and section focus moves to the title after lazy content mounts unless the reader moves focus first.

omp notices: `chat/transcript/notices.ts` parses displayed `custom_message` entries into typed notices (background jobs, IRC messages, process exits, advisor notes, skill use, other). It reads omp's structured `details` first and strips omp's wrapper markup only as a fallback, caching the result per entry. `chat/transcript/NoticeRow.tsx` renders them in the transcript and in the helper conversation dialog, and `features/session-tools/tree.ts` uses `noticeSummary` for the session tree.

Narration: `ThinkingContent.narration` is optional for older omp versions. `replyText` in `chat/transcript/turns.ts` classifies flagged thinking as reply text for Markdown, file links, pacing, tool-group boundaries, helper conversations, the live activity label and completed-reply announcements. Unmarked thinking keeps its existing disclosure. omp 18.14's collab serializer and the installed 18.13.3 binary serialize the complete message shape, so the flag survives replication; saved 18.13.3 Opus 5.5 entries also contain it.

Model fallbacks: `collab/lib/modelFallback.ts` reads the displayed branch's `model_change.resolvedModelIsFallback === true`. omp 18.13.3's `session-manager.appendModelChange` writes that flag for retry-chain and usage-preflight changes. The `fallback` role alone is insufficient because omp also uses it when returning to the primary model. Manual choices, missing flags, account rotation and nearby limit errors do not establish a fallback. `chat/transcript/ModelFallbackNotice.tsx` shows the warning at the entry, and the composer derives its marker from the latest choice, keeping the original model through a fallback chain. A manual choice or primary restoration clears it. Live collab state supplies the selected model; saved entries supply it without a running omp.

omp's retry controller persists `retryRecovery` on failed assistant messages. When the first assistant message after a flagged change explicitly records `recovery: "model"` and its `supersededBy` provider/model matches the destination, the warning quotes that error and uses its source model. Other nearby errors remain separate. The quoted error retains any reset or retry information as historical text; the app computes no reset countdown. Provider-reported assistant content of type `fallback`, with `from.model` and `to.model`, gets its own warning within the reply. The composer shows that response's serving model until a later ordinary response or model choice replaces it.

The composer returns selected and displayed identities separately. `ModelList` compares against the selected identity, so a provider fallback displayed as the serving model can still be chosen explicitly. A provider fallback is displayed only while its source identity matches live selection. Retry-chain tracking distinguishes an unknown original from a chain that has not started.

`chat/transcript/announcements.ts` tracks new fallback entries and provider blocks for `ReplyAnnouncer`, the existing polite live channel. The initial snapshot and the first snapshot after reconnect are silent. Provider blocks use response timestamp, block position and source/destination for deduplication across streaming and saved messages. New fallbacks and the latest reply received together share one announcement. The transcript remains `aria-live="off"`.

The installed omp's `retry_fallback_applied` session event includes `from`, `to`, `role` and `reason`, and the TUI prints its warning. However, 18.13.3's collab host event allowlist excludes that event, and `model_change` saves no reason. Consequently a live warning can name the fallback without explaining why, including a preflight quota switch with no failed request. The wrapper does not read provider APIs, classify a manual switch by timing, or invent a usage-limit cause. An omp improvement would replicate this existing event and persist its source, reason and optional structured reset time on the model-change entry. Existing unopened-result and notification rules remain tied to turn completion and questions.


Helper views: `features/panes/derive.ts` holds `stripAssignmentPreamble` and `activityOf`, shared by the Tasks pane and the task tool card (`tool-render/tools/task.tsx`). `features/panes/helperTranscript.ts` classifies a helper's session into assignment, messages, one-line notices, plain prompts, replies and displayed notices. `tool-render/tools/task.tsx` derives a task row's mark from its helpers, using the `neutral` value of `ToolStatus` (`chat/friendly.ts`) for stopped helpers.

Running work: `ompRunning` in `derive.ts` says whether an omp process may still run the chat's helpers and jobs: this tab's omp starting, live or reconnecting, or another process during a read-only follow whose ownership is elsewhere or unknown. A follow that found the file free does not count, because the tab stays read-only until Continue here while no other process writes it. Unless progress or lifecycle reports a different outcome, `helpersOf` maps a helper omp keeps after its turn (registry `idle` or `parked`) to `done` with `messageable` set, so it shows Done and retains its Message action; it lists running helpers first and finished ones newest first, and `foldHelpers` picks the ones the Tasks pane shows before "Show earlier helpers". `transcriptHelperStates` reads each helper's last recorded state from task results, `job` and `wait` results and async-result deliveries, and marks work still running at an omp `session_exit` entry as stopped; `settleHelper` turns a working helper into stopped and clears `messageable` when omp is not running. `backgroundJobs(entries, ompLive, activeTools?)` applies the same rule to background jobs and returns each job's command, the intent from its call (omp records it on the tool call, and the model sends it as the `i` argument), its start time, omp's reported run time from a delivery or job snapshot, and the exit code from omp's closing "Command exited with code N" line, running jobs first. A delivery after a poll has settled a job keeps the poll's outcome and adds the final output, run time and exit code. `commandSummary` picks the first top-level step of a command that does something, using a small shell scanner that respects quotes, substitutions and here-documents and falls back to the first line when the quoting does not parse; job rows in the Tasks pane and job notices in the chat use it. `SessionHeader.tsx`, `TasksPane.tsx` and `Transcript.tsx` all pass `ompRunning(view)`, so the header chip, the Tasks pane and the transcript's task rows and helper cards agree.

Late background output: the collab client retains ended tool-call ids, including ids from saved results and idle reconciliation. Later updates enter `backgroundTools` instead of `activeTools`, so they cannot restore a foreground working indicator. `backgroundJobs` reads both maps and uses `partialResult.details.async.state`; a saved settled poll or delivery takes precedence over an older live frame. The Tasks pane, its badge and the header chip share this derivation. Cancelled bash badges use the neutral treatment.

Durations: `fmtDuration` in `collab/lib/format.ts` formats job notice rows (`NoticeRow.tsx`), background job tool rows (`tool-render/tools/job.tsx`) and helper cards (`task.tsx`). `parseOmpDuration` in `notices.ts` reads omp's compact duration text from a task result ("2m41s") when omp gives no millisecond value.

Approval settings: `config:approval` reads the installed omp's `cfg://tools.approvalMode` enum to advertise supported choices. A recognized mode has its typed value; an unknown value has `mode: null` and is retained in `rawMode`, without rewriting config or substituting a permission policy. `config:approval:forget` invokes only `/forget-approvals` in a short-lived no-session RPC process and requires `command_output` plus `agentInvoked: false`. The command clears omp's persisted file and folder grants for all projects; another process's in-memory session grants remain until that process restarts.


## Renderer loading and packaging

`src/renderer/src/registry/lazy.tsx` wraps dynamic imports for pages, Settings sections, views and sheets. Feature entry points register lazy components; registry slots render these chunks on demand. Idle preloading and explicit `preload()` calls load components before they are opened when possible. Usage, Settings sections, xterm, KaTeX and other heavier features have separate chunks. In the v0.5.0 build, the uncompressed initial renderer entry chunk is approximately 1.56 MB, xterm approximately 331 KB and KaTeX approximately 262 KB. These figures are uncompressed build-output sizes of individual chunks.

`electron.vite.config.ts` bundles main and preload dependencies other than externalized packages. Pure-JavaScript main-process packages are devDependencies and are bundled into `out`; native `node-pty` remains a runtime dependency and is selectively included by `electron-builder.yml`. `electronLanguages` retains `en` and `en-US`; source maps are excluded from packaged output. `node-pty`'s package contents are trimmed to runtime files.

## Data sources
| Need | Source |
|---|---|
| Live chat state | collab guest snapshot |
| Session history | `~/.omp/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl` (256-byte title slot, header, entry tree) |
| Settings | `omp config list/get/set --json` |
| Model roles, presets | `config.yml` `modelRoles` / `modelPresets` |
| Models | `omp models --json` |
| Agents | `~/.omp/agent/agents/*.md`, `<project>/.omp/agents/*.md`, bundled via `omp agents` |
| MCP | `~/.omp/agent/mcp.json`, `<project>/.omp/mcp.json` |
| Usage/limits | Provider limits come from omp's usage reports. Saved rate-limit resets are listed and spent through omp's builtin `/usage reset`, sent as a prompt to a short-lived `omp --mode rpc --no-session` process whose `command_output` events carry what omp prints (`src/main/features/usage/resets.ts`, `usage:resetAccounts` and `usage:spendReset`). Recorded usage comes from local session and subagent JSONL files through `src/main/features/extensions.ts` (`extensions:spend`, up to 371 days for the activity grid; scans of different ranges run one after another and share a parsed-transcript cache); `features/extensions/usage/limitsStore.ts` shares the limits snapshot with the status bar. The browser stats link starts `omp stats`. |
| Working state | `SessionController` snapshots expose `workingSince`; tool elapsed time is shown only when a call has known start and result times. |
| Dock visibility | `state/app.ts` exports `useDockVisible()`, which accounts for pages and narrow layouts where chat takes precedence over the open dock, and `currentDock()`, the focused chat's panel layout. |
| Git | `git`, `gh` |

## Compatibility
The collab wire protocol is versioned (`COLLAB_PROTO`). On launch the app reads `omp --version` and
compares it with `MIN_OMP_VERSION` (`src/main/omp/locate.ts`); an older omp opens the setup screen
with the install command, and there is no upper bound.
