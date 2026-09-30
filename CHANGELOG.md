# Changelog

Each release's section below becomes its GitHub release notes (see [docs/RELEASING.md](docs/RELEASING.md)). Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

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
