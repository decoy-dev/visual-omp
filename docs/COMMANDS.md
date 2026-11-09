# omp commands in visual-omp

This page records how visual-omp handles each omp slash command and the menus those commands open. The catalog was reviewed against omp v18.18.5, with 89 builtin commands and 9 aliases, plus the skills, custom commands, extension commands, MCP prompts and file commands a project provides. omp 18.18.0 through 18.18.5 added no builtin commands. The minimum supported version remains omp v18.15.0; `/unpin` requires omp v18.17.0.

Each app-hosted chat runs omp in a pseudo-terminal. macOS, Linux and Windows use Tern Surface Protocol (TSP) by default, with semantic editor actions, native cards and an omp screen for unclaimed menus or output. Settings > Advanced has a "Classic omp terminal" switch, off by default, for new chats that need omp's terminal screen. Main reads the choice at host launch; running hosts keep their presentation until omp restarts in them. Developer overrides `VOMP_TSP=1` and `VOMP_TSP=0` force TSP and classic respectively on every platform. Windows TSP hosts use node-pty's bundled ConPTY; classic hosts use the system ConPTY. Classic code remains while the setting exists. Both presentations use collab for the transcript and questions.

## How a slash line is handled

1. **Slash menu.** Typing `/` in the composer lists the commands omp accepts in this project, with descriptions, aliases and a source label for anything that is not a builtin. After `/name ` the menu lists that command's subcommands and its argument hint. The descriptions are omp's own text. The list comes from omp's `get_available_commands` request over a short-lived RPC process in the project folder, merged with a builtin catalog in `src/main/services/omp-builtin-commands.ts`, because omp's RPC list leaves out about 40 builtins that only exist in the terminal interface and describes the rest in the syntax of its editor integrations. The catalog's entries therefore win for builtins. The main process keeps a folder's list until skills, plugins, MCP servers, providers or settings change, asks omp again for a minute after a `/mcp`, `/skills`, `/plugins`, `/plugin`, `/marketplace` or `/reload-plugins` line runs, and never keeps the builtin-only fallback it returns when omp can't be asked.
2. **Routing.** `routeSlash` (`src/renderer/src/features/session-tools/slash.ts`) handles a line in the app when the table below gives it a native or guarded treatment. Everything else goes to omp.
3. **Results.** `sendSlashCommand` (`session-tools/typed.ts`) submits the line through the selected host presentation. TSP chats collect known outcomes from new or changed semantic feedback and keep other output as notices or unclaimed omp content. Classic chats watch the painted screen and turn stable output above the editor into result rows. Commands that start a turn, change the session or replace the editor do not produce a scraped result. Result rows are anchored after the last displayed message at submission, can be dismissed, and are not saved. `/btw` uses the side-answer presentation described below.
4. **Dialogs.** Generic lists, confirmations, one-line inputs and multi-line editors use the omp dialog card (`session-tools/OmpDialogCard.tsx`). TSP cards read semantic hook documents and send declared actions. Questions matched to a collab request use their existing chat question card, with guarded arbitration for local answers. Classic cards read painted dialogs and answer with keys. Plan Review has its own card.
5. **Omp sheet.** Unclaimed semantic menus, screen-mode panels and other output open in the TSP omp screen. The app's transcript and composer remain separate. Classic commands that replace the editor with a screen no card draws open the terminal sheet, which closes again when that screen goes away. In classic chats, `/btw <question>` also opens the terminal sheet explicitly for a visible originating chat, including either half of a split, when no terminal sheet is already open. That side-answer sheet stays open until the reader closes it; background submissions leave the current view unchanged.

File commands with YAML frontmatter `side: true` use omp's side-answer output. In classic chats, they follow the explicit terminal-sheet path without result scraping, including invocations without arguments because the file supplies the prompt. Since omp's RPC command listing omits this flag, the hosted native extension asks omp's public `discoverSlashCommands` SDK at submission time. That lookup retains enabled user and project providers, nested bare names, namespace aliases and source precedence. Registered extension, custom and skill commands and builtin names retain precedence over file-side metadata. Discovery failure preserves the draft instead of guessing from a directory scan. TSP chats send file commands through the semantic editor and retain their output in the semantic presentation; the native Side questions route applies to `/btw`.

Typing in the classic terminal sheet sends directly to omp and bypasses app slash routing. The TSP omp screen provides semantic controls and raw keys only for focused fallback content; it is not a general terminal prompt. In the tables and design notes below, **Sheet** means the semantic omp screen for TSP chats and the painted terminal sheet for classic chats.

