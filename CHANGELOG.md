# Changelog

Each release's section below becomes its GitHub release notes (see [docs/RELEASING.md](docs/RELEASING.md)). Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- Outputs no longer parses every running command's output again for each changed file. In one turn that had changed 2,478 files, most of them from a site build, that repeated parsing blocked the app's window for about 1.6 seconds on each update.
- When omp reports that a background command's job ended, Outputs stops showing the command as running, and the files and folders the command named no longer add to what the app watches.
- The app no longer reads addresses such as `https://example.com/page` in a command or its output as file paths. Previously, a command that printed many addresses could use up the 32 paths the app checks for each command, so Outputs missed a file the command made.

## [0.7.17] - 2026-11-11

visual-omp 0.7.17 tells you when omp stops using a provider sign-in, shows omp's setting questions once and supports omp 18.18.8 and 18.18.9. It requires omp 18.15.0 or later.

### Highlights

- **New:** **Expired sign-in notices.** When omp stops using a provider sign-in, the app tells you once and opens Providers so you can sign in again.
- **Improved:** Saved ask results show the option notes omp 18.18.8 records.
- **Fixed:** **Setting questions appear once.** omp's question to save or change a setting shows only in the chat's question card, with the setting name formatted as code.

### Detailed changes

#### New

- When omp stops using a provider sign-in after a failed refresh or an upstream invalidation, such as an expired grant, the app shows a notice with a button that opens Providers. Each sign-in is reported once: a launch reports the sign-ins omp stopped using since the previous check, and the first launch after this update reports any that omp already lists. The notice names the account when omp reports one, and several sign-ins share one notice.

#### Improved

- Saved ask results show the option notes omp 18.18.8 records, beneath their matching answers. The note editor in omp's own form stays display-only in the app.
- Question cards and saved ask results show code in a question's wording, such as a setting name, formatted as code instead of between backticks.
- A wait that omp cuts short to deliver a message, steering or a job notice says "interrupted by message", as omp shows it, instead of an empty list of running jobs. With omp 18.18.9, messages between agents always end a wait this way and follow it as their own row.

#### Fixed

- Helpers created in Settings are saved in the folder omp reads when your shell sets `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` or an omp profile. omp 18.18.8 and later read helpers from `PI_CODING_AGENT_DIR`.
- omp's question to save or change a setting appears once, in the chat's question card. The question formats the setting name as code, which previously made the chat show a second copy of omp's dialog that could not be answered.
- Saving an omp setting no longer adds "Changed 1 file" to the turn summary. The summary lists only files on this computer that omp wrote or edited.

#### Removed

- Command suggestions no longer offer `/mcp smithery-search`, `smithery-login` or `smithery-logout`. Smithery shut down its API on October 31, 2026, and omp 18.18.9 removed these commands.

## [0.7.16] - 2026-11-10

visual-omp 0.7.16 keeps the omp screen closed until you request it, adds Continue for main chats and offers Undo after a rewind. It requires omp 18.15.0 or later.

### Highlights

- **New:** Main chats offer Continue to resume interrupted work, or to interrupt and continue a running reply, with omp 18.18.2 or later.
- **Improved:** **Undo a chat rewind.** Undo returns the chat to its previous position and restores the draft the rewind replaced.
- **Improved:** Grep steps highlight search patterns and show an empty search as a single "0 matches" line.
- **Fixed:** **Open the omp screen on request.** Errors, task output and leftover menus no longer open the omp screen over the chat.
- **Fixed:** Helper cards keep a readable width in narrow chats, with additional helpers available through Tasks.

### Detailed changes

#### New

- Main chats offer Continue in the chat menu to resume interrupted work, or to interrupt and continue a running reply. It requires omp 18.18.2 or later.

#### Improved

- Grep steps highlight the parts of a search pattern, leave out a redundant "1 file" when one file was searched, and show an empty search as a single "0 matches" line.
- After Rewind to here, Undo returns the chat to its previous position and restores the draft the rewind replaced. Undo remains available until you send a message or the chat changes.
- The omp screen and classic terminal appear without a slide animation.

#### Fixed

- The notice for a model change in the current chat only shows its keyboard shortcut with the app's key symbols, so it no longer appears as an empty box.
- Chats no longer update a hidden handoff timer every second while no handoff is in progress.
- Helper cards above the message box keep a readable width in narrow chats. Helpers that do not fit are available through the control that opens Tasks.
- The omp screen and classic terminal open only when requested. Rate-limit errors, task output and leftover native menus no longer open them over the chat.

## [0.7.15] - 2026-11-10

visual-omp 0.7.15 gives omp more time to open its model picker during the first model switch in a chat on slow machines. It requires omp 18.15.0 or later.

### Highlights

- **Fixed:** The first model switch in a chat waits longer for omp's model picker, avoiding a premature fallback on slow machines.

### Detailed changes

#### Fixed

- The first model switch in a chat now waits up to 30 seconds for omp's model picker, giving slow machines more time before the app tries /switch.

## [0.7.14] - 2026-11-10

visual-omp 0.7.14 supports omp 18.18.7's way of keeping busy chats connected and fixes a false error after switching models. It requires omp 18.15.0 or later.

### Highlights

- **Fixed:** **Busy chats stay connected with omp 18.18.7.** When a chat falls behind during heavy helper activity, it rejoins automatically and keeps its transcript instead of showing an error.
- **Fixed:** Switching models no longer reports a failure after a switch that succeeded.

### Detailed changes

#### Fixed

- A successful model switch no longer reports a failure when omp has already closed its model picker before the app tries to close it.
- With omp 18.18.7 and later, a chat that falls behind during frequent helper updates rejoins automatically and keeps its transcript. Question cards close when omp marks their questions unavailable.

## [0.7.13] - 2026-11-10

visual-omp 0.7.13 keeps the omp screen closed while the app works with omp, keeps omp's questions in the chat and marks helper conversations clearly. It requires omp 18.15.0 or later.

### Highlights

- **Improved:** **Helper conversations are clearly marked.** A teal band names the helper and the chat it came from, with a Back button, and the message box names the helper that receives your message.
- **Fixed:** **Fewer interruptions from the omp screen.** App actions such as switching models and rewinding no longer open the omp screen automatically, and questions shown in chat stay there.
- **Fixed:** Choosing a thinking level in a new chat applies it instead of reporting an error, and finishing a question form closes it without the chat jumping.
- **Fixed:** Links in replies to local files now open in the side panel, including paths with spaces. File rows show paths relative to the chat's folder for files inside it.

### Detailed changes

#### Improved

- A helper's conversation now opens under a teal band that names the helper and its parent chat, with a button to return to that chat. Its message box names the helper receiving the message, and the chat header labels the original chat as Parent chat.

#### Fixed

- The omp screen no longer opens automatically during app actions such as switching models or rewinding a chat. Other automatic openings wait 300 ms so brief screens do not interrupt the chat. Screens you explicitly request still open immediately.
- Questions from omp with multiline titles, such as the offer to spend a saved rate-limit reset, stay in the chat's question card without also opening the omp screen. Dialogs that could match a chat question no longer open the omp screen automatically; you can still open them on request.
- Finishing a question form closes it in place, without the chat jumping or scrolling back.
- Settings waits for the model list before warning that an assigned model is unavailable, including after omp updates.
- File rows show project-relative paths for files inside the chat's folder, including projects opened through symlinks or macOS folder aliases, while files elsewhere keep their absolute paths.
- Links in replies to existing files in the chat's folder, including paths with spaces, now open the file in the side panel.
- Stats results omit the redundant Open dashboard line when the dashboard URL is already available.
- Choosing a thinking level in a new chat no longer reports a switching error when omp first initializes the setting to Off before selecting the requested level.

## [0.7.12] - 2026-11-09

visual-omp 0.7.12 shows what slash commands and handoffs are doing, supports the question forms in omp 18.18.3 and later and opens large local files. It requires omp 18.15.0 or later.

### Highlights

- **New:** **Handoffs show their progress and result.** /handoff shows omp's progress with elapsed time and Stop, then a Handed off row that shows the handoff document with Copy.
- **New:** Settings > About offers Roll back to an eligible earlier release. After a successful update, the notice offers the version you used before updating when it remains eligible.
- **New:** Starting a new chat from a large chat can bring a handoff and your unsent message.
- **Improved:** Running helpers appear in one compact row above the composer, with their time and Stop.
- **Fixed:** **Slash commands answer in the chat.** Results, reports and outcomes from commands such as /tools, /move and /stats stay readable in the chat.
- **Fixed:** Question forms from omp 18.18.3 and later, including the tabbed forms in 18.18.4, can be answered in the chat. Forms the chat cannot show offer View question in omp screen without opening it automatically.
- **Fixed:** Local videos, large images and large PDFs open in Files without size limits.

### Detailed changes

#### New

- Settings > About offers Roll back, and the successful update notice links to the version you used before updating. Both open Past versions with an eligible earlier release selected.
- After /handoff, the chat shows a Handed off row that opens to the handoff document omp now continues from, with Copy. Summaries from compaction open the same way from their Context summarized row.
- Starting a new chat from the large-chat warning can bring an omp handoff and send your pending message with its attachments. The option is on by default. If you cancel the handoff or omp cannot finish writing it, the message stays as a draft in the new chat.

#### Improved

- Running helpers appear in one compact row above the composer, with their duration and Stop controls. A brief teal cue marks activity updates; overflow and See all tasks open the chat's Tasks panel.

#### Fixed

- An open helper conversation now follows the same helper after omp restores its interrupted work. Earlier queued messages remain failed and available to copy without being sent again.
- Homebrew and Scoop rollback guidance now offers a verified installer download and explains how to switch to it while keeping app data and omp settings. Managed downloads require a published SHA-256 checksum and never run the installer automatically.
- Saved-chat previews recover first prompts after large opening entries, within bounded transcript scan limits.
- Unfinished native hook answers remain available when the same dialog is cancelled and reopened or shown in the omp screen.
- While omp writes a handoff or a context summary, the chat now shows omp's progress with elapsed time and a Stop button, instead of looking idle until the command finishes.
- Questions from omp 18.18.3 and later HTML forms show their fields and recorded answers, and can be answered through the chat's question cards, including free-text Other choices. With omp 18.18.4 and later they stay in the chat through tabs, Review and Hide. A form the chat cannot show offers View question in omp screen instead of opening it automatically. Saved question-list calls from older omp remain readable.
- Local videos and audio play in Files, and images and PDFs load without file-size caps. Media streams through read-only file grants; large text shows its first 2 MB with an option to open the rest in another app. Live PDF previews retain checked revisions across incomplete saves and restore the preceding document when a replacement iframe reports an error.
- Folder and worktree moves, context resets, SSH and MCP command feedback, extension errors and stats dashboard URLs now remain readable in the chat. Result locations offer Copy and existing local paths offer Show in folder.
- Read-only slash-command reports keep omp's title and body in the chat, with markdown such as tables and headings formatted. Live omfg and cleanse boards open in the omp screen, and their final outcomes remain available afterward, including omfg's saved rule path.
- Model options refresh their capabilities and prices after omp is updated.
- Short code in table columns, such as tool names, stays whole instead of breaking between letters.
- File names formatted as inline code in replies, including names with spaces listed under a folder named in the same reply, open in the side panel viewer when exactly one existing file matches.

## [0.7.11] - 2026-11-06

visual-omp 0.7.11 makes release notes easier to scan and fixes file mentions for paths that contain spaces. It requires omp 18.15.0 or later.

### Highlights

- **Improved:** **Release notes are easier to scan.** The viewer groups highlights by type with icons and counts, places headline changes first, and gives important notices distinct formatting.
- **Fixed:** **File mentions support spaced paths.** Files inserted through drag and drop or file selection use quoted mentions to preserve spaces in their paths.
- **Fixed:** Settled tool calls with missing results use a neutral mark and a result-unavailable label.
- **Fixed:** On macOS and Linux, projects opened through symlinks stay grouped with their saved chats in the sidebar.

### Detailed changes

#### Improved

