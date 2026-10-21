# omp commands in visual-omp

This page records how visual-omp handles each omp slash command and the menus those commands open. The list was taken from omp v18.12.2, which registers 86 builtin commands and 8 aliases, plus the skills, custom commands, extension commands, MCP prompts and file commands a project provides.

Every chat runs omp's own terminal interface in a hidden terminal, so any line that reaches omp behaves as it would in a terminal. The app adds four things around that: a slash menu that lists what omp accepts, native screens for commands the app already covers, a result row for what omp prints, and native cards for omp's generic dialogs. The terminal sheet remains the fallback for omp screens the app does not draw.

## How a slash line is handled

1. **Slash menu.** Typing `/` in the composer lists the commands omp accepts in this project, with descriptions, aliases and a source label for anything that is not a builtin. After `/name ` the menu lists that command's subcommands and its argument hint. The descriptions are omp's own text. The list comes from omp's `get_available_commands` request over a short-lived RPC process in the project folder, merged with a builtin catalog in `src/main/services/omp-builtin-commands.ts`, because omp's RPC list leaves out about 40 builtins that only exist in the terminal interface and describes the rest in the syntax of its editor integrations. The catalog's entries therefore win for builtins. The main process keeps a folder's list until skills, plugins, MCP servers, providers or settings change, asks omp again for a minute after a `/mcp`, `/skills`, `/plugins`, `/plugin`, `/marketplace` or `/reload-plugins` line runs, and never keeps the builtin-only fallback it returns when omp can't be asked.
2. **Routing.** `routeSlash` (`src/renderer/src/features/session-tools/slash.ts`) handles a line in the app when the table below gives it a native or guarded treatment. Everything else goes to omp.
3. **Results.** `sendSlashCommand` (`session-tools/typed.ts`) types the line into omp and watches the painted screen. Lines omp prints above its editor, including inline report panels, become a result row in the chat once they stop changing. Nothing is recorded when the command starts a turn, changes the session or replaces omp's editor. Result rows sit after the message that was last on screen when the command was sent, can be dismissed, and are not saved.
4. **Dialogs.** omp's generic dialogs (a list of options, a Yes and No confirmation, a one-line input and a multi-line editor) are local to its terminal and do not reach the app over collab. The omp dialog card (`session-tools/OmpDialogCard.tsx`) reads them from the screen and answers with key presses. The Plan Review overlay has its own card.
5. **Terminal sheet.** When a typed command replaces omp's editor with a screen no card draws, the terminal sheet opens, and it closes again when omp's screen goes away.

Typing a command in the terminal sheet sends it straight to omp, without the menu or the routing, so omp's own screen for a command the app routes elsewhere stays available there.

## Treatments

- **Native**: the app handles the line with its own screen or control. Most native screens never involve omp. The plan and vibe toggles, restart, export and fork drive omp themselves and confirm what omp did.
- **Result**: the line goes to omp and what omp prints shows as a result row.
- **Card**: omp opens a generic dialog, which the omp dialog card draws.
- **Sheet**: omp opens a screen with no app counterpart, which the terminal sheet shows. The design notes below record where a native version belongs.
- **Guarded**: the line is not sent, because it would break how the app hosts omp. A warning explains why and offers the app's way to do it.

## Commands

The table describes the form without arguments unless it shows one.

