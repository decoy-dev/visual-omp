# visual-omp product specification

visual-omp is a desktop app that puts an interface modeled on the Claude Code desktop app on top of
[omp (oh-my-pi)](https://github.com/can1357/oh-my-pi). People who have never opened a terminal must
be able to use it, and it exposes the features that set omp apart from other coding agents.

## Audience and platforms
- **Audience:** public release for anyone, including non-technical users.
- **Platforms:** macOS (Apple Silicon + Intel) and Windows (x64 + ARM64).
- **Distribution:** Homebrew cask (`brew install --cask decoy-dev/tap/visual-omp`) on macOS; Scoop
  bucket (`scoop install decoy-dev/visual-omp`, which unpacks the app from the NSIS installer
  without running it) and separate x64 and ARM64 NSIS installers on GitHub Releases for Windows. Scoop selects the architecture for a fresh install and retains it for updates. Direct updates and reinstalls choose native ARM64 when Electron reports x64 translation on Windows or macOS, and match `process.arch` otherwise. Emulated Scoop copies receive manual native-reinstall instructions in About only when the latest published release has a trusted ARM64 installer; those instructions refresh Scoop and install with `--arch arm64`. Normal updates and Switch to Scoop remain architecture-neutral. GitHub Actions builds
  a release when a `v*` tag is pushed and updates the Homebrew cask and the Scoop manifest for
  stable versions (see docs/RELEASING.md). The cask requires Homebrew 6.0.16 or later. Direct
  macOS copies offer a safe Homebrew transfer or a Homebrew installation guide from Settings > About.
  Windows installer copies offer a verified Scoop transfer, or the installation guide when Scoop is missing.
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
- visual-omp requires omp 18.15.0 or later. Native first-run setup includes welcome, a conditional
  install or update step, provider sign-in, a default chat model, permissions, app appearance and a
  done summary, followed by the existing guided tour. Provider sign-in runs `omp login` in an inline
  terminal; **Skip** changes to **Continue** once a provider is connected. The model selection saves
  omp's global default chat model. Welcome and Done use ink covers with the animated periscope mark.
  Content steps pair a 440px control column and six progress ticks with a persistent, non-interactive
  miniature app shell that reflects the detected omp version, connected providers, model and permission.
  Below 900px, only the control column is shown. Appearance previews the miniature immediately and the
  controls follow 240ms later. Start chatting expands the miniature into the app before the tour;
  reduced motion uses a 140ms crossfade.
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
- Each app-hosted chat runs omp in a pseudo-terminal. On macOS, Linux and Windows, the app uses
  **Tern Surface Protocol (TSP)** documents by default for omp's menus, editor state and native controls.
  Input uses omp's semantic actions and guarded paste or key paths. The live transcript,
  thinking, tools, subagents and questions use omp's collab protocol over a loopback relay,
  so the app-to-omp connection never leaves the machine.
- Full-screen menus and other omp content without a native app presentation open in the
  **omp screen**, a semantic sheet. Classic chats retain the painted terminal sheet.
  Settings > Advanced offers **Classic omp terminal**, off by default, to make new chats use
  omp's terminal screen if a chat does not work with the omp screen. Main reads the app preference
  `classicPresentation` when each host launches; open chats keep their view until omp restarts in them.
  Developer overrides `VOMP_TSP=1` and `VOMP_TSP=0` force TSP and classic respectively on every
  platform. Windows TSP hosts use node-pty's bundled ConPTY; classic hosts use the system ConPTY.
  Classic code remains while the setting exists; any later removal is the owner's decision.
- Setup keeps a permission mode the user already chose and suggests **Ask me first** (omp
  `always-ask`) only while omp is on its default. It saves a changed mode globally and blocks
  Continue when omp reports a mode it does not recognize. The permission button next to Send can change it later. `ensureNewUserApproval`
  remains a fallback for a fresh profile whose omp config has no `tools.approvalMode`: it writes
  `always-ask` once (`src/main/services/approval-default.ts`, `newUserApproval` in
  `src/main/prefs.ts`, run from `src/main/features/config.ts` and before each chat's omp starts).
  While omp cannot be read to check, a fresh profile's chat does not start and shows why, and the
  next start checks again. The fallback preserves an existing config or environment mode and
  existing users' settings; omp's own default stays Auto (`yolo`).

The app uses a consistent system with an ink sidebar and status bar in both themes, a light default main sheet, a gray page canvas and a floating side panel. Dark mode preserves the surface hierarchy. One teal accent marks actions and selection; stronger borders define controls and cards. Radii and spacing use shared proportional scales. Motion uses `src/renderer/src/ui/motion.tsx` and respects reduced-motion preferences. The Prompt periscope is the app icon (docs/DESIGN.md §0 and §1).

Output: friendly summaries that expand to details. Normal view groups tool calls, shows omp's current todo board, helper and job activity when known, and lists files from omp edit and write results with clearly labelled edit totals. Plan checklist items appear only when the plan file has checkbox steps. Markdown supports framed tables, disc, circle and decimal list markers, task-list checkboxes, tone callouts and code headers with Copy. A transcript view toggle offers Normal, Thinking and Verbose. Paced transcript updates are excluded from live-region announcements; a polite screen-reader announcement follows a completed assistant reply.

Rendered chat Markdown, user messages, thinking text and question cards show decorative color swatches beside six- and eight-digit hex codes. Markdown inline code and backtick-delimited plain text also support three- and four-digit hex codes; prose short forms stay plain so short issue and PR references are unambiguous. Six- and eight-digit issue references or hash-prefixed commit ids can also look like colors and receive swatches. Fenced code and explicit heading anchors remain unchanged. Rendered Markdown excludes URL destinations and image text; literal Markdown-like link and image syntax in plain-text messages and questions can contain swatches. Swatches show alpha over a checker pattern, retain the original visible text and add no copied text. Saved question answers use the same display.

omp's displayed harness notices appear in the chat in all three views, presented the way omp's terminal shows them. The normal presentation removes omp's wrapper tags, and Verbose offers the original text in a "Text sent to the model" disclosure. Finished background jobs and helpers become one tool-style row per job that opens to the result; IRC messages become message cards with the body cut to three lines; process exits, advisor notes, skill invocations and other notices each get their own row or card. Verbose initially expands job results, skill text and other-notice details, while IRC message bodies stay collapsed to three lines in every view. The session tree uses the same one-line summaries.

User shell (`!` / `!!`) and Python (`$` / `$$`) runs appear in live and saved chats in all transcript views. They retain user attribution, mono source, recorded entry times and the exit code or cancelled state. Output uses the tool-step disclosure, initially open in Normal, Thinking and Verbose. Long output uses the existing 20-line preview with a control to show the remaining lines, and the user can still fold the entire result. Empty results show "No output." immediately. Agent-run tool cards keep their existing defaults. TSP deferred results remain visible before the next prompt through omp's semantic `nativeTail`; matching saved results replace them once. Conditional presentation claims keep Other omp output available whenever the corresponding chat row is hidden or outside its rendered window.

When omp explicitly records a model fallback, all transcript views show a warning at the switch. The warning names the source when recorded and the destination, and quotes a related error only when omp's saved retry attribution identifies that model recovery. Missing reasons remain unspecified, so a provider error or preflight switch is never described as usage exhaustion without evidence. Provider-reported fallback content within a reply also shows a warning. Account rotation and manual changes keep their existing presentation. Recovery during a turn does not create an unopened result or background alert; the normal completion and question rules still apply.

The existing screen-reader announcement channel announces a newly recorded fallback once. Loaded history, reconnect snapshots and the saved copy of a streamed provider fallback remain silent, and the transcript itself stays outside live-region announcements.

The transcript shows recorded times on user messages, assistant messages, thinking disclosures, tool steps and timed notices in Normal, Thinking and Verbose views. User messages retain their entry time; assistant thinking and calls share their message's recorded time because omp does not record per-block starts. Unsaved active calls use their own start time, tool groups show the first call's time, and expanded completed tools show their result time. Compact labels use the user's locale hours and minutes, with the date for entries outside today. Full dates and times with seconds remain available through semantic time elements, accessible labels and tooltips. Consecutive tool steps in the same minute suppress repeated visible labels while preserving their space and full time. Saved chats and classic and TSP chats share the same renderer. Reply announcements contain no timestamps.

Full timestamp tooltips open from keyboard focus and close with Escape. Existing thinking, action and notice disclosure controls retain their keyboard stop; standalone times receive their own focus indicator. A shared midnight timer and focus or visibility refresh keep saved-entry dates current after the local day changes.

## Feature scope (all in scope)
### Sessions
- Open chats appear in a Current chats sidebar section, with unopened results first and a divider before viewed chats. Each group follows the persisted tab order. Dragging a row, Alt+Arrow Up or Alt+Arrow Down on its focused title, and Move up or Move down in both row menus change that order and its shortcut numbers. Moves retain title focus and announce the displayed position through a polite live region. Drops across the divider clamp to the nearest end of the source group; a boundary-only move leaves the order unchanged. Automatic moves between groups preserve tab order and shortcut numbers. A blue dot, stronger title and accessible "New result" or "Waiting for your answer" label mark unopened results. The same mark appears on open chats in the Projects tree, Home's recent chats and project overviews.
- Close all chats is available in the Current chats header's section menu and command palette. It always asks once with Cancel as the default, listing chats where omp or helpers are working, chats whose state is unknown after the quit flow's bounded wait, and each chat whose draft text or attachments would be discarded. A running host without a synced room is unknown. Confirming closes the selected chats sequentially in the order captured on invocation, awaiting each omp worktree decision. Draft-loss findings use that captured order even if tabs reorder while state is checked. Saved chats enter the 10-entry reopen stack with text drafts; older entries fall off, while saved chat files are not deleted. Attachments are discarded for all closed chats, and text from unsaved chats is discarded. Cancel and Escape restore the invoking control when it survives; successful closes focus the main area or New chat. The shared quit and single-chat warnings also restore focus, including when their dialog fails to load.
- The Projects header offers Sort by with Recent activity (default), Name and Date created. A separate View group shows Group by project as a trailing on/off switch (on by default); the whole menu row toggles and keeps the menu open so the changed state is visible. Choices persist across restarts. Grouped projects and their chats sort by the chosen key with pins first; names use case-insensitive natural number order and follow displayed titles, including live title changes and unnamed-chat labels. Date created puts the oldest saved chats first and uses each project's earliest saved chat, including archived chats, because folder creation dates are unavailable. Unknown creation dates follow known dates. Ungrouping lists all non-archived chats across projects with their project name and optional folder color dot, with chat pins first. Search and row actions work in both modes, equal keys retain source order, and Current chats keeps its own order and shortcut numbers.
- A chat's status is, in order: waiting for an answer, an error reported by omp, working (omp's own turn), helpers working (omp's turn has ended and a helper it started still runs, on a running omp), open, or saved. Both working states show the spinning mark everywhere chat status appears: Current chats, the chat header, Home's recent chats and project overviews. Background shell jobs do not keep a chat in a working state, since a dev server started as a job can run until it is stopped. omp's OSC 7501 messages provide waiting and error text when collab has no matching question.
- ⌘1-⌘9 open the numbered Current chats row; ⌘⇧[ and ⌘⇧] cycle open chats. ⌘⇧T reopens the last eligible closed chat and its text draft without starting omp. ⌘⇧A selects the next chat waiting for an answer.
- The sidebar's New chat button always starts in the temporary folder: `/tmp` on macOS and Linux, and the system temp folder on Windows. It has no keyboard shortcut hint because ⌘N/Ctrl+N keeps the focused chat's or visible project overview's folder. From Home, pages or an empty view, that command uses the temporary folder. File > New Chat and the command palette follow the same rule; `/new` keeps its originating chat's folder. New chat here, the project overview's composer and open side by side keep their project.
- Each chat can run in its own Git worktree. The current chat follows omp's folder and session moves. omp's worktree startup and exit questions use native dialogs, and closing the chat waits for its worktree decision.
- Side-by-side chats each have a header button with Columns and the visible text "Close split view". Its accessible label and tooltip read "Close split view (⌘\)" (Ctrl+\ on Windows and Linux). At narrow pane widths it becomes a bordered icon button. Close split view is also available in that header's ⋯ menu. It keeps that pane's chat full width and focuses its composer, or its header menu for a read-only chat. The other chat stays open in Current chats, and both chats retain their drafts and side panel layouts. ⌘\ (Ctrl+\ elsewhere) keeps the focused pane's chat. Outside split view the menu offers Open side by side.
- A chat can be rewound or forked from any message.
- Both chat row menus offer Change icon for live and saved chats. The dialog previews the title, accepts an emoji and offers the operating system's emoji panel where supported. Existing card codes and title text stay unchanged; plain titles also require a 1-6 character letter or digit code. omp saves the composed title through `/rename` for live chats or its session-name RPC for saved chats.
- After a nonzero exit without omp's current `session_exit` marker, **Continue where omp stopped** explicitly restores interrupted work through `omp --restore`. Ordinary restarts continue to use `--resume`.
- The transcript displays omp's recognized startup model-substitution warnings and its latest idle recap without adding model messages. The recap is hidden after a newer user or assistant message on any branch, including a reply still streaming. Earlier recaps remain in omp's journal.
- When the user moves to another chat, a saved chat that was only viewed is released: it has no unopened result, no host, no sent input, no draft or attachments and no open omp terminal. A viewed chat whose side panel is open, or was resized, is not released, so the panel is there when the user comes back. A chat also stays open when a chat that was already open appears later in Current chats, so no ⌘ number shifts. Browsing from one saved chat to the next releases the one left behind.
- Queued messages can be sent now, edited or removed.
- A prompt explicitly rejected before its turn starts, or an image paste rejected by omp, remains with its original text and images in the queue and shows omp's diagnostic. It waits for an explicit retry or removal rather than retrying when omp becomes ready. A newer composer draft remains unchanged. If omp's editor could not be cleared safely, sending stays blocked until omp is relaunched.
- A chat has an unopened result when its main turn finishes or it starts waiting for an answer while the window is unfocused or minimized, or while another chat, Home, a page, a project overview or an expanded side panel covers it. Showing the chat in either split half with window focus clears only that chat. Closing it removes its unopened result. The count and reasons persist with restorable open tabs and are validated on load, so a restart on Home keeps results available to review.
- The macOS Dock badge and Windows taskbar overlay show the unopened-chat count, including while the window is focused on another chat and while background alerts are off. On macOS, Settings › Sounds & alerts advises turning on Allow notifications and Badge application icon in System Settings › Notifications › visual-omp if the Dock count is missing. The background-alert switch controls native notifications and the one-time Dock bounce or taskbar flash. These alerts occur only in the background. Notifications follow omp's main turn, so a reply that ends while helpers still run is reported when it ends.
- All saved omp sessions (including ones started in a terminal) appear in history grouped by
  project and can be resumed; a session still live elsewhere opens read-only.
- Before the app starts omp on a saved chat whose file is 32 MiB or more, a warning states the file's size and that omp may become slow or unresponsive, with Stop possibly not responding. The user can cancel, start a new chat in the same folder or resume the chat. Cancelling or starting a new chat leaves omp stopped and the saved chat as it was, and reports no error. A message or app command being sent returns to that chat's composer unsent; when a newer draft was typed meanwhile, the draft stays and the declined message waits in the queue instead. Declining from the omp screen closes it. The warning covers each launch of omp on a saved file: a send, command or mode change, Start omp again, Continue where omp stopped, Continue here, opening the omp screen and a Restart omp that relaunches omp. It is skipped for a chat whose omp already ran or was adopted, and for a file the user chose to resume earlier, until the app window reloads or the app quits. Restarts inside a running omp, `/resume` typed to omp and the app's own reading of saved history are not covered. The size is a precautionary threshold chosen after a 70.5 MB chat stopped answering Stop; it is not an omp limit, and smaller chats are not promised to resume smoothly.

### Panes
- Each chat has its own side panel: whether it is open, which pane it shows and how wide it is belong to that chat, so a chat that never opened its panel shows it closed at the default width, and opening, closing or resizing it in one chat never changes another. Links and buttons in a chat open that chat's panel. Each restored chat comes back with its panel after a restart. Home and project overviews share one panel.
- The Changes pane shows uncommitted edits per file, sends line comments to omp, and runs *Review code* via `/review`. Commit history follows these edits and remains available when the work tree is clean. Each history row shows its subject, author, short SHA, relative date and line totals. Show more loads another 30 commits from the same immutable snapshot, so a new commit between pages cannot duplicate or skip entries. Selecting a commit opens its read-only diff against its first parent, or the empty tree for a root commit, with the existing file list, collapse and Show all lines controls. Commit metadata wraps within a bounded scrolling region, leaving Back to changes visible. Back returns to uncommitted edits and the loaded history. Discard, line comments and Review code apply only to uncommitted edits. A new HEAD refreshes the loaded history window without reopening the pane, while working-file changes reuse unchanged history. Repositories with SHA-1 or SHA-256 objects and detached HEAD are supported, and a repository without commits explains that state.
- The Files pane shows the project tree and a file viewer, and clicking a file can @-mention it. Saved `.html` and `.htm` files open as rendered pages in existing viewer tabs, including when live previews are off. Preview and Source remain available, with Open in browser for interactive pages. HTML previews use narrow local asset grants, disable scripts and network access, and explain those restrictions beside the page.
- The Preview pane is a built-in browser for dev servers.
- The Tasks pane shows omp's todo list, its helpers (subagents) and background jobs. Each helper's activity line prefers what it is doing now, then what it did last, then omp's task description and finally its assignment with omp's assignment preamble removed. Its conversation opens in the chat column, starts with the assignment and labels later messages by sender. A helper that finished its turn shows Done, even while omp keeps it for a follow-up message, and the Tasks pane still offers to message it; a message runs it again and shows it as working. The pane lists every running helper, then the three latest finished ones and any older failed one, with the rest behind "Show earlier helpers". A task row shows a success check only when every helper finished; helpers that stopped get a neutral "Stopped" mark, and a mixed batch reads running if any helper runs and failed if any failed. Helper and job outcomes come from omp's async-result notices and `job` and `wait` results. Without omp running for the chat (a saved or exited chat), a helper still marked working shows Stopped, a finished helper stays Done and can no longer be messaged, and a running job shows stopped; work still running at an omp `session_exit` entry also shows stopped in a resumed chat. A read-only chat counts as running while another window owns it or its ownership is unknown; once it is found free to continue, its unfinished work shows stopped. The header work chip, the Tasks pane, task rows and helper cards agree. Background jobs list running jobs first and then the five most recent finished ones, with the rest behind "Show earlier jobs". Each job is titled by the intent the model gave its command (or by its first real step when there is none), with that step under it. A running job shows the time since it started; a settled job shows omp's reported run time and, for a failure, the exit code, when omp reports them. A job opens to the full command, its latest output and its id. Durations on job rows and helper cards use one style: "847ms", "4.2s", "42s", "4m 05s", "1h 13m".
- Tasks, pinned helpers and transcript helper cards open the same helper focus view. It replaces that chat's transcript and composer, while the main chat retains its draft and scroll position. Back to chat and Escape return keyboard focus to the opener or that chat's composer. The header names the helper and shows its status. Replies, tool cards, thinking and notices share the main transcript's presentation and view mode. Complete new entries appear as omp appends the helper's local file; word-by-word helper streaming is outside this feature.
- Messages to a working helper remain in a visible app queue until omp reports the helper idle. Queued messages, including ones still being prepared for delivery, can be cancelled. Delivery continues after leaving the helper view. Immediately before writing to the socket, the app checks that the helper remains idle, its latest lifecycle and registry state are not aborted, its chat has not ended and the pending operation still exists. Completion evidence counts only after dispatch. Delivery errors remain available for explicit retry, with no automatic replay into a changed chat or host generation. An unconfirmed delivery is not an exactly-once guarantee.
- omp has no conditional idle-only helper command. A helper can still start working or become aborted in the instant between the app's final check and omp's handling of that command; omp may then steer the newly running helper or revive the newly aborted one. Removing this residual race requires an upstream command that checks eligibility atomically with delivery.
- The Plan pane shows the current plan and lets you approve or refine it.
- TSP chats, including default macOS and Linux chats, open a local Side question bottom drawer for `/btw <question>` and bare `/btw`. A question starts through omp's semantic editor; bare `/btw` opens its history in the drawer. The drawer covers the originating chat's transcript and composer without opening or changing its side panel. Live answers stream from omp's document, and previous topics, titles and exact times come from its read-only sidecar files, including focused-helper histories. New questions, follow-ups, copying and the declared Stop side answer action retain their existing controls. Main-turn Stop remains collab abort. The app never deletes a topic or writes omp's history. omp 18.16's steering block and Inject into main appear only when omp publishes them. Classic chats keep the terminal-sheet behavior.
- Side-question history keeps main and helper records separate even when their ids match. Native actions apply only to a topic established as belonging to the current omp overlay. Drafts retain their original chat scope and topic; displaced drafts can be copied from Saved drafts. A pending operation disables history mutation, and late results cannot clear a newer draft. The Side questions pane remains available for browsing and copying saved answers, with no pane-bottom Done action.
- The drawer is a non-modal dialog labelled "Side question" above a flat dimmed scrim scoped to that chat's transcript and composer. Covered content is inert for pointer and keyboard input and excluded from accessibility navigation, while transcript, task and status updates continue behind it. The chat header, sidebar, side panel and other split column remain usable; Tab is not trapped inside the drawer. Focus moves into the drawer on opening. Main input stays disabled through omp's existing `btw` availability reason, "Finish the side question to send a message." Send never dismisses the side question.
- The drawer's top-right Done button, an outside click on its scrim and Escape share `putAwayBtwPanel`, the scoped single-flight close operation. It closes omp's overlay without stopping a running side answer or removing its saved history. The drawer retains its presentation until the closing document confirms success, then shows "Side question saved to History" only when a topic exists. Closing an empty history produces no saved toast. Focus returns to the originating chat's composer only if that chat still owns the view and its controller, host generation and protocol epoch still match; a later chat or split-focus choice is preserved.
- Opening has an eight-second deadline even when the native request never returns or publishes a document. Expiry displays an error with a working Done, scrim and Escape dismissal. A scoped listener puts away a late native overlay after dismissal, without a saved toast. Put-away also has an eight-second deadline covering its history read, native close and closing document. Failure or timeout keeps the drawer visible with the error and permits retry. Repeated dismissal requests share the outstanding close. Outstanding native closes remain shared across layout changes without being sent again.
- The drawer enters and exits from the bottom through the shared motion system while its scrim fades. Reduced motion keeps opacity only. Both layers are positioned over the existing chat, so opening, streaming and closing cause no transcript or composer layout jump. Eager presentation registration and the existing native claim remain active while the drawer is visible, including lazy control loading, so the generic omp screen does not appear during opening or put-away.
- Outputs groups images, PDFs and files by whether omp created, wrote, changed or viewed them.
- Outputs also previews supported visual outputs while omp makes them, including streamed SVG, Mermaid, static HTML, Markdown and CSV, eval images, saved image and PDF updates, and image-generator requests. The stage retains the selected output and its last valid frame, with an explicit end-state label.
- Watch opens the originating chat's Outputs. Automatic opening is a separate General setting, off by default. Turning live previews off stops file watching and closes the stage while the existing output lists remain available.
- Stop aborts the current turn. Stop and redirect holds queued messages, waits for stop confirmation, and prefixes that chat's existing draft while preserving its attachments. Sending from that composer or pressing Escape releases the hold. A ten-second failure releases it and permits another stop request.
- HTML live previews use local, narrowly granted assets, with scripts and network access disabled. Links leave the preview unchanged and offer Open in browser for HTTP and HTTPS addresses. A saved page main cannot serve keeps the previous frame, and a page in a temporary or home folder notes that some assets may be unavailable.

### Git
- The status bar shows Git state, and commits can use an AI-written message (`omp commit`).
- Pull requests and draft pull requests can be created through the GitHub CLI.
- Pull request and CI status appear in the status bar, with *Fix CI* for failing checks.

### Composer
- The composer card contains ＋, text, microphone and send or stop actions. Permission, Suggestions, model, thinking and context controls appear in a quieter row beneath it.
- The model button marks a recorded fallback with a warning icon and “Fallback”, and its tooltip names the original model when known. It follows the live selected model or, for saved chats, the latest recorded choice. Provider fallback content identifies the model serving that reply. A manual choice or return to the primary removes the retry fallback marker.
- The picker uses omp's selected identity independently of its serving-model label, so a provider fallback can still be explicitly selected. An unknown original stays unknown through subsequent fallbacks until a non-fallback choice resets the chain.
- In a running chat, an account picker follows the model button when omp lists at least two stored OAuth accounts for that model's provider. It uses omp's email or account label with organization qualifiers, checks only omp's current session account and leaves an unknown selection unchecked. Choosing an account sends `/session pin` through the current presentation and waits for omp's active-account state before confirming the choice. While omp replies, choices are disabled with an explanation. A pin prefers that account for this chat; omp can still rotate accounts at usage limits. Saved chats without a running omp have no account control.
- Next-message suggestions follow omp's `composer.predictions` setting and remain off unless the user turns them on. Suggestions saves the choice to omp's global config through the same settings service as Advanced; it never creates a project config file. A project or higher-priority setting keeps control and is explained in the tooltip. omp reloads the setting in running chats, including classic and TSP, and Restart omp also applies the saved choice. The tooltip explains the extra model request after replies and that it counts toward usage. Suggestions are inserted with Tab without sending.
- While omp works, the primary action queues the message; Send now remains available with ⌘↵. While an `ask` question waits, Enter sends the message immediately and closes the question without stopping the reply. The question card and composer hint explain this choice. Send now on a queued message does the same in classic and TSP chats; other extension and hook dialogs retain their guarded answer controls.
- Approval cards keep the one-time approval as the default, including when omp lists remembered file or folder grants first. Broader grants and session approval appear as secondary actions. The card explains that sending a message now denies the pending request. Ask and remember is available alongside the other permission modes; Settings > Permissions can forget persisted approvals across projects through omp's own command.
- The context popover's Compact chat button becomes Queue compaction while omp works. It adds `/compact` to the visible app queue, where it can be edited or removed, and runs after the current reply.
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
- Providers checks status outside projects with extensions disabled. Each stored account reported by omp's `get_logout_accounts` listing has its own Sign out action, identified by omp's account label and detail, including organization qualifiers and numbered API keys. Confirmation names the selected account; main rechecks its identity before omp's `logout` RPC removes that credential alone. Other stored accounts and authentication from environment variables or config remain unchanged. Older omp without the listing retains provider status without offering provider-wide sign-out. Sign-in export and import are global-only operations through omp, with warnings about unencrypted credentials and refresh-token rotation. Export uses restricted file permissions where supported, and credential contents never cross renderer IPC.

### omp extras
- Usage & limits shows provider limits by account and window, preserving omp's window order. Expanded accounts include omp's optional routing priority, reserve and account-wide state. Unknown values and warnings remain visible. Saved resets list through `omp usage reset --json`; after confirmation, `omp usage reset <provider>/<id>` spends one and its exit code determines success, then limits refresh. The activity grid shows model requests per day over the last year, and Home shows recent months. Recorded usage comes from local session and subagent files; its 7- or 30-day period does not filter limits or the activity grid. The page includes an estimated API cost chart and searchable chat table with filters, pagination and CSV export. Its browser Stats action follows the dashboard URL printed by omp, which chooses the port.
- Security scan and cleanse can be run for a project.
- Chats can be imported from Claude Code and Codex.
- The session tree navigator shows every branch of a chat.

### Sharing
- Share > Invite publishes the running chat through omp's public relay and browser client at my.omp.sh, with end-to-end encrypted rooms. A configured custom relay or browser client requires the existing native confirmation before publication.
- The QR code opens the control link, so a phone can send messages, answer questions, approve actions and stop a turn through omp's browser client. The dialog explains that anyone with the code can control the chat. Copyable control and view-only links remain available.
- Stop sharing disconnects guests without changing the room credentials. If the same room is shared again, its previous QR code and links work again. The dialog explains this beside the active links and before sharing resumes. Encryption protects chat content; the relay can see connection metadata.
- The app prevents idle system sleep while any chat is shared, including relay reconnection and room replacement. The display may turn off, and closing a laptop lid can still suspend it. The dialog states this behavior. Stopping the last share or closing its chat releases sleep prevention.
- When omp replaces a shared chat's room during `/new`, `/resume`, a fork or restart, sharing follows the new room using the previously approved endpoints. The dialog removes obsolete links while waiting, then updates both links and the QR code and explains that connected guests need the new link. Ending omp stops sharing. A fork opened as a separate chat does not inherit another chat's share.

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
- The project overview leads with a live board: Waiting for you (questions, approvals and errors), Working (omp or its helpers), New results (unopened results), then Recent chats. It combines open tabs, including chats without a saved file yet, with non-archived saved chats. Active attention states take precedence over unopened results. Within each group, open chats without saved history keep tab order ahead of saved chats, which keep newest-created order while activity streams. Attention groups show every chat; Recent chats shows five before Show all. Selecting a row opens that chat without starting work. Empty attention groups disappear, and a polite announcement reports each transition into waiting once per episode while initial history stays silent. Instructions and settings, Git status and quick-start prompts follow the board.
- New results with a current omp recap display it as a muted second line below the title; without a recap they retain the compact single-line row. Known open chats remain available when saved history is loading or cannot be read. Waiting announcements distinguish questions from errors, and errors without detail keep their error label.
- Home is where the app opens and what the title bar's Home button (⇧⌘H) shows: a prompt box that starts a chat in any project with the new chat's choices (project folder, permission level, model, thinking level, attached files), the latest chats across every project, the projects with their folder colors, and plan limits with the last 7 days' estimated API cost. A quiet animated dot field renders behind it and holds still under reduced motion.
- Home's composer starts with the temporary folder selected, including on first run before any project or chat exists. Choosing a project or opening a folder changes only the Home draft's folder, leaving the active project elsewhere in the app unchanged. The chosen folder is saved with unfinished text and attachments, so leaving Home, returning or restarting the app preserves their destination. Starting the chat successfully resets the draft to the temporary folder; a cancelled send keeps the whole draft. Returning to Home with no text or attachments also resets its folder. The picker names it the same way as the projects list, and its model, thinking and permission defaults use the same project settings as other folders.
- When the sidebar is visible, a page places Back under the sidebar header, and the header and Back share a teal card while the page is open. Settings places its section navigation under the card, in place of the chat lists; other pages keep the lists visible beneath the card. With the sidebar hidden, Back and navigation render inline and page focus moves to the title after lazy content mounts.

### Packaging and loading
- Main-process pure-JavaScript packages are bundled from devDependencies. Only native runtime packages such as node-pty remain runtime dependencies. Source maps and unused Electron locales are excluded.
- The renderer's initial JavaScript entry chunk, an uncompressed build-output size, decreased from approximately 4.87 MB to 1.56 MB. Xterm is about 331 KB and KaTeX about 262 KB in separate chunks. Settings sections and feature views are code-split.

### Settings
- Settings is a full page with curated common sections and a searchable **Advanced** section that
  lists every omp setting.
- Appearance offers one app-wide status-bar layout, with independent visibility and reordering within the left and right groups. Drag or keyboard moves preserve focus and announce the new position. Right-clicking the status bar offers the same visibility checklist and a link to Appearance. omp status and the app update notice cannot be hidden because they provide recovery actions. Existing Git, plan-usage, app CPU and app RAM items remain enabled by default. Context use, model, thinking level, queue length, working time and helpers running are optional focused-chat items, off by default. Working time follows the existing turn timer and omits a duration when the start was not observed.
- About includes a **Diagnostics** row with **Open logs folder**, which opens the current profile's
  `logs` folder for reviewing local event logs and crash reports before sharing. Opening the folder
  starts no upload. The description warns that crash reports may contain sensitive information and
  directs the person to Advanced for automatic reporting.
- Advanced's visual-omp group includes **Send crash reports**, on by default. It automatically sends
  crash reports and selected app failure events to Sentry. Event logs exclude chat contents; native
  crash reports may contain sensitive information from process memory. Turning the switch off keeps
  diagnostics local. Development sends only with `VOMP_SENTRY_DSN`.
- Direct macOS copies offer **Switch to Homebrew**. The app adds the tap and checks the published
  cask. A matching app at the destination is adopted, including when it is a separate copy.
  An empty destination permits installation while the running copy remains elsewhere. A differing
  destination version blocks the switch and asks the person to update that copy first through
  its existing update flow. The switch never replaces a bundle. Existing cask copies are reused.
  Restart opens the verified target from disk; moving a separate old copy to the Trash is optional.
- Windows installer copies offer **Switch to Scoop**, then **Continue in PowerShell** through the quit
  guard. Discovery checks configured, default user, global and PATH Scoop roots before installing.
  After exit, a visible PowerShell script installs or reuses the package and verifies its executable,
  install receipt, installed manifest version and resolved app path. It copies the old NSIS
  uninstaller to a unique temporary file and runs `/S /KEEP_APP_DATA /currentuser --updated _?=<dir>`
  (or `/allusers` for a matching machine installation), waits and deletes the temporary copy.
  Installation failure reopens the retained installer copy. Cleanup failure starts the verified
  Scoop copy and reports that the old copy could not be removed. Result or log write failures
  cannot prevent the launch attempt or the visible error. The script never recursively deletes
  the installation directory. A JSON result and plain log describe each phase.
- Updates, reinstalls and both package-manager switches share one installation-operation state. Conflicting
  actions are disabled in the renderer and refused by main until the active operation settles.
- Both switch confirmations start on Cancel and return focus to their trigger when closed.
  Footer actions wrap at narrow widths and larger text sizes. Chats and omp settings are preserved,
  and omp's installation remains unchanged. A missing package manager shows brew.sh or scoop.sh
  and README commands, with **Check package manager again** after installation.
- About's **Read release notes** and **Review update** actions open the same release history. An
  earlier release with a trusted installer for this computer offers **Install v{version}**. A
  confirmation names the running and selected versions, explains the restart and preserves chats
  and omp settings. Confirming reuses the existing download progress, cancel, error and installer
  controls. Main fetches the official release metadata again before selecting the earlier installer.
- For disk-image and Windows installer copies, About offers **Reinstall v{version}** for the running
  version when a fresh official release lookup finds that exact version and a trusted installer
  for this computer. A confirmation names the version, explains replacement and restart, and
  states that saved chats, omp settings and the rollback update skip are preserved. Cancelling
  starts no download.
- Disk-image and Windows installer reinstalls use the existing progress, cancellation, retry and
  installer controls. Main fetches the release again before downloading. The shared download
  path checks trusted asset URLs and redirects, verifies byte count, and validates a supplied
  SHA256 digest. Missing digests remain compatible with older releases.
- Homebrew and Scoop reinstalls show package-manager instructions under a generic reinstall
  heading instead of promising the exact running version. Homebrew's
  `brew reinstall --cask visual-omp` uses the currently published cask. Scoop's
  `scoop update visual-omp --force` uses the bucket's current manifest, with `--global` and an
  administrator PowerShell for global installations. Either command may install a newer version.
  Saved chats, omp settings and package-manager records remain available. If the replacement
  version exceeds the saved rollback skip, the usual startup check clears it.
- Reinstall availability distinguishes development builds, unsupported installations, a missing
  exact release, a missing trusted platform installer and an offline release lookup. Drafts are
  excluded; the existing prerelease track applies to the exact running version.
- On macOS, completing a rollback requires opening the downloaded disk image, quitting visual-omp,
  copying the app into Applications with **Replace**, and reopening it. On Windows, running the
  downloaded installer closes visual-omp; the user completes setup and reopens the app.
- Homebrew and Scoop installations offer **Show downgrade steps** instead of an in-app rollback
  download. Homebrew users select an older cask from the tap's history. Scoop users can reset to a
  previously installed version if its files remain, or consult the bucket's historical manifest
  and available download. Package-manager installs keep their own installation records.
- A confirmed installer rollback saves the version being left as `appUpdateSkipThrough` in app
  preferences. In visual-omp 0.7.1 and later, background checks suppress versions at or below this
  ceiling and offer a newer version above it. Running a version strictly newer than the ceiling
  clears it; running the same version retains it. **Check for updates** explicitly includes skipped
  versions without clearing the preference. Choosing a regular update clears it before updating;
  reinstalling the current version through a direct installer leaves it unchanged.
  Versions before 0.7.1 retain the preference but do not honor it, so they may still offer the
  version being left. Those updates require a user action and can be left uninstalled.

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