- The release notes viewer groups highlights by category with icons and counts. Authored headline changes appear above the groups, and important notices appear above the highlights.
- GitHub release notes use the same category order while preserving the authored order within each category.

#### Fixed

- Settled tool calls with missing results no longer show a success check. They use a neutral mark labeled "Result unavailable."
- File mentions inserted through drag and drop, the @ picker, the command palette and the Files pane quote paths containing spaces. Paths containing both single and double quotes remain plain text because omp's mention syntax cannot represent them.
- Quoted file mentions remain complete in composer chips, sent-message chips and transcript file links.
- On macOS and Linux, project folders use the same resolved paths as omp so their saved chats remain in one sidebar group. On macOS, this also handles equivalent `/private` paths. Windows path spelling is unchanged.

## [0.7.10] - 2026-11-06

visual-omp 0.7.10 fixes stalled chat input after a connection replacement and incorrect helper status after a connection ends. It requires omp 18.15.0 or later.

### Highlights

- **Fixed:** Chats recover message and command input after omp replaces their connection. If recovery does not finish within five seconds, the app offers Restart omp.
- **Fixed:** Helpers no longer appear to be running after their chat's connection ends. Queued messages show an error with recovery instructions, and Stop reports when it cannot reach omp.
- **Fixed:** On macOS and Linux, visual-omp now finds saved chats, prompt history and transcript images in omp's data directory when you have configured XDG_DATA_HOME.

### Detailed changes

#### Fixed

- Chats recover message and command input after omp replaces a lost connection.
- Helpers no longer appear to be running or leave messages queued after their chat connection ends. Stop reports a lost connection instead of silently doing nothing.
- Saved chats, prompt history, transcript images and usage discovery now follow omp's existing XDG data directory on macOS and Linux.

## [0.7.9] - 2026-11-06

visual-omp 0.7.9 reduces delays in chats with many helpers, lowers CPU use while replies stream, improves document previews and fixes live video previews. It also adds support for omp 18.17 features while continuing to require omp 18.15.0 or later.

### Highlights

- **Fixed:** Chats with many helpers batch progress updates and reconnect to omp's current state when updates fall too far behind, so an accumulated backlog does not keep delaying questions.
- **Improved:** Long chats use less renderer CPU while replies stream, including when helpers are running.
- **Fixed:** Playable video previews in Outputs update while a video renders, and a new render of the same file replaces the previous one.
- **Improved:** Outputs previews use more of the pane's height, Word previews retain their page proportions, and HTML previews follow changed content while omp writes.
- **Fixed:** Chats reconnect when omp replaces a lost connection. Restart omp can also stop omp and resume the saved chat when its screen is unavailable.
- **New:** omp update notices provide release notes and chat restart actions on all supported omp versions. With omp 18.17, you can also configure automatic updates, choose thinking levels in model tags, view prompt-cache predictions and keep selected skills available only for manual invocation.

### Detailed changes

#### New

- The composer's slash menu offers `/unpin` when omp reports it, starting with omp 18.17. It removes a chat's pin from omp's resume list without changing its preferred account.
- Settings > Skills & plugins now lets you keep matching skills out of the model's catalog while retaining manual invocation, with "Manual only" labels reported by omp. Pattern editing requires omp 18.17 or later.
- Added an optional status item showing omp's next-message prompt-cache prediction and diagnostics. It requires omp 18.17 or later.
- LSP results now display the source previews, diagnostic counts and server failures reported by omp 18.17, and web searches show which providers failed.
- Added omp model-tag completion and keyword highlighting with effect tooltips in running chats. Thinking levels in `^model:level` tags and the `chillax` keyword require omp 18.17 or later.
- Added automatic-update settings for omp 18.17 or later and a retry action when another omp installer is running. Update notices, What's new release notes and chat restart actions are available with any supported omp version.

#### Improved

- HTML previews in Outputs and Files default to a desktop-width page scaled to fit, with Fit width, 100% and Phone options. While omp writes a page, the preview follows changed content and highlights it briefly when a suitable element is available. Clicking the page, changing the size or choosing Pause following stops following. Scrolling inside the script-free page does not pause following on its own. After writing finishes, the preview keeps your place and offers Show latest when a newer revision is available.
- Word previews in Outputs keep their pages' proportions and margins, scaled to the pane's width, and scroll through multi-page documents. Spreadsheet previews fill the available space, with sheet tabs staying in view while the grid scrolls.
- The composer's settings row is more compact. The permission button shows only the mode's name, Suggestions shows its pressed state, and shortened account names remain distinguishable. The row scrolls horizontally when space is limited.
- Helper rows in Tasks now have one conversation button for reading replies and sending messages when available.
- Outputs previews use more of the pane's height to show documents, pages and recent frames, while compact previews leave room for saved outputs.
- Long chats use less renderer CPU while replies stream, including when helpers are running.
- visual-omp now batches helper progress, streamed replies and tool output instead of redrawing for each update: the chat you are looking at applies them once per screen refresh and other chats about once a second, while questions, finished turns, errors and helper status changes still arrive at once. If visual-omp falls far behind omp, the chat reconnects to omp's current state, including any open question, instead of working through a backlog. Previously a chat with many helpers could fall half an hour behind and hold back a question omp had already asked.

#### Fixed

- Transcript following now accounts for layout changes when helper cards shrink above the newest entries, which could previously stop following and show "new content below". Scrolling up with the wheel, keyboard, touch or scrollbar, jumping to an earlier part of the chat, or opening a question card still stops following.
- Quitting while an Office preview is converting no longer risks deleting the converter's working folder while it is still in use, which could fail on Windows. visual-omp now cleans up after you confirm quitting and waits up to six seconds; cancelling Quit leaves previews working.
- Outputs now updates playable video previews while rendering and replaces the previous video when another render writes to the same path. This fixes previews that stayed blank or showed the previous render in 0.7.8.
- Saved bash output and instructions for reading saved artifacts are now restored when omp sends a shortened result, within display limits.
- Collapsed tool groups now show their first-to-latest recorded activity range, fixing timestamps that appeared stuck at the group's start during long turns. Full timestamps are available on hover and keyboard focus.
- A chat no longer stays on "Reconnecting to omp…" while omp keeps working after their connection drops. The app now joins the replacement connection omp opens and keeps trying while omp runs.
- Restart omp now works in a chat that lost its connection to omp. It previously failed with "omp screen: The session changed or its semantic UI is not ready." When there is no omp screen to restart from, visual-omp now stops omp and resumes the saved chat. If omp does not confirm the stop, the existing "omp is still running" choice appears.

## [0.7.8] - 2026-11-05

visual-omp 0.7.8 changes how chats confirm completion, addresses a reported Windows Export error, shows which effort Auto thinking picked, opens helper conversations and HTML files inside the app, and previews playable video and saved documents in Outputs while omp works. It requires omp 18.15.0 or later.

### Highlights

- **Fixed:** Chats wait for omp's completion or idle confirmation before showing as done and sending a finished notification. The reported incidents after helpers finished have not been reproduced.
- **Fixed:** Export uses an absolute path to address the reported Windows error "EEXIST: file already exists, mkdir '.'". The change has not been verified on Windows.
- **New:** With Auto thinking, the thinking button shows the effort omp picked for the current message, for example "Auto · Low", so you can switch to a higher level when a chat needs more reasoning.
- **New:** A helper's conversation opens inside the chat and updates as the helper works, and helpers show an icon for their type and what they are doing.
- **New:** HTML files open as rendered pages in the app, and hex colors in chats and questions show a color swatch.
- **New:** Outputs shows a video while it renders when the file can already play, and previews Word documents and spreadsheets.
- **New:** Choose the status bar's items, pick a chat's provider account, and open a shared chat on your phone with a QR code.

### Detailed changes

#### New

- Running chats show an account button next to the model button when omp reports multiple stored OAuth accounts for their provider. While omp is idle, choose the account the chat prefers; omp can still switch accounts at usage limits. Settings → Providers can sign out one account through omp without removing other sign-ins for the same provider. These controls remain hidden when omp lacks the required account APIs.
- Continue a shared chat on your phone by scanning the control link's QR code. While a chat is shared, visual-omp keeps the computer from sleeping when idle, and the links refresh when omp changes rooms. Stop sharing disconnects guests; sharing the same room again revives its earlier links.
- Choose which items the status bar shows, and in what order, by right-clicking the status bar or in Settings → Appearance. New optional items show the focused chat's context use, model and thinking level, queued messages, working time and running helpers. omp status and the update notice always show.
- Outputs plays videos (MP4, M4V, WebM and MOV) with seeking, shows render progress from ffmpeg, Remotion and manim, and offers six key frames after rendering that you can click to jump to. While a render runs, Outputs plays what already exists: a video that is playable as it grows, such as a fragmented MP4, manim's finished animation clips, or the newest frame of an image sequence. Pausing or seeking stops following the render until you choose Follow render. With reduced motion, nothing plays on its own, and Load latest video loads the newest version. An ordinary MP4 may need to finish before it can play. Playback during rendering was checked in headless Chrome through an HTTP bridge; Windows Electron playback and native protocol behavior remain unverified.
- Outputs previews Word documents and spreadsheets while omp saves them, and slides when LibreOffice is installed. Files are checked and cleaned before they render, and the last complete version stays visible while omp finishes a save. A file refused as unsafe stays available as a chip but no longer replaces a good preview. Word and spreadsheet previews were checked in a macOS development build; slide conversion with LibreOffice, packaged worker loading and Windows behavior are not verified yet.
- Settings → General offers "Ask omp for a proof before long renders", off by default. It installs the visual-proofs skill, which asks omp to prepare a proof and request your approval before the full render. The model decides whether to follow this guidance; the app does not enforce approval. Proofs cost tokens and possibly provider credits. Start a new chat or restart omp in an existing chat to load skill changes.
- A helper's conversation opens inside the chat from Tasks, a pinned helper or a helper card, with the same replies, thinking and tool cards as the main chat, and it updates as the helper writes. Back or Esc returns to the chat with its draft and scroll intact. A message to a helper waits until the helper is idle and can be cancelled; if the helper starts working at the moment it is sent, omp delivers it as an interruption.
- Helpers show an icon for their type (such as scout, reviewer or designer) instead of their initial, with a small badge for what they are doing while they work: reading, writing, running commands, using the web, asking or waiting.
- With Auto thinking, the thinking button, its menu and the optional status bar item show the effort omp picked for the current message, for example "Auto · Low", or "Auto · Pending" until omp decides. omp's Auto can choose Low for short messages, so a chat that needs more reasoning can switch to an explicit level.
- Hex colors in chats and question dialogs show a color swatch beside the code, including transparent colors. Six- and eight-digit codes such as #2B72E5 get swatches in prose and inline code; three- and four-digit codes such as #fff get them only in inline code, so issue numbers like #123 stay plain. Code blocks, URLs and file paths remain unchanged.
- HTML files opened from a chat now show as a rendered page in the Files viewer, with their stylesheets and images, even with live previews off. Scripts and network access stay off, so interactive pages may not work; Source shows the file's code, and Open in browser opens it in your default browser.

#### Improved

- While the window is hidden or minimized, chats stop redrawing; omp keeps working, and notifications and sounds still arrive. Returning to the window shows the latest reply at once. This reduces work while visual-omp is in the background and may help with the freezes some Windows users reported; its effect is not measured yet.
- Outputs groups the frames of a declared render sequence and keeps unrelated numbered images separate.
- The chat transcript and the helper view load when first needed, which takes about 250 KB out of the code visual-omp loads at startup. The first chat after launch can show an empty transcript area for a moment while its composer is already usable.

#### Fixed