While omp works, Enter queues pass-through slash commands. Send now, from the composer or a queued row, submits them through omp's editor without waiting for the main turn. omp dispatches its builtins before its streaming-message queue, so commands such as `/btw`, `/fast status`, `/queue` and `/tan` can run during that turn; individual commands still apply omp's own restrictions. If submission fails, a queued row returns to its original position and a notification gives the reason. A direct send keeps its draft.

In TSP chats, an approval blocks slash routing before either app controls or
omp commands are invoked. Ordinary messages remain available and let omp deny the approval and
continue with that message. Open omp menus and screen-mode settings retain their separate close-menu
and close-screen instructions.
In TSP chats, rename, export, compact, handoff and jobs-kill results use
new or changed semantic feedback after submission. Cleanse reads its settled panel outcome.
The Result keeps omp's literal text and printed export path. Completed compaction and handoff content stays in its collab transcript row,
which says "Handed off" or "Context summarized" and opens to the document omp continues from, with Copy.
omp does not save a /handoff document as a separate file; it replaces the earlier context in place, and
the messages before it stay in the chat. While omp writes a handoff or summary, the working row and session
header show omp's own label ("Generating handoff…", "Compacting context…") with elapsed time and Stop.
Feedback delivered to a result row or native presentation is omitted from the separate notice
projection, including the "Session compacted" toast that only restates a completed handoff.
Undisplayed output returns to notices with its arrival anchor. A quiet jobs-kill
waits 1.5 seconds before releasing the queue. Other pass-through commands retain new or changed
public main-region text, Markdown, rows and links in command-labelled Result rows. This includes
folder and worktree moves, context resets, SSH mutations, MCP connection reports and authorization
instructions, extension or custom-command exceptions, and the bound dashboard URL from `/stats`.
Unchanged earlier output, hidden fields, collab-source session status toasts and content already
presented by collab or a native card are excluded. Output can arrive after omp's editor becomes available; attribution ends at the next
input or a host, room or protocol-epoch change. Results keep their arrival position without opening
the omp screen or moving focus. Printed paths and URLs offer Copy, and existing local paths offer
Show in folder through the app's existing reveal action. Dashboard and authorization URLs remain
selectable and copyable when omp's declared browser action cannot be sent safely.
Classic chats retain painted-screen result parsing.

Read-only reports from `/tools`, `/changelog`, `/jobs full`, `/advisor status`, memory reports,
SSH help/list and MCP listings retain omp's title and body in Result rows. The app closes the
report through its declared Close action only after its native Result owns the exact report.
Unsupported report content and additional actions stay in the omp screen.
Reports consisting of omp Markdown use the chat's Markdown renderer, including tables, headings
and code blocks. Long reports start within a bounded reading area and can expand. Copy result
copies the complete original Markdown. Text-only reports and earlier Result rows remain plain text.
Unclaimed semantic dock panels also open that screen, including the active `/omfg` and `/cleanse`
boards. Their questions keep their existing cards. Settled outcomes remain in Result rows after
the boards close: cleanse distinguishes Clean, Diagnostics remain, No runnable checker, Cancelled
and Error. Omfg retains its failure details or saved rule path, with Copy path and Show in folder
when the file exists. Background chats retain feedback without opening the current chat's screen.

In TSP chats, `/btw` is routed to the originating chat's Side questions pane. Bare `/btw` opens
history; `/btw <question>` starts a side answer through omp's semantic editor. The pane reads
live frames and watches omp's history files without writing them. Follow up uses omp's topic
selection and follow-up field. Put away closes the overlay without stopping an answer; Stop side
answer sends omp's declared stop action and then closes it. Main-turn Stop remains collab abort.
The pane has no delete control. An optional 18.16 steering prompt is injectable only while omp
declares that action. Classic chats retain their terminal-sheet behavior.



## Treatments

