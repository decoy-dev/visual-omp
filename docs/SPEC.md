# visual-omp product specification

visual-omp is a desktop app that puts an interface modeled on the Claude Code desktop app on top of
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi). People who have never opened a terminal must
be able to use it, and it exposes the features that set omp apart from other coding agents.

## Audience and platforms
- **Audience:** public release for anyone, including non-technical users.
- **Platforms:** macOS (Apple Silicon + Intel) and Windows.
- **Distribution:** Homebrew cask (`brew install --cask decoy-dev/tap/visual-omp`) on macOS; NSIS
  installer on GitHub Releases for Windows. GitHub Actions builds a release when a `v*` tag is
  pushed and updates the Homebrew cask for stable versions (see docs/RELEASING.md). The cask
  requires Homebrew 6.0.16 or later.
- **Signing:** ad-hoc signed (no Apple Developer ID). macOS can report a quarantined ad-hoc signed
  copy as damaged with no way to approve it, so the Homebrew cask removes the quarantine attribute
  from the installed app bundle after installation, upgrade or reinstallation. This bypasses the
  approval check triggered by quarantine, which the owner accepted on 2026-10-12; Homebrew still
  verifies each download against the checksum in the cask. The README documents the macOS
  *System Settings → Privacy & Security → Open Anyway* step for disk-image installs and the Windows
  SmartScreen *More info → Run anyway* step, which can reappear after an update. Nothing else strips
  quarantine or disables Gatekeeper.
- **License:** MIT. Code derived from oh-my-pi (MIT) is credited in `NOTICE`.
- **Language:** English, translation-ready (all UI strings in locale files).
- **Accessibility:** WCAG 2.2 AA: full keyboard navigation, screen-reader labels, adjustable text
  size, reduced motion, and contrast-safe colors in both themes.

## Engine
- The user installs omp themselves. When omp is missing or too old, the app shows a guided setup
  screen in plain language with the official install command, a **Run installer** button that runs
  it visibly in the built-in terminal (user-initiated), and **Check again**.
- Each chat is backed by a **real omp terminal (TUI) running hidden in a pseudo-terminal**. The app
  types messages and commands into it (e.g. the Restart button sends `/restart`), and mirrors its
  live state (streaming text, thinking, tool calls, subagents, questions) as native UI through
  omp's collab protocol over a relay bound to 127.0.0.1, so the app-to-omp connection never leaves
  the machine.
- Full-screen TUI menus that are not rebuilt natively open in a **terminal sheet** showing the
  live omp terminal.
