# Live previews, Phase 2: implementation plan

Written 2026-11-04 against `main` at `8206da5` (0.7.6, untagged), from `docs/LIVE-PREVIEW.md` (whole file, including Owner decisions and the Phase 1 notes) and the Phase 1 code. Revised the same day after astra's review ("adopt with required changes"). Paths are relative to the repository root. `[INFERENCE]` marks a claim no source, probe or command confirmed. The original plan made no repository changes and ran no Electron, dev server or browser. Slice A1 was implemented on 2026-11-05 as described below.

## Objective

Extend the Phase 1 stage to video (playback with range requests, parsed render progress, key frames), DOCX, XLSX and PPTX, saved HTML pages that run their scripts with an optional per-page network permission, Attach this frame, and the opt-in `visual-proofs` omp skill, whose proof always waits for the person's answer (Owner decision 2). Phase 1's guarantees stay: no added model requests, narrow grants, no network by default, every adapter lazily loaded.

## Findings in the Phase 1 code

1. **Wildcard CORS on every response, corrected in A1.** Phase 1's `headers()` sent `Access-Control-Allow-Origin: *` for every type, while `docs/LIVE-PREVIEW.md` specified fonts only. Since 2026-11-05, only WOFF, WOFF2, TTF and OTF font responses carry it.
2. **One global policy.** `PREVIEW_CSP` is a constant (`preview-protocol.ts:13`). Scripts and network need a per-grant policy.
3. **No script, module, video or Office types.** `TYPES` (`:15-24`) lacks `.js`, `.mjs`, `.mp4`, `.webm`, `.mov`, `.m4v`, `.docx`, `.xlsx`, `.pptx`; these answer 415 today. `cap()` (`:147-149`) knows PDF, raster images and text only.
4. **Whole-file reads only.** `readPreviewDocument` buffers the file (`:152-182`); `handlePreviewRequest` ignores `Range` (`:184-201`).
5. **The renderer cannot fetch the protocol.** Renderer `connect-src` has no `vomp-preview:` (`src/renderer/index.html:7`); Office bytes come over IPC, as PDFs do through `panes:readPdf` (`src/shared/contracts/panes.ts:48`).
6. **Renderer `img-src` allows `https:`** (`src/renderer/index.html:7`). Anything rendered into the app document itself (DOCX) can load remote images unless the adapter removes them.
7. **Watcher allowlist.** `VISUAL_EXT` (`src/main/services/preview-watch.ts:12`) covers images, SVG, PDF and HTML only.
8. **One subject per file.** File subjects are keyed by path (`src/renderer/src/features/live-preview/subjects.ts:190-209`, id at `:203`), so a numbered frame render would make one chip per frame.
9. **Progress text is already available.** `pathsOf` joins a running call's partial text (`subjects.ts:110-113`).
10. **Subframe device permissions are denied in main.** Both handlers require the app's main frame (`src/main/index.ts:58-63`, `src/main/services/app-origin.ts:26,39`).
11. **No `message` listeners** in the renderer (only the collab WebSocket's `onmessage`), so a frame's `postMessage` reaches nothing. Pinned by a test in slice F.
12. **No `session.webRequest` use** anywhere in `src/`, so a request filter on the window's session would not contend with another listener.
13. **Attach path exists.** `attachPaths` (`src/renderer/src/chat/composer/attach.ts:32-39`) and `composer:saveTemp` (`src/main/features/composer.ts:94-97`).
14. **omp's agent folder** is resolved by `ompAgentDir()` (`src/main/omp/config-file.ts:35`), which honors `PI_CODING_AGENT_DIR` and profiles.
15. **Lazy boundaries.** Tracker lazy (`src/renderer/src/features/live-preview/index.ts:5`), adapters behind `import()` (`formats/index.ts:4-16`), `Stage` statically imported by `OutputsPane.tsx:24`. The bundle guard checks entry size and forbidden initial-chunk modules (`scripts/guard-renderer-bundle.mjs:9-11,35-38`).
16. **No virtualization library** in `package.json`.
17. **This machine:** `ffmpeg` is installed; LibreOffice is not.

## Slice order

Each slice is vertical: code, tests and its fixture scenario land together.

| Slice | Content | Depends on |
|---|---|---|
| A | Security and isolation decisions: CORS correction (A1), process isolation investigation (A2, blocking for F), exfiltration test page (A3) | none |
| B | Minimal shared contract: per-grant policy function and per-type response table, no new served types | A1 |
| C | Video, complete | B |
| D | Office (DOCX, XLSX, PPTX), complete | B |
| E | `visual-proofs` skill | none (independent of B) |
| F | Scripts in saved HTML and the network permission, on the architecture A2 chose | A, B |
| G | Attach this frame, after F settles where script pages render | C, D, F |
| H | Docs and changelog | all |

C, D and E run in parallel. `preview-protocol.ts` is edited by A1, B, C and F, and `Stage.tsx` by C, D, F and G; each file has one integration owner who merges in that order.

## Slice A: security and isolation decisions

### A1. CORS correction (done 2026-11-05, ships alone as a Phase 1 fix)

- `headers(type)` sends `Access-Control-Allow-Origin: *` only for the served `font/*` types: WOFF, WOFF2, TTF and OTF. EOT retains its existing MIME type without the header. Refused requests carry no CORS permission. Module scripts (slice F) will get it only for `.js`/`.mjs`, added in F with its tests.
- Phase 1 needs CORS permission only for fonts loaded by the opaque-origin HTML frame. Its HTML, stylesheets and images load without it. Image subjects load through the app document's `<img>` elements without `crossorigin`; PDF subjects use `panes:readPdf` and the app's Blob viewer. Neither subject needs a cross-origin response header.
- Protocol tests cover GET and HEAD font responses, HTML, CSS, raster images, SVG, PDF, text and EOT responses without the header, refused font requests, and prepared HTML revisions without the header. Live and saved HTML retain the scripts-off CSP, no-store and nosniff policy.

### A2. Process isolation investigation (blocking for F)

Question: does a sandboxed, opaque-origin `vomp-preview:` iframe run in a renderer process other than the app's? [INFERENCE: Chromium's sandboxed-iframe isolation may apply; unverified for custom schemes in Electron 44.]