- Restarting a saved chat no longer repeats its earlier "Supervised process failed" lines after the first message you send. When omp resumes a chat, it redraws process exits from the chat's history in its own wording, and visual-omp showed those redrawn lines as new notices below the chat. The chat's own process exit rows still appear where they happened.
- visual-omp now keeps a chat working through omp's non-terminal end events and waits for a terminal end or a fresh idle observation before marking it finished. This addresses paths that could report completion too early; the incidents reported after helpers finished have not been reproduced. Each transition from working to idle records its cause in the diagnostics event log, without chat contents.
- The Watch button on a tool card now lines up with the card's other icons instead of sitting above them at the far right.
- Export now passes omp an absolute path to avoid the reported Windows error "EEXIST: file already exists, mkdir '.'". omp's /export can't take a path with spaces, so when the chat's folder path has spaces, the export is saved to Downloads and the confirmation says why. If the Downloads path has spaces too, the export uses omp's command-line export in the chat's folder, which leaves out the system prompt, the tool list and --themes. This change has not been verified on Windows.
- The status bar's right-click menu now limits its height and scrolls the item list to keep Arrange status bar… available. The layout change has not yet been confirmed in Electron.

## [0.7.7] - 2026-11-05

visual-omp 0.7.7 adds crash reporting to help investigate freezes and crashes, closes all chats at once, lets you put Current chats in your own order, moves a macOS disk-image copy to Homebrew and a Windows installer copy to Scoop from Settings, and fixes choosing Auto thinking in some chats. It requires omp 18.15.0 or later.

### Highlights

- **New:** visual-omp sends crash reports and app failure events to Sentry, on by default. Native crash reports may contain sensitive information from process memory; turn reporting off in Settings → Advanced to keep diagnostics local.
- **New:** After the window's content process crashes, visual-omp reloads the window once instead of leaving it blank.
- **New:** Close all chats from the Current chats menu or the command palette, after one confirmation.
- **New:** Reorder Current chats by dragging or with Move up and Move down in a chat's menu. Numbered shortcuts follow the new order.
- **New:** From Settings → About, a macOS disk-image copy can switch to the Homebrew cask, and a Windows installer copy can switch to Scoop.
- **Fixed:** Choosing Auto thinking no longer fails in chats where Auto had already picked an effort.

### Detailed changes

#### New

- visual-omp now keeps local diagnostics in its profile folder: crash reports and an event log that records app starts, omp starts and exits per chat, a window that stops or resumes responding, crashed processes and memory use every 5 minutes. The event log excludes chat contents, prompts and file contents. Settings → About opens the folder, so you can review the files before sharing them.
- Crash reports and selected app failure events go to Sentry automatically, on by default. App failure events include a bounded event-log excerpt, the app version and platform, with home-directory paths replaced by `~`. They also include a random installation ID when available. Native crash reports may contain sensitive information from process memory. Turn off Send crash reports in Settings → Advanced to keep diagnostics local. Development builds send nothing unless configured to.
- When the window's content process crashes, visual-omp records it and reloads the window once. A second crash within a minute leaves the window as it is, so a crash loop does not repeat.
- Current chats has a menu with Close all chats, which is also in the command palette. One confirmation, with Cancel selected, names chats where omp or its helpers are still working, chats whose state could not be checked and drafts that closing would discard. Chats then close one at a time, so omp's worktree questions appear one after another. Saved chats are not deleted. Reopen closed chat keeps the last 10 saved chats with their text drafts; attachments are discarded.
- Current chats can be reordered by dragging, with Option+Up and Option+Down (Alt+Up and Alt+Down on Windows and Linux), or with Move up and Move down in a chat's menus. The order is saved, and ⌘1 to ⌘9 (Ctrl+1 to Ctrl+9 on Windows and Linux) follow it. Chats with results you have not opened still show above the others, and a move stays within its group.
- On macOS, Settings → About offers Switch to Homebrew for a copy installed from the disk image when Homebrew is installed. visual-omp can reuse an existing Homebrew copy, adopt an app that matches the published cask version at Homebrew's destination, or install into an empty destination. It checks the result before restarting from the Homebrew copy. It never replaces an app: if the destination contains a different version, update that copy through its existing update flow first. Moving a separate old copy to the Trash is optional. Without Homebrew, About shows how to install it.
- On Windows, Settings → About offers Switch to Scoop for a copy installed with the Windows installer when Scoop is installed. visual-omp closes, and a PowerShell window adds the decoy-dev bucket if needed, installs visual-omp with Scoop or reuses an existing Scoop copy, and checks its executable, install record and version. Only then does it remove the installer copy, keeping saved chats and settings, and open the Scoop copy. If the installation fails, the installer copy stays and opens again; if removing the old copy fails, the Scoop copy opens and the window says what remains.

#### Improved

- Without Scoop, Windows installer copies show a guide to install Scoop and switch by hand. It now asks you to check that the Scoop copy opens with your chats and settings before you uninstall the installer copy.
- Updates, reinstalls and both package-manager switches no longer run at the same time.
- When you cancel quitting, closing a chat or closing all chats, keyboard focus returns to the control you used or its menu button when available. Otherwise, it moves to the main area or New chat.

#### Fixed

- Choosing Auto thinking no longer fails in chats where Auto had already picked an effort. omp shows the effort Auto picks, such as Low, and visual-omp read that effort as the chosen level. The thinking menu showed Low, and choosing Auto moved omp off Auto and reported that omp could not switch to that thinking level. visual-omp now reads the chosen level from omp's own events, so the menu shows Auto when it is set.
- Previews of local files grant cross-origin access only to fonts, which need it. Web pages, stylesheets, images and PDFs no longer receive that permission.

## [0.7.6] - 2026-11-04

visual-omp 0.7.6 makes the omp screen the default on Windows, keeps long chats responsive on macOS and in Linux builds, previews visual outputs as omp makes them and asks before resuming a very large saved chat. It requires omp 18.15.0 or later.

### Highlights

- **New:** Windows chats use the omp screen by default. If a chat does not work with it, the Classic omp terminal switch in Settings → Advanced brings back omp's terminal screen for new chats.
- **New:** Outputs previews images, PDFs, web pages and other visual files while omp makes them.
- **New:** Before omp resumes a saved chat of 32 MiB or more, visual-omp asks whether to resume it, start a new chat or cancel.
- **New:** Change a chat's icon from its row menu.
- **Improved:** The main window loads about 22% less code at startup. Screens and panes that cannot load their code or text now offer Try again.
- **Fixed:** On macOS and in Linux builds, long chats no longer make visual-omp unresponsive while omp works.
- **Fixed:** Chats you start in visual-omp get emoji icons in their titles again.
- **Fixed:** The word you are typing near the right edge of the message box stays visible.

### Detailed changes

#### New

- Before omp resumes a saved chat of 32 MiB or more, visual-omp now asks whether to resume it, start a new chat in the same folder or cancel. Resuming a chat that large can make omp slow or unresponsive, and Stop may not respond.
- Chat row menus now offer Change icon, with a title preview, an emoji field and the operating system's emoji panel where supported. omp saves the icon in the chat title for live and saved chats.
- Outputs now previews supported visual files while omp makes them. Watch opens the current output, and Stop and redirect preserves your draft and attachments while you write a correction. Live previews are on by default; opening Outputs automatically is a separate setting, off by default. A preview whose background tracker or format cannot load offers Try again. Turning previews off and on retries the tracker, and a file update retries its failed format.
- Windows chats now use the omp screen by default, as on macOS and Linux.
- Settings → Advanced now offers a Classic omp terminal switch, off by default, to make new chats use omp's terminal screen if a chat does not work with the omp screen. Open chats keep their view until omp restarts in them.

#### Improved

- visual-omp's main window startup bundle is 22.2% smaller in build measurements, down from 2.04 MB to 1.59 MB. Release notes and several screens and panes now load on demand. Settings stays available at startup, while text for its sections, connected tools and project details loads with those screens or in idle time. Icons retain regular styles and selected additional styles, and saved data checks no longer require the validation library at startup. Pages and panes show loading placeholders; setup shows a blank window, and some dialogs remain hidden until loaded. A part of the window that cannot load its code or text now shows a message with Try again, or stays hidden when it has nothing of its own to show, instead of leaving the window blank.

#### Fixed

- On macOS and in Linux builds, long chats no longer make visual-omp unresponsive while omp works. For each streamed update, visual-omp copied omp's whole screen document, which holds the full transcript, to every part of the window that reads it: up to 1.6 MB per update in a chat of about 1,400 entries. The window fell further behind with every reply, so the elapsed timer, the status bar and new chats stopped responding. visual-omp now sends only the parts that changed, combines streamed frames within a 16 ms batching window, and keeps one shared document per chat in the window. In an isolated development-build measurement of that chat, a six-second reply sent 2.7 MB to the window instead of 295 MB, and the window caught up about a second after the reply ended instead of 26 seconds later.
- Typing near the right edge of a chat's message box no longer hides the word you are typing until the line wraps. When omp offered a word completion that did not fit on the line, the completion carried the typed letters with it onto a line the message box did not show yet.
- Chats you start in visual-omp use emoji icons in their titles again. In chats that use the omp screen, the default on macOS and in Linux builds, omp 18.16 could head a new title with a Nerd Font symbol that the sidebar cannot display, so the row showed the chat's short code and title without an icon. For a chat that already has one of these symbols, choose Change icon in its row menu.
- On macOS, Outputs lists a file once when tools use both `/tmp`, `/var` or `/etc` and their `/private` paths. The newest use supplies the output, and paths keep the chat folder's spelling. Live previews use the same comparison.
- Rename chat now focuses its text field when it opens, so typing starts in the field.

## [0.7.5] - 2026-11-03

visual-omp 0.7.5 opens omp menus in the omp screen and `/btw` answers in the Side questions pane by default on macOS and in Linux builds, and keeps messages omp rejects in the queue. It requires omp 18.15.0 or later.

### Highlights

- **New:** On macOS and in Linux builds, omp menus open in the omp screen, and `/btw` answers appear in the Side questions pane by default.
- **New:** A Suggestions switch below the composer turns omp's next-message suggestions on or off.
- **New:** Shell tool cards show which omp filter changed a command's output.
- **Fixed:** Messages omp rejects before starting a turn stay in the queue with omp's error, instead of being added to your next message.
- **Fixed:** Shell and Python runs you start with `!` or `$` appear in chats with their output open.
- **Fixed:** Background-job waits end when the last job stops, so queued messages continue.

### Detailed changes

#### New

- Expanded shell tool cards now show which omp filter changed a command's output and its byte sizes before and after filtering, when omp records them.
- App-hosted chats now use omp's Tern Surface Protocol (TSP) by default on macOS and Linux. omp menus open in the omp screen, and `/btw` answers appear in the Side questions pane. Windows keeps the classic presentation.
- A Suggestions switch below the composer saves your next-message suggestion preference to omp's global settings. Suggestions remain off by default, and project-specific settings still take precedence. Each suggestion sends an extra request containing the full conversation to the chat's model, which counts toward usage.

#### Fixed

- A background check no longer leaves a lasting “TUI debug text timed out” error at the top of a chat when omp is slow to respond, including while reopening a long chat.
- Saved chats now show the model's name in the composer, as live chats do, instead of its provider and model id.
- Background jobs from before a chat's omp restarted no longer show as running in Tasks and the chat header.
- Rewinding to an earlier message of yours now hides the later messages right away, instead of showing the whole chat until the next reply.
- Background-job waits now end when the last job is cancelled or finishes without another reply, allowing queued messages to continue.
- Shell and Python runs started with `!` or `$` now appear in live and saved chats with their source, execution status and output expanded by default in every transcript view. Long results show a bounded preview, with controls to reveal the remaining lines or fold the entire output.
- An image omp can't read is no longer sent as its file path in classic chats. After the message box is restored, the message stays queued with its images and omp's error until you retry or remove it.
- Closing a chat on Windows now releases its terminal worker and JavaScript pipe connections, preventing those resources from accumulating across chats.
- Settings > Providers now offers Sign out for stored API-key credentials from providers without usage reporting.
- GitHub workflow watches now distinguish pending jobs from unknown states and label job statuses for screen readers.
- Command results in classic chats now omit execution status lines and wait for running commands to finish.
- Plugin failure messages now omit leading `[!!]` and `[-]` markers.
- Messages omp rejects before starting a turn remain in the queue with their original text, images and omp's diagnostic, so they can be retried or removed without being appended to the next message.