| Command | Treatment |
|---|---|
| `/settings` | Native: Settings |
| `/setup`, `/providers`, `/login`, `/logout` | Native: Settings → Providers. `/login <provider>` and `/logout <provider>`: Sheet (omp's sign-in dialog and account list). `/login <redirect URL>`: Result |
| `/model`, `/models`, `/modelpreset` | Native: Settings → Models & roles. `/modelpreset <args>`: Result |
| `/switch` | Native: the composer's model picker. `/switch <model>`: Result |
| `/effort` | Native: the composer's thinking picker. `/effort <level>`: Result |
| `/usage`, `/usage show` | Native: Usage & limits. `/usage reset <target>`: Result; `/usage reset` alone: Sheet |
| `/agents` | Native: Settings → Helpers |
| `/mcp`, `/mcp add` | Native: Settings → Connected tools. Other subcommands: Result |
| `/skills`, `/skills help` | Native: Settings → Skills & plugins. Other subcommands: Result |
| `/plugins`, `/plugin`, `/marketplace`, `/marketplace install` | Native: Skills & plugins, Plugins tab. Other subcommands: Result |
| `/memory`, `/memory view` | Native: Settings → Memory. Other subcommands: Result |
| `/tree`, `/branch`, `/rewind` | Native: the session tree |
| `/goal`, `/loop` | Native: the goal and loop dialogs. With arguments: Result, and Card for omp's goal prompts |
| `/plan`, `/vibe` | Native: the plan and vibe toggles. With a prompt: Result (a turn) |
| `/new`, `/share`, `/export`, `/restart` | Native: new chat, Share dialog, export, restart. `/export <args>`: Result |
| `/hotkeys` | Native: Settings → Shortcuts, which lists the app's shortcuts. omp's key list for its own terminal stays available by typing `/hotkeys` in the terminal sheet |
| `/fork` | Native: fork into a new chat. `/fork pane`, `window`, `tab`: Guarded, offering a fork in a new chat |
| `/git` | Native: the Changes pane. `/git <revision>`: Sheet |
| `/hub`, `/jobs` | Native: the Tasks pane, which lists running helpers and background jobs. omp's fuller Agent Hub stays available in the terminal sheet. `/jobs <args>`: Result |
| `/exit`, `/quit`, `/q` | Native: close this chat, with its usual confirmations |
| `/delete`, `/session delete` | Native: the sidebar's move-to-trash confirmation for this chat |
| `/resume` | Native: the sidebar's chat search. `/resume <id>`: Result (the chat reconnects to that session) |
| `/collab`, `/collab start`, `view`, `stop`, `/collab <relay URL>`, `/leave` | Guarded, offering Share → Live invite. `/collab list` and `/collab status`: Result |
| `/join <link>` | Guarded: joining another room would replace this chat with someone else's session, and the app cannot open another person's chat as a guest yet |
| `/move` | Guarded, offering to start a chat in another folder |
| `/wt`, `/worktree` | Guarded, offering New worktree, which opens a new chat in the worktree |
| `/compact`, `/handoff`, `/guided-goal`, `/rename`, `/plan-review` | Result |
| `/advisor`, `/advisor on`, `off`, `status`, `dump` | Result. `/advisor configure`: Sheet |
| `/security`, `/fast`, `/slow`, `/skillful`, `/extended-context`, `/computer`, `/browser`, `/prewalk`, `/ratchet`, `/tan`, `/force`, `/queue`, `/retry`, `/clear`, `/fresh`, `/shake`, `/trace`, `/dump`, `/open`, `/ssh`, `/add-dir`, `/remove-dir`, `/dirs`, `/pin`, `/reload-plugins`, `/changelog`, `/tools`, `/context`, `/stats`, `/todo`, `/record`, `/session pin <account>` | Result |
| `/omfg`, `/cleanse` | Result, with Card for their dialogs |
| `/seance` | Sheet for omp's session picker and its model picker, Card for "Consult this session with". `/seance <session>`: Card, then Sheet for the model picker |
| `/extensions`, `/status`, `/session`, `/session info`, `/session pin`, `/copy`, `/btw`, `/debug`, `/pause`, `/live`, `/annotate` | Sheet |
| `/todo edit` | Sheet: omp opens the file in the external editor set by `$VISUAL` or `$EDITOR`, which runs inside omp's terminal |
| Skills (`/skill:<name>`), custom commands (`/review`, `/green`, `/init`, `/autoresearch`), extension commands, MCP prompts (`/<server>:<prompt>`), file commands | Listed in the slash menu and sent to omp. Their dialogs reach the app over collab and show in the question card; fullscreen screens such as `/annotate` use the sheet |

Shortcut-only features such as Shift+Tab, Ctrl+P and double Esc are covered by the thinking picker, the model picker and the session tree; the rest stay available in the terminal sheet.

## Design notes for sheet and guarded commands

These notes record where a native version of each sheet screen belongs, or why the sheet stays. Until a native version exists, the command works through the terminal sheet.

- **`/extensions`**: The terminal sheet remains the right home, because Settings already covers Providers, Connected tools and Skills & plugins. A later Extensions overview section in Settings would link to those three sections and add the live tool list for the current chat.
- **`/session info`**: A Chat details dialog from the session ⋯ menu would show the session id, file path, model, message counts and token use, with Show in folder and Copy path.
- **`/session pin`**: A dialog from the session ⋯ menu would list the signed-in accounts as radio rows, reusing the Providers account presentation, with Pin to this account disabled while omp is working.
- **`/copy`**: The message hover actions would gain a Copy menu for the message, its code block, its command or its last link, in the style of the code block Copy button. `/copy code`, `/copy cmd` and `/copy link` already work with a result row.
- **`/btw`**: Each side answer would show as a transcript card titled Side answer, with Copy, Branch and Follow up, following the advisor card's layout, and `/btw` alone would open a sheet of past side answers.
- **`/debug`**: A Diagnostics section on the Help page would offer one row per action (open the artifact folder, recent logs, system info, dump the session, test terminal protocols, clear the artifact cache), with a confirmation before clearing.
- **`/pause`**: A modal card titled Chat paused would show the hold time with Resume as the primary action.
- **`/live`**: The terminal sheet remains the right home, because live voice needs a realtime audio path the app does not have. A later native version would be a composer voice mode with a level meter and Stop.
- **`/annotate`**: An Annotate action on messages and on Files viewer selections would collect feedback into the composer, which is where omp puts it, next to the Changes pane's existing line comments.
- **`/todo edit`**: An Edit checklist sheet would list each task with a text field, a state mark and a delete action, reusing the task card's data. The other `/todo` subcommands already work with result rows.
- **`/usage reset`**: Usage & limits offers Spend a reset on each account that holds saved resets, with a confirmation because a spent reset cannot be returned (DESIGN §4.18). The page sends omp's own `/usage reset <provider>/<credential id>` to a short-lived omp, so no chat is involved. Typed in a chat without a target, the command still opens omp's account picker in the terminal sheet.
- **`/advisor configure`**: An Advisor sheet opened from the advisor row in the work modes menu would offer a scope switch, the composer model list for the advisor model and a tool checklist, with Open in external editor for the raw file.
- **`/git <revision>`**: A Revision sheet would reuse the Changes pane's diff view as a read-only view of the chosen commit.
- **`/seance`**: A Consult a session dialog would pick a chat with the sidebar's chat search and then a model from the composer model list, and the consultation would appear as a helper in the Tasks pane.
- **Session toggles** (`/fast`, `/slow`, `/skillful`, `/extended-context`, `/computer`, `/browser`, `/prewalk`): A Chat options popover on the composer's control row would list each toggle as a switch, reading its state from the command's `status` form and confirming each change from what omp prints, the same way the advisor toggle works.
- **Reports** (`/context`, `/tools`, `/jobs`, `/changelog`, `/memory stats`): These already show as expandable result rows. Each would also gain a permanent home: the context ring popover for `/context`, the Tasks pane for `/jobs`, Settings → Memory for `/memory stats`, the Help page for `/changelog` and a Help dialog for `/tools`.
- **Guarded commands**: The app hosts the collab room that mirrors omp into the chat, so starting, restarting or stopping a room from omp, or leaving it, would disconnect the app, and `/join` would replace the chat with another session. `/move`, `/wt` and `/worktree` move the running session to another folder, which the app cannot follow; New worktree creates the worktree and a new chat in it, and it does not move this conversation or carry its changes. `/fork pane`, `window` and `tab` need a terminal multiplexer, which the app does not have; plain `/fork` and split view cover the same needs.

## Keeping this current

The builtin catalog is a copy of omp's registry at the version named in its header. When omp adds a builtin, the command still works when typed, and its description appears once omp lists it over RPC or the catalog is refreshed from omp's `packages/coding-agent/src/slash-commands/`.