Evidence required, from a **packaged** build (`npm run dist:mac` in a scratch worktree, not the owner's running dev build), recorded under `scripts/live-preview-fixture/evidence/isolation/`:

1. `webFrameMain` for the preview iframe (`contents.mainFrame.framesInSubtree`) and its `osProcessId` versus `contents.mainFrame.osProcessId`, plus `app.getAppMetrics()` before and after the frame loads.
2. A saved page with `sandbox="allow-scripts"` and a button that runs `while (true) {}`. After clicking it, typing in the composer must echo within 100 ms for 10 seconds, the stage's Close must work, and closing must free the busy process (CPU of that PID drops to idle in `app.getAppMetrics()`).
3. Repeat on Windows; record macOS and Windows results separately.

Decision rule: iframe scripts are allowed only if 1 shows distinct process IDs and 2 passes on both platforms. Otherwise F uses the WebContentsView design below. The decision and evidence go into `docs/LIVE-PREVIEW.md` before F starts.

### Fallback design: one WebContentsView per script-enabled page

Used if A2 fails, and only for saved HTML with scripts on. Streaming and script-free pages keep Phase 1's iframe.

- **Session.** `session.fromPartition("vomp-preview-scripts")`, an in-memory partition (no `persist:` prefix), created once. Nothing from the app session (cookies, storage, permissions) is shared.
- **Protocol.** `ses.protocol.handle("vomp-preview", handlePreviewRequest)` on that session, the same handler and grants; the app session's registration stays for iframes. The scheme is already registered as privileged app-wide (`registerPreviewScheme`, `preview-protocol.ts:68-72`).
- **webPreferences.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload, `webSecurity: true`, `spellcheck: false`, `navigateOnDragDrop: false`, `safeDialogs: true`, `disableDialogs: true`, `autoplayPolicy: "document-user-activation-required"`, `backgroundThrottling: true`.
- **Permissions.** `setPermissionRequestHandler` and `setPermissionCheckHandler` deny everything; `setDevicePermissionHandler` denies; `setDisplayMediaRequestHandler` denies; `will-download` cancels; `setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` on the view's contents [INFERENCE: verify it blocks STUN from the page].
- **Network enforcement.** `ses.webRequest.onBeforeRequest` allows `vomp-preview:` and, only for pages with permission, `https:`; it cancels everything else. The listener is the only one on that session.
- **Origin and sandbox parity.** A top-level view does not inherit the iframe's `sandbox` attribute or its opaque origin, and Electron's `sandbox: true` is process sandboxing only. Every HTML response loaded into the view therefore carries the CSP directive `sandbox allow-scripts` (without `allow-same-origin`), which gives the page an opaque origin and blocks forms, popups and top-level navigation as the iframe does. Tests check parity with the iframe for origin (`self.origin` is `"null"`), storage (`localStorage`, `indexedDB` and cookies unavailable), forms and navigation.
- **Navigation.** `will-navigate`, `will-frame-navigate` and `will-redirect` cancel everything except loads main itself starts: main records the exact URL it is about to load into the view (`view.webContents.loadURL`) and allows only that navigation, since the iframe's initiator rule has no meaning for a top-level view. `setWindowOpenHandler` denies, and `http(s)` links go to `shell.openExternal` only when the person clicks Open in browser.
- **Layout.** The renderer reports the stage slot's rectangle with `preview:viewBounds(token, rect | null)`; main converts CSS pixels with the window zoom factor and sets the view's bounds in `mainWindow.contentView`. A view draws above the app's DOM, so the renderer sends `null` (hide) whenever an app overlay is open (menus including the stage's `DotsThree`, dialogs, the expanded layer, popovers), when the Outputs pane is hidden or scrolled so the slot is not fully visible, and when the window is narrower than the stage. The slot shows the last captured frame while the view is hidden.
- **Lifecycle.** Created on the first saved revision with scripts; navigated per revision; destroyed (`webContents.close()`) on token revoke, subject switch, stage close, chat close, window reload and `render-process-gone` of the app; on the view's own `render-process-gone` the slot says "This page stopped" with Reload. Stop on the stage and closing the subject call `forcefullyCrashRenderer()` first if the page is unresponsive (`unresponsive` event).
- **Focus and keyboard.** Tab into the view and Escape back to the stage are handled by `before-input-event` on the view [INFERENCE: check screen reader exposure].
- **Capture.** `view.webContents.capturePage()` directly (slice G).