## [0.7.4] - 2026-11-02

visual-omp 0.7.4 fixes model and thinking changes in chats, adds fallback model settings and a grouped model menu, and lets you send a message while omp waits on a question. It requires omp 18.15.0 or later.

### Highlights

- **New:** Edit fallback models for each role in Settings › Models & roles.
- **New:** The model menu groups models by provider and family.
- **New:** Send a message while omp waits on a question, and queue compaction while omp works.
- **New:** The transcript shows when each message, thinking step and action happened.
- **New:** The status bar shows how much CPU and memory visual-omp uses.
- **Changed:** visual-omp now requires omp 18.15.0 or later.
- **Fixed:** Model and thinking changes no longer fail with a warning that an omp menu is open.

### Detailed changes

#### New

- Models & roles now lets you edit ordered fallback models, their thinking levels and when omp switches or returns to the main model.
- Background jobs now show what they are for, and Tasks shows omp's one-line captions when available.
- You can send a message instead of answering an ask question. omp closes the question and continues with your message.
- You can queue compaction while omp works, then edit or remove it from the message queue.
- The status bar shows visual-omp CPU and memory usage, with a short CPU history and details about which app processes are counted.
- The model menu groups choices by provider and model family. Expand a family to pick an exact version, or search across all versions.
- Transcript messages, thinking and actions now show recorded times, with dates for earlier entries and full timestamps available on hover.

#### Changed

- visual-omp now requires omp 18.15.0 or later. An older omp opens setup with instructions for updating it.

#### Fixed

- Fixed model and thinking changes failing with an incorrect warning that an omp menu was open.
- File names in omp's replies that start with the chat folder's own name, such as `Sheets/overview.pdf` in a chat whose folder is `Sheets`, now become file links when the referenced file exists in that folder.
- Table charts now exclude ratio and speedup columns when the values identify them as quotients of two other measurements.
- Plan proposals no longer show a stray “Stopped” notice with omp's internal marker text in the transcript.

## [0.7.3] - 2026-10-30

visual-omp 0.7.3 adds sidebar sorting, a live overview of each project's chats and a Close split view button, and keeps long links inside your message bubbles.

### Highlights

- **New:** Sort the sidebar by recent activity, name or creation date, with or without project groups.
- **New:** Project overviews show which chats are waiting for you, which are working and which have new results.
- **New:** Split view has a **Close split view** button in both chat headers.
- **Fixed:** Long links and paths in your messages wrap inside the message bubble.

### Detailed changes

#### New

- The sidebar can sort projects and chats by recent activity, name or creation date. Use the sort button beside **Projects** to choose an order, and turn **Group by project** off to list non-archived chats together across projects. Both settings are saved.
- Project overviews now group chats by waiting, working, new results and recent history, with live activity summaries and keyboard-accessible rows.
- Both chat headers in split view now have a **Close split view** button. It keeps the chat you clicked at full width, and the other chat stays open in Current chats with its draft and side panel.

#### Fixed

- Long links and paths in your messages now wrap inside the message bubble instead of running past its edge.

## [0.7.2] - 2026-10-30

visual-omp 0.7.2 fixes Copy actions, which failed with a clipboard permission error in 0.7.0 and 0.7.1.

### Highlights

- **Fixed:** Copy buttons and copy menu items work again.

### Detailed changes

#### Fixed

- Copy actions no longer fail with a clipboard permission error, which began in 0.7.0. Clipboard writes are restricted to the app's main document, and clipboard reads remain blocked.

## [0.7.1] - 2026-10-30

visual-omp 0.7.1 lets you return to an earlier version or reinstall the current one, shows chat status as icons, and displays only the latest idle recap.

### Highlights

- **New:** Install an earlier version from the release notes, or reinstall the current one from **Settings → About**.
- **Improved:** Chats show their status as icons with distinct shapes instead of dots.
- **Changed:** Installed copies send their version, platform and architecture once per fresh update check. The project's collector stores daily totals without IP addresses or identifiers.
- **Fixed:** A chat shows only the latest idle recap, and helper cards no longer repeat their status beneath them.

### Detailed changes

#### New

- You can return to an earlier visual-omp version from its release notes: open **Settings → About → Read release notes → Past versions**, choose an earlier release and select **Install v{version}**. The installer comes from the official GitHub release through the same checked download path as updates, and your chats and omp settings stay as they are. Homebrew and Scoop installs show the package manager's downgrade steps instead. From 0.7.1 onward, automatic update checks skip releases through the version you left until a newer release is available. **Check for updates** includes skipped versions without clearing that choice. Versions before 0.7.1 still offer the newer update, which you can leave uninstalled.
- **Settings → About** now offers reinstalling visual-omp. Disk-image and Windows installer copies download the running version from its official GitHub release through the existing checked download path, preserving saved chats, omp settings and skipped updates. Homebrew and Scoop copies show package-manager commands, which may install a newer version. If that version exceeds the saved update skip, the usual startup check clears it.

#### Improved

- Chat status marks in the sidebar, Home, project overviews and the chat header are now icons with distinct shapes: a spinning notch while omp works, a pulsing robot while only its helpers work, a question mark while it waits for you, an X for an error and a power symbol for an open chat with omp running. Saved chats, and inactive open chats under Current chats, show a small faint history clock. Unopened finished results on inactive chats show blue double checks; unanswered questions keep the question mark, and active chats retain their status icon with a blue badge.

#### Changed

- Packaged builds of visual-omp now send the app version, platform and architecture once per fresh update check. The collector stores daily update-check totals without IP addresses or identifiers; these totals cannot identify unique installations. Development builds and tests send nothing, and failed counting requests do not delay or interrupt updates. See Updating in the README.

#### Fixed

- A chat shows only omp's latest idle recap, and hides it once a newer message arrives. Opening the terminal sheet no longer fills the end of the transcript with every earlier recap.
- Helper cards in the Tasks pane show each helper's task name instead of its agent type, and no longer repeat the helper's status and counters in a block beneath the card. Charts that a task's widget draws still appear under its card.

## [0.7.0] - 2026-10-29

visual-omp 0.7 is the first beta release, adding native reply rendering, session controls and settings for omp 18.14. It requires omp 18.14 or later. Versions before 0.7 were alpha releases.

### Highlights

- **New:** A first-run setup assembles a miniature of the app as you install omp, sign in to providers, choose a default model, set permissions and pick an appearance, then grows it into the app.
- **Changed:** visual-omp now requires omp 18.14 or later, and the setup screen can update omp for you.
- **New:** Replies show omp's interim updates, SVG and Mermaid diagrams, and charts under numeric tables.
- **New:** You can read release notes before installing an update and browse earlier versions.
- **New:** The Tasks pane can stop background jobs, shows helpers' progress and draws job charts.
- **New:** The Changes pane keeps earlier commits below your uncommitted edits, so you can review a commit's changes after it is made.
- **New:** Saved chats can be renamed, pinned, moved to another computer and exported as an anonymized copy.
- **New:** Settings include a native Advisor sheet, restricted folders, per-model compaction limits and more of omp's options.
- **Improved:** The message box offers word suggestions, approval cards offer Deny and say why, and an interrupted chat can continue where omp stopped.
- **Security:** Tool lookup, MCP project servers, update downloads and the packaged app are hardened.

### Detailed changes

#### Changed

- visual-omp now requires omp 18.14.0 or later. If an older version is installed, choose **Update omp** on the setup screen to run omp's updater and read its output without opening a terminal. Setup cannot advance past installation until the detected version meets the requirement. omp discovery ignores relative PATH entries and resolves an explicit executable path before checking its version, so a project folder cannot supply a different omp.
- Chats that visual-omp runs now follow your omp settings for interim replies, SVG, next-message predictions, idle recaps and worktree exit choices, because the app now shows each of them natively. Tables are charted with omp's local rules only, which avoid extra model requests. Automatic worktree creation at startup stays off, because omp 18.14 does not report when a starting chat is ready for input.
- Installation guidance now recommends Homebrew on macOS and Scoop on Windows, with the direct installers as alternatives.

#### New

- The Changes pane now includes commit history below uncommitted edits, so earlier changes remain available after a commit. Each row shows the subject, author, date, short commit ID and line totals, and **Show more** loads older commits. Selecting a commit opens a read-only diff against its first parent, or the empty tree for the first commit in a repository. Discard, line comments and **Review code** apply only to uncommitted changes. New commits appear without reopening the pane.
- A first-run setup guides new users through provider sign-in and default-model selection, then adds permissions and app appearance. It opens and finishes on ink covers with an animated periscope mark. Each step in between pairs its controls with a miniature app that shows installation status, the detected omp version, connected providers, the selected model and the permission mode as you choose them, and progress ticks show completed, current and remaining steps. Appearance choices preview in the miniature first, then in the window. **Start chatting** saves setup, expands the miniature into the app and moves keyboard focus there before the tour begins; with reduced motion this is a short crossfade. Narrow windows hide the miniature and keep the controls. When omp is missing or too old, setup offers its official installer or updater with output shown in the window. Managed installations direct you to the application responsible for updates. Provider sign-in uses `omp login`; model and permission choices are saved globally. The permission step keeps a mode you already chose and suggests Ask me first only when omp is still on its default. Provider sign-in and model selection can be skipped. Existing users see only installation recovery when omp is missing, unsupported or refused by the operating system. **Run setup again** is available from Help and the command palette. visual-omp leaves omp's setup-completion setting unchanged, preserving its terminal setup for glyph, composer and theme choices.
- Interim replies that omp writes to `out://`, including shell redirects, appear as assistant text while omp keeps working. They use reply pacing and screen-reader announcements, stay in saved chats and helper conversations, and never count as file changes.
- Replies and SVG or Mermaid file previews show theme-aware figures and diagrams, with the source available. Numeric Markdown tables get a chart beneath them, drawn with omp's own chart rules, and the table stays as it was. Diagram images expose their titles and descriptions to screen readers and scroll sideways at narrow widths instead of shrinking.
- Python cards show tables, expandable JSON fields and Markdown from omp's cell views. Submit Result cards show the submitted section and fields with omp's rejection reason. Running MCP tools show the progress the server reports. Read cards show jq filters separately from the file path and keep JSON highlighting. Large results open with a first page and controls to reveal more.
- The Tasks pane shows helpers' current stages and completion estimates, nests their background jobs beneath them and shows job folders when known. **Stop** and **Stop all** use omp's own job commands, even while a turn is busy. Job widgets include full charts with trend directions, targets and a data table for screen readers. When omp waits for background jobs, the chat stays active and offers **Stop waiting**.
- You can read release notes before installing an update, from the update notice or Settings › About, including every version between yours and the new one. A version selector shows earlier notes, and the bundled changelog keeps them available offline.
- Saved chats can be renamed from the sidebar without opening them. Pins use omp's shared pin file, and existing pins move over automatically. Share can save a chat archive for another computer, import an archive into a chosen folder and export an anonymized copy.
- Conversations that omp continued in another file appear once in chat lists and search, and saved history follows the newest copy. Deleting such a chat checks that no other omp process owns any of its files before moving them all to the system trash.
- **Configure advisors** opens a native sheet for advisor models, tools, instructions, review cadence and catch-up policy. Changes keep comments and unknown fields in omp's files and can be applied to a ready chat without restarting it.
- Settings › Permissions has a restricted folders list and a policy for omp's computer control. Models & roles adds the Job widgets role, marks the active saved preset, labels free models and sets per-model compaction limits with a preview of when compaction starts. The Instructions page lists and edits the extra instruction files omp is configured to read.
- Usage & limits shows each account's routing priority, reserve and state in omp's window order. Saved resets are listed through omp's command line and spent with a clear result. Providers can export and import sign-ins through omp. Connected tools can sign in to OAuth servers through omp. npm and git plugins offer **Update**.
- **Continue where omp stopped** restarts an interrupted chat with omp's restore option. The chat follows omp's folder and worktree moves, and worktree exit questions use native dialogs. Startup model substitutions and idle recaps appear in the transcript.
- The omp terminal uses the active omp theme's colours.

