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
which keeps every ⌘ number stable. Closing a saved chat adds it to the reopen stack with its text draft. Reopen
closed chat restores the last eligible entry without starting omp. `normalizeRestoredChatSelection` in the same file
repairs the persisted layout on launch: a restored chat view takes its project from the focused half of a split, a
restored project overview keeps its own project even when an open chat belongs to another project, and a page that
was open returns to the chat or overview it came from. Split view can show two chats, each with its own controller.
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
   link's port and room id, and hands the control link to the renderer.
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

Helper views: `features/panes/derive.ts` holds `stripAssignmentPreamble` and `activityOf`, shared by the Tasks pane and the task tool card (`tool-render/tools/task.tsx`). `features/panes/helperTranscript.ts` classifies a helper's session into assignment, messages, one-line notices, plain prompts, replies and displayed notices. `tool-render/tools/task.tsx` derives a task row's mark from its helpers, using the `neutral` value of `ToolStatus` (`chat/friendly.ts`) for stopped or waiting helpers.

Running work: `ompRunning` in `derive.ts` says whether an omp process may still run the chat's helpers and jobs: this tab's omp starting, live or reconnecting, or another process during a read-only follow whose ownership is elsewhere or unknown. A follow that found the file free does not count, because the tab stays read-only until Continue here while no other process writes it. `transcriptHelperStates` reads each helper's last recorded state from task results, `job` and `wait` results and async-result deliveries, and marks work still running at an omp `session_exit` entry as stopped; `settleHelper` turns a working or waiting helper into stopped when omp is not running. `backgroundJobs(entries, ompLive, activeTools?)` applies the same rule to background jobs and returns each job's command, the intent from its call (omp records it on the tool call, and the model sends it as the `i` argument), its start time, omp's reported run time from a delivery or job snapshot, and the exit code from omp's closing "Command exited with code N" line, running jobs first. A delivery after a poll has settled a job keeps the poll's outcome and adds the final output, run time and exit code. `commandSummary` picks the first top-level step of a command that does something, using a small shell scanner that respects quotes, substitutions and here-documents and falls back to the first line when the quoting does not parse; job rows in the Tasks pane and job notices in the chat use it. `SessionHeader.tsx`, `TasksPane.tsx` and `Transcript.tsx` all pass `ompRunning(view)`, so the header chip, the Tasks pane and the transcript's task rows and helper cards agree.

Durations: `fmtDuration` in `collab/lib/format.ts` formats job notice rows (`NoticeRow.tsx`), background job tool rows (`tool-render/tools/job.tsx`) and helper cards (`task.tsx`). `parseOmpDuration` in `notices.ts` reads omp's compact duration text from a task result ("2m41s") when omp gives no millisecond value.

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
| Usage/limits | Provider limits come from omp's usage reports. Recorded usage comes from local session and subagent JSONL files through `src/main/features/extensions.ts`; `features/extensions/usage/limitsStore.ts` shares the limits snapshot with the status bar. The browser stats link starts `omp stats`. |
| Working state | `SessionController` snapshots expose `workingSince`; tool elapsed time is shown only when a call has known start and result times. |
| Dock visibility | `state/app.ts` exports `useDockVisible()`, which accounts for pages and narrow layouts where chat takes precedence over the open dock. |
| Git | `git`, `gh` |

## Compatibility
The collab wire protocol is versioned (`COLLAB_PROTO`). On launch the app reads `omp --version` and
compares it with `MIN_OMP_VERSION` (`src/main/omp/locate.ts`); an older omp opens the setup screen
with the install command, and there is no upper bound.