The fallback's cost is estimated after A2, from the investigation's findings; this plan does not guess it.

### A3. Exfiltration and exposure test page (fixture `fixture exfil`)

A saved page that tries every channel with scripts on and network off, run against whichever architecture A2 picks, plus unit tests of the policy strings. It must log every attempt to its own DOM and the test reads the DOM through `capturePage` or the test harness:

- `fetch`, XHR, `navigator.sendBeacon`, `WebSocket`, `EventSource` to `https:` and `http://127.0.0.1`; `<img>`, `<link rel=stylesheet|prefetch|preconnect|dns-prefetch>`, `<video>` and CSS `url()` to `https:`; `RTCPeerConnection` with a STUN server; form submit; `location` and `window.open`; `<meta refresh>`; `<a download>`.
- Canvas readback of a granted image and of a granted video frame (`getImageData`, `toDataURL`) must throw (tainted).
- `fetch("vomp-preview://<own token>/style.css")` and `document.styleSheets[0].cssRules` on a granted stylesheet must fail.
- A module import of a granted `.mjs` must run (F adds ACAO for scripts).
- A request to another live grant's token (passed in by the harness, since a page cannot learn other tokens) succeeds by capability only if the token is known; the test proves a page's DOM and URL never contain another token.
- DNS prefetch and WebRTC are shipping gates, not residuals: the product promises that a page without network permission makes no network requests. The page must produce no DNS lookup for `dns-prefetch` or `preconnect` hints and no STUN or other UDP traffic from `RTCPeerConnection`, checked with a local DNS and packet log during the test. If either channel cannot be closed for the chosen architecture (for example with `setWebRTCIPHandlingPolicy` and by stripping resource hints), scripts stay off until the owner explicitly approves a narrower promise.

What a script-enabled page can learn from granted files with network off, documented in `docs/LIVE-PREVIEW.md`: whether a granted path exists (load and error events), an image's or video's dimensions and duration, a font's rendering, and whatever a granted `.js` file computes when it runs in the page. It cannot read image pixels, video pixels, stylesheet rules, HTML or other text of granted files. With network on, all of that becomes sendable to `https:` destinations.

Separate protections, each tested on its own: response CSP, opaque origin, per-subject grants and containment, navigation guards, main-frame checks on IPC and permissions, and (fallback) the separate session and request filter.

## Slice B: minimal shared contract

Implemented on 2026-11-05: the response table owns MIME types, read limits and CORS, each grant owns its scripts-off and network-off policy, and successful `preview:prepare` calls return that policy. Slice B introduces no served extensions.

- `preview-protocol.ts`: `previewPolicy(grant)` replaces the `PREVIEW_CSP` constant and returns Phase 1's exact string for every grant until F changes it; `headers(type, grant)` builds per-type headers (A1's CORS rule). A table `{ type, cap, cors }` replaces `cap()` so slices C, D and F each add their rows. No new extensions are served in B.
- `src/shared/contracts/preview.ts`:

```ts
/** What a preview document may do; main enforces it, the renderer mirrors it. */
export interface PreviewPolicy { scripts: boolean; network: boolean }
/** Phase 1's union gains the policy main will serve this revision with. */
export type PreviewPrepared =
	| { ok: true; policy: PreviewPolicy }
	| { ok: false; reason: "missing" | "tooLarge" | "notFile" | "revoked" };
```

- Tests: every Phase 1 protocol test passes unchanged; `preview:prepare` returns `policy: { scripts: false, network: false }`.

## Slice C: video

Implementation checkpoint, 2026-11-05: B completed first (typecheck and 66 existing protocol/HTML tests passed), then C added the protocol, watcher, parsers, render subjects, sequence handling and lazy video/contact-sheet adapter together. The affected suite passed 350 tests across nine files; the final incomplete-file and sequence-deletion regressions passed with all 54 subject/video tests. Four Node fixture tests passed. Real fixture commands produced 19 distinct ffmpeg frame updates through frame 180, six sequence frames plus three unrelated photos, and successful replay of both captured renderer logs. No generated media is committed.

A headless Chrome harness exercised the actual stage and video adapter over a local HTTP video, with mocked app actions and grant addresses. Playback reached six seconds, a key-frame click sought to 3.57 seconds, and six key-frame tiles used two columns. At 320 px and the maximum 130% text scale, the player was 288.8 px wide, Stop remained available and the page had no horizontal overflow. Light and dark renders were inspected. This does not establish Electron codec behavior, custom-scheme playback, CORS tainting or Windows behavior.

The production build and renderer guard passed after rebasing onto main's hidden-window rendering fix. The entry was 1,601,993 bytes, below the shared 1,611,722-byte ceiling. The lazy video chunk was 3,797 bytes, sequence 234 bytes, and combined subjects/progress/command parsers 17,458 bytes. Temporary test caches, media and the headless server were removed. The integration owner still owns the final full-suite run and Windows Electron acceptance; the fixture README lists the video steps.

