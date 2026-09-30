# visual-omp — Product Specification

visual-omp is a desktop app that puts a friendly, Claude Code–desktop–style interface on top of
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi). It must be usable by people who have never
opened a terminal, while exposing everything that makes omp unique.

## Audience and platforms
- **Audience:** public release for anyone, including non-technical users.
- **Platforms:** macOS (Apple Silicon + Intel) and Windows.
- **Distribution:** Homebrew cask (`brew install --cask decoy-dev/tap/visual-omp`) on macOS; NSIS
  installer on GitHub Releases for Windows. Releases are built by GitHub Actions on tag push, which
  also updates the Homebrew tap.
- **Signing:** ad-hoc signed (no Apple Developer ID). The cask caveats and README document the
  one-time *System Settings → Privacy & Security → Open Anyway* step; Windows documents the
  SmartScreen *More info → Run anyway* step. Nothing strips quarantine or disables Gatekeeper.
- **License:** MIT. Code derived from oh-my-pi (MIT) is credited in `NOTICE`.
- **Language:** English, translation-ready (all UI strings in locale files).
- **Accessibility:** WCAG 2.2 AA — full keyboard navigation, screen-reader labels, adjustable text
  size, reduced motion, contrast-safe colors in both themes.

## Engine
- The user installs omp themselves. When omp is missing or too old, the app shows a guided setup
  screen in plain language with the official install command, a **Run installer** button that runs
  it visibly in the built-in terminal (user-initiated), and **Check again**.
- Each chat is backed by a **real omp terminal (TUI) running hidden in a pseudo-terminal**. The app
  types messages and commands into it (e.g. the Restart button sends `/restart`), and mirrors its
  live state — streaming text, thinking, tool calls, subagents, questions — as native UI through
  omp's collab protocol over a relay bound to 127.0.0.1. Nothing leaves the machine.
- Full-screen TUI menus that are not rebuilt natively open in a **terminal sheet** showing the
  live omp terminal.
- Default permission mode for new users: **auto-approve everything** (omp `yolo`), changeable next
  to Send.

## Visual design
- omp's own identity (π mark, omp accent colors), **light mode by default**, dark mode available.
- New app icon derived from omp's π mark.
- Output: **friendly summaries, expandable** — tool steps collapse into plain-language cards
  ("Edited 3 files", "Ran tests ✓") with raw output/diffs one click away; transcript view toggle
  Normal / Thinking / Verbose.

## Feature scope (all in scope)
### Sessions
- Parallel sessions (tabs + split view)
- Git worktree per session toggle
- Rewind / fork from any message
- Message queue editing (Send now, Edit, Remove)
- Notifications when a chat finishes or needs input
- All saved omp sessions (including ones started in a terminal) appear in history grouped by
  project and can be resumed; a session still live elsewhere opens read-only.

### Panes
- Diff review (per-file, line comments sent to omp, *Review code* via `/review`)
- Files (tree + viewer, click to @-mention)
- Web preview (built-in browser for dev servers)
- Tasks & subagents (todos, subagents, background jobs)
- Plan (current plan with Approve / Refine)

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

### omp management (native screens)
- Model roles editor (default/smol/slow/plan/commit/advisor/… + presets)
- Agents hub (bundled + custom agents, per-agent model, enable/disable, create with AI)
- MCP servers manager (global + per project)
- Skills & plugins browser
- Memory viewer

### omp extras
- Usage, cost & limits dashboard
- Share & collaborate (share links, HTML export, live collab invites)
- Security scan / cleanse
- Import from Claude Code / Codex
- Session tree navigator

### Commands
- Cmd/Ctrl+K command palette with every omp command searchable in plain language
- Header bar with the most-used buttons (Restart, Compact, Plan, Model, Agents, New)
- `/` in the composer also works

### Projects
- Project sidebar with sessions (search, pin, rename, archive)
- New project wizard (empty folder, open existing, clone from GitHub URL)
- Project instructions editor (AGENTS.md / rules)
- Per-project settings (model, permissions, MCP, agents, skills)
- Project home dashboard (recent chats, git status, weekly cost, quick-start prompts)

### Settings
- Curated common settings + searchable **Advanced** tab listing every omp setting.

### Help
- First-run guided tour
- Plain-language tooltips on every button
- Example prompts on empty chats
- Built-in help / glossary
- In-app update notice

### Lifecycle
- Quitting or closing a tab while omp is working warns first, then stops cleanly; sessions resume
  where they left off.
