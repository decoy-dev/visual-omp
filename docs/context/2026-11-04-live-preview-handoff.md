# Handoff, 2026-11-04: live previews, Change icon and follow-ups

This session ran beside another session that shipped the 0.7.6 release commit (`9a6876c`, not tagged yet) and later Windows and TSP work. This note covers only this session's work. Nothing here was pushed or tagged.

## Commits on main

- `6998819` fix(composer): a word suggestion that did not fit on the line no longer hides the word being typed. The suggestion now wraps on its own (a `<wbr>` before the ghost span in the highlight mirror).
- `d95502e` docs: `docs/LIVE-PREVIEW.md`, the live preview plan, with the owner's decisions recorded at its end (astra's recommendations accepted on all five questions).
- `e4e42a1` refactor(panes): the Tasks pane and helper transcript dialog load on demand, which made room under the bundle guard.
- `62f917b` feat(sidebar): Change icon in both chat row menus. It saves the emoji through omp (`/rename` for live chats, `set_session_name` for saved ones). The other session's `4719297` also asks omp for emoji title icons in app chats, which prevents most Nerd Font icons in the first place.
- `cc68949` feat(outputs): live preview Phase 1 (Outputs stage, Watch, Stop and redirect, the `vomp-preview:` protocol with prepared HTML snapshots and a script-free, network-free CSP, the turn-scoped watcher, two settings, the scripted provider fixture in `scripts/live-preview-fixture/` and the omp 18.16 abort and steer probe).
- `e60ac87`, `73ac331`, `33f694c`: dialog initial focus for Change icon and Rename chat; one macOS path key so `/tmp/...` and `/private/tmp/...` are one file in Outputs and live previews; Try again for a failed live preview tracker or format load.

## Verification

- Full Vitest suite, typecheck, build and the renderer bundle guard passed after each change. After `33f694c` the entry is 1,591,722 bytes, well under the guard.
- A development build driven over CDP against the fixture (isolated HOME and profile) showed SVG drawing mid-stream, HTML with project assets while remote stylesheets, images, fonts, scripts, meta refresh and link clicks were blocked, three successive PNG revisions, Stop and redirect leaving no file, and Change icon renaming a live chat.
- Headless Chrome with the stage and adapters (no Electron, because the owner's development build was running) confirmed Markdown, Mermaid (last good diagram on a syntax error), CSV with its chart, PDF, image-generator requests, result images, the elision note and the 320px layout. The CSV chart scrolls sideways inside the stage at 320px, which is the existing chart behavior.
- The CDP and headless Chrome screenshots and assertion output were scratch files under `/tmp` and were not kept; these results are recorded only here and in the session's own transcript. The omp 18.16 probe evidence is kept in `scripts/live-preview-fixture/evidence/`: an abort during a streaming `write` saves nothing, and a steer does not stop the write. The UI never describes Send now on the stage.

## Open items

- **Decided, not done:** the bundle guard still allows the old 2,044,096-byte ceiling while the entry is now about 1.59 MB, so a large eager import could pass unnoticed. The owner accepted astra's recommendation to record a new, tighter owner-approved ceiling; do it next session.
- The installed 0.7.5 app's stuck chat is diagnosed in [2026-11-04-handoff.md](2026-11-04-handoff.md): symptoms consistent with the bug addressed by `a7c7343`; memory pressure may have contributed; the fix was not tested on this chat. This session's earlier reading that the renderer was idle came from this machine's replaced `ps` and `top`, which report misleadingly low CPU; use `/usr/bin/top`.
- **Phase 2 first step:** `preview-protocol.ts` sends `Access-Control-Allow-Origin: *` on every response, while the plan says fonts only. Scripts are off in Phase 1, but narrow it before anything enables scripts.
- Not exercised in Electron: Mermaid, Markdown and CSV streaming, a LaTeX PDF, a stream over the collab frame limit, classic (non-TSP) chats, and recovery from a failed tracker load.

## Phase 2

`docs/LIVE-PREVIEW-PHASE2.md` is the implementation plan for Phase 2 (video, Office formats, scripts with per-page network permission, Attach this frame, the opt-in proofs skill). astra approved it after two revisions, with its security and isolation gates mandatory before script-enabled previews ship. Its first slice is a blocking investigation of process isolation for script-running frames and the CORS correction. The owner accepted the recommendation on both of its questions (network permission per file for the app session across chats; the permission includes remote scripts and local-network HTTPS, said in the confirmation text); they are recorded at its end. No Phase 2 work has started.

## Next session: the owner's list

The owner listed these for 2026-11-05 and will choose which to start. Several need feasibility testing before any plan. Pointers are where today's code already touches each item.

1. **Status bar customization:** add and remove status bar items, and offer more metrics to add. Today's items are defined in `src/renderer/src/shell/StatusBar.tsx`, with app metrics from `AppMetricsItem.tsx`, `useAppMetrics.ts` and `src/main/features/app-metrics.ts`.
2. **Mobile and remote session handling** (feasibility first). Hosted chats use a collab relay bound to loopback only (`src/main/omp/relay.ts`); omp's own collab sharing is wrapped by `src/main/features/share.ts`.
3. **Helper conversations like the main transcript:** reflect how omp shows helpers and let the user talk to them as naturally as in the main chat. Today a helper's conversation opens in the Tasks pane's `TranscriptDialog` (`src/renderer/src/features/panes/TasksPane.tsx`), also reachable from the pinned helper strip.
4. **Animation smoothing and general speed polish.** Motion goes through `src/renderer/src/ui/motion.tsx` (AGENTS.md rule).
5. **Continue the live preview phases:** start Phase 2 with slice A (the CORS correction, then the process isolation investigation), plus the bundle ceiling above.
6. **Swap the install method from the wizard to Homebrew or Scoop.** To confirm with the owner: whether this means omp's installation in the setup wizard or visual-omp's own installation (installer versus `Casks/visual-omp.rb` and `bucket/visual-omp.json`, kept current by `scripts/update-homebrew-cask.mjs` and `scripts/update-scoop-manifest.mjs`).

## Cleanup

- All of this session's worktrees and branches were removed after their work was merged into main.
- The fixture's scratch root `/tmp/vomp-smoke` was deleted. To use the fixture again, follow `scripts/live-preview-fixture/README.md` from an existing checkout, substituting that checkout's path for the README's `/tmp/vomp-live-preview`; the server creates its own scratch root.
