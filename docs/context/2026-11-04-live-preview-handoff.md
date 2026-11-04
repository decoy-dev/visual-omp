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
- Headless Chrome with the real stage and adapters (no Electron, because the owner's development build was running) confirmed Markdown, Mermaid (last good diagram on a syntax error), CSV with its chart, PDF, image-generator requests, result images, the elision note and the 320px layout. The CSV chart scrolls sideways inside the stage at 320px, which is the existing chart behavior.
- omp 18.16 probe: an abort during a streaming `write` saves nothing; a steer does not stop the write. The UI never describes Send now on the stage.

## Open items

- **Owner:** the bundle guard still allows the old 2,044,096-byte ceiling while the entry is now about 1.59 MB, so a large eager import could pass unnoticed. astra recommends recording a new owner-approved ceiling.
- **Owner:** the installed visual-omp stopped joining new chats this morning (its window never connected to the new chats' relays while omp started normally). A restart was recommended; the cause was not found.
- **Phase 2 first step:** `preview-protocol.ts` sends `Access-Control-Allow-Origin: *` on every response, while the plan says fonts only. Scripts are off in Phase 1, but narrow it before anything enables scripts.
- Not exercised in Electron: Mermaid, Markdown and CSV streaming, a LaTeX PDF, a stream over the collab frame limit, classic (non-TSP) chats, and recovery from a failed tracker load.

## Phase 2

`docs/LIVE-PREVIEW-PHASE2.md` is the implementation plan for Phase 2 (video, Office formats, scripts with per-page network permission, Attach this frame, the opt-in proofs skill), revised after astra's review. Its first slice is a blocking investigation of process isolation for script-running frames and the CORS correction. Its open questions for the owner are listed at its end.

## Cleanup

- All of this session's worktrees and branches were removed except `/tmp/vomp-loose-ends` (branch `fix/loose-ends`, merged into main), used for these docs.
- The fixture's scratch root `/tmp/vomp-smoke` was deleted. Rerun `scripts/live-preview-fixture/README.md` to recreate it.