#### Improved

- The message box shows omp's word suggestions as ghost text, and Tab inserts one without sending. Next-message predictions appear the same way when you turn them on in omp; they stay off by default because omp bills an extra request for each.
- Approval cards offer **Deny and say why**, which sends your explanation with the denial. The card always explains that sending a message denies the pending request.
- Dictation shows **Starting…** until omp reports that recording has started, and stopping during startup cancels it.
- File commands marked `side: true` show their answers in the terminal sheet, like `/btw`.
- Plan, vibe, goal and loop controls read and change omp's modes directly instead of reading the status line.
- Forking a chat copies it in a separate omp process, so the original chat keeps its place. Saved chats check omp's own session ownership before the app's process checks.
- Closing a chat no longer sends further queued input, and asks before interrupting a slow shutdown or a worktree cleanup.

#### Security

- Tools such as git are found only through absolute PATH entries, so a project folder cannot supply its own copy.
- MCP servers defined by a project run only after you choose to check or sign in to that server and confirm. Provider status checks and sign-in transfers run outside project folders. The Stats dashboard opens only on this computer's own addresses.
- Remote images in replies and tool results load only when you choose **Load image**. Mermaid diagrams that reference images or external styles show their source instead.
- Custom sharing servers need confirmation, with both addresses shown, before a chat is shared.
- Downloaded installers must match the SHA-256 checksum GitHub publishes for them.
- The packaged app turns off Electron features that let other programs run code inside it, and app requests from anywhere other than its own window are refused.
- Release builds use narrower permissions and pinned actions, and dependencies are updated to clear known vulnerabilities.

## [0.6.8] - 2026-10-29

visual-omp 0.6.8 warns you when omp switches to a fallback model and fixes several problems with newer omp versions.

### Highlights

- **New:** The chat shows a warning when omp falls back to another model.
- **Fixed:** Permission settings load again when omp uses Ask and remember, and approval cards keep one-time approval as the main choice.
- **Fixed:** Claude Opus 5.5 narration between steps appears as reply text instead of hidden thinking.
- **Fixed:** Finished background commands no longer show as running.
- **Improved:** Startup failures now show recognized error messages from omp.
- **Changed:** Chats that visual-omp runs turn off omp features the app cannot display yet, such as interim replies, charts and predictions.

### Detailed changes

#### New

- When omp records a model fallback, the chat now shows a warning at the switch, naming the destination and the source model when recorded. It quotes an error only when omp explicitly ties that error to the model recovery. Provider-reported fallbacks within a reply also show a warning. Screen readers announce each new switch once; loaded history and reconnect snapshots stay silent, and saving a streamed fallback does not repeat its announcement. The model button beneath the message box marks the fallback model with **Fallback**, and its tooltip names the original model when recorded. Replies from a different model receive their own header. Manual model switches and account rotation within the same provider keep their existing presentation. omp does not include the fallback reason in saved model changes or send its reason-bearing fallback event through the connection visual-omp uses, so the warning includes a reason only when an explicitly attributed error provides one.

#### Improved

- When omp fails during startup, the banner now shows recognized error messages, such as a missing saved chat file or an unavailable model, limited to eight lines and 1,200 characters. When omp reports that the requested saved chat file is missing, **Start a fresh chat** opens a new chat in the same folder instead of retrying the missing file.
- The slash command list now includes omp 18.14's command updates while retaining commands supported by older versions. It adds `/local` and `/forget-approvals`, and `/subagents` now opens the Tasks pane like `/hub`. The `/context` description and command guide now reflect omp's read-only context viewer, shown in the terminal sheet on newer versions. Older versions continue to show a report in the chat.
- Helper definitions now follow omp 18.11's rules. The helper editor no longer shows an empty or malformed tool list as access to every tool, visual-omp no longer adds `yield` to the tools it reads, and editing or duplicating a helper keeps its `structured` setting and output schema. A new **Return structured results** switch sets `structured` for omp 18.11 or later. The editor notes that earlier omp versions may treat malformed tool lists as default tools and add `yield`.

#### Fixed

- Permission settings now work with omp's **Ask and remember** mode (omp 18.12.3 or later). Previously, choosing that mode in omp stopped the permission button beneath the message box and the permission settings from loading. Settings, project settings and the permission button now offer **Ask and remember** when the installed omp supports it, and Settings › Permissions can forget remembered approvals through omp's own command. A permission mode the app does not recognize is shown with an explanation and left unchanged.
- Approval cards now recognize omp's broader approval choices, such as approving a tool for the rest of the session or approving a whole file or folder. One-time approval stays the main action and keeps keyboard focus, and broader approvals appear as separate buttons with omp's exact wording. Previously these requests appeared as a general question whose preselected answer could approve a whole folder. With omp 18.11 or later, the card also explains that sending a message denies the pending request.
- With Claude Opus 5.5, text that omp marks as narration between tool calls now appears as reply text instead of folded thinking, in every transcript view and in helper conversations. It also receives file links, reply pacing and screen-reader announcements, and the activity label shows writing while it streams.
- Background commands no longer appear to keep running after they finish. Since omp 18.10.2, a command sent to the background keeps reporting after its tool card settles, and those late reports marked finished jobs as running. The Tasks pane now shows the state omp reports, its count and the Tasks button in the chat header count only running jobs, and late output no longer counts as foreground activity. Cancelled background commands show a neutral badge instead of a green one.
- Saved, followed and live chats now preserve omp's current branch when a late result or usage record names a different active leaf (omp 18.12.4 or later). The session tree uses the same rule for its current marker and navigation order. The session index now skips symbolic links to project session folders, preventing duplicate chat listings.
- When omp reports that another app, such as Tern, manages its installation, the omp row in Settings › About now names that app with **Managed by** and offers no **Update omp** button. Previously, the update check reported that it could not recognize omp's output.

#### Changed

- Chats that visual-omp runs now disable interim replies written to `out://` and stop advertising SVG pictures and table charts that the app cannot display yet. They also disable next-message predictions and idle recaps, avoiding extra model requests for results the app does not display. Automatic worktree creation is disabled at startup, and existing worktrees are kept at exit, so startup cannot move the chat to an unsupported folder and shutdown does not wait for an unseen worktree question. These settings apply only to chats the app runs; separately launched terminal sessions are unaffected.
- Chats opened directly in your home folder or in a shared temporary folder such as `/tmp` no longer offer project helpers or project skill installs. visual-omp applies omp 18.11's helper and skill discovery limits across all supported omp versions, including older versions that may load definitions from those folders. Subfolders keep project scope.

## [0.6.7] - 2026-10-29

visual-omp 0.6.7 adds Up and Down message recall and opens the terminal for /btw answers in visible chats.

- In a chat's message box, Up recalls earlier messages and commands, newest first, and Down moves toward newer ones. Up works from the first visible line and Down from the last, so you can still move through a longer message. Down past the newest entry, or Escape while browsing history, restores your unfinished draft with its attachments. Editing a recalled message makes it your new draft; sending submits the text shown. Shell and Python modes recall their own commands.
- Sending a `/btw` question now opens omp's terminal sheet when its chat is visible and no terminal is already open, including when you choose **Send now** for a queued question. The answer appears in the terminal, and the sheet stays open until you close it. For a background chat, return to that chat and open its omp terminal to read the answer. If a queued question cannot be sent, it stays in the queue and a notification explains why.
- Tables in chats now preserve ordinary word widths when sizing columns, avoiding splits such as "Col / our". Long headers can wrap to leave more room for other columns. Links and inline code can still wrap within a word, while long unbroken plain text can make the table scroll sideways.
- File names shortened with "…", such as `comparison_portrait_desynth_….png`, can now become links when exactly one file or folder matches in the first matching folder. The link keeps the shortened text, while its tooltip and **Copy path** show the full path. If that folder contains multiple matches, the shortened name stays plain text.
- On macOS, Settings › Sounds & alerts now includes help for a missing Dock count: open System Settings › Notifications › visual-omp and turn on Allow notifications and Badge application icon.
- On macOS, releases now use the project's own self-signed certificate. This is meant to preserve permissions you grant visual-omp in System Settings, such as App Management for updates through Homebrew, but that has not yet been confirmed through an installed update. You may need to grant those permissions once more after installing this version. Releases remain unnotarized by Apple.

## [0.6.6] - 2026-10-27

visual-omp 0.6.6 marks unopened chats with a blue dot, so they stand apart from open chats.

- Unopened chats are now marked with a blue dot instead of a teal one, so they stand apart from the green dot of an open chat in Current chats, the project lists, Home and project overviews.

## [0.6.5] - 2026-10-27

visual-omp 0.6.5 counts chats with unopened results on the app icon and lists them first in Current chats.

- When a chat finishes its main reply or needs your answer while it is not shown in the focused window, it now counts as having an unopened result. This includes results received while the window is in the background or minimized, while you view another chat, Home, a page or a project overview, or while an expanded side panel covers the chat. Each chat counts once. Showing it in either split pane with the window focused clears its mark and count; closing its tab removes them too. Focusing the window on another chat or Home preserves the remaining count. The macOS Dock badge and Windows taskbar overlay show the count while you work in other chats; Windows displays 9+ above nine. In Current chats, unopened results appear first with teal marks and stronger titles, with a divider between unopened and viewed chats when both groups are present. Chat rows in the Projects tree, Home's recent chats and project overviews use the same marks. Unopened results persist with restored chats after restarting visual-omp. The count remains enabled when **Alert me in the background** (Settings → Sounds & alerts) is off. That setting controls background notification banners and the Dock bounce or taskbar flash. Notification banners remain unavailable in the current macOS build.

## [0.6.4] - 2026-10-26

visual-omp 0.6.4 starts chats from the New chat button and Home in the temporary folder instead of the last project you used.

- **New chat** in the sidebar now always starts in `/tmp` on macOS and Linux, or the system temporary folder on Windows, instead of the last project you used, and it no longer shows ⌘N. The message box on Home starts there too. You can still pick another folder on Home, and an unfinished Home message keeps the folder you picked when you leave and come back; once the chat starts, Home goes back to the temporary folder. ⌘N (Ctrl+N on Windows) and File > New Chat keep using the project of the chat or project overview you have open, and start in the temporary folder from Home and other pages. **New chat here** on a project, the project overview and `/new` keep their project. Choosing a folder on Home no longer changes the project shown in the sidebar and status bar.

## [0.6.3] - 2026-10-23

visual-omp 0.6.3 adds right-click menus for links, files, paths, images and text throughout the app.

- Right-click links in chats and side panels to choose Open in browser or Copy link. In project chats, links to localhost or 127.0.0.1 also offer Open in Preview pane. Each chat now keeps its own Preview browsing history.
- Right-click files and folders in chats, tool steps, file-change summaries and side panels to open them, reveal them in Finder or Windows File Explorer, or copy their paths. Project menus also offer Mention in chat, and paths inside the project offer Copy relative path. File-change summaries and Changes rows offer Show changes. Copy path now copies the full absolute path, including in the Files pane.
- Right-click images, including attached screenshots and images in Files and Outputs, to choose Copy image or Save image as…. Images with a backing file also offer Open with default app, a reveal action and Copy path.
- Files also offer Open with default app. Opening other file types, including SVG, requires confirmation; supported raster images and PDFs that pass the file checks open directly. The confirmation warns that opening a file outside visual-omp may run code.
- Open a focused link, file or image menu with Shift+F10 or the context-menu key. Right-clicking within selected text keeps the text menu.
- Text fields now have native right-click menus for editing and spelling corrections, including Delete on Windows and Add to dictionary for a misspelled word. Selected chat text offers Copy, with Look up available on macOS. Shell commands, paths and other code-like fields keep spellchecking disabled.

## [0.6.2] - 2026-10-22

visual-omp 0.6.2 brings a chat to its latest messages when you send one, even if you had scrolled up.

