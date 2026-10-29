# visual-omp product specification

visual-omp is a desktop app that puts an interface modeled on the Claude Code desktop app on top of
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi). People who have never opened a terminal must
be able to use it, and it exposes the features that set omp apart from other coding agents.

## Audience and platforms
- **Audience:** public release for anyone, including non-technical users.
- **Platforms:** macOS (Apple Silicon + Intel) and Windows.
- **Distribution:** Homebrew cask (`brew install --cask decoy-dev/tap/visual-omp`) on macOS; Scoop
  bucket (`scoop install decoy-dev/visual-omp`, which unpacks the app from the NSIS installer
  without running it) and the NSIS installer on GitHub Releases for Windows. GitHub Actions builds
  a release when a `v*` tag is pushed and updates the Homebrew cask and the Scoop manifest for
  stable versions (see docs/RELEASING.md). The cask requires Homebrew 6.0.16 or later. Installer
  copies on Windows suggest switching to Scoop in their update window, because Scoop updates run
  without the setup wizard.
- **Signing:** macOS releases are signed with the project's own self-signed certificate (no Apple
  Developer ID), so every release keeps one designated requirement; this is meant to keep
  permissions such as App Management across updates (see docs/RELEASING.md). Local builds are
  ad-hoc signed. macOS can report a quarantined copy that Apple has not notarized as damaged with no
  way to approve it, so the Homebrew cask removes the quarantine attribute
  from the installed app bundle after installation, upgrade or reinstallation. This bypasses the
  approval check triggered by quarantine, which the owner accepted on 2026-10-12; Homebrew still
  verifies each download against the checksum in the cask. The README documents the macOS
  *System Settings → Privacy & Security → Open Anyway* step for disk-image installs and the Windows
  SmartScreen *More info → Run anyway* step for the installer, which can reappear after an update.
  Nothing else strips quarantine or disables Gatekeeper.
- **License:** MIT. Code derived from oh-my-pi (MIT) is credited in `NOTICE`.
- **Language:** English, translation-ready (all UI strings in locale files).
- **Accessibility:** WCAG 2.2 AA: full keyboard navigation, screen-reader labels, adjustable text
  size, reduced motion, and contrast-safe colors in both themes.

## Engine
- visual-omp requires omp 18.14.0 or later. Native first-run setup includes welcome, a conditional
  install or update step, provider sign-in, a default chat model, permissions, app appearance and a
  done summary, followed by the existing guided tour. Provider sign-in runs `omp login` in an inline
  terminal; **Skip** changes to **Continue** once a provider is connected. The model selection saves
  omp's global default chat model. Appearance changes preview immediately in the app.
- Fresh app preferences set `setupCompleted: false`; an existing file without the flag is treated
  as completed. Existing users whose omp is missing, unsupported or refused see only the install
  step. Finishing, **Exit setup** or Esc marks setup completed. Help and the command palette offer
  **Run setup again** for the full wizard. The app never writes omp's `setupVersion`, so terminal
  omp still offers its glyph, composer and theme setup.
- The install step reuses the existing installer IPC. Missing omp offers the official install
  command, **Run installer** in an inline terminal and **Check for omp**. An older omp is refused,
  with **Update omp** running omp's own updater in the existing update dialog. Output and errors
  remain visible, and the detected version is refreshed on completion. Managed installations
  direct the user to the application that updates omp. A Windows launch refusal shows the reported
  reason and offers another check after the user allows omp.
- Each chat is backed by a **real omp terminal (TUI) running hidden in a pseudo-terminal**. The app
  types messages and commands into it (e.g. the Restart button sends `/restart`), and mirrors its
  live state (streaming text, thinking, tool calls, subagents, questions) as native UI through
  omp's collab protocol over a relay bound to 127.0.0.1, so the app-to-omp connection never leaves
  the machine.
- Full-screen TUI menus that are not rebuilt natively open in a **terminal sheet** showing the
  live omp terminal.