- **Native**: the app handles the line with its own screen or control. Most native screens never involve omp. Mode switches use the app-hosted extension's `ctx.sessionModes` controls; restart, export and fork use omp's existing command paths.
- **Result**: the line goes to omp and what omp prints shows as a result row.
- **Card**: omp opens a generic dialog, which the omp dialog card draws.
- **Sheet**: omp opens a screen with no app counterpart, which the semantic omp screen or classic terminal sheet shows. The design notes below record where a native version belongs.
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
| `/goal`, `/loop` | Native: the goal and loop dialogs. `/goal pause`, `resume`, `drop`: native extension controls. Other arguments: Result, and Card for omp's goal prompts |
| `/plan`, `/vibe` | Native: the plan and vibe toggles. With a prompt: Result (a turn) |
| `/new`, `/share`, `/export`, `/restart` | Native: new chat, Share dialog, export, restart. `/export` and `/export --themes` prefer an absolute chat-folder path, then Downloads for whitespace paths; CLI export is the last fallback. `/export <path>`: Result |
| `/hotkeys` | Native: Settings → Shortcuts, which lists the app's shortcuts. In classic chats, typing `/hotkeys` directly in the terminal sheet opens omp's own key list |
| `/fork` | Native: fork into a new chat. `/fork pane`, `window`, `tab`: Guarded, offering a fork in a new chat |
| `/git` | Native: the Changes pane. `/git <revision>`: Sheet |
| `/hub`, `/subagents`, `/jobs` | Native: the Tasks pane lists helpers and background jobs, with helper-owned jobs beneath their helper. Only this chat's own running jobs offer Stop and Stop all, sent as `/jobs kill <id>` and `/jobs kill all` through Send now. Classic chats can open omp's fuller Agent Hub directly in the terminal sheet. `/jobs <args>`, including `/jobs full`: Result |
| `/exit`, `/quit`, `/q` | Native: close this chat, with its usual confirmations |
| `/delete`, `/session delete` | Native: the sidebar's move-to-trash confirmation for this chat |
| `/resume` | Native: the sidebar's chat search. `/resume <id>`: Result (the chat reconnects to that session) |
| `/collab`, `/collab start`, `view`, `stop`, `/collab <relay URL>`, `/leave` | Guarded, offering Share → Live invite. `/collab list` and `/collab status`: Result |
| `/join <link>` | Guarded: joining another room would replace this chat with someone else's session, and the app cannot open another person's chat as a guest yet |
| `/move` | With a destination: Result with the full destination path. Without one: Sheet for omp's directory picker. The current chat follows omp's destination folder and session file. |
| `/wt`, `/worktree` | Result with the full worktree path, branch and carried-changes summary. omp creates and owns the worktree, and the current chat follows it. Startup and exit worktree confirmations use native dialogs. |
| `/compact`, `/handoff`, `/guided-goal`, `/rename`, `/plan-review` | Result |
| `/advisor`, `/advisor on`, `off`, `status`, `dump` | Result. `/advisor configure`: native Advisor sheet |
| `/unpin [session id]` | Result (omp 18.17 or later). Removes a chat's resume-list pin; `/session pin <account>` still selects its preferred OAuth account. The sidebar already shows resume-list pins. |
| `/security`, `/fast`, `/slow`, `/skillful`, `/extended-context`, `/computer`, `/browser`, `/prewalk`, `/ratchet`, `/tan`, `/force`, `/queue`, `/retry`, `/clear`, `/fresh`, `/shake`, `/trace`, `/dump`, `/open`, `/ssh`, `/add-dir`, `/remove-dir`, `/dirs`, `/pin`, `/reload-plugins`, `/changelog`, `/tools`, `/stats`, `/todo`, `/record`, `/forget-approvals`, `/session pin <account>` | Result |
| `/omfg`, `/cleanse` | Sheet for their live boards, Card for their dialogs, then Result for their settled outcomes. Omfg keeps the saved rule path; cleanse reports omp's final diagnostic outcome. |
| `/seance` | Sheet for omp's session picker and its model picker, Card for "Consult this session with". `/seance <session>`: Card, then Sheet for the model picker |
| `/extensions`, `/status`, `/session`, `/session info`, `/session pin`, `/copy`, `/debug`, `/pause`, `/live`, `/annotate` | Sheet |
| `/context` | Sheet: omp opens a read-only viewer for context usage and detailed content |
| `/btw <question>` | TSP: opens Side questions and asks omp there; bare `/btw` opens its history. Classic: the terminal sheet opens explicitly for the inline side answer, including while the main turn runs; bare `/btw` opens omp's side-answer history |
| `/todo edit` | Sheet: omp opens the file in the external editor set by `$VISUAL` or `$EDITOR`, which runs inside omp's terminal |
| `/local [name]` | Sheet: omp opens a session `local://` file in `$EDITOR`, with a file picker when no name is given |
| Skills (`/skill:<name>`), custom commands (`/review`, `/green`, `/init`, `/autoresearch`), extension commands, MCP prompts (`/<server>:<prompt>`), file commands | Listed in the slash menu and sent to omp. Their dialogs reach the app over collab and show in the question card; fullscreen screens such as `/annotate` use the sheet. Thrown handler errors printed by omp remain visible in command Result rows. |

Shortcut-only features such as Shift+Tab, Ctrl+P and double Esc are covered by the thinking picker, the model picker and the session tree. Other terminal keys remain available in classic sheets and in focused TSP fallback content that forwards raw keys.

## Design notes for sheet and guarded commands

These notes record where a native version of each sheet screen belongs, or why the sheet stays. Until a native version exists, its omp content uses the semantic omp screen or classic terminal sheet.