- Sending a message now brings the latest messages into view and keeps the chat following the reply. This applies when you send directly to omp: Enter or the send button while omp is idle, **Send now** from the composer or queue tray, a slash command omp runs, or a shell or Python line. Your first message also brings the chat to the end while omp is starting. Otherwise, adding messages to the queue does not bring the chat to the end. Automatic queue delivery and activity from other sources leave your position unchanged while you are scrolled up; new chat activity shows **Show new activity**. Sending and selecting **Show new activity** use the same short scroll to the bottom, or move there immediately with reduced motion. Scrolling up stops the movement and automatic following.

## [0.6.1] - 2026-10-22

visual-omp 0.6.1 stops long chats flickering at the top and gives each chat its own side panel. It also removes the blank space under messages sent with images, smooths collapsing sections and shows finished helpers as done. A chat keeps its spinning ring while its helpers work, and the quit and close-chat warnings now include working helpers.

- Long chats no longer flicker at the top. When the latest messages in a chat fit on about one screen, which happens often after long runs of tool calls, the transcript kept loading the earlier messages and dropping them again. The top rows, the "Show N earlier messages" count and the scrollbar changed many times a second, and a reply streaming in could stop following. The chat now loads earlier messages only after you scroll away from the bottom. It returns to the latest ones when you scroll back to the end or choose "Show new activity". Loading earlier messages keeps the message you are reading in place. With reduced motion on, layout changes take effect immediately.
- Each chat now keeps its own side panel. Whether the panel is open, which pane it shows (Changes, Files, Tasks and the rest) and how wide you dragged it belong to the chat you set them in, so opening Tasks in one chat no longer opens it in every other chat. A chat where you never opened the panel shows it closed. File links, Review changes, Show more in Tasks and new terminals open in the panel of the chat they came from, even if you have moved to another chat by the time a terminal starts. The Files pane keeps its open files and folders separately for each chat. When you switch chats, the previous chat's pane fades out and the new chat's pane fades in. A chat you only viewed stays in Current chats while its panel is open or its width differs from the default. Your chats come back with their panels after a restart, and Reopen closed chat restores the panel along with your unsent text. After updating, chats you already had open start with the panel closed.
- A message sent with images no longer ends in a block of empty space. The transcript turned each attached image into a blank line under the text, so five images left five empty lines inside the message, and Copy carried them too. Rewinding or forking a message now preserves the line breaks between its text blocks when placing it back in the composer.
- Collapsing thinking, a group of tool calls or a single step now runs smoothly. Previously, the fading content was drawn over the rows moving up beneath it, and a step collapsed near the end of the chat could make the view jump by the step's full height before it closed. The same fix applies to every section that opens and closes, including the queue tray, the Files pane, Usage & limits and the pinned helpers. Reduced motion keeps its instant open and fade.
- Helpers that finished their work now show "Done" in the Tasks pane, on their card in the chat and in the task row, even while omp keeps them ready for a follow-up message. They keep their Message button, and a helper that gets a message shows as working again. The Helpers section lists the running helpers, then the three latest finished ones and any older helper that failed, and "Show N earlier helpers" opens the rest, so a long run of helpers no longer fills the pane with "Waiting" cards. When omp is no longer running for a chat, a helper that had finished stays "Done" instead of turning into "Stopped".
- A chat whose reply has ended now keeps the spinning ring in the sidebar, the chat header and the overviews while any of its helpers is still working, with the label "omp's helpers are working". The chat header says "Helpers are working. omp is ready for your next message." The "Finished" notification still arrives when omp's reply ends. Finished helpers and background jobs, such as a dev server, don't keep the ring spinning.
- Quitting visual-omp or closing a chat now warns about working helpers as well as omp's reply. The warning describes the work running when you chose to quit or close. The quit warning lists chats with running or unchecked work and updates their status as work ends, showing "No work running" while it waits for your answer. If visual-omp cannot check a chat within 5 seconds, it lists that chat as "Not checked" and asks before quitting, even if you selected "Always stop working chats when quitting". That preference now applies only to quitting. Closing one chat leaves any pending quit awaiting its own confirmation. On macOS, choosing Quit after closing the window reopens it when omp is still running so visual-omp can check whether a warning is needed.

## [0.6.0] - 2026-10-21

visual-omp 0.6.0 installs and updates through Scoop on Windows and reworks how the chat shows omp at work. In Normal view, consecutive tool calls share a row as they run and thinking shows as omp writes it; running helpers stay pinned above the message box, and Usage & limits lets you spend saved rate-limit resets.

- visual-omp can now be installed on Windows with Scoop, and a copy installed that way updates without the setup wizard. **Update and restart** in the update window closes visual-omp, runs `scoop update visual-omp` in a PowerShell window and opens visual-omp again when Scoop finishes. If Scoop didn't install a newer version, or visual-omp couldn't start, the window stays open with Scoop's output, and the next launch says whether the update took. For installation commands, see "visual-omp on Windows (Scoop)" in the README. A copy Scoop installed for all users needs an administrator to update, so its update window shows the command to run instead of running it.
- Copies installed with the Windows installer suggest Scoop at the end of their update window, from the update after this one. A link there shows the steps to switch: install Scoop, run three commands in PowerShell, then uninstall the installer's copy. Both copies use the same profile folder, so chats and settings stay. To switch now, follow "visual-omp on Windows (Scoop)" in the README.
- Scoop installs for one user can now show Windows notifications, subject to the Windows notification settings. Notifications remain unavailable for Scoop installs for all users.
- visual-omp checks for new versions of itself and of omp about ten seconds after it opens and every 30 minutes while it stays open. It used to reuse a saved result for up to six hours, even across restarts, so a new release could go unnoticed for up to six hours.
- The message box in a chat now spans the full width of its card. ＋, the microphone and the send, stop, **Send now** and **Queue message** buttons moved to a row under the text, so while omp works the text no longer shares its line with three buttons and wraps at half the width. The prompt box on Home uses the same layout.
- In Normal view, omp's tool calls go straight into the collapsed "tool calls" row from the moment each call appears, so a call no longer shows as its own row and then folds away. A single call gets a "1 tool call" row as well, so it stays grouped when the turn ends. While a call in it runs, the row takes the running look of a tool row, reads "Working for 14s" with the time counting up, and its count grows as calls arrive. Opening it shows each step, including a running command's output, and it stays open when the reply is saved. The previous turn's file-change summary also stays visible after you send the next message, where it used to disappear until omp replied.
- A new setting, **Settings → General → Show thinking as omp thinks** (on by default), keeps the thought omp is writing open in Normal view, so you can follow it as it streams, and folds it once omp moves on to a step or a reply. A thought you open or close yourself keeps that choice after the reply is saved and after it moves into the tool calls row. The Transcript view setting now describes each view more accurately; the Thinking and Verbose views are unchanged.
- While omp's helpers are working, they stay in view in a compact strip pinned at the bottom of the chat, just above the working line, instead of scrolling away with the conversation. Each running helper gets one row with a status mark, its name, what it is doing now, its tool-call count, a live run time and a Stop button, and clicking a helper that has a conversation opens it. Up to three helpers show there, and "Show N more in Tasks" opens the Tasks pane for the rest. While a helper is in the strip, its card is left out from under its task call, so it never appears twice. When it finishes, fails, stops or starts waiting, it leaves the strip, keyboard focus moves to the next row or the message box, and its card returns under its task call, where later messages move it up and out of view as usual. Expanding sections also keep their correct height when Reduce motion is switched on or off while they are open.
- A working helper's run time in the Tasks pane and under its task call now updates each second, including while it waits for a model reply. Previously the time stayed at the last progress report. Waiting and finished helpers, and durations read from the transcript, keep their reported values.
- The working line above the message box and the "Worked for" line count hours once a turn passes an hour, for example "1h 02m", where they used to show "62m 10s".
- The chat's scrollbar no longer flashes as the transcript changes height. On macOS, overlay scrollbars appeared while the chat followed new content, for example after a question was answered or the working line opened, and faded about a second later. visual-omp now styles its scrollbars itself, so the thin scrollbar stays visible while the content overflows and uses the theme's colors in light and dark. Scrolling with the wheel, the keyboard and the thumb works as before. The chat also keeps room for the scrollbar on both sides, so its column keeps its width and stays centered over the message box.
- Pressing Enter or **Queue message** now always adds the message to the end of the queue while omp is busy, including messages with images and slash commands that omp runs. Previously a message with pasted screenshots went to omp at once in the middle of its reply, and a message sent just as the queue emptied could reach omp immediately as well. Busy covers omp starting or working, messages already waiting, a message omp has not yet acknowledged, a slash command still being typed or watched for its result, and omp's own full-screen menu being open. Only **Send now** delivers at once. Queued messages keep their images, show an image count in the queue tray, and go out one at a time: each waits until omp starts a turn for the one before, or for a shell or Python line until that line's result arrives. A message that fails to send stays in its place in the queue, and a failed **Send message now** explains why in a notification. If a message's images reached omp but its text did not, visual-omp stops typing into omp, because the next message would carry those images, and the queue tray offers **Restart omp**; after the restart the queue continues and that message goes out with its images attached once. A message made only of images is now submitted as well.
- Usage & limits shows the rate-limit resets that Codex and Claude accounts have saved: the count beside the provider, a warning when one expires within a day, and the soonest expiry on each account. A reset can be spent from the account after a confirmation that names omp's stored sign-in and its exact target. visual-omp runs omp's own `/usage reset` in a separate omp process, so no chat needs to be open, and it refuses to spend when it can't read omp's list of accounts in full or no single sign-in matches the account's email and organization. The dialog shows omp's reply word for word; when omp doesn't confirm the result, it says so and asks you to check the account before trying again. It then refreshes the limits and says whether that worked.
- The status bar keeps every provider it has shown since the window opened, so a Codex helper's plan usage stays in view after its task ends. Those providers come after the ones the focused chat uses now, and the list starts fresh when visual-omp quits or the window reloads. The status bar also folds its labels before they reach the project name.

## [0.5.9] - 2026-10-20

visual-omp 0.5.9 connects to chats on Windows when omp was installed with Bun.

- On Windows, a chat no longer stays at "Starting omp…" when omp was installed with `bun install -g`. That install starts omp through Bun's `omp.exe` launcher, which runs omp in a second process, and visual-omp looked for the chat only under the launcher's process. omp's terminal worked in the terminal sheet, but the chat never connected. visual-omp now recognizes the chat by its room on the app's own relay, so it finds the chat in either process.

## [0.5.8] - 2026-10-20

visual-omp 0.5.8 makes the teal behind Back in the sidebar a little darker.

- The teal that fills the top of the sidebar behind the app name and **Back** while Settings, Usage & limits, Help or a project page is open is a little darker, so the white text on it stands out more.

## [0.5.7] - 2026-10-20

visual-omp 0.5.7 folds the steps omp has finished into one row while it works, and says in plain words what it is doing.

- While omp works, the steps it has finished fold into one row as it goes, such as "Worked for 1m 12s · 14 tool calls", instead of filling the chat with a line per command and file. The step still running stays in view below it, and clicking the row opens every step. A step or group you have opened, or moved into with the keyboard, stays where it is until you close it and move on. Finished replies already folded their steps this way. Choose Thinking or Verbose in the chat's **⋯** menu to see every step as its own row.
- The line above the chat box now says what kind of work omp is doing, such as "Working… 1m 17s · Running commands", "Reading files" or "Writing a reply", instead of the full command it is running.

## [0.5.6] - 2026-10-20

visual-omp 0.5.6 opens on a new Home screen, shows your omp activity as a grid of days, and lets you give each project a folder color.