Review corrections, 2026-11-05: video requests reserve one of four per-grant and sixteen global slots before opening a file, including pending opens. Excess requests return `429`; every refusal and descriptor-close path releases its reservation. Premature EOF errors the response body, while growth stays within its original advertised extent. FFmpeg totals now come from the recognized invocation's tokenized input/output scopes, with unknown totals for ambiguous limits. Animation-local percentages keep an unknown-total progress bar indeterminate. After rebasing onto main with A2's tooling, typecheck, 422 affected Vitest tests and 17 Node fixture/evidence tests passed. The rebase preserves the isolation-test identity checks, both fixture scenario sets and both Node test lists. No production build was rerun for these review corrections; the integration owner owns the final build and full-suite run.

**Types and watcher.** Add `.mp4`, `.m4v` (`video/mp4`), `.webm`, `.mov` rows in the same change as the ranged handler, so no video is served before streaming exists. Add the extensions to `VISUAL_EXT`; skip path segments named `partial_movie_files` (manim's per-animation files [INFERENCE: manim CE layout from its docs]) the way `.git` is skipped (`preview-watch.ts:61-63`).

**Ranged handler** for `video/*`:

- Opens with the same `O_NOFOLLOW`, inode and containment checks as `readPreviewDocument`, then streams from that handle (`createReadStream({ fd, start, end })` through `Readable.toWeb`) with backpressure, never buffering the file.
- `bytes=a-b` and `bytes=-n` (suffix) answer `206` with `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`. An open-ended `bytes=a-` answers `206` for at most 8 MiB from `a`, with a `Content-Range` that states the shorter end; this is the only place the 8 MiB cap applies. A request without `Range` answers `200` with the whole file streamed from the handle (bounded memory, no body cap). Unsatisfiable or multi-range requests answer `416` with `Content-Range: bytes */size`. HEAD answers headers only.
- Cancellation: when the request's signal aborts, the stream is destroyed and the handle closed. Revocation: each grant keeps a set of active streams; `revokePreview` and `revokeAllPreviews` destroy them.

**Progress** (new `src/renderer/src/features/live-preview/progress.ts`), pure functions from a call's command and output tail to `LiveProgress | null`, returning `null` rather than a guess:

- ffmpeg: last `frame=\s*(\d+)` and `time=`, total from `-frames:v`, `-t`, `-to`, or `Duration:` if still in the tail; also `-progress pipe:1` keys.
- Remotion: rendered and encoded `N/M` counts [INFERENCE: strings vary by version; captured from Remotion's own logs first].
- manim: tqdm `Animation (\d+): .*?(\d+)%`; "File ready at" gives the output path.
- LaTeX: `Output written on (.+?) \((\d+) pages?`.

```ts
export interface LiveProgress {
	tool: "ffmpeg" | "remotion" | "manim" | "latex";
	done: number; total: number | null;
	unit: "frame" | "second" | "animation" | "page";
	percent: number | null;
}
```

**Render subjects** (`subjects.ts`, `types.ts`): `LiveSubjectKind` gains `"render"`, `LiveFormat` gains `"video"` and `"sequence"`, `LiveSubject` gains `progress` and `sequence`. A running bash or eval call whose command is a recognized renderer becomes a `render` subject with progress and its parsed output path; it switches to `file` when the watcher reports that path stable, as elided writes do (`subjects.ts:185-187`). `isVisualCall` (`:55-58`) recognizes these calls.

**Frame sequences, only for identified render outputs.** Coalescing applies only to output patterns parsed from a recognized render command: ffmpeg output arguments containing `%0Nd` or `%d`, Remotion `--sequence` with its output folder, manim `--save_pngs`, Blender `-o` with `#` runs. The renderer passes them to main:

```ts
export interface PreviewSequencePattern { folder: string; prefix: string; digits: number | null; suffix: string }
// PreviewWatchRequest gains: sequences: PreviewSequencePattern[]
// "preview:watchNamed" becomes args: [watchId: string, named: string[], sequences: PreviewSequencePattern[]]
// PreviewChange gains: sequence?: { pattern: PreviewSequencePattern; count: number }
```

Main reports only the newest matching file per pattern per debounce, with the count. Files matching no declared pattern are reported individually, as today, so unrelated numbered images never merge.

**Adapter** (new `formats/video.tsx`): `<video controls preload="metadata" muted playsInline>` with `?rev=`; codec failure (`MEDIA_ERR_SRC_NOT_SUPPORTED`) shows "This video format cannot play here" and Open in Files; a load error keeps the last good revision. During `render`, a progress bar and "Rendering · frame 120 of 300".

**Key frames.** After `loadedmetadata`, a second hidden `<video>` seeks to six evenly spaced times and draws each to a small canvas (display only; tainted canvases are fine). Tiles wrap to two columns at 320 px. Clicking a tile seeks the player. The app runs no ffmpeg; key frames before the full render come from proofs (slice E).

**Fixtures:** `fixture video` (bash runs `ffmpeg -f lavfi -i testsrc=duration=6:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -progress pipe:1 out.mp4`), `fixture sequence` (a declared `%04d.png` pattern plus three unrelated numbered images in the same folder), `fixture progress` (replays recorded Remotion and manim logs from new `scripts/live-preview-fixture/samples/`, each with its tool version line).

Acceptance:
1. Playback, seeking to middle and end; DevTools shows `206` with correct `Content-Range`; open-ended responses never exceed 8 MiB; a request without `Range` gets `200` streamed.
2. Unit tests: explicit, suffix, open-ended, past-end (`416`), multi-range (`416`), HEAD, symlink out of grant, revoked token, and a stream destroyed by abort and by revocation with its handle closed (no open descriptor afterwards).
3. The ffmpeg fixture shows "frame N of 180" advancing at least three times while the file is incomplete, and the stage shows the video only once it is decodable. The integration owner approved this wording on 2026-11-05 because ffmpeg creates its incomplete output file before its first progress update.
4. Parsers pass against every recorded sample; unknown output yields `null`.
5. The declared sequence shows one chip with the newest frame and count; the three unrelated images stay separate.
6. A ProRes `.mov` shows the unsupported note.
7. A stale revision's result never replaces a newer one (video, key frames).
8. At 320 px and the largest text size, the progress line, player controls and contact sheet remain usable and Stop stays visible.

## Slice D: Office

**Bytes and limits** (main): `preview:readBinary(token)` reads a snapshot under the grant (existing checks, 32 MiB file cap), then validates the ZIP before returning it:

```ts
export type PreviewBinary =
	| { ok: true; bytes: Uint8Array<ArrayBuffer>; size: number; mtimeMs: number }
	| { ok: false; reason: "missing" | "tooLarge" | "notFile" | "revoked" | "incomplete" | "unsafe" };
```

- `incomplete`: no end-of-central-directory record (a save in progress).
- `unsafe`: more than 10,000 entries, declared total uncompressed size over 256 MiB, any single entry over 64 MiB, ZIP64, encryption, or path entries with `..` or absolute paths.
- Declared sizes can lie, so the renderer worker inflates with `fflate` (0.8.3, MIT, 797 KB unpacked, checked with `npm view`) under a running byte counter and aborts at the same limits. The worker is terminated on a newer revision, on subject close and after 15 seconds; a stale result is dropped by revision.

**DOCX** (new `formats/docx.tsx`):

- `docx-preview` (0.4.1, Apache-2.0, depends on `jszip`) runs on the main thread only after the worker's inflate check passes and `word/document.xml` is at most 20 MiB inflated. It renders into a detached container; the result is attached only if its revision is still current. A render already running cannot be interrupted [INFERENCE: `renderAsync` has no abort], which the size limits bound.
- Options: `useBase64URL: true`, `renderAltChunks: false`, `experimental: false`, `ignoreLastRenderedPageBreak: true` [INFERENCE: option names from the README; check against 0.4.1].
- **Before rendering**, the worker rewrites the package so nothing can start a load: it removes every relationship with `TargetMode="External"` (replaced by a placeholder image "External image not loaded"), drops `altChunk`, OLE and ActiveX parts, and removes field codes and hyperlinks whose targets are not `http:`, `https:`, `mailto:` or in-document anchors. Post-render sanitization alone is too late, because detached image elements can start loads before they are attached.
- **After rendering, before attaching**, as defense in depth: remove `script`, `iframe`, `object`, `embed`, `link`, `meta`, `base`, `form`, `style` elements outside docx-preview's own style container; remove every `on*` attribute; keep `href` only for `http:`, `https:`, `mailto:` and in-document `#` anchors; keep `src` only for `data:image/` (PNG, JPEG, GIF, WebP, BMP); strip CSS `url()` values that are not `data:` from the generated styles. The renderer CSP's `https:` image allowance (finding 6) therefore never applies to document content.
- Shadow root for style isolation only; security comes from the sanitizer, the renderer CSP and link interception. Clicks on links are cancelled and `http(s)` links go through the app's external-link handler.

**XLSX** (new `formats/xlsx.tsx`, `formats/xlsx.worker.ts` via Vite `?worker`):

- SheetJS **0.20.3 from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`**, pinned in `package.json` with lockfile integrity `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==`. Verified this session: HTTP 200 over TLS from SheetJS's own CDN, 2,409,319 bytes, 26 files, `package.json` version 0.20.3, license Apache-2.0, no dependencies. GitHub's advisory database lists GHSA-4r6h-8v6p-xvw6 (CVE-2023-30533, below 0.19.3) and GHSA-5pgg-2g8v-p4x9 (CVE-2024-22363, below 0.20.2), both affecting the npm registry's last release 0.18.5 and not 0.20.3. Not verified: a signature or provenance attestation (SheetJS publishes none that this session found), and whether a newer CDN release exists.
- The worker parses with `cellFormula: false`, `cellHTML: false`, keeps the workbook, and answers window requests `{ sheet, rowStart, rowEnd, colStart, colEnd }` with formatted text (`raw: false`). Per sheet it exposes at most 100,000 rows by 200 columns; cell text is cut at 1,000 characters.
- The grid is virtualized in place (fixed row height, about 40 visible rows plus overscan, absolute positioning, no new library), rendered as text through React; no `sheet_to_html`, no `innerHTML`. Sheet tabs scroll horizontally and truncate in the middle at 320 px.

**PPTX** (new `formats/pptx.tsx`, new `src/main/services/preview-office.ts`):

- `preview:officeTools` detects an already-installed LibreOffice (`soffice` on the login-shell PATH, `/Applications/LibreOffice.app/Contents/MacOS/soffice`, `%ProgramFiles%\LibreOffice\program\soffice.exe`, `/usr/bin/soffice`). visual-omp never installs it (Owner decision 5).
- `preview:slides(token)` converts a **validated snapshot**, never the original file: main copies the bytes `readBinary` validated into `<app temp>/slides/<token>/<revision>/input.pptx` after rejecting macro-enabled content (`[Content_Types].xml` declaring a macro-enabled type, or any `vbaProject.bin`) and rewriting every relationship with `TargetMode="External"` to an empty internal target (with `fflate` in main), so linked images, OLE links and remote templates cannot load.
- Command: `soffice --headless --norestore --nolockcheck --nodefault -env:UserInstallation=file://<app temp>/lo-profile --convert-to pdf --outdir <dir> input.pptx`. The private profile is seeded with `registrymodifications.xcu` setting macro security to the highest level and link updates to never [INFERENCE: exact configuration keys to confirm against LibreOffice's documentation]. The child gets a minimal environment with `http_proxy` and `https_proxy` pointing at a closed loopback port as a second network barrier [INFERENCE: LibreOffice honors these].
- One conversion at a time per app, newest revision wins (a queued request is replaced), 60-second timeout with process-tree kill, 32 MiB caps on input and output; output deleted on revoke.

```ts
export type PreviewSlides =
	| { ok: true; pdfPath: string; revision: number }
	| { ok: false; reason: "noLibreOffice" | "unsafe" | "timeout" | "failed" | "tooLarge" | "revoked" };
```

- Without LibreOffice: "Slide previews need LibreOffice, which is not installed. Slide images omp saves appear here." with the same turn's image subjects listed.

**Bundle.** Add a forbidden initial-chunk rule to `scripts/guard-renderer-bundle.mjs` for `node_modules/(docx-preview|jszip|xlsx|fflate|pako)/`, with tests in `scripts/guard-renderer-bundle.test.mjs`. Measure, not estimate: record the entry, `docx` chunk, `xlsx` chunk and worker chunk sizes from `out/renderer/renderer-chunks.json` on the slice's first build, and store them as budgets the guard checks for the lazy chunks (new optional `lazyBudgets` in the baseline file, same approval rule as `acceptedGrowth`). Check the packaged app's third-party notices for the new licenses.

**Fixtures:** `fixture docx`, `fixture xlsx`, `fixture pptx`, each built with Python's `zipfile` only: DOCX with a heading, table, embedded image, external image and a hyperlink, saved three times plus one truncated save; XLSX with two sheets, a cached formula, `<img src=x onerror=alert(1)>` as text and a 50,000-row sheet; PPTX with two slides and an external image relationship; plus a ZIP bomb (small file, huge inflated entry) for each.

Acceptance:
1. DOCX renders; the link opens the browser and the app stays; the external image shows the placeholder and no `https:` request appears in DevTools.
2. Three saves update three times; the truncated save keeps the previous frame with "Waiting for omp to finish saving".
3. XLSX shows cached values and the markup as literal text; switching sheets works; scrolling the 50,000-row sheet keeps main-thread tasks under 50 ms in a DevTools performance trace; the DOM holds under 200 rows at any time.
4. Each ZIP bomb is refused as `unsafe` without the renderer exceeding 300 MB of memory; a newer revision terminates a running worker.
5. With LibreOffice installed (scratch install, or another machine), the deck converts within the timeout; a save during conversion yields the newer deck; the external image relationship makes no network request (checked with a loopback listener on the target); a `.pptm` is refused.
6. Without LibreOffice, the note appears.
7. Stale revisions never replace newer frames.
8. At 320 px and the largest text size, sheet tabs, the grid and the DOCX page remain usable.
9. `npm run build` passes the guard with the recorded budgets.

## Slice E: `visual-proofs` skill

- New `src/main/services/visual-proofs.ts`: `join(await ompAgentDir(), "skills", "visual-proofs", "SKILL.md")`. Frontmatter `name`, `description`, `managed-by: visual-omp`, `managed-version: 1`. Body per `docs/LIVE-PREVIEW.md:175-180`, with the wait mandatory: make the cheapest proof (first page or first two slides; three to five key frames with Remotion `still` or ffmpeg `-ss <t> -frames:v 1`; a low-resolution draft), save it in `proofs/` beside the output, print each proof's absolute path, call `ask` with "The proof is ready. Continue with the full render?", and stop if the answer is no. The separate "Wait for my answer" option described at `docs/LIVE-PREVIEW.md:179` is removed from the doc.
- Ownership: write only when absent or `managed-by: visual-omp`; delete only such a file; atomic write (temp plus rename); rewrite a managed file with an older `managed-version` on app start when the setting is on.
- Contract:

```ts
export type VisualProofsStatus =
	| { state: "off" | "on" | "outdated" }
	| { state: "conflict"; path: string }
	| { state: "unavailable"; reason: "skillsDisabled" | "ignored" | "unreadable" };
"proofs:status": { args: []; result: VisualProofsStatus };
"proofs:set": { args: [enabled: boolean]; result: VisualProofsStatus };
```

- Prefs `visualProofs` (default false) in `src/main/prefs.ts` and `src/shared/ipc.ts`; Settings › General "Ask omp for a proof before long renders", whose description says omp's model decides whether to follow it and the proof costs tokens and possibly provider credits. Changes broadcast `skills:changed` (`src/main/features/skills.ts:10`).
- **Fixture:** `fixture proof` writes `proofs/frame-1.png`, calls `ask`, then on yes runs the ffmpeg render.

Acceptance: the file appears and disappears with the setting; omp's skill listing in a scratch agent dir shows it without warnings (checks the `managed-by` key [INFERENCE until run]); a hand-written file without the field is untouched and reported as a conflict; `PI_CODING_AGENT_DIR` is honored; in the fixture the question card appears and "no" ends the turn without the render.

## Slice F: scripts in saved HTML, per-page network permission

Built on A2's chosen architecture. Streaming pages never run scripts.

**Policy** (`previewPolicy`): for a saved HTML grant, `script-src 'unsafe-inline' vomp-preview:`; everything else as Phase 1 (`connect-src 'none'`, `worker-src 'none'`, `frame-src 'none'`, `form-action 'none'`, `object-src 'none'`). With network allowed, add `https:` to `script-src`, `style-src`, `img-src`, `font-src`, `media-src` and `connect-src`; never `http:`, `ws:` or `vomp-preview:` in `connect-src`. No `'wasm-unsafe-eval'` and no `'unsafe-eval'`. Add the `.js` and `.mjs` rows (ACAO `*`, for module scripts).

**Permissions Policy.** Every HTML response carries a `Permissions-Policy` header disabling `camera`, `microphone`, `geolocation`, `display-capture`, `clipboard-read`, `clipboard-write`, `fullscreen`, `payment`, `usb`, `serial`, `hid`, `bluetooth`, `midi`, `screen-wake-lock`, `web-share`, `publickey-credentials-get`, `identity-credentials-get`, `idle-detection`, `local-fonts`, `window-management`, `autoplay`, `picture-in-picture`, `encrypted-media`, `gamepad`, `xr-spatial-tracking`, `accelerometer`, `gyroscope`, `magnetometer`, `ambient-light-sensor`, `attribution-reporting`, `browsing-topics` (each `=()`). The iframe's `allow` attribute lists the same features as `'none'`. Main-process denials (finding 10, and the fallback's handlers) stay as an independent layer.

**Permission store and revocation** (main): network permission is held per file realpath for the app session, across chats (Owner decision 1). `preview:setNetwork(token, allowed)` updates it and returns the new policy; main broadcasts `preview:policyChanged { path }`.

Revocation takes effect at once, without waiting for the renderer:

- Main tracks every frame (iframe) or view showing a token for that realpath. On revoke, a `session.webRequest.onBeforeRequest` filter keyed on the request's frame URL token (`details.frame`) [INFERENCE: `details.frame` is populated for subframe requests in Electron 44; verify in A3] blocks new `https:` requests, but it cannot stop requests already in flight. Main therefore also tears the page down at once: it reloads every iframe showing that page to its script-off revision (renderer `preview:policyChanged`, confirmed by main through the frame's navigation) and, in the fallback, closes the view, which cancels its in-flight requests. A test keeps a long-running `https:` response open (a local test server that streams slowly), revokes the permission mid-response and asserts that the page receives no further bytes and that no new request starts.
- The renderer, on `preview:policyChanged`, destroys every iframe document for that page (both slots) and loads a fresh one under the new policy; the stage shows the last capture until it loads.

