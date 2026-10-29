# omp parity audit, 2026-10-29

visual-omp's first commit was recorded on 2026-09-30 at 16:58 UTC. The latest published omp was 18.4.4 (npm: 2026-09-29T19:44Z); 18.4.5 followed at 2026-09-30T19:17Z, 2 hours 19 minutes after the commit. These timestamps do not establish the version the author had installed. This audit read all 47 subsequent release notes, 18.4.5 through 18.14.0, totaling 7,203 lines across every monorepo package. The six passes checked visual-omp's code against omp 18.14.0's source and, where available, the installed 18.13.3 executable. The [findings appendix](2026-10-29-omp-parity-audit-findings.md) preserves their tables, file:line evidence, no-impact counts, unresolved questions and dated release inventory.

About 2,460 changelog bullets require no visual-omp changes, according to the six reports' approximate counts. They cover provider and catalog fixes, internal changes, Tern-only interface work (the app runs omp with `PI_TUI_NATIVE=0`), and features already handled by existing paths: new settings appear in Advanced, new providers come from `get_login_providers`, new models come from `omp models --json`, and slash commands pass through the terminal.

## Owner decisions (2026-10-29)
- Raise the minimum omp to 18.14 for 0.7.
- Implement full parity, with native handling for every user-facing omp addition since 18.4.4. Keep blocked work explicitly recorded until its prerequisite is available; a temporary disabling pin does not complete parity.
- Run a scheduled workflow against each new omp release and open a triage issue with its notes.
- Record omp API gaps here without filing upstream issues.
- Ship small fixes as 0.6.9 and the larger parity work as 0.7.

## 0.6.9: breaking or misleading today (small fixes)