- **`/extensions`**: The omp sheet retains the current extension UI, because Settings already covers Providers, Connected tools and Skills & plugins. A later Extensions overview section in Settings would link to those three sections and add the live tool list for the current chat.
- **`/session info`**: A Chat details dialog from the session ⋯ menu would show the session id, file path, model, message counts and token use, with Show in folder and Copy path.
- **`/session pin`**: The composer's account picker lists the current provider's stored OAuth accounts as radio rows when there are at least two. It sends an explicit `/session pin OAuth credential #<id>` and waits for omp's active-account state. Choices are disabled while omp replies. Typing bare `/session pin` still opens omp's own account selector in the sheet.
- **`/copy`**: The message hover actions would gain a Copy menu for the message, its code block, its command or its last link, in the style of the code block Copy button. `/copy code`, `/copy cmd` and `/copy link` already work with a result row.
- **`/btw`**: TSP chats use the native Side questions pane described above. In classic chats, omp displays a side answer above its editor without adding a collab message. The app opens the terminal sheet for a visible chat when no terminal is already open, and leaves it open for reading. Background submissions and an existing terminal leave the current view unchanged. omp's own Copy, Branch and Follow up actions remain available there with omp's restrictions.
- **`/debug`**: A Diagnostics section on the Help page would offer one row per action (open the artifact folder, recent logs, system info, dump the session, test terminal protocols, clear the artifact cache), with a confirmation before clearing.
- **`/pause`**: A modal card titled Chat paused would show the hold time with Resume as the primary action.
- **`/live`**: The omp sheet retains omp's UI, because live voice needs a realtime audio path the app does not have. A later native version would be a composer voice mode with a level meter and Stop.
- **`/annotate`**: An Annotate action on messages and on Files viewer selections would collect feedback into the composer, which is where omp puts it, next to the Changes pane's existing line comments.
- **`/todo edit`**: An Edit checklist sheet would list each task with a text field, a state mark and a delete action, reusing the task card's data. The other `/todo` subcommands already work with result rows.
- **`/local`**: The omp sheet retains omp's session-file picker and external-editor content, using raw keys for focused fallback content in TSP. A future session-files view could reuse the Files pane's viewer and editing controls.
- **`/context`**: omp opens a read-only context viewer in the omp sheet. A native context details dialog could open from the context ring and show its usage breakdown and detailed content.
- **`/usage reset`**: Usage & limits offers Spend a reset on each account that holds saved resets, with a confirmation because a spent reset cannot be returned (DESIGN §4.18). The page sends omp's own `/usage reset <provider>/<credential id>` to a short-lived omp, so no chat is involved. Typed in a chat without a target, the command still opens omp's account picker in the omp sheet.
- **`/advisor configure`**: The Advisor sheet opens from Configure advisors in the work modes menu. It edits the project-root or active agent-directory `WATCHDOG.yml` (or the existing `.yaml`), with per-advisor models, tool access, instructions, cadence (`turn` or `agent-end`, every Nth eligible update) and catch-up (`off`, `1`, `3`, `5`, `strict`). Saving applies the persisted roster through omp's own editor callback while the chat is ready; otherwise the sheet offers Apply saved configuration. Turn advisor on and Turn advisor off retain omp's session toggle. Open file uses the desktop's file association for raw editing.
- **`/git <revision>`**: A Revision sheet would reuse the Changes pane's diff view as a read-only view of the chosen commit.
- **`/seance`**: A Consult a session dialog would pick a chat with the sidebar's chat search and then a model from the composer model list, and the consultation would appear as a helper in the Tasks pane.
- **Session toggles** (`/fast`, `/slow`, `/skillful`, `/extended-context`, `/computer`, `/browser`, `/prewalk`): A Chat options popover on the composer's control row would list each toggle as a switch, reading its state from the command's `status` form and confirming each change from what omp prints, the same way the advisor toggle works.
- **Reports** (`/tools`, `/jobs full`, `/changelog`, `/advisor status`, memory reports, SSH help/list and MCP listings): Supported read-only reports show omp's title and complete body in expandable Result rows. Unknown content or additional actions retain the omp screen. Permanent homes remain the Tasks pane for jobs, Settings → Memory for memory reports, and Help for tools and changelog.
- **Guarded commands**: The app hosts the collab room that mirrors omp into the chat, so starting, restarting or stopping a room from omp, or leaving it, would disconnect the app, and `/join` would replace the chat with another session. `/fork pane`, `window` and `tab` need a terminal multiplexer, which the app does not have; plain `/fork` and split view cover the same needs. Folder and worktree moves are supported through the host extension's owning-session location.

## Keeping this current

The builtin catalog is a copy of omp's registry at the version named in its header. When omp adds a builtin, the command still works when typed, and its description appears once omp lists it over RPC or the catalog is refreshed from omp's `packages/coding-agent/src/slash-commands/`.