**Frames.** `formats/html.tsx:27` sets `sandbox="allow-scripts"` exactly when `policy.scripts`; no `allow-same-origin`, `allow-forms`, `allow-popups`, `allow-modals`, `allow-downloads`, `allow-top-navigation*`, `allow-pointer-lock`. With scripts on, the hidden slot of the two-iframe swap is removed from the DOM once the new revision is visible, not hidden, so no script-running document stays alive off screen.

**Stage.** For every saved HTML subject: "Scripts run · no network" and an always-present "Allow network for this page" button (computed `fetch` targets make static counting unreliable, so no count is shown). Once allowed: "Network allowed for this page" with Block. The button's confirmation text says that network access lets the page run scripts from the web and reach HTTPS services on the local network, and that a page with network access can send any granted file content it can read (A3's list). At 320 px the control moves into the `DotsThree` menu with Stop still visible.

Security model:

| Capability | Streaming HTML | Saved, default | Saved, network allowed |
|---|---|---|---|
| Inline and granted scripts | no | yes | yes |
| Remote `https:` scripts, styles, images, fonts, media, `fetch` | no | no | yes |
| HTTPS services on the local network | no | no | yes |
| `http:`, `ws:`, plain loopback | no | no | no |
| `fetch` of granted files, stylesheet rules, image and video pixels | no | no | no |
| Existence, dimensions, duration of granted files | no (no scripts) | yes, in page only | yes, and sendable |
| Forms, popups, modals, downloads, top navigation, workers, nested frames | no | no | no |
| Device and powerful features | denied (Permissions Policy plus main) | same | same |
| App origin or IPC | no (opaque origin, main-frame checks) | no | no |