- visual-omp now opens on **Home**, and the new Home button at the left of the title bar (⇧⌘H, or View → Home) brings you back to it. Home asks "What should we work on?" above a message box that starts a chat in any project, with the same choices as a new chat: the project folder, the permission level, the model, the thinking level and attached files. A model or thinking level you pick there applies to that new chat only. Below it, side by side in a wide window, are cards with your latest chats across every project, your projects with their folder colors, and your plan limits with the estimated API cost of the last 7 days, linking to Usage & limits. A quiet field of dots renders behind it, and every few seconds a sonar ping sweeps across it in teal; it holds still when reduced motion is on, and pauses once the window has been in the background for 10 seconds. Your open chats still come back in the sidebar after a restart, and closing the last one returns you to Home.
- Usage & limits and Home show your activity as a grid of days, like the contribution graph on a GitHub profile. Each square is one day, in a stronger teal the more requests omp made to a model that day. The shades compare the days the grid shows, so the busiest quarter of those active days has the strongest teal, and a day can have a different shade on Home than on Usage & limits. Usage & limits shows the last year, and Home shows as many recent weeks as its usage card fits. Point at a day, or move between days with the arrow keys, to see its date, requests and estimated API cost.
- Projects can have a folder color. Right-click a project in the sidebar, or open its **⋯** menu, and choose **Folder color** to pick red, orange, yellow, green, blue, purple or gray, the colors macOS Finder uses for tags. The project's row in the sidebar then shows its folder icon in that color, on a background tinted with it. The color is kept by visual-omp and doesn't add a Finder tag or change the folder itself. When you create a new empty folder in visual-omp, the wizard offers the same colors under the location. Removing a project from the list forgets its color.
- While Settings, Usage & limits, Help or a project page is open, the top of the sidebar fills with teal behind the app name and **Back**, with the text in white, so the sidebar shows that a page has replaced the chat and where to return. The fill sweeps in from the left when the page opens and back out when it closes, and it fades instead when reduced motion is on.
- A sidebar row stays highlighted while its right-click menu or its **⋯** menu is open. Previously the highlight disappeared as soon as the pointer moved into the menu, which made it hard to tell which chat or project the menu belonged to.

## [0.5.5] - 2026-10-19

visual-omp 0.5.5 lists omp's slash commands in the chat box and shows what they print, fixes switching models and thinking levels when omp uses its default status line, and explains when Windows refuses to start omp.

- Typing `/` in the chat box opens a menu of the commands omp accepts in this project: omp's built-in commands, plus the project's skills, custom commands, extension commands, MCP prompts and command files. After a command name, the menu lists its options and shows how to use it. omp provides the list, and the app adds the built-in commands omp only offers in its terminal.
- What omp prints for a slash command now shows in the chat. `/fast status`, `/context`, `/tools` and the other commands that answer with text add a row after the latest message, with long output folded under "Show all N lines". These rows are not saved with the chat and can be dismissed.
- Slash commands the app already has a screen for open that screen. For example, `/settings` opens Settings, `/model` opens Models & roles, `/switch` and `/effort` open the model and thinking menus, `/tree` opens the session tree and `/exit` closes the chat. `/delete` asks before it moves the chat to the trash, where omp would delete it without asking. A few commands would break how the app runs omp, so the app does not send them and explains why: `/collab` apart from `list` and `status`, `/join` and `/leave`, `/move`, and `/wt`. `docs/COMMANDS.md` lists how every omp command is handled.
- omp's own dialogs, such as the goal objective prompt, the option list from `/seance`, the input from `/cleanse` and the confirmation `/debug` asks before clearing its cache, now appear as cards in the chat instead of in the terminal sheet. Plan Review no longer opens the terminal sheet behind its card. A command that opens an omp screen the app does not draw opens the terminal sheet, which closes again when omp's screen goes away.
- Switching a chat's model or thinking level, including choosing **Auto**, no longer fails with "omp has a menu open" when omp uses its default status line settings. visual-omp confirms these changes by reading omp's status line, and it recognized only one status line style, while omp's default style shows the thinking level as an icon on the model name and uses a different separator. Chats now use the status line style visual-omp reads. Your saved omp settings are unchanged, though symbols and the status line in a chat's terminal sheet can look different from your own terminal.
- The thinking button keeps showing **Auto** after omp answers in Auto. omp's status line shows the level Auto chose for the latest message, and the button used to show that level, so choosing the same level from the menu did nothing because the app treated it as already set. The app now reads Auto from the thinking changes omp reports and records in the chat.
- On Windows, when omp can't start, visual-omp now gives guidance and quotes the error Windows reported, where it used to show only "spawn UNKNOWN". omp's Windows builds are unsigned, and Smart App Control, antivirus software or an application control policy can block unsigned programs, so Windows can refuse a new omp release. The setup screen opens with "omp can't start", and settings, chats and other omp actions show the same message. It says whether Windows confirmed a policy block. When Smart App Control is on, the message names it as a possible cause and explains what turning it off would change. **Check for omp** becomes the main action on that screen, so you can check again after allowing omp.

## [0.5.1] - 2026-10-14

visual-omp 0.5.1 makes the background jobs in the Tasks panel say what each job is doing.

- Each background job is now titled with the purpose the model gave its command, such as "Building the macOS installers", instead of the start of the raw command. A job whose command came without a stated purpose is titled by its first real step. Under the title is the first step of the command that does something, so lines like `set -e` or `cd folder` no longer open the row. A running job shows how long it has been running. A finished job shows how long it took and a failed job shows its exit code, when omp reports them. Opening a job shows the full command, its latest output and its job id.
- Running jobs are listed first, followed by the five most recent finished ones, as in omp's own `/jobs` list. Older jobs are behind **Show earlier jobs**, and the jobs share one list in place of a separate box for each.
- The "Background job finished" rows in the chat show the same command step.

## [0.5.0] - 2026-10-14

visual-omp 0.5.0 redesigns the app around the chats you have open, with clearer separation between areas, a new Usage & limits page, smoother chat updates and summaries of omp's work.

- The window has a new frame. The sidebar and status bar are a near-black band in both themes, and the chat, pages and side panel are lighter sheets with rounded corners, so each area stands apart. In the dark theme the sheet is lighter than the frame in the same way. Borders and secondary text are stronger throughout, and menus, pickers and lists across the app share one layout.
- The tab strip is gone. **Current chats** at the top of the sidebar lists every chat you have open, in the order you opened them, with a mark for chats that are working or waiting for your answer, and the projects below still list every chat. ⌘1 to ⌘9 open the first nine current chats, ⌘⇧[ and ⌘⇧] step through them, ⌘⇧T reopens the last chat you closed that can still be opened, with its unsent text, and ⌘⇧A goes to the next chat waiting for your answer. A saved chat you only looked at leaves Current chats when you switch to another chat, as long as omp has not started for it, you sent it nothing, and it has no draft, attachment or open omp terminal. It stays if removing it would change the number of a chat that was already open before you switched. ⌘W, a middle-click or the row's menu closes a chat, and the **Search commands** field in the title bar opens the command palette (⌘K).
- **Settings**, **Usage & limits**, **Help**, **Project settings** and a project's **Instructions** open as full pages in place of the chat, and the chat keeps running underneath. **Back** is at the top of the sidebar when it is visible, and Esc does the same. While Settings is open, the sidebar shows its sections. Models & roles, Helpers, Connected tools, Skills & plugins and Memory, which previously opened in separate panels over the chat, are now Settings sections. Leaving a page with edits you haven't saved asks whether to discard them.
- The chat header shows the chat's title, a line about what omp is doing, a summary of its work such as "5 of 7 tasks · 2 helpers working" that opens the Tasks panel, **Review changes**, the side panel toggle and a **⋯** menu with the chat's other commands.
- omp's work is easier to follow in the chat. Its task list is a card with a progress bar, and each helper it starts has a card with its status, current activity, tool calls, tokens and run time. When a reply finishes, its tool steps fold into one line such as "Worked for 1m 39s · 10 tool calls", and a summary lists the files omp changed in that turn with edit totals from omp's own edit results. Replies render tables, task lists, callouts and code blocks with a **Copy** button, and a plan with checkbox steps shows them as a checklist.
- omp's notices in the chat no longer appear as raw text with tags. A finished background job or helper is a short row that opens to its result, a message between agents is a card with the sender's name, a process that exits shows its exit code, an advisor note shows its severity, and a skill you invoked reads "Used the {name} skill". The session tree summarizes them the same way. A helper's transcript labels each later message from the main chat with its sender, where it used to call every message the assignment, and the helper's card no longer shows omp's "Complete assignment thoroughly:" preamble as its activity. A task whose helpers were stopped shows a neutral mark instead of a success check, and lists in replies show their bullets and numbers.
- Replies scroll into view smoothly as they arrive, new reply blocks fade in, steps expand and collapse more smoothly, and scrolling up while omp writes keeps your place. Screen readers hear each finished reply once instead of fragments of it.
- The chat box holds your message, **＋** (attachments, Shell and Python modes, dictation) and the send button, with the permission level, model, thinking level and context ring in a quieter row under it. While omp works, Enter queues your message and **Send now** (⌘↵) sends it at once. The context ring moved here from the status bar.
- On a new install, visual-omp sets omp's permission mode to **Ask me first** when no mode has been chosen, so omp can look around on its own but asks before it changes a file or runs a command. The app writes this once to omp's global settings (`tools.approvalMode: always-ask`) before the first chat starts. If it cannot read omp's settings at that point, the chat does not start and says why, and starting omp again checks once more. Existing installs keep their current mode, as does anyone who has set one in omp's settings, a project or the environment, and omp's own default is still Auto.
- The side panel is a floating sheet that opens one view at a time from a named list: Changes (previously Diff), Files, Preview, Outputs, Plan, Tasks and Terminal. **Outputs** groups files into those omp reported creating, those it wrote (which may be new or may have replaced a file), those it changed and those it only looked at. In a narrow window the side panel takes the place of the chat until you choose a chat or press **Back to chat**, and split view shows only the focused chat until there is room for both. On Windows, the Files panel now shows the project folder's name instead of its full path and tells you to Ctrl-click a file to mention it.
- **Usage & limits** shows a summary row per provider, with its selected account and limit window, and expands to show every account and window. Below it is the usage omp recorded on this computer for the last 7 or 30 days: key figures, a daily chart with its average, estimated cost by project, and a table of chats you can search, filter, sort and export as CSV. Dollar figures appear only on this page, as an estimated API cost at public API prices, because a subscription plan is billed differently. The project overview no longer shows a weekly cost.
- The project overview lists its recent chats, its instructions, model and permission mode, its Git state and example prompts that open a new chat ready to edit.
- **Help** is a page with short guides to a first chat, permission modes, rewinding and forking, and answering omp's questions, plus a glossary of the terms the app uses. The status bar's update notice opens **Settings → About**.
- The app is smaller and lighter to start. On a Mac with Apple silicon it takes about 243 MB instead of 304 MB, because it ships only English Electron resources and bundles its own code instead of whole libraries. The window's initial JavaScript entry file dropped from about 4.9 MB to 1.6 MB before compression; the terminal, math typesetting and less-used pages load when first needed or while the app is idle.

## [0.4.2] - 2026-10-14

visual-omp 0.4.2 fixes switching models from the chat box and lets an update through Homebrew finish without typing in its terminal.

- Choosing a model from the chat box now switches the model in a saved chat and while omp is replying. A saved chat showed a connection error because the picker read omp's screen before omp had started, and in a longer chat a reply that mentioned an error could be reported as a failed switch. The app now waits for omp to start and confirms the switch from the model omp reports for the chat. If omp does not confirm it within a few seconds, the app shows a warning and keeps the picker open.
- Updating a Homebrew install from **Settings → About** no longer stops at Homebrew's "Do you want to proceed with the upgrade? [y/n]" question, which needed you to click into the terminal and type `y`. Homebrew 6 and later asks it whenever its plan names the cask by its full name (`decoy-dev/tap/visual-omp`) while the app passes the short name, so the app now turns the question off. Clicking the update button is the confirmation. The copy you are running decides how it updates, so the update to 0.4.2 from an earlier version still asks once; press `y` in the terminal when it does.

## [0.4.1] - 2026-10-12

visual-omp 0.4.1 lets you go back and change an earlier answer when omp asks several questions at once.

