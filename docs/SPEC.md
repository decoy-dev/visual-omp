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

## Visual design
- One teal accent over near-neutral surfaces, **light mode by default**, dark mode available, and
  none of the gradient, glass or eyebrow patterns of generated UI (docs/DESIGN.md §0).
- App icon: the "Prompt" periscope (a `>` prompt with a periscope rising from its underscore, ink with
  a teal lens), chosen from the concepts in docs/logo-concepts/.
- Output: **friendly summaries, expandable.** Tool steps collapse into plain-language rows
  ("Edited 3 files", "Ran tests") with raw output and diffs one click away, and a transcript view
  toggle switches between Normal, Thinking and Verbose.

## Feature scope (all in scope)
### Sessions
- Open chats appear in the sidebar, and split view shows two chats side by side.
- Git worktree per session toggle
- Rewind / fork from any message
- Message queue editing (Send now, Edit, Remove)
- Notifications when a chat finishes or needs input
- All saved omp sessions (including ones started in a terminal) appear in history grouped by
  project and can be resumed; a session still live elsewhere opens read-only.

### Panes
- The Changes pane reviews edits per file, sends line comments to omp, and runs *Review code* via
  `/review`.
- Files (tree + viewer, click to @-mention)
- Web preview (built-in browser for dev servers)
- Tasks & subagents (todos, subagents, background jobs)
- Plan (current plan with Approve / Refine)
- Outputs groups images, PDFs and files by whether omp created, wrote, changed or viewed them.

### Git
- Status bar + commit with AI message (`omp commit`)
- Create pull request / draft PR (GitHub CLI)
- PR & CI status with *Fix CI*

### Composer
- @-mention files (fuzzy picker)
- Drag-drop / paste images and files
- Voice dictation (omp speech-to-text)
- Shell (`!`) and Python (`$`) quick modes
- Prompt library (saved prompts, custom commands, skills)

### omp modes
- Plan mode + Plan Review
- Goal mode / guided goal
- Vibe mode
- Loop mode
- Advisor

### omp management (native screens, as Settings sections)
- Models & roles edits the model for each role (default/smol/slow/plan/commit/advisor/…) and its
  presets.
- Helpers manages bundled and custom agents, with a per-agent model, enable/disable and create
  with AI.
- Connected tools manages MCP servers for all projects and per project.
- Skills & plugins browses, installs and manages skills and plugins.
- Memory shows what omp remembers and lets you delete it.

### omp extras
- The Usage & limits page shows plan limits, recorded usage and estimated API cost.
- Share & collaborate (share links, HTML export, live collab invites)
- Security scan / cleanse
- Import from Claude Code / Codex
- Session tree navigator

### Commands
- The Cmd/Ctrl+K command palette makes every omp command searchable in plain language, and the
  title bar's *Search commands* field also opens it.
- The session header shows the chat's state, *Review changes*, the side panel toggle and a ⋯ menu
  of chat commands (Rename, Share, Fork, Compact, Plan, Goal, Restart, Helpers and the rest).
- `/` in the composer also works.

### Projects
- The project sidebar lists sessions with search, the Active filter, pin, rename and archive.
- New project wizard (empty folder, open existing, clone from GitHub URL)
- The Instructions page edits the project's AGENTS.md and rules.
- The Project settings page sets the project's model and permission mode and links to its
  connected tools, helpers and instructions.
- The project overview shows recent chats, an instructions and settings summary, git status and
  quick-start prompts.

### Settings
- Settings is a full page with curated common sections and a searchable **Advanced** section that
  lists every omp setting.

### Help
- First-run guided tour
- Plain-language tooltips on every button
- Example prompts on empty chats
- The built-in Help page has guides and a glossary.
- In-app update notice

### Lifecycle
- Quitting or closing a chat while omp is working warns first, then stops cleanly; sessions resume
  where they left off.