- Setup preselects **Ask me first** (omp `always-ask`) and saves the chosen permission mode
  globally. The permission button next to Send can change it later. `ensureNewUserApproval`
  remains a fallback for a fresh profile whose omp config has no `tools.approvalMode`: it writes
  `always-ask` once (`src/main/services/approval-default.ts`, `newUserApproval` in
  `src/main/prefs.ts`, run from `src/main/features/config.ts` and before each chat's omp starts).
  While omp cannot be read to check, a fresh profile's chat does not start and shows why, and the
  next start checks again. The fallback preserves an existing config or environment mode and
  existing users' settings; omp's own default stays Auto (`yolo`).

The app uses a consistent system with an ink sidebar and status bar in both themes, a light default main sheet, a gray page canvas and a floating side panel. Dark mode preserves the surface hierarchy. One teal accent marks actions and selection; stronger borders define controls and cards. Radii and spacing use shared proportional scales. Motion uses `src/renderer/src/ui/motion.tsx` and respects reduced-motion preferences. The Prompt periscope is the app icon (docs/DESIGN.md §0 and §1).

Output: friendly summaries that expand to details. Normal view groups tool calls, shows omp's current todo board, helper and job activity when known, and lists files from omp edit and write results with clearly labelled edit totals. Plan checklist items appear only when the plan file has checkbox steps. Markdown supports framed tables, disc, circle and decimal list markers, task-list checkboxes, tone callouts and code headers with Copy. A transcript view toggle offers Normal, Thinking and Verbose. Paced transcript updates are excluded from live-region announcements; a polite screen-reader announcement follows a completed assistant reply.

omp's displayed harness notices appear in the chat in all three views, presented the way omp's terminal shows them. The normal presentation removes omp's wrapper tags, and Verbose offers the original text in a "Text sent to the model" disclosure. Finished background jobs and helpers become one tool-style row per job that opens to the result; IRC messages become message cards with the body cut to three lines; process exits, advisor notes, skill invocations and other notices each get their own row or card. Verbose initially expands job results, skill text and other-notice details, while IRC message bodies stay collapsed to three lines in every view. The session tree uses the same one-line summaries.

When omp explicitly records a model fallback, all transcript views show a warning at the switch. The warning names the source when recorded and the destination, and quotes a related error only when omp's saved retry attribution identifies that model recovery. Missing reasons remain unspecified, so a provider error or preflight switch is never described as usage exhaustion without evidence. Provider-reported fallback content within a reply also shows a warning. Account rotation and manual changes keep their existing presentation. Recovery during a turn does not create an unopened result or background alert; the normal completion and question rules still apply.

The existing screen-reader announcement channel announces a newly recorded fallback once. Loaded history, reconnect snapshots and the saved copy of a streamed provider fallback remain silent, and the transcript itself stays outside live-region announcements.

## Feature scope (all in scope)
### Sessions
- Open chats appear in a Current chats sidebar section, with unopened results first and a divider before viewed chats. Each group keeps open order, and numbered shortcuts keep their original chat numbers. A blue dot, stronger title and accessible "New result" or "Waiting for your answer" label mark unopened results. The same mark appears on open chats in the Projects tree, Home's recent chats and project overviews.
- A chat's status is, in order: waiting for an answer, an error reported by omp, working (omp's own turn), helpers working (omp's turn has ended and a helper it started still runs, on a running omp), open, or saved. Both working states show the spinning mark everywhere chat status appears: Current chats, the chat header, Home's recent chats and project overviews. Background shell jobs do not keep a chat in a working state, since a dev server started as a job can run until it is stopped. omp's OSC 7501 messages provide waiting and error text when collab has no matching question.
- ⌘1-⌘9 open the numbered Current chats row; ⌘⇧[ and ⌘⇧] cycle open chats. ⌘⇧T reopens the last eligible closed chat and its text draft without starting omp. ⌘⇧A selects the next chat waiting for an answer.
- The sidebar's New chat button always starts in the temporary folder: `/tmp` on macOS and Linux, and the system temp folder on Windows. It has no keyboard shortcut hint because ⌘N/Ctrl+N keeps the focused chat's or visible project overview's folder. From Home, pages or an empty view, that command uses the temporary folder. File > New Chat and the command palette follow the same rule; `/new` keeps its originating chat's folder. New chat here, the project overview's composer and open side by side keep their project.
- Each chat can run in its own Git worktree. The current chat follows omp's folder and session moves. omp's worktree startup and exit questions use native dialogs, and closing the chat waits for its worktree decision.
- A chat can be rewound or forked from any message.
- After a nonzero exit without omp's current `session_exit` marker, **Continue where omp stopped** explicitly restores interrupted work through `omp --restore`. Ordinary restarts continue to use `--resume`.
- The transcript displays omp's recognized startup model-substitution warnings and journaled idle recaps without sending those notices back to the model.
- When the user moves to another chat, a saved chat that was only viewed is released: it has no unopened result, no host, no sent input, no draft or attachments and no open omp terminal. A viewed chat whose side panel is open, or was resized, is not released, so the panel is there when the user comes back. A chat also stays open when a chat that was already open appears later in Current chats, so no ⌘ number shifts. Browsing from one saved chat to the next releases the one left behind.
- Queued messages can be sent now, edited or removed.
- A chat has an unopened result when its main turn finishes or it starts waiting for an answer while the window is unfocused or minimized, or while another chat, Home, a page, a project overview or an expanded side panel covers it. Showing the chat in either split half with window focus clears only that chat. Closing it removes its unopened result. The count and reasons persist with restorable open tabs and are validated on load, so a restart on Home keeps results available to review.
- The macOS Dock badge and Windows taskbar overlay show the unopened-chat count, including while the window is focused on another chat and while background alerts are off. On macOS, Settings › Sounds & alerts advises turning on Allow notifications and Badge application icon in System Settings › Notifications › visual-omp if the Dock count is missing. The background-alert switch controls native notifications and the one-time Dock bounce or taskbar flash. These alerts occur only in the background. Notifications follow omp's main turn, so a reply that ends while helpers still run is reported when it ends.
- All saved omp sessions (including ones started in a terminal) appear in history grouped by
  project and can be resumed; a session still live elsewhere opens read-only.

### Panes
- Each chat has its own side panel: whether it is open, which pane it shows and how wide it is belong to that chat, so a chat that never opened its panel shows it closed at the default width, and opening, closing or resizing it in one chat never changes another. Links and buttons in a chat open that chat's panel. Each restored chat comes back with its panel after a restart. Home and project overviews share one panel.
- The Changes pane reviews edits per file, sends line comments to omp, and runs *Review code* via
  `/review`.
- The Files pane shows the project tree and a file viewer, and clicking a file can @-mention it.
- The Preview pane is a built-in browser for dev servers.
- The Tasks pane shows omp's todo list, its helpers (subagents) and background jobs. Each helper's activity line prefers what it is doing now, then what it did last, then omp's task description and finally its assignment with omp's assignment preamble removed. Its conversation dialog starts with the assignment and labels later messages by sender. A helper that finished its turn shows Done, even while omp keeps it for a follow-up message, and the Tasks pane still offers to message it; a message runs it again and shows it as working. The pane lists every running helper, then the three latest finished ones and any older failed one, with the rest behind "Show earlier helpers". A task row shows a success check only when every helper finished; helpers that stopped get a neutral "Stopped" mark, and a mixed batch reads running if any helper runs and failed if any failed. Helper and job outcomes come from omp's async-result notices and `job` and `wait` results. Without omp running for the chat (a saved or exited chat), a helper still marked working shows Stopped, a finished helper stays Done and can no longer be messaged, and a running job shows stopped; work still running at an omp `session_exit` entry also shows stopped in a resumed chat. A read-only chat counts as running while another window owns it or its ownership is unknown; once it is found free to continue, its unfinished work shows stopped. The header work chip, the Tasks pane, task rows and helper cards agree. Background jobs list running jobs first and then the five most recent finished ones, with the rest behind "Show earlier jobs". Each job is titled by the intent the model gave its command (or by its first real step when there is none), with that step under it. A running job shows the time since it started; a settled job shows omp's reported run time and, for a failure, the exit code, when omp reports them. A job opens to the full command, its latest output and its id. Durations on job rows and helper cards use one style: "847ms", "4.2s", "42s", "4m 05s", "1h 13m".
- The Plan pane shows the current plan and lets you approve or refine it.
- Outputs groups images, PDFs and files by whether omp created, wrote, changed or viewed them.

### Git
- The status bar shows Git state, and commits can use an AI-written message (`omp commit`).
- Pull requests and draft pull requests can be created through the GitHub CLI.
- Pull request and CI status appear in the status bar, with *Fix CI* for failing checks.

### Composer
- The composer card contains ＋, text, microphone and send or stop actions. Permission, model, thinking and context controls appear in a quieter row beneath it.
- The model button marks a recorded fallback with a warning icon and “Fallback”, and its tooltip names the original model when known. It follows the live selected model or, for saved chats, the latest recorded choice. Provider fallback content identifies the model serving that reply. A manual choice or return to the primary removes the retry fallback marker.
- The picker uses omp's selected identity independently of its serving-model label, so a provider fallback can still be explicitly selected. An unknown original stays unknown through subsequent fallbacks until a non-fallback choice resets the chain.
- While omp works, the primary action queues the message; Send now remains available with ⌘↵.
- Approval cards keep the one-time approval as the default, including when omp lists remembered file or folder grants first. Broader grants and session approval appear as secondary actions. The card explains that sending a message now denies the pending request. Ask and remember is available alongside the other permission modes; Settings > Permissions can forget persisted approvals across projects through omp's own command.
- Read-only chats explain the reason in the session header and the available action in the placeholder. Composer controls are muted and disabled without repeating a lock banner.
- At narrow widths, composer actions wrap to a second line so the text box keeps a usable width.
- Up and Down recall this chat's submitted text when the caret is on the first or last visual line respectively, including wrapped text. Down past the newest entry, or Esc while browsing, restores the original draft and caret with attachments unchanged. Editing a recalled message makes it the new draft. Completion menus keep their arrow keys, and IME input and modified arrows keep native editing behavior.
- History combines transcript user text, successfully delivered lines from this window and omp's read-only, session-filtered prompt database, with consecutive duplicates removed. Unsent queue rows remain in the tray. Shell and Python modes recall only their own commands. Split composers browse independently; Home has no chat history. Transcript and omp database records survive restarts, while window-only records end when the chat closes or changes session.
- Browsing shows transient previews and leaves the persisted draft unchanged. Reloading while browsing restores that unfinished draft. Editing a preview commits it as the draft; Send submits the preview and clears the draft normally. The app writes no other persistent prompt log.

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
- Connected tools manages MCP servers for all projects and per project. Project servers require an explicit per-server action and native confirmation before connection or sign-in. Background checks use fresh user-source definitions in a neutral folder. OAuth sign-in preserves the selected project and scope while suppressing ambient MCP and extension initialization.
- Skills & plugins browses, installs and manages skills and plugins. Installed npm and git plugins can update through omp's upgrade command.
- Memory shows what omp remembers and lets you delete it.
- Providers checks status outside projects with extensions disabled. Sign-in export and import are global-only operations through omp, with warnings about unencrypted credentials and refresh-token rotation. Export uses restricted file permissions where supported, and credential contents never cross renderer IPC.

### omp extras
- Usage & limits shows provider limits by account and window, preserving omp's window order. Expanded accounts include omp's optional routing priority, reserve and account-wide state. Unknown values and warnings remain visible. Saved resets list through `omp usage reset --json`; after confirmation, `omp usage reset <provider>/<id>` spends one and its exit code determines success, then limits refresh. The activity grid shows model requests per day over the last year, and Home shows recent months. Recorded usage comes from local session and subagent files; its 7- or 30-day period does not filter limits or the activity grid. The page includes an estimated API cost chart and searchable chat table with filters, pagination and CSV export. Its browser Stats action follows the dashboard URL printed by omp, which chooses the port.
- Security scan and cleanse can be run for a project.
- Chats can be imported from Claude Code and Codex.
- The session tree navigator shows every branch of a chat.

### Text interactions
- Right-clicking an editable field opens the operating system's editing menu, including spelling suggestions and Add to dictionary for a misspelled word. Undo, Redo, Cut, Copy, Paste and Select all reflect the field's available actions; Windows also offers Delete, and rich-text fields offer Paste and match style.
- Right-clicking selected read-only text offers Copy. macOS also offers Look up. Nothing selected outside an editable field opens no native menu.
- The normal composer checks spelling. Shell and Python modes, paths, commands and repository URLs do not. Renderer menus for specific targets consume their own right-click events without blocking the native menu on ordinary text.
- Links, file and folder references, tool paths, image thumbnails and previews, turn-summary files and Changes rows have context menus. Files tree entries, folder contents and viewer tabs share their file actions. Helper conversations and Plan Markdown share link and image actions.
- Link menus offer Open in browser and Copy link; localhost and loopback links also open in the originating chat's Preview pane. Each chat keeps its own Preview URL and history, including chats in the same project. File menus open the file or folder, reveal it, copy its absolute path and mention it in chat. Copy relative path is available only inside the chat's project. Known filesystem names retain their punctuation. File rows with changes can open their diff.
- Image menus copy the displayed image or save it as PNG through a native dialog. Known file paths add default-app, reveal and copy-path actions. Other file types require confirmation before opening with the default app, because opening them outside visual-omp may run code.
- The context-menu key and Shift+F10 open the focused target's menu. Right-clicking within selected text keeps the native selection menu, including selections inside or across a link. Selections elsewhere leave target menus available. Left-click behavior is unchanged.

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
- The Instructions page edits the project's AGENTS.md, configured additional instruction files and rules. Additional filenames can be added to this project's `contextFiles.extra` list without removing inherited names.
- The Project settings page sets the project's model and permission mode and links to its connected tools, helpers and instructions.
- The project overview shows recent chats, an instructions and settings summary, Git status and quick-start prompts.
- Home is where the app opens and what the title bar's Home button (⇧⌘H) shows: a prompt box that starts a chat in any project with the new chat's choices (project folder, permission level, model, thinking level, attached files), the latest chats across every project, the projects with their folder colors, and plan limits with the last 7 days' estimated API cost. A quiet animated dot field renders behind it and holds still under reduced motion.
- Home's composer starts with the temporary folder selected, including on first run before any project or chat exists. Choosing a project or opening a folder changes only the Home draft's folder, leaving the active project elsewhere in the app unchanged. The chosen folder is saved with unfinished text and attachments, so leaving Home, returning or restarting the app preserves their destination. Starting the chat successfully resets the draft to the temporary folder; a cancelled send keeps the whole draft. Returning to Home with no text or attachments also resets its folder. The picker names it the same way as the projects list, and its model, thinking and permission defaults use the same project settings as other folders.
- When the sidebar is visible, a page places Back under the sidebar header, and the header and Back share a teal card while the page is open. Settings places its section navigation under the card, in place of the chat lists; other pages keep the lists visible beneath the card. With the sidebar hidden, Back and navigation render inline and page focus moves to the title after lazy content mounts.

### Packaging and loading
- Main-process pure-JavaScript packages are bundled from devDependencies. Only native runtime packages such as node-pty remain runtime dependencies. Source maps and unused Electron locales are excluded.
- The renderer's initial JavaScript entry chunk, an uncompressed build-output size, decreased from approximately 4.87 MB to 1.56 MB. Xterm is about 331 KB and KaTeX about 262 KB in separate chunks. Settings sections and feature views are code-split.

### Settings
- Settings is a full page with curated common sections and a searchable **Advanced** section that
  lists every omp setting.

### Help
- The first-run guided tour introduces the app after setup completes and a supported omp is
  available. It never starts over the setup wizard.
- Every button has a plain-language tooltip.
- Empty chats offer example prompts.
- The built-in Help page has guides, a glossary, **Take the tour** and **Run setup again**.
  The command palette also offers **Run setup again**.
- An in-app notice announces updates.

### Lifecycle

Quitting or closing a chat while omp is working, either replying or with helpers at work, warns first with the work recorded when the user chose to quit or close, then stops cleanly; the saved chats can be reopened afterwards. A quit also asks about any chat whose state could not be checked within 5 seconds, so unknown work is never stopped without asking. On macOS, a quit after the window was closed while omp still runs opens the window again to ask. On restart, the app opens on Home with the open chats back in the sidebar; the project last shown stays the active one, and pages are not restored.