- When omp asks several questions at once, the question card now shows them one at a time with "Question 2 of 3" and a **Previous question** button, so you can go back and change an earlier answer before anything is sent. omp itself takes the answers one question at a time and cannot return to a question it has already received, so the app keeps your answers until you reach the last question and then sends them all with **Send answers**. If omp asks in a way the app does not expect while it sends them, it stops and shows the remaining questions for you to answer one by one. **Chat about this** and **Skip questions** still end the questions right away.

## [0.4.0] - 2026-10-12

visual-omp 0.4.0 adds plan usage reported by your providers to the status bar, background chat alerts, image zoom and broader SVG previews. While the app window remains open and in the background, alerts tell you when a chat finishes or needs your answer. On macOS, these use a Dock badge and bounce. The Homebrew cask now removes quarantine from the installed app bundle to avoid the macOS approval check that reported it as damaged.

- The status bar shows provider-reported plan usage for the models used by the focused chat, next to the context ring. It reads omp's own usage report (`omp usage`) about once a minute while a chat with a known model is focused and the window is visible. A window reported as exhausted takes priority; for pooled accounts, every reporting account must report that window as exhausted. Otherwise, each provider shows its 5-hour window, for example "Claude 5h 23%", then its 7-day window, then its monthly window, falling back to its most-used window. The meter changes color at 70% and again at 90%. Hovering lists every window with its reset time, and clicking opens **Usage & limits**. Helpers running on another provider's model add that provider. A saved chat uses its last recorded model selection, or its last reply's model when no selection was recorded.
- When a chat finishes or needs your answer while visual-omp is in the background, the app now tells you. On macOS the Dock icon shows how many chats are waiting and bounces once for each one. Notification banners are unavailable in the current macOS build, because macOS refused them for the app as it is signed today. On Windows the app requests a notification, subject to your system notification settings, flashes the taskbar button and shows the count on it, and clicking the notification opens the chat. The count clears when you return to the window, and **Settings → Sounds & alerts** turns these alerts off. These alerts work while the app window remains open, including when it is minimized; closing the macOS window stops them until a window is reopened.
- Clicking an image in the **Files** viewer, the **Outputs** larger view or **Expand preview** zooms in at the point you click, and clicking again fits it back. While zoomed you can drag or scroll to move around, and Ctrl or ⌘ with the scroll wheel, or a trackpad pinch, zooms gradually. The **Show at actual size** toggle in **Expand preview** is replaced by a **Zoom in** toggle that follows the image's state.
- SVG files show in more places. **Outputs** now lists SVGs that commands write into the folders they name, file rows in replies show a thumbnail for an SVG, and an SVG that only sets a `viewBox` fills the preview instead of appearing at a small default size. An SVG without the `xmlns` attribute, which the app could not draw before, now displays as well. SVGs are still drawn as images, so scripts inside them do not run, and they never open in another app.
- The Homebrew cask now removes quarantine from the installed app bundle after installation, upgrade or reinstallation. macOS reported a Homebrew copy of 0.3.0 as "visual-omp is damaged and can't be opened" although its signature passed `codesign --verify`, and that message offers no way to approve the app. Removing the attribute avoids the approval check that quarantine triggers. Homebrew still verifies the download against the checksum in the cask, and the cask now requires Homebrew 6.0.16 or later. Disk images downloaded from a release are unchanged and still need **Open Anyway** on first launch.
- If macOS reports a Homebrew-installed copy as damaged, it cannot open to update itself. Open Terminal and run `brew update`. After that succeeds, run `brew upgrade --cask visual-omp`. If Homebrew reports that the latest version is already installed, run `brew reinstall --cask visual-omp` to apply the updated cask to that version.

## [0.3.1] - 2026-10-01

visual-omp 0.3.1 lets you open the files omp names in its replies, and looks for and previews the PDFs and images its commands write. The title bar now shows the app's version.

- File and folder names in omp's replies become links once the reply finishes. A name in a sentence shows as a small chip with a file-type icon. A paragraph or list item containing only a reference shows as a row with its folder and, for images and PDFs, a thumbnail when available. Clicking one opens it in the side panel's **Files** tab: text and code, images, PDFs, and folders as a grid of previews. Names become links when the app finds them on disk.
- The **Files** tab can open files and folders outside the project. When you open something from a reply it hides the project's file tree so the file gets the whole panel, and the button at the start of its tabs brings the tree back.
- **Expand preview** shows an image or PDF over the whole window, which suits wide layouts such as print spreads. PDFs in the side panel open fitted to its width, without the page thumbnails.
- The **Outputs** tab now checks the paths that commands and scripts name for files changed while they ran, so the PDFs and images a script writes show up. Folder scans include PDFs and raster images within fixed limits, and a file a command names directly can be any type. This is best effort: it can miss files a command never names and can include unrelated files changed at the same time.
- PDFs now open in the side panel in a full PDF viewer, show a first-page thumbnail when the operating system provides one, and can be opened in their default app.
- The **Outputs** tab now lists what omp made in the chat first, then other files, then the images and PDFs omp only looked at, so finished work stays at the top.
- The title bar shows the running visual-omp version next to the name.

## [0.3.0] - 2026-10-01

visual-omp 0.3.0 keeps a live chat's earlier messages on screen during a reply and adds an Outputs tab for what omp makes. Buffered text display now smooths pauses in streamed replies, and a working chat has a single stop button. It needs omp 18.4 or later.

- A live chat no longer drops its earlier messages partway through a reply. omp's live stream leaves out the bookkeeping entries it writes between a tool call and its result, and the app treated each gap as the start of the chat, so the transcript often showed only the reply in progress. The app now keeps earlier messages visible when the live stream omits intermediate entries.
- The transcript no longer goes blank while omp connects. The first message sent into a saved chat, and commands that reconnect the chat to omp such as `/restart`, used to clear the transcript until omp finished sending the chat again; the messages already on screen now stay until the new copy arrives.
- Replies and thinking now use a short adaptive buffer to smooth pauses between incoming text chunks. This adds a display delay, and the app accelerates the remaining text when omp finishes the message. Collapsed thinking adds no reveal delay, and **Reduce motion** shows text as it arrives. Earlier unchanged paragraphs retain their layout during incremental updates, so their text can be selected while omp is still writing.
- While omp works there is one stop button, in the composer where the send button sits, and the status row above the composer only reports progress. The composer's bottom row now fits the chat's width: as the chat narrows, controls shorten to an icon first and then move into the ＋ menu, and the send and stop buttons always stay in view.
- A new **Outputs** tab in the side panel collects the images and files omp made or viewed in the chat, newest first. An image whose file still exists loads from disk, so a file omp rewrote shows its latest version, and the larger view can open an image in its default app, show it in its folder or copy its path. Files open in the **Files** tab.
- The chat header shows its buttons as icons when the chat is narrow, so opening the side panel no longer pushes the chat underneath it.

## [0.2.1] - 2026-10-01

visual-omp 0.2.1 fixes the macOS error that reported downloaded copies as damaged. This release changes nothing on Windows.

- The macOS app is now ad-hoc signed as a whole bundle. 0.2.0 carried only the signature that Electron's linker adds, which fails the signature check macOS runs before a downloaded copy first opens, so copies installed through Homebrew or a browser download reported "visual-omp is damaged and can't be opened". The app is still not notarized, so the first launch asks for approval: open visual-omp, then click **Open Anyway** in **System Settings → Privacy & Security**.
- If macOS reports your 0.2.0 copy as damaged, it cannot open to update itself. With Homebrew, run `brew update` and then `brew upgrade --cask visual-omp`. Otherwise, download the Apple Silicon or Intel disk image from this release and drag visual-omp to Applications.

## [0.2.0] - 2026-09-30

visual-omp 0.2.0 is the first published release. It includes everything listed under 0.1.0, which was never published on its own, along with the changes below. It needs omp 18.4 or later.

- **Start chat…** in the sidebar asks which folder the chat should run in. You can pick a recent project, browse into any folder on the computer (the equivalent of `cd`), or create a folder inside the one you are viewing, and a chat that hasn't sent anything yet can move to another folder from the chip in the message box. The Projects header in the sidebar gained a menu for opening a folder, creating one and cloning from GitHub.
- **Settings → Providers** lists every provider omp has credentials for, with its accounts and any credential omp has disabled. Signing in to a new provider, signing in again and adding an account run omp's own `omp login` in a terminal inside the app, and signing out runs `omp auth-broker logout`, so omp performs every sign-in and keeps the credentials in its own store. The model picker links to the same screen.
- On macOS, a chat that is still open in a terminal omp now updates in the app as the terminal writes to it, and shows when the view has stopped updating. Once no other omp process has the session open, **Continue here** resumes the chat in the app after another ownership check. On Windows the app cannot detect terminal sessions, so saved chats show a notice to close the terminal copy before replying.
- The transcript no longer leaves blank space for the tool bookkeeping entries omp writes to the session file, and consecutive tool rounds share one reply header.
- The interface was redesigned around one teal accent on near-neutral surfaces. The gradient spectrum, bracketed section labels, striped cards and blurred glass are gone, icons come from Phosphor, and panels, lists, tabs, sheets and new messages animate as they change. **Settings → Appearance → Reduce motion**, or the system setting, turns the movement off.
- A new mark and app icon: a `>` prompt with a periscope rising out of its underscore, drawn in ink with a teal lens. The concepts it was chosen from are in `docs/logo-concepts/`.
- Chat status in the sidebar, tabs and Home now has a distinct shape for each state as well as a color, chat tabs move with the arrow keys and collapse into a "more" menu when they don't fit, and the shared checkbox, switch and input components use higher-contrast control borders.
- A chat restored into view when the app starts now shows its transcript right away.
- Button and menu labels name what they act on, and help text no longer promises that rewinding a chat undoes file changes.
- Release notes now come from this file: tagging a version publishes its section, a tag without one fails before anything is built, and prereleases no longer update the Homebrew cask.
- Settings → About shows the visual-omp and omp versions, the omp channel and the time of the last check, and updates either one. When the running app is the copy the Homebrew cask installed, it upgrades in a terminal inside the app and restarts into the new version; other macOS installs download and open the new disk image, and Windows downloads and runs the new installer. Installers download only from the release's own GitHub links. **Check for updates…** is in the app menu on macOS and the Help menu on Windows.
- omp is checked for updates on the same six-hour schedule as the app. After omp updates, **Restart open chats** asks the chats that were already running to restart on the new omp and reports when they have reconnected.
- The update notice names what changed in one line and offers **Update visual-omp** or **Dismiss notice**. The status bar marks an available visual-omp update next to the omp chip.

## [0.1.0] - 2026-09-30

The first release build of visual-omp. It needs omp 18.4 or later, which the app detects on first launch and offers to install.

- Each chat runs a full omp session in a hidden terminal and mirrors it through omp's collab stream over a relay bound to 127.0.0.1, so slash commands, `!` shell and `$` Python input, and message queueing behave as they do in the terminal.
- Tool calls collapse into short steps with line counts, and each step opens to its full output, diff or reasoning. The transcript switches between Normal, Thinking and Verbose.
- Projects group every saved omp session by folder, including sessions started in a terminal, with search, pinning, renaming and archiving. The new-project wizard starts from an empty folder, an existing folder or a GitHub URL.
- The Diff, Files, Tasks, Plan and web preview panes appear beside the chat. Diff comments go back to omp as a message, and the git bar commits with a generated message, opens pull requests and shows CI status.
- Plan, Goal, Vibe and Loop modes and the Advisor run from the chat header and the command palette. Plan review can run the plan, summarize the chat before running it, keep the full chat context, or send it back with a comment.
- Settings covers the common omp options plus an Advanced tab listing every setting. Model roles, agents, MCP servers, skills, plugins, memory and usage each have their own screen.
- The command palette (⌘K, or Ctrl+K on Windows) searches the app's commands by what they do, and full-screen omp menus without a native screen open in a terminal sheet.
- Installers are built for macOS (Apple Silicon and Intel, through a Homebrew cask) and Windows (NSIS). Neither is notarized or signed, so the operating system asks for approval before the app opens, as described in the README.