| omp | Problem in visual-omp | Fix |
|---|---|---|
| 18.12.3 | `tools.approvalMode: always-ask-cached` ("Ask and remember") makes `config:approval` throw (`main/features/config.ts:461,486`): the permission button, General and Permissions settings and the project settings page fail. | Accept the fourth mode in the schema, contract and maps, fall back on unknown modes, and offer "Ask and remember" in the three pickers. |
| 18.11.3, 18.12.3 | Approval prompts now carry "Approve for this session" and grant options. `QuestionCard.tsx:99` only recognises exactly `["Approve","Deny"]`, so these prompts fall to the generic card, where "Answer" picks option 0: under Ask and remember that is a folder grant. | Recognise approvals by their `Approve` / `Approve Once` and `Deny` labels, keep the one-time approval as the default, and show the session and grant choices as extra buttons. |
| 18.11.0 | Sending a message with Send now while approval is pending denies the call and steers the turn, without explaining the denial (`state/session.ts:864`). | Add a note on the approval card or queue tray that Send now denies the pending action. Keep the explicit "Deny and say why" action in 0.7. |
| 18.12.0 | Opus 5.5 replies between tool calls arrive as thinking blocks marked `narration: true`; the app folds them as thoughts, hiding mid-task answers. | Carry `narration` in the wire type and render those blocks as reply text, in grouping, playout and announcements. |
| 18.10.2 | Background job updates arrive after the tool call ended; the client adds them to `activeTools` (`collab/lib/client.ts:484-497`) and the Tasks pane forces those jobs to running (`derive.ts:355-367`). | Track ended call ids, keep late frames out of `activeTools`, and take the job state from `details.async.state`; give `cancelled` a neutral tone (`bash.tsx:94-97`). |
| 18.14.0 | `out://` interim replies are on by default; the app shows them as a file write and ignores bash `details.replies`. | Pin `out.enabled: false` in 0.6.9. Remove the pin in 0.7 once both reply paths render as assistant prose, reach reply announcements, and exclude `out://` from file links. |
| 18.7.0, 18.8.0 | omp tells the model that `svg` blocks render as pictures and that tables get charts; the app shows code and no charts. | Pin `tui.renderSvg: false` and `tui.autoGraph: "off"` in 0.6.9. Remove the respective pins in 0.7 once native SVG and Mermaid replies and write previews, and native table charts, are implemented. |
| 18.8.6 | `worktree.onStart: create` or `ask` moves app-hosted chats into a worktree the app cannot follow; `onExit: ask` is cut short on close. | Pin `worktree: { onStart: "off", onExit: "keep" }` in 0.6.9. In 0.7, follow omp's worktree folder and session moves and resolve its exit choice before shutdown. Remove `onStart` and `onExit` pins only when their corresponding native handling is implemented. |
| 18.9.0 | When enabled, `composer.predictions` makes an additional model request after each turn; the prediction appears only in the hidden terminal. | Pin `composer.predictions: false` in 0.6.9. Implement native next-message predictions in 0.7 and remove the pin once the composer displays and accepts them. |
| 18.4.6 | Idle recaps make a model request and appear only in the hidden terminal, according to the source trace; runtime behavior remains unverified. | Pin `recap.enabled: false` in 0.6.9. Implement recap notices in 0.7 and remove the pin once the native transcript displays them. |
| 18.12.4 | Saved and followed chats ignore `activeLeafId`, so a file ending in an off-branch entry shows the abandoned branch. | Resolve the leaf the way omp does (`resolveSessionLeafId`). |
| 18.6.3, 18.7.0 | An omp that exits at startup (missing session file, `retry.modelFallback: false`) shows only "omp exited (code N)". | Keep the last screen lines as the exit reason, and offer a fresh chat when the session file is missing. |
| 18.8.7 | `omp update --check` for an omp managed by another app prints a message the app can't parse ("Unrecognized omp update output"). | Recognise the managed-install message and hide Update. |
| 18.13.0, 18.13.2 | The command catalog is from 18.12.2: no `/local`, no `/subagents` alias (it opens omp's hub in the sheet), and `/context` is listed as a result although it now opens a viewer. | Refresh the catalog and COMMANDS.md from 18.14; route `/subagents` like `/hub`. |
| 18.12.0 | Symlinked session buckets can list a session twice. | Skip symlinked buckets, as omp does. |
| 18.11.0 | Helper and skill discovery walks beyond omp's home and temporary-root ceilings; project helper creation can write into ignored folders, including the default `/tmp` (`agents/service.ts:59-68`, `skills/service.ts:276-290`). | Match omp's discovery ceilings for home, `/tmp`, `/var/tmp` and `os.tmpdir()`, including their ancestors, in both walks. Hide or disable project scope at a ceiling. Project config loading is a separate open question. |
| 18.10.2, 18.11.0 | The helper parser injects `yield` and grants default tools for malformed `tools`; Duplicate drops `structured` (`agents/parse.ts:159-165`, `HelpersSection.tsx:125-141`). | Match omp's parser: stop injecting `yield`, give malformed `tools` no tools, parse `structured`, and preserve it through Duplicate. Correct the existing editor's tool-access description; keep the expanded structured-results editor in 0.7. |
| 18.4.9, 18.5.0, 18.13.2 | Live continuation following depends on omp's version. The host updates the file on room reconnect (`host.ts:239-245`), which covers newer room rotation; earlier continuation paths can leave it stale (`host.ts:191-195`). | Follow `continuationOf` in the host for every supported version that can continue into another file, including versions without room rotation. Update the tab and navigation's current session file and show omp's session-moved warning. Keep sidebar and search chain consolidation in 0.7. |

Until native helper-job nesting is implemented, update the `/jobs` row in `docs/COMMANDS.md` to direct readers to `/jobs full` for helper-owned jobs.

## 0.7: parity (requires omp 18.14)

### Groundwork
- Raise the minimum omp to 18.14, refuse older versions with a clear "Update omp" path, remove compatibility code, and update README and docs.
- Schedule the test suite and a live smoke test against each new omp release, and open a triage issue with its notes and a checklist.

### Transcript and tools
- Render `out://` interim replies and bash `details.replies` as assistant prose, streaming where collab carries it, and include them in reply announcements. Exclude `out://` from file links, then remove the `out.enabled` pin.
- Render SVG and Mermaid natively in replies and write previews, and implement native table charts. Remove the respective `tui.renderSvg` and `tui.autoGraph` pins after those paths are implemented.
- Render Python `cells[].views` as tables, JSON trees and Markdown, replacing the corresponding plain output spans (18.12.1).
- Show the section label, field tree and rejection reason on the Submit Result card (18.8.7).
- Show MCP tool progress on running cards and eval cells (18.12.4).
- Strip `?q=` filters from read-tool file paths, show the filter as a badge, and retain JSON highlighting (18.7.0).
- Split title cards' `<icon> <CODE>: title` into an icon and a code chip, and map or strip Nerd Font glyphs (18.8.0, 18.8.7).
- Give file commands with `side: true` frontmatter the same handling as `/btw` (18.13.0).

### Tasks, helpers and jobs
- Add Stop to the viewer's running background jobs through `/jobs kill <id>`, add Stop all through `/jobs kill all`, and show the job's folder (18.4.6, 18.8.8).
- Nest helper-owned background jobs under their helper, without a Cancel control. Retain the documented `/jobs full` route until this view is available (18.11.1, 18.12.4).
- Show helper `stage` text and `completionPercent` on helper rows and task cards (18.4.11, 18.12.3).
- Render job widget headlines and all supported widget chart output in job and wait cards and the Tasks pane. A compact sparkline alone does not satisfy full parity; provide the full chart view as part of 0.7 (18.12.3).
- Show "Waiting for background jobs" from `agent_end.awaitingAsyncWork`, with a Stop waiting action (18.13.0).
- Add a "Return structured results" switch for `structured: true`, and explain that the output schema requires it. Parser correctness and Duplicate preservation are 0.6.9 work (18.10.2, 18.11.0).
- Add per-helper account pools through `task.agentAccountPools` (18.8.1).

### Sessions
- Consolidate `continuationOf` chains as one chat in the sidebar and search, and make tree, rewind and fork resolve the newest linked session. Host continuation following across supported versions is 0.6.9 work (18.4.9, 18.5.0, 18.13.2).
- Use omp's session lease for ownership checks, retaining the lsof and ps heuristics as a fallback where required (18.4.9, 18.5.0).
- Read and write omp's `session-pins.json` with its lock-and-atomic-replace pattern, and migrate the app's existing pins (18.14.0).
- Rename saved chats without opening them, using omp's title-slot format (18.13.3).
- Offer "Continue where omp stopped" after a crash, restarting with `--restore` (18.10.3, 18.11.2).
- Fork through RPC `fork(entryId)` once its live-source ownership and mutation behavior is established, replacing `/tree` driving (18.4.11).
- Add session transfer through `omp session pack` / `unpack`, and anonymized export through `omp anonymize`, to the Share dialog (18.8.8, 18.10.0).
- Implement native handling of omp's worktree startup choices, follow resulting folder and session moves in the host and views, and resolve keep/remove/ask exit behavior before terminating omp. Remove the corresponding `worktree.onStart` and `worktree.onExit` pins when each path is implemented (18.8.6, 18.8.7).

### Settings, models and usage
- Add "Forget remembered approvals" under Permissions through `/forget-approvals`; the "Ask and remember" pickers are 0.6.9 work (18.12.3).
- Add a Restricted folders list and computer-control policy to Permissions (18.13.1, 18.14.0).
- Add the `widget` model role to Models & roles, including its fallback and description (18.12.3).
- Mark the active model preset in Presets, matching role assignments and thinking level (18.6.0).
- Add per-model compaction limits supporting the base token form (`90k`), percentages (`80%`) and fixed limits (`f400k`). Show a "compacts at" preview and omp's extended-window warning above the standard window (18.8.5, 18.8.8).
- Preserve all `pricingStatus` values: apply the low-cost badge only to eligible `fixed` prices, label `free` explicitly, and show no low-cost badge for `included`, `unknown` or `variable` (18.4.5).
- List and edit `contextFiles.extra` instruction files on the Instructions page (18.8.8, 18.9.0).
- Hide Tern-only settings in Advanced once omp exposes their UI conditions. This is externally blocked: an isolated 18.14.0 runtime listed 574 settings with only `value`, `redacted`, `type` and `description` fields, matching `cli/config-cli.ts:223-229`; `cfg://` also omits conditions. Keep the settings visible until omp provides a metadata path (18.6.3).
- Show account routing `policy` (priority, reserve and state) in Usage & limits, preserve omp's usage-window order, and list saved resets through `omp usage reset --json`, using the CLI exit code when spending one (18.8.5, 18.9.0, 18.13.0).
- Fold aliased logins such as `openai-codex-device` into the base provider, and add sign-in export and import through `omp auth export` / `import`. Exact alias metadata is externally blocked until omp exposes `storeCredentialsAs`; retain that part of parity explicitly (18.7.0, 18.8.1, 18.10.0).
- Add a Sign in action for OAuth servers in Connected tools. Run `omp -p '/mcp reauth <name>'` in the project folder and report failure through its exit code (18.12.6).
- Offer Update for npm and git plugins through `omp plugin upgrade` (18.4.5).
- Let omp choose the Stats dashboard port and read its printed URL (18.14.0).

### Composer and approvals
- Add "Deny and say why" to approval cards through the composer's steer path. The Send now denial warning is 0.6.9 work (18.11.0).
- Implement ghost-text word completion through `predict_word` and feedback, plus native next-message predictions. Remove the `composer.predictions` pin once the latter can be displayed and accepted (18.4.9, 18.9.0).
- Show "Starting…" until dictation is recording, and treat cancellation during startup as cancellation. This parity item is blocked pending investigation of TUI debug values and status-line state; it is externally blocked only if those paths cannot provide the state and omp must expose it (18.11.0).

### Other
- Implemented: the terminal mirror uses the active omp theme's `terminal` background, foreground and ANSI palette. The app-hosted extension can read compiled bundled JSON through the public `@oh-my-pi/pi-tui/theme/loader` export; the previously reported bundled-theme blocker is resolved. Custom JSON themes use the same path (18.4.8).
- Read omp's OSC 7501 program status for waiting and error states (18.8.7).
- Display idle recaps as transcript notices and remove `recap.enabled: false` once that presentation works (18.4.6).
- Implemented: the native Advisor sheet edits per-advisor cadence and catch-up policy in omp's `WATCHDOG.yml`/`.yaml`, applying through omp's own configuration editor callback (18.4.10).
- Implemented: the app-hosted extension reports mode state through `ctx.sessionModes` and `mode_changed`, and native plan, vibe, goal and loop controls request transitions directly. Status labels no longer determine modes (18.13.2).
- Read config layers with `omp config list --scope`, retaining comment-preserving YAML editing (18.13.3).
- Implemented: preserve startup-model substitution warnings from omp's painted startup warning rows, including word-wrapped model names. The warning still has no collab notice, but this screen path was verified on isolated 18.14.0 without a model prompt.
- Retain native retry-fallback and manual-compaction event parity as externally blocked work until omp forwards those events through collab (18.13.x, 18.14.0).

## omp API gaps
- Collab does not forward `retry_fallback_applied` or `manual_compaction_*` in 18.14.0. The retry event's reason is therefore unavailable through that event path; the reports do not establish whether saved model-change records omit it.
- The startup warning for an unavailable default or dictation model is sent only through startup notifications (18.14.0). Recognized startup screen capture provides the native presentation.
- `get_available_commands` does not expose a command's `side` flag; the file frontmatter provides an app-readable alternative (18.13.0).
- `get_login_providers` does not expose `storeCredentialsAs` for aliased logins (18.8.1).
- Config list JSON and `cfg://` omit `ui.condition` and any equivalent Tern-only classification. The Advanced visibility rule requires omp to expose that metadata (verified on 18.14.0).
- Collab has no dedicated background-job snapshot channel. The app can still derive jobs from tool results and forwarded updates (18.11.1).
- Early-input readiness is externally blocked: the collab room can connect before the editor's bootstrap submit gate opens and before outer startup dialogs finish. omp must expose `startupComplete` or equivalent input readiness through collab, the debug socket or an extension API. A live collab snapshot alone cannot establish readiness. Native worktree preflight waits for an already-painted question to finish, but does not close the question-not-yet-painted race.

## Open questions to settle through source inspection or runtime checks

The [findings appendix](2026-10-29-omp-parity-audit-findings.md) preserves each report's proposed check. Use 18.14 for 0.7 checks, and retain version-specific checks for 0.6.9's supported versions.

- Check 18.14.0's collab protocol version against the app's `COLLAB_PROTO` 3.
- Established: deferred startup can expose a live collab room before input is safe. The source trace and the required readiness metadata are recorded under omp API gaps and in the findings appendix.
- Check whether `narration`, `agent_end.awaitingAsyncWork` and streaming `write out://` arguments survive collab replication.
- Check whether a jobs widget headline containing "Plan", "Goal" or "Loop" can confuse `parseStatusLine` mode detection.
- Check plan-review keys in the classic interface against `PlanReviewCard.tsx`.
- Check whether `/rename` can exceed the app's 10-second wait when it asks the title model for a card.
- Check project config loading in home and temporary folders, separately from helper and skill discovery ceilings, using the source reported by `omp read cfg://`.
- Establish whether RPC fork claims or mutates the source session file while the chat is live, including its ownership and modification time.
- Resolve Linux session-lease socket names and Windows mutex identifiers from the matching pi-utils file-lock implementation.
- Capture `/omfg` inline prompts and check them against `ompDialog.ts`.
- Check whether interrupting a queued steer omits collab `agent_end`, and whether that affects the app's queue logic.
- Capture the saved-reset status-line indicator and check its effect on editor-border parsing.
- Check thinking choices for unverified models, including `reasoning` metadata and whether Auto disables thinking.
- Check slash-command behavior during a pending approval, including whether Send now submits `/btw` as a command or as a denial message.
- Check whether widget, stage and percentage fields persist in session JSONL or exist only in live snapshots.
- Trace live mirror `displayLeaf` handling of off-branch entries, separately from the confirmed saved-history fix.
- Capture approval option ordering on 18.13.3; the original audit established the order only in 18.14.0 source.
- Inspect TUI debug values and the status line during dictation startup, recording and transcription before classifying state availability as an omp API gap.
- Observe idle recap behavior at runtime; the audit traced its source but did not observe one.
- Capture numeric-table output and inspect usage to establish hidden-terminal auto-chart rendering and judge-model requests in `auto` and `smart` modes. Native table charts remain committed 0.7 work regardless of that runtime result.
- Establish whether saved model-change records include retry fallback reasons; the supplied reports do not settle this.

The historical question about reset JSON availability in 18.9 is retired for the 0.7 implementation because its minimum is 18.14, where the report confirmed `omp usage reset --json`.
