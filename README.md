<p align="center">
  <img src="https://github.com/decoy-dev/visual-omp/blob/main/assets/hero.png?raw=true" alt="visual-omp">
</p>

<p align="center">
  A desktop app for <a href="https://github.com/can1357/oh-my-pi">omp (oh-my-pi)</a>, the coding agent by <a href="https://github.com/can1357">@can1357</a>. Published by <a href="https://decoy.ltd">decoy</a>.
</p>

<p align="center">
  <a href="https://github.com/decoy-dev/visual-omp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/decoy-dev/visual-omp?style=flat&colorA=222222&colorB=0e7490" alt="License: MIT"></a>
  <a href="https://github.com/decoy-dev/visual-omp/releases"><img src="https://img.shields.io/github/v/release/decoy-dev/visual-omp?style=flat&colorA=222222&colorB=0e7490&include_prereleases" alt="Latest release"></a>
  <a href="https://github.com/decoy-dev/visual-omp#install"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-0e7490?style=flat&colorA=222222" alt="Platforms: macOS and Windows"></a>
</p>

omp has subagents, plan mode, model roles, an advisor, MCP servers and skills, and all of it runs in a terminal. visual-omp puts that same omp behind a desktop window, so the chats, plans, subagents and settings become things you can click. People who have never opened a terminal can use omp this way, and people who already work in one get a clearer view of what omp is doing while it works.

> [!NOTE]
> visual-omp is at version 0.1, its first release build. The Homebrew cask and the Windows installer are published when a version is tagged, and [CHANGELOG.md](CHANGELOG.md) lists what each version contains.

## Install

visual-omp runs the omp you already have installed, so install omp first. If it is missing, visual-omp detects that on first launch and offers to run the installer for you.

**omp on macOS or Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

**omp on Windows (PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

**visual-omp on macOS (Homebrew)**

```sh
brew tap decoy-dev/tap https://github.com/decoy-dev/visual-omp
brew install --cask decoy-dev/tap/visual-omp
```

**visual-omp on Windows**

Download `visual-omp-<version>-win-x64.exe` from the [latest release](https://github.com/decoy-dev/visual-omp/releases/latest) and run it.

visual-omp supports macOS on Apple Silicon and Intel, Windows 10 and later, and omp 18.4 or later.

### First launch

visual-omp is not notarized by Apple or signed for Windows SmartScreen yet, so the operating system asks you to approve it before it opens. Expect the prompt on first launch, and possibly again after an update:

- **macOS:** open visual-omp, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to the message about visual-omp.
- **Windows:** on the "Windows protected your PC" screen, click **More info**, then **Run anyway**.

## How it works

Each chat runs a full omp session in a hidden terminal on your computer. visual-omp types your messages into that session and reads omp's own collaboration stream back over a relay bound to 127.0.0.1, which means the connection between the app and omp never leaves your machine. The practical consequence is that visual-omp does not reimplement omp: a slash command works when you type it into the message box whether or not the app has a button for it yet, and the handful of full-screen omp menus without a native screen open in a terminal sheet drawn by omp itself.

## What you can do

### Start a chat in any folder

The sidebar's **Start chat…** button asks where the chat should run. You can pick a recent project, browse into any folder on your computer, or create a new folder inside the one you are looking at, and omp starts there, the same as running `omp` after `cd`. Folders you use become projects in the sidebar, next to every session you have run in a terminal.

### Follow a chat that is open in a terminal

On macOS, a session that is still running in a terminal opens in the app as a view that updates while the terminal works, and replies go through the terminal. Once the app sees that no other omp process has the session open, **Continue here** checks again and lets you resume the chat in the app.

### Read what omp did

Replies stream in as formatted text, and the tool calls behind them collapse into short steps such as "Edited 3 files" or "Ran tests". Each step opens to its full output, diff or reasoning, and the transcript switches between Normal, Thinking and Verbose.

### Run commands without memorizing them

The chat header holds the commands people use most, such as Restart, Compact and Plan mode. **⌘K** (**Ctrl+K** on Windows) searches the app's commands by what they do, and anything you type after `/` in the message box goes to omp exactly as it would in the terminal.

### Plan before building

Plan mode has omp draft a plan for your approval before it implements anything. The Plan pane shows that plan with options to run it, summarize the chat before running it, keep the full chat context, or send it back with a comment. Goal, Vibe and Loop modes and the Advisor are in the chat header's ⋯ menu and the command palette.

### Review changes and ship them

When omp hands work to subagents, the Tasks pane shows each one while it runs, with its token count and its transcript where omp provides one, next to the todo list and background jobs. The Diff pane collects the project's uncommitted changes file by file, and you can comment on lines and send the comments back to omp, commit with a generated message, open a pull request and check CI from the same window.

### Manage providers, models and agents

Settings lists the model providers omp is signed in to, and connecting a new one or signing in again after a token expires opens omp's own sign-in inside the app. The **Model roles** screen shows which model handles each omp role (default, smol, slow, plan, commit, advisor and the rest), and **Helpers** lists every bundled and custom subagent with the model it uses.

### Everything else omp can do

MCP servers, skills and plugins, memory, usage limits and cost, session sharing and live collaboration, imports from Claude Code and Codex, and the session tree each have a screen of their own, and omp's security scan and `omp cleanse` run from the command palette.

### Accessibility

Settings has text size, reduced motion and a light or dark theme. The command palette runs any app command from the keyboard, controls carry labels for screen readers, a short tour runs on first launch, and Help includes a glossary of omp's terms.

## Updating

visual-omp checks GitHub for a new release shortly after launch and every six hours after that, and it checks omp the same way through `omp update --check`. **Settings → About** shows both versions and installs either update. A Homebrew install upgrades through `brew upgrade --cask visual-omp`, any other macOS install downloads the new disk image, and Windows downloads and runs the new installer. Open chats keep the omp version they started with until they restart, so after an omp update the app offers to restart them.

## Development

```sh
git clone https://github.com/decoy-dev/visual-omp
cd visual-omp
npm install
npm run dev
```

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the app drives omp, [docs/SPEC.md](docs/SPEC.md) covers the product scope, and [docs/RELEASING.md](docs/RELEASING.md) describes how a version is published.

## License

visual-omp is licensed under the [MIT License](LICENSE). It includes code adapted from [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT), credited in [NOTICE](NOTICE).
