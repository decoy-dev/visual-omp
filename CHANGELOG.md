# Changelog

Each release's section below becomes its GitHub release notes (see [docs/RELEASING.md](docs/RELEASING.md)). Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

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
