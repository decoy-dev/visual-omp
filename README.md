<p align="center">
  <img src="https://github.com/decoy-dev/visual-omp/blob/main/assets/hero.png?raw=true" alt="visual-omp">
</p>

<p align="center">
  <strong>omp, without the terminal.</strong>
  <strong><a href="https://github.com/decoy-dev/visual-omp">visual-omp</a></strong>
</p>

<p align="center">
  <a href="https://github.com/decoy-dev/visual-omp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/decoy-dev/visual-omp?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.electronjs.org"><img src="https://img.shields.io/badge/Electron-47848F?style=flat&colorA=222222&logo=electron&logoColor=white" alt="Electron"></a>
  <a href="https://github.com/decoy-dev/visual-omp#install"><img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Windows-ed4abf?style=flat&colorA=222222" alt="Platforms"></a>
  <a href="https://github.com/can1357/oh-my-pi"><img src="https://img.shields.io/badge/engine-omp-5ad8e6?style=flat&colorA=222222" alt="Powered by omp"></a>
</p>

<p align="center">
  A desktop app for <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> by <a href="https://github.com/can1357">@can1357</a> · Built by <a href="https://decoy.ltd">decoy</a>
</p>

Everything that makes omp the most capable coding agent — subagents, plan mode, model roles, the advisor, collab, skills, MCP — in a window anyone can use. No commands to memorize, no terminal to learn. Real omp underneath, every feature within a click.

**Real** omp under every chat · **every** slash command one click away · **light** & **dark** · **macOS** & **Windows**.

> [!NOTE]
> visual-omp is in active pre-release development. Features land continuously on `main`; the
> first tagged release will publish the Homebrew cask and Windows installer below.

## Install

visual-omp drives the omp you already have. Install omp first:

**macOS · Linux**

```sh
curl -fsSL https://omp.sh/install | sh
```

**Windows (PowerShell)**

```powershell
irm https://omp.sh/install.ps1 | iex
```

Don't have it yet? visual-omp detects that on first launch and walks you through it.

**visual-omp on macOS (Homebrew)**

```sh
brew install --cask decoy-dev/tap/visual-omp
```

**visual-omp on Windows**

Download the `visual-omp-<version>-win-x64.exe` installer from the [latest release](https://github.com/decoy-dev/visual-omp/releases/latest).

macOS (Apple Silicon · Intel) · Windows 10+ · omp ≥ 18.4

### First launch

visual-omp is not yet notarized by Apple or signed for Windows SmartScreen, so the first launch needs one extra click:

- **macOS** — open visual-omp once, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to the visual-omp message.
- **Windows** — on the "Windows protected your PC" screen, click **More info → Run anyway**.

## A real omp, _behind glass_.

Every chat is a genuine omp session running out of sight. visual-omp types for you, then reads omp's own live stream — the same encrypted feed omp uses to share sessions — over a relay that never leaves your computer. Every omp feature works because it is omp: nothing re-implemented, nothing emulated, nothing lost in translation.

### 01 · Chats that read like a conversation

Replies stream in as formatted text. The work behind them — files read, commands run, edits made — folds into short, plain-language steps ("Edited 3 files", "Ran the tests ✓") that open up to the full output, diff, or reasoning when you want it. Switch between **Normal**, **Thinking**, and **Verbose** at any time.

### 02 · Every command, one click away

`/restart`, `/compact`, `/plan`, `/model`, `/agents` — the header puts the everyday ones on buttons, and **⌘K / Ctrl+K** searches all of omp's commands in plain language. Typing `/` in the message box still works. The rare full-screen omp menus open in a terminal sheet, exactly as omp draws them.

### 03 · Projects, not paths

Folders become projects in the sidebar, each with its chats underneath — including every session you ever ran in a terminal. Start a project from an empty folder, an existing one, or a GitHub link. Each project gets a home page with recent chats, git status, and what it cost this week.

### 04 · Plan first, then build

Plan mode lets omp investigate read-only and write a plan. Review it in the Plan pane, then **Approve & execute**, approve with a fresh context, or send it back to refine. Goal, Vibe, and Loop modes and the Advisor are toggles, not incantations.

### 05 · Watch the subagents work

When omp fans work out to subagents, the Tasks pane shows each one live — what it's doing, what it costs, and its transcript — alongside the todo list and background jobs.

### 06 · Review every change

The Diff pane collects everything omp changed, file by file. Leave comments on lines and send them back to omp, ask for a code review, commit with a generated message, open a pull request, and watch CI — without leaving the window.

### 07 · The agent roles, finally visible

omp routes work by role — `default`, `smol`, `slow`, `plan`, `commit`, `advisor`, and more. The Model Roles editor shows which model does what and lets you change it. The Agents hub lists every bundled and custom subagent, its model, and whether it's enabled, and can write a new agent for you.

### 08 · Everything else omp can do

MCP servers, skills and plugins, memory, usage limits and cost, session sharing and live collab, security scans, `omp cleanse`, importing Claude Code and Codex sessions, and a visual session tree — each with its own screen.

### 09 · Built for everyone

Light by default, dark when you want it. Keyboard-navigable end to end, labelled for screen readers, adjustable text size, reduced motion, and plain-language tooltips on every button. A first-run tour and a built-in glossary explain the rest.

---

## Development

```sh
git clone https://github.com/decoy-dev/visual-omp
cd visual-omp
npm install
npm run dev
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the app drives omp and [docs/SPEC.md](docs/SPEC.md) for the full product scope.

---

## License

visual-omp is licensed under the [MIT License](LICENSE). It includes code adapted from [oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT); see [NOTICE](NOTICE).