**Fixture:** `fixture scripts` (inline and module scripts, a computed `fetch` target, a worker, a busy loop behind a button, a remote image) plus A3's `fixture exfil`.

Acceptance:
1. Saved page runs its inline and module scripts; with network off its `fetch`, remote image, font and stylesheet fail; the streaming version runs nothing.
2. Allow network: the remote image loads and the computed `fetch` succeeds. Block: a `fetch` loop running in the page fails from the next request onward (no reload needed for the block to apply), and both iframe documents are replaced within one second.
3. A second grant for the same file inherits the choice; quitting the app clears it.
4. A3's matrix passes on the chosen architecture, including the DNS prefetch and WebRTC shipping gates.
5. Every Permissions Policy feature listed reports disabled (`document.featurePolicy.allowsFeature` or `document.permissionsPolicy`) inside the frame.
6. The busy-loop button leaves the composer responsive (A2's criterion, now as a regression test).
7. Stale revisions are rejected: a revision older than the visible one never becomes visible.
8. 320 px and largest text size: Allow network and Block are reachable and Stop stays visible.

## Slice G: Attach this frame

- Move `saveTemp` from `src/main/features/composer.ts:94` into a service shared with capture.
- New `src/main/services/preview-capture.ts`, `preview:captureFrame(rect: PreviewRect)` returning a temp PNG path. It validates the rect (finite, positive, inside the content size), converts CSS pixels to DIPs with the zoom factor, captures with `mainWindow.webContents.capturePage(rect)` or, for a fallback view, `view.webContents.capturePage()`, limits the long side to 1,568 px [INFERENCE: matches the vision documentation's guidance the plan cites; check], and saves.
- Stage action "Attach this frame": PNG, JPEG, GIF and WebP subjects attach the file itself; others capture. In the narrow layout it moves into `DotsThree`. No token estimate is shown.

Acceptance: SVG, HTML (iframe or view), PDF, DOCX, XLSX, paused video and sequence subjects each attach a PNG of what the stage shows, at zoom 100% and 125%, without app chrome; a PNG subject attaches its file; draft text and attachments stay; a paused hardware-decoded video does not capture black [INFERENCE: if it does, draw the paused frame to a canvas and capture that].

## Slice H: docs and changelog

`docs/LIVE-PREVIEW.md`: Phase 2 implemented notes, the CORS correction, A2's decision and evidence, the exposure list, the mandatory wait, artifact-folder discovery moved to Phase 3. `CHANGELOG.md` per release practice. Fixture README updated per scenario as each slice lands.

## Verification

Per slice, as listed. Overall: `npm run typecheck`, `npm test`, `npm run build` (guard and budgets), the Phase 1 acceptance list, and the fixture scenarios driven by the integration owner in a development build, with DevTools network logs for C, D and F, and A2's evidence from a packaged build.

## Risks

1. **Script isolation.** If A2 fails, F moves to WebContentsViews, which adds layout, overlay and focus work; cost is set after A2.
2. **Browser channels CSP does not cover** (DNS prefetch, WebRTC) [INFERENCE]; A3 makes closing them a shipping gate for scripts.
3. **SheetJS supply chain.** Pinned tarball with integrity; no signature available.
4. **Progress strings drift** between tool versions; parsers return `null`, samples are versioned.
5. **DOCX fidelity** is approximate; a long `docx-preview` render cannot be aborted, only bounded.
6. **LibreOffice** startup time, hangs and configuration keys; untestable on this machine until installed in a scratch location.
7. **Watcher volume** for undeclared numbered outputs is not coalesced by design; the debounce and the Linux directory cap still bound it.
8. **Proofs are advisory**; the model may skip the skill.
9. **Capture accuracy** under zoom, device scale and video overlays.

## Owner decisions

On 2026-11-04 the owner accepted the recommendation on both questions:

1. **Network permission lifetime:** per file, for the whole app session, across chats.
2. **The network permission's reach:** allowing network also allows remote executable scripts and HTTPS services on the local network, and the confirmation text says so.

Decided, not asked: the proof wait is mandatory; artifact-folder discovery is Phase 3; Quick Look thumbnails, WebAssembly and token estimates are cut; SheetJS 0.20.3 from SheetJS's CDN; `docx-preview` for DOCX, LibreOffice for PPTX only.

## Estimate

`[INFERENCE]` Excluding the possible WebContentsView fallback: A 2 to 3 days (packaged builds on two platforms, exfiltration page); B 0.5; C 4; D 5 (sanitizer, worker limits and virtualized grid added); E 1.5; F 2.5; G 1; H and integration passes 2. About 18 to 20 engineer-days. The fallback, if A2 requires it, is estimated from A2's findings.

## Not verified in this session

Chromium's range request pattern and codecs; sandboxed-frame process isolation; `details.frame` on subframe requests; DNS-prefetch and WebRTC behavior under CSP; `capturePage` on video, PDF and views; `docx-preview` option names and abort behavior; jszip's browser resolution; LibreOffice configuration keys and proxy handling; omp's acceptance of `managed-by`; Remotion and manim log strings; chunk sizes.