- Default permission mode for new users: **Ask me first** (omp `always-ask`), changeable from the
  permission button next to Send. A fresh profile (no preferences file at first launch) whose omp
  config has no `tools.approvalMode` gets `always-ask` written to the global config once
  (`src/main/services/approval-default.ts`, `newUserApproval` in `src/main/prefs.ts`, run from
  `src/main/features/config.ts` and before each chat's omp starts). While omp cannot be read to
  check, a fresh profile's chat does not start and shows why, and the next start checks again.
  Existing users, and anyone whose config or environment already sets a mode, keep their setting;
  omp's own default stays Auto (`yolo`).

The app uses a consistent system with an ink sidebar and status bar in both themes, a light default main sheet, a gray page canvas and a floating side panel. Dark mode preserves the surface hierarchy. One teal accent marks actions and selection; stronger borders define controls and cards. Radii and spacing use shared proportional scales. Motion uses `src/renderer/src/ui/motion.tsx` and respects reduced-motion preferences. The Prompt periscope is the app icon (docs/DESIGN.md §0 and §1).

Output: friendly summaries that expand to details. Normal view groups tool calls, shows omp's current todo board, helper and job activity when known, and lists files from omp edit and write results with clearly labelled edit totals. Plan checklist items appear only when the plan file has checkbox steps. Markdown supports framed tables, disc, circle and decimal list markers, task-list checkboxes, tone callouts and code headers with Copy. A transcript view toggle offers Normal, Thinking and Verbose. Paced transcript updates are excluded from live-region announcements; a polite screen-reader announcement follows a completed assistant reply.

omp's displayed harness notices appear in the chat in all three views, presented the way omp's terminal shows them. The normal presentation removes omp's wrapper tags, and Verbose offers the original text in a "Text sent to the model" disclosure. Finished background jobs and helpers become one tool-style row per job that opens to the result; IRC messages become message cards with the body cut to three lines; process exits, advisor notes, skill invocations and other notices each get their own row or card. Verbose initially expands job results, skill text and other-notice details, while IRC message bodies stay collapsed to three lines in every view. The session tree uses the same one-line summaries.

## Feature scope (all in scope)
### Sessions
- Open chats appear in a Current chats sidebar section in open order, alongside their entries in the Projects tree. Current chats carries status and selection; open tree entries have a quiet open marker.
- ⌘1-⌘9 open the numbered Current chats row; ⌘⇧[ and ⌘⇧] cycle open chats. ⌘⇧T reopens the last eligible closed chat and its text draft without starting omp. ⌘⇧A selects the next chat waiting for an answer.
- Each chat can run in its own Git worktree.
- A chat can be rewound or forked from any message.
- When the user moves to another chat, a saved chat that was only viewed is released: it has no host, no sent input, no draft or attachments and no open omp terminal. It stays open when a chat that was already open appears later in Current chats, so no ⌘ number shifts. Browsing from one saved chat to the next releases the one left behind.
- Queued messages can be sent now, edited or removed.
- Notifications report when a chat finishes or needs input.
- All saved omp sessions (including ones started in a terminal) appear in history grouped by
  project and can be resumed; a session still live elsewhere opens read-only.

### Panes
- The Changes pane reviews edits per file, sends line comments to omp, and runs *Review code* via
  `/review`.
- The Files pane shows the project tree and a file viewer, and clicking a file can @-mention it.
- The Preview pane is a built-in browser for dev servers.
- The Tasks pane shows omp's todo list, its helpers (subagents) and background jobs. Each helper's activity line prefers what it is doing now, then what it did last, then omp's task description and finally its assignment with omp's assignment preamble removed. Its conversation dialog starts with the assignment and labels later messages by sender. A task row shows a success check only when every helper finished; helpers that stopped or are waiting get a neutral "Stopped" or "Waiting" mark, and a mixed batch reads running if any helper runs and failed if any failed. Helper and job outcomes come from omp's async-result notices and `job` and `wait` results. Without omp running for the chat (a saved or exited chat), a helper still marked working or waiting shows Stopped and a running job shows stopped; work still running at an omp `session_exit` entry also shows stopped in a resumed chat. A read-only chat counts as running while another window owns it or its ownership is unknown; once it is found free to continue, its unfinished work shows stopped. The header work chip, the Tasks pane, task rows and helper cards agree. Background jobs list running jobs first and then the five most recent finished ones, with the rest behind "Show earlier jobs". Each job is titled by the intent the model gave its command (or by its first real step when there is none), with that step under it. A running job shows the time since it started; a settled job shows omp's reported run time and, for a failure, the exit code, when omp reports them. A job opens to the full command, its latest output and its id. Durations on job rows and helper cards use one style: "847ms", "4.2s", "42s", "4m 05s", "1h 13m".
- The Plan pane shows the current plan and lets you approve or refine it.
- Outputs groups images, PDFs and files by whether omp created, wrote, changed or viewed them.

### Git
- The status bar shows Git state, and commits can use an AI-written message (`omp commit`).
- Pull requests and draft pull requests can be created through the GitHub CLI.
- Pull request and CI status appear in the status bar, with *Fix CI* for failing checks.

### Composer
- The composer card contains ＋, text, microphone and send or stop actions. Permission, model, thinking and context controls appear in a quieter row beneath it.
- While omp works, the primary action queues the message; Send now remains available with ⌘↵.
- Read-only chats explain the reason in the session header and the available action in the placeholder. Composer controls are muted and disabled without repeating a lock banner.
- At narrow widths, composer actions wrap to a second line so the text box keeps a usable width.

### omp modes
- Plan mode is available, with Plan Review for approving plans.
- Goal mode and guided goals are available.
- Vibe mode is available.
- Loop mode is available.
- The advisor can be turned on to review each turn.

### omp management (native screens, as Settings sections)
- Models & roles edits the model for each role (default/smol/slow/plan/commit/advisor/…) and its
  presets.
- Helpers manages bundled and custom agents, with a per-agent model, enable/disable and create
  with AI.
- Connected tools manages MCP servers for all projects and per project.
- Skills & plugins browses, installs and manages skills and plugins.
- Memory shows what omp remembers and lets you delete it.

### omp extras
- Usage & limits shows provider limits by account and window, with status and expandable account detail. Unknown values and warnings remain visible. Recorded usage comes from local session and subagent files; its 7- or 30-day period does not filter provider limits. The page has a segmented KPI strip, daily cost chart with average line, cost share bars by project and a chat table with project and model filters, pagination and CSV export. Estimated API cost is labelled.
- Security scan and cleanse can be run for a project.
- Chats can be imported from Claude Code and Codex.
- The session tree navigator shows every branch of a chat.

### Commands
- The Cmd/Ctrl+K command palette makes every omp command searchable in plain language, and the
  title bar's *Search commands* field also opens it.
- The session header shows the chat's state, *Review changes*, the side panel toggle and a ⋯ menu
  of chat commands (Rename, Share, Fork, Compact, Plan, Goal, Restart, Helpers and the rest).
- `/` in the composer also works.

### Projects
Current chats, navigation shortcuts and preview release are described under Sessions.
- Project search, pinning, folder colors, renaming, archiving and project actions are available. A project's folder color is set from its sidebar menu or, for a new empty folder, in the new project wizard.
- The new project wizard creates an empty folder, opens an existing folder or clones from a GitHub URL.
- The Instructions page edits the project's AGENTS.md and rules.
- The Project settings page sets the project's model and permission mode and links to its connected tools, helpers and instructions.
- The project overview shows recent chats, an instructions and settings summary, Git status and quick-start prompts.
- Home is where the app opens and what the title bar's Home button (⇧⌘H) shows: a prompt box that starts a chat in any project with the new chat's choices (project folder, permission level, model, thinking level, attached files), the latest chats across every project, the projects with their folder colors, and plan limits with the last 7 days' estimated API cost. A quiet animated dot field renders behind it and holds still under reduced motion.
- When the sidebar is visible, a page places Back under the sidebar header, and the header and Back share a teal card while the page is open. Settings places its section navigation under the card, in place of the chat lists; other pages keep the lists visible beneath the card. With the sidebar hidden, Back and navigation render inline and page focus moves to the title after lazy content mounts.

### Packaging and loading
- Main-process pure-JavaScript packages are bundled from devDependencies. Only native runtime packages such as node-pty remain runtime dependencies. Source maps and unused Electron locales are excluded.
- The renderer's initial JavaScript entry chunk, an uncompressed build-output size, decreased from approximately 4.87 MB to 1.56 MB. Xterm is about 331 KB and KaTeX about 262 KB in separate chunks. Settings sections and feature views are code-split.

### Settings
- Settings is a full page with curated common sections and a searchable **Advanced** section that
  lists every omp setting.

### Help
- A first-run guided tour introduces the app.
- Every button has a plain-language tooltip.
- Empty chats offer example prompts.
- The built-in Help page has guides and a glossary.
- An in-app notice announces updates.

### Lifecycle

Quitting or closing a chat while omp is working warns first, then stops cleanly. Sessions resume where they left off. On restart, the app opens on Home with the open chats back in the sidebar; the project last shown stays the active one, and pages are not restored.
