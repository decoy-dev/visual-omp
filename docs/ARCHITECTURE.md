# visual-omp — Architecture

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

Each chat tab owns one **SessionHost**:

1. Allocates a loopback WebSocket relay on a free port (listening on `127.0.0.1` and `::1` only).
2. Writes a per-session config overlay (`collab.autoStart: control`,
   `collab.relayUrl: ws://localhost:<port>`, `collab.displayName`) into the app's data directory
   and spawns `omp --config <overlay> [--resume <file>]` in a node-pty with the project as cwd.
   The user's own `config.yml` is never modified for this.
3. When the omp host connects to the relay (`/r/<roomId>?role=host`), SessionHost resolves the
   room key with `omp collab list --json` + `omp collab link <instanceId> --json`, matching the
   link's port and room id, and hands the control link to the renderer.
4. The renderer's guest client joins the room and exposes a live snapshot (header, entries,
   streaming message, active tools, subagent progress, model/thinking/context state, pending
   `select`/`editor` UI requests) through `useSyncExternalStore`.
5. **All user input is typed into the real TUI** (bracketed paste + Enter), so every omp feature,
   slash command, `!`/`$` prefix and queue behaviour works exactly as in a terminal. The guest
   channel is used for UI-request answers, abort and subagent commands.
6. `/restart`, `/new`, `/resume`, branching and forking start a new collab room (new generation);
   SessionHost re-resolves the link and the renderer reconnects transparently.

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
  renderer/      React app
    collab/      vendored omp collab guest client + wire contracts (MIT, see NOTICE)
    tool-render/ tool call renderers (friendly summary + details)
    components/  UI
    i18n/        locale files
    theme/       design tokens (light default, dark)
```

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
| Usage/limits | `omp usage --json`, `omp stats` API |
| Git | `git`, `gh` |

## Compatibility
The collab wire protocol is versioned (`COLLAB_PROTO`). The app checks `omp --version` against a
supported range and shows a clear upgrade/downgrade notice when outside it.
