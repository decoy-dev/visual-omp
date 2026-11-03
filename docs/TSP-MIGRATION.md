# visual-omp: moving app-hosted chats to TSP plus collab

Status: proposed migration. Written 2026-10-30 against visual-omp `main` at `da5e968` (0.7.2) and omp 18.14.0, then revised after astra's review. The protocol and recording baseline is now omp 18.15.0. It describes intended changes; `docs/ARCHITECTURE.md` and `docs/SPEC.md` remain the description of current behavior until each phase ships.

## Sources and citations

- **omp** source citations from the original study remain pinned to tag `v18.14.0` (commit `31147f9d1a76608549821c3759f8487b4d66c72d`) of `can1357/oh-my-pi`, MIT licensed. The current vendored protocol and recordings use tag [`v18.15.0`](https://github.com/can1357/oh-my-pi/tree/3fedf8d53267e32a6d7521ce725fdcc4a36fdc67), commit `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67`. The reference applier and encoder are unchanged between those releases.
- **studio** links point at commit `4dbe037dc3bda4c37e831625450225cf102267d7` of `DawnJson/omp-studio`, MIT licensed. Its `docs/architecture/tsp-migration.md` records a desktop app that has completed a move to TSP. Its findings are labeled as studio observations, made against omp 18.12.3 to 18.14.0, and are evidence for this plan rather than guarantees about visual-omp.
- **visual-omp** paths in backticks are relative to the repository root.
- **The TSP study** is an investigation of omp 18.14.0 made on 2026-10-30. It is not committed; the findings this plan depends on are restated in the Background section, each with an upstream link or the probe that produced it.
- `[INFERENCE]` marks an engineering conclusion that no source or probe has confirmed.

## Objective

Every app-hosted chat moves from reading omp's painted classic TUI to reading omp's Tern Surface Protocol (TSP) documents, with collab kept as the transcript, sharing and question channel. The plan ends with TSP as the default presentation and the classic screen adapters A2-A17 deleted. File-based terminal-follow for sessions owned by another process stays as it is.

Removing the painted terminal for hosted chats is the proposed consequence of the owner's direction ("use TSP, if it means rebuilding how visual-omp works, then so be it"). It is conditional: every place that opens the omp terminal today must have a working semantic replacement before the default changes.

## Background: what the TSP study established

**Activation and handshake.** omp starts TSP when `TERM_PROGRAM=tern` and the path can carry APC; `PI_TUI_NATIVE=0` forces classic rows ([`packages/tui/src/terminal.ts:59-88`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/terminal.ts#L59-L88), [`docs/environment-variables.md:650-652`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/docs/environment-variables.md?plain=1#L650-L652)). omp sends `ESC _ tsp;q;{"q":"hello","v":[1],"app":"omp","features":["edit","undo","send"]} ESC \` followed by a DA1 sentinel, and expects the TSP reply before the DA1 answer ([`packages/tui/src/native/encode.ts:136-151`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/encode.ts#L136-L151), [`packages/tui/src/terminal.ts:1991-2028`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/terminal.ts#L1991-L2028)). The reply lists the kinds and terminal features the client supports, an APC size limit, credits, columns and appearance ([`packages/wire/src/tsp.ts:993-1016`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L993-L1016)). The program's own `features` list in the query (`edit`, `undo`, `send`) says which events omp accepts; it is a separate list from the client's terminal features. An optimistic start that is not confirmed within 1 second falls back to classic rows ([`packages/tui/src/tui.ts:1106`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/tui.ts#L1106), [`packages/tui/src/tui.ts:1679`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/tui.ts#L1679)).

**Framing and flow control.** Messages are `ESC _ tsp;<verb>[;<key>=<value>]*;<body> ESC \` with JSON bodies; program verbs are `q`, `o`, `f`, `b`, `x` and client verbs are `r` and `e` ([`packages/wire/src/tsp.ts:1-31`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L1-L31)). Large messages are chunked with `c=<id>` and `m=1`, and a PTY read can split any sequence or UTF-8 code point ([`packages/tui/src/native/encode.ts:57-128`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/encode.ts#L57-L128)). Each surface allows two unacknowledged frames by default; once credits are exhausted omp stops sending frames, and after 5 seconds without an acknowledgment it logs a warning and resumes without credits ([`packages/wire/src/tsp.ts:25-28`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L25-L28), [`packages/tui/src/native/backend.ts:557-571`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/backend.ts#L557-L571)).

**Documents.** A node is `{id, k, p?, c?}`. A surface has regions `main`, `dock` and `layer`, and frames carry ordered operations (`add`, `set`, `text`, `splice`, `move`, `del`, `settle`, `focus`, `reveal`, `scroll`, `suspend`, `resume`) ([`packages/wire/src/tsp.ts:935-991`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L935-L991)). omp ships a reference applier used by its tests and debug path ([`packages/tui/src/native/apply.ts:1-10`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/apply.ts#L1-L10)). The 18.14 vocabulary has 44 kinds ([`packages/wire/src/tsp.ts:37-83`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L37-L83)), including `editor` with exact text, cursor, ghost suffix and `sendable` ([`packages/wire/src/tsp.ts:393-417`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L393-L417)), `overlay`, `toast` and the `rows` fallback of pre-rendered ANSI lines ([`packages/wire/src/tsp.ts:437-452`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L437-L452)), and the data-first `picker` and `prefs` ([`packages/wire/src/tsp.ts:455-686`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L455-L686)). Components without a semantic description become `rows` ([`packages/tui/src/native/reconcile.ts:937-949`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/reconcile.ts#L937-L949)).

**Events.** The client sends `ack`, `resize`, `theme`, `motion`, `visible`, `toggle`, `select`, `activate`, `action`, `change`, `edit`, `undo`, `send`, `focus`, `error` and `gone` ([`packages/wire/src/tsp.ts:1019-1066`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L1019-L1066)). `send` and `undo` may be sent only when the program advertised them ([`packages/wire/src/tsp.ts:1043-1058`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L1043-L1058)). `send` goes through the composer's ordinary submission path, saves a displaced draft for recall and waits for in-flight paste work ([`packages/tui/src/prompt/custom-editor.ts:1416-1427`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/prompt/custom-editor.ts#L1416-L1427)); omp drops a `send` for a stale surface or a target that is not the live editor ([`packages/tui/src/native/backend.ts:828-833`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/backend.ts#L828-L833)). Ordinary PTY keys remain valid input.

**Readiness.** `sendable` follows the editor's submit gate ([`packages/tui/src/components/editor.ts:1896-1909`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/components/editor.ts#L1896-L1909), [`packages/tui/src/prompt/custom-editor.ts:1063-1071`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/prompt/custom-editor.ts#L1063-L1071)). omp clears that gate during interactive initialization ([`packages/coding-agent/src/modes/interactive-mode.ts:2912`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/interactive-mode.ts#L2912)) and only later may ask the startup worktree question ([`packages/coding-agent/src/main.ts:766-767`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/main.ts#L766-L767), [`packages/coding-agent/src/modes/interactive-mode.ts:8884-8897`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/interactive-mode.ts#L8884-L8897)). The first `sendable: true` therefore does not prove outer startup is complete, which is why the hosted `worktree.onStart: off` override stays.

**No second screen.** While TSP is active, omp's native branch returns before the row renderer ([`packages/tui/src/tui.ts:1749-1759`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/tui.ts#L1749-L1759), [`packages/tui/src/tui.ts:3879-3885`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/tui.ts#L3879-L3885)). The xterm mirror and every adapter that reads painted rows stop working for a TSP host. Ordinary OSC output, including OSC 7501, continues.

**Collab beside TSP.** Collab attaches to session events and its own WebSocket without checking the renderer ([`packages/coding-agent/src/collab/host.ts:473-543`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/host.ts#L473-L543)). A scratch probe confirmed the omp collab host connected to a loopback relay while TSP frames flowed. The probe did not establish a guest join: `omp collab list --json` returned no hosts in the isolated environment, so no decrypted guest snapshot was obtained. Sharing parity is therefore unproven. Collab-aware hook dialogs race the local dialog against the guest response, and either answer cancels the other ([`packages/coding-agent/src/modes/controllers/extension-ui-controller.ts:964-981`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts#L964-L981)). Collab carries no BTW records or commands ([`packages/coding-agent/src/collab/host.ts:84-114`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/host.ts#L84-L114), [`packages/wire/src/index.ts:328-384`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/index.ts#L328-L384)).

**Live probe.** With the installed omp 18.14.0 under a scratch HOME and no model, the probe observed: the hello query above, surface `s:1` opened with role `omp.session`, `["set","g.line/input",{"sendable":true}]`, a `send` of `/btw` that opened `layer.ov-k` with role `omp.overlay.btwHistory`, Escape closing it, and `/exit` producing an `omp.toast.status` node "Closing session…" before `x` closed the surface with `keep: true`. The node ids in that run were specific to it and must be read from the document each time. The raw capture was 5,503 bytes containing nine TSP messages; Phase 1 commits an equivalent capture as a fixture (see Rule 5).

**Windows.** node-pty 1.1.0 offers `useConptyDll`, marked experimental, to use its shipped `conpty.dll` instead of the system ConPTY (`node_modules/node-pty/typings/node-pty.d.ts:88-104`); visual-omp sets neither ConPTY option (`src/main/omp/host.ts:167-173`). studio observed that the system ConPTY drops APC output and that the bundled DLL passes it ([`docs/architecture/tsp-migration.md:28`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L28), [`src/main/tsp/tsp-session.ts:87-99`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/src/main/tsp/tsp-session.ts#L87-L99)). omp accepts client messages as APC or as OSC 877 because a ConPTY input parser discards APC ([`packages/tui/src/terminal.ts:48-54`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/terminal.ts#L48-L54), [`packages/tui/src/terminal.ts:1706-1709`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/terminal.ts#L1706-L1709)). No Windows run happened in the study.

### Adapter inventory

These are the visual-omp mechanisms that read the painted screen or drive it with keys, with the ids the rest of this plan uses. Renderer paths omit `src/renderer/src/`.

| Id | Location | What it does today |
|---|---|---|
| A1 | `src/main/omp/host.ts` (headless xterm, serializer, `host:data`, `host:buffer`, `PI_TUI_NATIVE=0`) | Mirrors every PTY byte into a headless xterm; OSC 7501 decoding is separate and stays. |
| A2 | `src/main/omp/tui-debug.ts`, `src/main/handlers.ts` | Polls omp's debug channel for focus, overlays, painted text and component state; sends debug keys. |
| A3 | `features/session-tools/screen.ts`, `status.ts` | Reads the status line for model and thinking; diffs rows for command output. |
| A4 | `features/session-tools/drive.ts` | Treats a painted editor border with no overlay as ready; types slash commands and waits for painted change. |
| A5 | `state/session.ts`, `host.ts` `submit`/`paste`/`withEditorInput` | Sends prompts as bracketed paste plus Enter or Ctrl+Q; holds the input lock for editor transactions. |
| A6 | `state/session.ts`, `features/session-tools/typed.ts`, `results.ts` | Derives queue holds from overlays; watches slash output until it settles; opens the terminal for unclaimed screens. |
| A7 | `features/palette/OverlayWatcher.tsx`, `overlays.ts` | Detects overlays by debug focus kinds and regex titles; auto-opens the terminal unless a native card claims the screen. |
| A8 | `features/palette/TerminalSheet.tsx`, `TerminalMirror.tsx` | The interactive omp terminal sheet. |
| A9 | `features/session-tools/ompDialog.ts`, `ompDialogActions.ts`, `OmpDialogCard.tsx` | Parses hook select, confirm, input and editor dialogs; answers with keys; defers to collab questions. |
| A10 | `features/session-tools/screen.ts`, `PlanReviewCard.tsx`, `features/panes/PlanPane.tsx` | Parses plan review and drives it with keys. |
| A11 | `features/session-tools/model.ts`, `pickers.tsx` | Types `/switch` after screen readiness; cycles thinking with Shift+Tab and reads the border; collab confirms identity. |
| A12 | `features/session-tools/navigate.ts`, `tree.ts`, `TreeSheet.tsx` | Predicts `/tree` row order, navigates with keys, clears the restored draft with Ctrl+C. |
| A13 | `features/session-tools/advisorApply.ts` | Drives `/advisor configure` with keys and reads the saved message. |
| A14 | `features/session-tools/modes.tsx`, `drive.ts`, `chat/composer/tools.tsx` | Reads painted feedback for rename, handoff, guided goal, compact, cleanse and export. |
| A15 | `src/main/omp/host-observations.ts`, `host.ts` shutdown | Matches the startup and exit worktree confirms; types `/exit` and reads "Closing session…" rows. |
| A16 | `host.ts`, `host-observations.ts` | Reads startup diagnostics above the editor from the headless buffer. |
| A17 | `src/main/omp/prediction-transfer.ts` | Finds the painted next-message prediction; Tab transfer and recovery use the extension API. |
| A18 | `state/session.ts`, `collab/lib/client.ts`, `src/main/omp/follow.ts` | Collab `ui-response`, `abort` and subagent commands; read-only JSONL follow. These are not screen adapters and stay. |

## Assumptions

- Phase 1 is fixed by the shared contract and is being built in a separate worktree. Later phases build on its modules and IPC names; where this plan names an interface, Phase 1's final names govern.
- omp 18.15.0 is the protocol baseline, matching `MIN_OMP_VERSION` in `src/main/omp/locate.ts`.
- Collab stays authoritative for the transcript replica, sharing, guest permissions, subagents, main-turn abort and replicated asks and approvals.
- The app keeps its own composer, transcript, cards and panes, and uses omp's documents for state and for a semantic screen. studio chose a similar hybrid ([`docs/architecture/tsp-migration.md:139`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L139)). Decision D1 asks the owner to confirm it.
- omp defines its role strings, such as `omp.overlay.hook-select`, outside the TSP v1 wire contract, so they can change between omp releases ([`packages/wire/src/tsp.ts:14-18`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L14-L18) cites the normative protocol, which does not define them).
- Every Windows statement is source or studio evidence until Phase 6 produces visual-omp's own.

## End state

```mermaid
flowchart LR
  subgraph Renderer
    UI[Chat, cards, panes]
    GC[Collab guest client]
    SV[Semantic omp screen]
  end
  subgraph Main
    SH[SessionHost]
    TS[tsp: stream, document, session]
    OB[OSC 7501 and recap observers]
    NB[Native bridge extension]
  end
  PTY[[omp in node-pty, TSP client]]
  UI -- IPC --> SH -- one writer --> PTY
  PTY -- APC frames --> TS -- snapshot and updates --> SV
  TS -- semantic facts --> UI
  PTY -- OSC --> OB
  PTY -- collab ws --> GC --> UI
  NB -- modes, location, editor text --> SH
```

Authority after the migration:

| Fact or action | Authority | Notes |
|---|---|---|
| Transcript, streaming text, tools, subagents, model and thinking identity, context usage | collab | Unchanged. |
| Chat status | Existing derivation in `docs/SPEC.md` (Sessions) | In order: waiting for an answer, an error reported by omp, working (omp's own turn), helpers working, open, saved. Collab supplies questions, turns and helpers; OSC 7501 supplies waiting and error text when collab has no matching question. TSP adds no status input unless a later SPEC change approves one (see Phase 4a). |
| Main-turn Stop | collab `abort` | Unchanged; never replaced by Escape. |
| Ask and approval answers replicated over collab | collab `ui-response` by `reqId` | Main enforces a single app answer path once a match is mirrored. Rule 8 and D10 describe the accepted delayed-channel race. |
| Sharing, guest permissions, custom endpoint confirmation | collab and main | Unchanged; covered by Phase 2 acceptance. |
| Work modes, cwd, session file, exact editor read and clear | native bridge extension | Unchanged. |
| Editor text, cursor, ghost text, `sendable` | TSP `editor` node | Replaces A4, part of A5, A17 detection. |
| Local hook dialogs, plan review, pickers, prefs, overlays, toasts, TSP-only notices, shutdown notice | TSP document | Replaces A6-A16 screen reading. |
| `/btw` live answers | TSP `omp.overlay.btwHistory`, reconciled with `btw-history/` sidecar files | Phase 5. |
| Sessions owned by another process | JSONL follow | Unchanged and read-only. |
| Errors before omp opens a surface | bounded raw byte capture | A pre-TUI failure cannot arrive as a TSP frame. |

## Rules for every phase

1. **Launch-time choice.** A host is classic or TSP for its whole process life, because the study found no supported way to switch a running omp between renderers. `HostState` carries the presentation (`"classic" | "tsp"`), so the renderer never guesses it from screen content.
2. **Developer flag until the flip.** Phases 1-6 run only with `VOMP_TSP=1`, read in main at chat launch. Each phase can merge on its own, but the preview is a developer tool with known gaps until the Phase 2 usability gate passes, and it reaches parity only at the end of Phase 4. Classic presentation and ordinary text input retain their existing behavior. The shared image safety fix is an explicit exception: classic image sends now wait for upstream attachment acknowledgement, retain rejected images for explicit retry and use recovery-safe shutdown when the editor cannot be restored.
3. **One writer.** Every byte written to the PTY goes through one synchronous writer in `SessionHost`. Renderer-originated TSP events and keys enter the existing application-input chain (`#applicationInput` in `src/main/omp/host.ts`), with closing, generation and surface-id checks. Only protocol housekeeping (hello reply, DA1 answer, `ack`, `resize`, `theme`, `motion`) bypasses the transaction queue; it still uses the same writer and is never written in the middle of a multi-part write. `send` and `undo` are emitted only when omp's hello query advertised them.
4. **Role registry.** Every omp role string, action name and status word the app depends on is declared once in `src/shared/tsp/roles.ts`. Feature code imports names from there, so an omp rename fails one test file. studio follows the same rule ([`docs/architecture/tsp-btw.md:73-75`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-btw.md?plain=1#L73-L75)).
5. **Fixtures pinned to omp 18.15.0.** Each scenario records omp's own journal (`PI_TUI_TSP_RECORD`) and the raw PTY bytes. Store fixtures in `src/main/omp/tsp/fixtures/18.15.0/<scenario>.jsonl` and `<scenario>.raw.bin`, with decoded messages, emitted events, a byte/CR/SHA-256 integrity manifest and a `README.md` giving the omp version, commit, config and redactions. Recordings use the standalone 18.15.0 executable with a scratch HOME and config root, and no owner profile. Scenarios use no model unless they opt into the loopback script in Rule 6. Re-record every scenario on a baseline change and remove the old baseline; the recorder sanitizes paths and decoded OSC payloads before storage.
6. **Scripted model turns.** Scenarios that need a model (plan review, asks, approvals, predictions, `/btw` answers, compaction) use a loopback OpenAI-compatible fake provider that returns scripted responses, so recordings cost nothing and repeat exactly. studio recorded its model-switch compaction fixtures this way ([`docs/architecture/tsp-migration.md:177`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L177)). The recorder confirms `models.yml` providers with `api: openai-completions`, a loopback `/v1` base URL, a local fixture key, and `modelRoles.default` and `smol` in scratch `config.yml`. Per-scenario replies support tool calls, delayed replies and explicit gates.
7. **Claims decide suppression.** A semantic node is hidden from the generic omp screen only when a working TSP-backed consumer claims it. A consumer registers its claim in the role registry in the same change that implements it for TSP; classic cards never claim TSP nodes. Everything unclaimed stays visible in the omp screen. For hook dialogs that collab may also replicate, the collab card claims the node only under the arbitration rule below, which Phase 2 implements before generic TSP dialogs become interactive.
8. **One answer path for questions.** TSP hook nodes expose no collab `reqId`, so content matching remains a conservative arbitration heuristic. Match only a unique pending request and unique live dialog within the same host, protocol epoch and collab generation, using their available title, field and option data. Ambiguous candidates disable local TSP answering while the collab question remains available. Main receives the renderer-owned pending-request mirror with scope and revision checks, then repeats arbitration inside the input lock immediately before writing. A matched collab request is answered through its chat question card; an unmatched TSP node is answered through TSP. A matched answer waits for the request to settle and the corresponding node to leave. An unmatched local answer waits only for its node to leave.

   **D10 decided by the owner on 2026-11-02:** every unmatched hook dialog (select, confirm, editor and input) stays answerable from the omp screen, without a settle window. This explicitly qualifies Rule 8's exactly-one-answer-path guarantee and removes replay/live ordering as a prerequisite for unmatched local answering. Main still refuses local input once the mirror reports a matched or ambiguous request. The accepted trade-off is that the app can briefly offer both answer controls when channel delivery is delayed; omp's `#raceCollabDialog` accepts the first result and aborts the other branch. omp 18.14.0 shows collab-aware select/editor/approval dialogs locally and to collab at once, so a local answer racing an in-transit collab request cannot give omp two completed answers. Consequences can include a chat question card that appears and closes at once, or a losing submission or cancellation error. Input (`showHookInput`) and confirm (`showHookConfirm`) never reach collab ([routing:185-209](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts#L185-L209), [race:969-994](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/controllers/extension-ui-controller.ts#L969-L994)).

   Content matching cannot establish identity across delayed channel updates. D10 accepts that limitation because omp owns the first-answer race. The `questionMatches` diagnostics record when main first observed each hook node and its matching mirrored request on one monotonic clock, without changing arbitration or input authority. A losing local submission whose node has already gone shows a calm completion message rather than an error state.

   Before the first collab room opens, the omp screen accepts input for non-hook documents only.
   Hook dialogs remain display-only until the mirror can arbitrate. omp retains collab-aware
   pending requests and replays them to a writable guest on join. Input and confirm hooks without
   a replicated request become locally answerable once a connected empty mirror can arbitrate.
   This startup presentation allowance preserves the connected-mirror requirement for hooks:
   omp installs its room object before the relay connects so early requests can be retained
   ([18.14.0 controller](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/controller.ts#L88-L107));
   `requestGuestUi` retains them and a writable guest receives pending requests on join
   ([18.14.0 host](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/host.ts#L344-L391),
   [join replay](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/collab/host.ts#L842-L852)).
   Main ends the allowance synchronously at the first relay room-open callback and never restores
   it for a later reconnect or protocol epoch. A restart before the first room retains it.
   The writer repeats that lifetime check inside the input lock, including when the room opens
   after rendering but before a queued event is written. D10's hook-answer policy is unchanged.

   **Manual Electron evidence from main, 2026-11-02.** Main ran the worktree's Electron build with `VOMP_TSP=1` and the fixture extension in a scratch project:
   - Hook input was answered from the omp screen, and omp received the exact text `café ✓ answer`.
   - Hook confirm was answered No from the omp screen, and omp received `false`.
   - For a collab-aware select, the mirrored request reached main 1.7 ms before the TSP node. Arbitration was matched, the omp screen's controls were display-only, and Escape did not cancel the question. The chat card delivered `Second option`.
   - For an editor, the request reached main 1.3 ms before the node. Arbitration was matched, and a card answer containing a newline arrived unchanged.
   - With collab delivery deliberately delayed by 4 seconds, the node arrived first and was unmatched. A local `Fourth option` answer was accepted by omp. The late request appeared as a chat card until the delayed `ui-request-end` removed it; that end event carried the same delivery delay.
   - Dropping the collab connection while a matched select was open changed arbitration to unavailable and disabled the controls. After reconnection, the same `reqId` was re-sent and matched, and the card answer was delivered.
   - A separate browser guest was not covered. In three naturally ordered runs, the request always arrived before the node, by 1.3 to 2.5 ms. These are scoped manual observations, without an exactly-one-app-answer-path guarantee.
9. **Lifecycle transitions are separate cases.** The app distinguishes four transitions and handles each explicitly:
   - **omp instance restart:** `/restart` can replace omp or start a child while retaining the existing PTY ([`packages/coding-agent/src/modes/interactive-mode.ts:7994-8031`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/modes/interactive-mode.ts#L7994-L8031): `execReplace` on POSIX, otherwise a child with inherited stdin, stdout and stderr). A newly negotiated hello starts a new protocol epoch even when SessionHost did not spawn another PTY. Reset live documents and reject events from the previous epoch. A new SessionHost spawn also starts a new epoch. Collab generation remains separate.
   - **Collab room rotation** (`/new`, `/resume`, branch, fork continuation, sibling-file continuation): `#resolveLink` increments `generation` when it finds the new room (`src/main/omp/host.ts`, around line 554). Generation does not prove a new process or a new hello, so TSP documents are not reset on a generation change alone.
   - **Session identity change** inside one process: the native bridge reports the new session id and file; the document stays and surfaces may change.
   - **Surface replacement**: omp closes a surface with `x` (`keep` true or false) and opens or adopts another. The applier retains a kept surface as read-only history and directs input only to the live surface.
10. **Unknown content stays readable.** Unknown kinds use a mono fallback containing readable text or an unsupported-kind message, with a one-time log entry. A known kind with an unknown role keeps its ordinary renderer; layout containers still show their children. Unknown actions stay read-only and log once. The normal view never dumps node props as JSON; that metadata belongs in the raw outline disclosure. An unknown interactive node may still prevent a workflow from finishing, so the app promises a readable view and a safe way out (Escape, closing the omp screen, collab abort, restart), and makes no promise that the workflow completes.
11. **Verification tiers.** Each acceptance criterion names its tier:
    - **Replay**: Vitest against recorded fixtures with a fake omp (`src/main/omp/tsp/testing/fake-tsp-omp.ts`) that writes recorded bytes and advances only after the exact expected event, as studio's tests do ([`docs/architecture/tsp-migration.md:123`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L123)). Replay proves the app follows a recording. It does not prove the current omp still accepts that workflow.
    - **Live**: tests gated on `OMP_BIN` that run the installed omp with a scratch profile, following `src/main/omp/compat.live.test.ts`. A no-model live suite checks handshake, roles and actions; a scripted-provider live suite runs the model-dependent workflows. Both run in `.github/workflows/omp-watch.yml` for each new omp release.
    - **Packaged**: checks against the built app layout and the packaged native modules.
    - **Manual**: the owner or the main agent in an Electron development build or an installed build, on macOS or Windows. Subagents never start Electron; they use headless Chrome against a Vite server with its own `cacheDir` and a stub preload fed from fixtures, then stop it.
12. **Docs and review.** Each phase updates `docs/ARCHITECTURE.md`, `docs/SPEC.md`, `docs/DESIGN.md`, `docs/COMMANDS.md` and `CHANGELOG.md` when it changes behavior, follows `docs/VOICE.md`, and goes to astra before the main agent commits it. SPEC's painted-terminal statements change in the phase that changes that behavior for users, which is Phase 7.

## What a TSP chat can do after each phase

The table applies to chats started with `VOMP_TSP=1`. Classic presentation and ordinary text input are unchanged; the attachment acknowledgement and rejection recovery described in Rule 2 are the shared safety exception. "Disabled" means the control is shown as unavailable with a one-sentence reason, so a preview user never sees a control that silently fails.

| After phase | Available in a TSP chat | Disabled, with the reason shown | Fallback |
|---|---|---|---|
| 1 | Transcript, tools, subagents and context over collab; Stop (collab abort); collab-replicated asks and approvals; read-only omp document inspector. Plain-text steer submission uses TSP `send` when the live editor is sendable and omp advertised `send`. Escape is available. Follow-up, attachment and other unsupported input paths return explicit errors; full composer parity remains Phase 3. | Every screen-driven control: omp dialog card, plan review actions, model and thinking changes, tree navigation, advisor apply, command result rows, prediction transfer, the interactive terminal sheet. | Restart the chat without the flag. |
| 2 | Phase 1 plus: the interactive semantic omp screen for every terminal entry point; send blocked while an overlay or `screen` surface is open, with the composer showing why; Escape and close handling for overlays; clean chat close and quit; TSP-only notices in the transcript | Plan review card, model and thinking controls, tree navigation, advisor apply, command result rows and prediction transfer still disabled; each offers "Open omp screen" where omp has its own menu | The semantic omp screen. |
| 3 | Phase 2 plus: steer and follow-up, shell and Python prefixes, pastes, images, queue holds, Escape queue restore, ghost text display | As phase 2 | The semantic omp screen. |
| 4 (each step) | The card or control that step converts, claiming its nodes | The controls of later steps | The semantic omp screen. |
| 5 | Native `/btw` pane | None beyond Phase 4 gaps | The omp screen shows the BTW overlay when the pane is closed. |
| 6 | Developer-opt-in TSP chats on Windows, pending machine evidence | Windows CI and manual acceptance remain open | Ordinary Windows chats stay classic. |
| 7 | TSP is the default for hosted chats | None | Proposed one-release hidden `VOMP_TSP=0` (decision D3). |

## Phase overview

| Phase | Ships | Depends on | Planning estimate |
|---|---|---|---|
| 1 Transport | Developer-only TSP host, IPC, inspector | none | 3-5 days (in progress) |
| 2 Usable preview | Minimum readiness, send and close; semantic omp screen; notices; claims | 1 | 8-11 days |
| 3 Input | Full composer parity | 2 | 3-5 days |
| 4 Adapter cutover | A9, A15, A10, A11, A14, A12, A13, A17, A16, A6/A7 | 2, 3 | 7-11 days |
| 5 Native `/btw` | Side-question pane | 2 (claims), 3, 4e | 3-5 days |
| 6 Windows | Bundled ConPTY, packaging, CI and machine evidence | 1; runs beside 2-5 | 3-5 days plus machine time |
| 7 Default flip and removal | TSP default; classic adapters and hosted xterm path deleted | 2-6 passed | 3-5 days plus one release |

These figures are planning judgment for one engineer familiar with the repository. Together they come to 30-47 engineer-days, about 6-9 weeks, with Phase 6 able to overlap Phases 2-5. The study's earlier figure of 3-5 weeks after a proof of concept excluded fixture recording, the usable-preview work and the removal release, which this plan includes.

---

## Phase 1: developer-only transport preview (fixed contract)

**Goal.** Provide a developer-only transport preview. Classic rendering remains unchanged, with the shared attachment safety exception in Rule 2; the TSP preview does not yet provide feature parity. A chat started with `VOMP_TSP=1` on macOS or Linux runs omp as a TSP client, keeps collab exactly as today, and shows a read-only outline of omp's documents in place of the xterm mirror.

**Files and modules (contract).** `src/main/omp/tsp/` (stream splitter, protocol and vendored applier, session), a small `src/main/omp/host.ts` integration, shared IPC contract types in `src/shared`, and a renderer inspector shown by `features/palette/TerminalSheet.tsx` for TSP hosts. The applier is vendored from [`packages/tui/src/native/apply.ts:1-277`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/apply.ts#L1-L277) (the `TspDocument` class begins at [`packages/tui/src/native/apply.ts:39`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/apply.ts#L39)) with MIT attribution beside it and in `NOTICE`.

**Recorded decisions (implementing agent and main, 2026-10-30).**

- The original hello reply advertised all 44 omp 18.14.0 kinds as inspection-only data. The current omp 18.15.0 baseline has 45 kinds, including `button`, and Phase 2 renders each kind or its documented fallback. The hello advertises the shared `TSP_KINDS` list. omp enables native button nodes only after that list includes `button`; this also enables segmented tabs. Button actions keep the per-action registry guard, including main's serialized writer refusal for unknown names.
- Terminal features are empty. omp 18.14 consults only `aside`, `blobs` and `scroll` ([`packages/tui/src/native/backend.ts:182`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/backend.ts#L182), [`packages/tui/src/native/backend.ts:619`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/backend.ts#L619), [`packages/tui/src/native/reconcile.ts:306`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/reconcile.ts#L306)), so an empty list is safe. This list is separate from the program's advertised `edit`, `undo` and `send`, which govern which events the app may send.
- Input uses APC; credits are 2; acks are cumulative and sent right after synchronous application.
- Plain-text steer submission uses TSP `send` when the live editor is sendable and omp advertised `send`. Escape is available through the guarded key path. Follow-up, attachment and other unsupported input paths return explicit errors; full composer parity remains Phase 3.
- Renderer events use the application-input lock with generation and surface checks. Hello and ack bypass the transaction gates and share the single writer.
- Phase 1 excluded Windows from `VOMP_TSP`. Phase 6 now enables the developer flag on Windows with bundled ConPTY; its CI and manual gates remain open.

**Acceptance criteria.**

1. Replay: flag off, the spawn environment still sets `PI_TUI_NATIVE=0` and deletes `TERM_PROGRAM`, no TSP module is constructed, and the full existing suite passes unchanged.
2. Replay: flag on, the spawn sets `TERM_PROGRAM=tern` and omits `PI_TUI_NATIVE=0`, and the collab overlay, extension, relay and room resolution arguments equal the classic launch. Phase 6 adds `useConptyDll: true` only to Windows TSP hosts. Flag off, classic Windows spawn options and writes remain byte-identical.
3. Replay: committed copies of the study's raw captures, fed in every two-way split and in one-byte pieces, produce the same decoded message list as a single feed. OSC 7501 and every non-TSP byte reach the existing path in order.
4. Replay: chunked messages (`c=<id>`, `m=1`) reassemble, including a split inside a multi-byte UTF-8 code point; an interrupted chunk sequence is dropped and reported.
5. Replay: the hello reply is written before the DA1 answer for each hello, its body is the recorded decision, and no `resize`, `theme` or `motion` APC is written before it. studio saw early APC torn apart at startup and carries those values in the reply instead ([`docs/architecture/tsp-migration.md:117`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L117)).
6. Replay: frames apply through the vendored applier; per-surface documents equal the applier's snapshot after replaying the probe journal; rejected operations are counted and reported.
7. Replay: every applied frame produces one cumulative `ack` for its surface, and no ack waits on the renderer. Live (no-model, informational): with acks withheld, frames stop after two per surface; after 5 seconds omp logs a warning and resumes without credits ([`packages/tui/src/native/backend.ts:557-571`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/native/backend.ts#L557-L571)). A replay cannot reproduce omp's timer, so this criterion only records omp's behavior.
8. Replay: `send` and `undo` are never written when the program's hello query did not list them.
9. Replay: the renderer fetches a snapshot per host and receives ordered updates with a sequence number; a sequence gap or a new protocol epoch (a newly negotiated hello, on the same PTY or a new spawn) forces a fresh snapshot. A collab generation change alone does not (Rule 9).
10. Replay: a renderer-originated event for a stale surface id, a previous protocol epoch or an old generation is refused; a valid one is written once, in order with other application input.
11. Replay: plain-text submission writes one `send` through the application-input lock to the current sendable editor. Missing capability, an unsendable editor and stale targets refuse submission. Escape uses the guarded key path. Unsupported input paths return explicit errors without falling back to painted-screen readiness.
12. Manual (macOS): with `VOMP_TSP=1 npm run dev`, a new chat starts, the transcript streams over collab, `/btw` shows the overlay node in the inspector, Escape closes it, and `/exit` shows the "Closing session…" toast node before the surface closes. Without the flag, the terminal sheet, dialogs and plan review behave as before.

**Risks and gate.** If the hello reply is late, omp falls back to classic rows after 1 second and the inspector stays empty; Phase 2 adds the explicit failure path. Gate to Phase 2: criteria 1-11 pass, criterion 12 is observed by the owner or main agent, and the Phase 1 report records the plain-text send and Escape results and lists unsupported input paths.

---

## Phase 2: usable preview and the semantic omp screen

**Goal.** Make a TSP chat usable for daily work behind the flag, with known gaps that are disabled and explained. This phase extends Phase 1's readiness and plain-text send with overlay and screen blocking and UI availability, brings the minimum close handling forward from Phase 4b, makes the Rule 8 question arbitration a prerequisite for interactive dialogs, adds a generic interactive renderer that replaces the terminal sheet for TSP chats, projects TSP-only notices into the transcript, and introduces claims (Rule 7). It removes the largest blocker the study found: the classic terminal sheet was the catch-all for menus the app has no card for, and a TSP host has no painted terminal.

**Implementation status.** Section 2.2 projects the registered TSP-only notices into transcript rows.
Recorded startup and usage warnings plus synthetic documents cover deferred snapshot attribution,
displayed-branch anchoring, replacement, parent-chain custom-message suppression, event
suppression, epoch/room reset and literal notice rendering. These checks do not establish identity
for a delayed collab notice event after a turn change. The remaining Phase 2 criteria gate the preview.

The omp 18.15.0 baseline adds native buttons to the 44 previously advertised kinds, bringing the hello to 45. Buttons reuse the app's Button and IconButton, with label, icon, display-only keycaps, variant, size, pressed, disabled-reason and busy states. Disabled, busy and unknown-action buttons send nothing. Segmented tabs reuse the shared segmented control. Code nodes accept strictly ascending, count-matched `nums`; gaps insert an ellipsis row, while invalid numbering falls back to `start`. Deferred `!` and `$` execution blocks arrive in `main` through omp's `nativeTail`. The transcript now presents supported data-first `omp.bash` and `omp.eval` nodes as the user's runs until matching saved execution entries arrive. These roles have conditional claims scoped to the rendered run or saved replacement; hidden chats, covering screens, unsupported shapes and saved rows outside the transcript window keep Other omp output available.

Pass-through slash delivery now uses main's semantic send availability, TSP submission and document
subscriptions for immediate and queued commands. Overlay and screen ownership holds the queue;
editor readiness, turn start, host exit, room generation changes and epoch changes release the
command watch. UI-only feedback uses the existing notice projection. Synthetic renderer tests
cover these paths without `host:screen`; live extension and overlay workflows remain part of the gate.

Unmatched hook dialogs can now be answered from the omp screen. Main accepts a complete
`host:tsp-answer` transaction only with a connected mirror in the current host, protocol epoch
and collab generation, no pending collab request, and a unique, live unmatched node. The check
runs again at the serialized writer inside the application-input lock. Select and confirm answers
activate omp's item ids; input and editor answers send a full observed-length edit and declared
submit action in one writer operation. Cancel uses the declared cancel/close action or Escape.
Generic hook events and raw-key fallbacks remain blocked. Local responses stay in answering
state until the node leaves; matched responses wait for collab settlement and node departure.
The screen explains matched, ambiguous and unavailable states without offering a second answer.
Hook picker search remains visibly unavailable because its upstream route uses raw keys; all
exposed options remain selectable.

omp 18.15.0's ordinary selector and confirm use a roleless picker when `picker` is advertised.
The registry recognizes their `options` noun, row layout and exact confirm/close action set;
replays of all recorded non-hook workflows guard against classifying other pickers as hooks.
Recorded select, confirm, input and editor submit/cancel events cover the guarded writer.
Live channel-ordering, sharing parity, packaged checks and the remaining manual criteria still
gate the complete Phase 2 preview. The native hook card in Phase 4a remains separate work.

The headless Chrome usability gate (`src/main/omp/tsp/testing/ui-gate.test.ts`) renders recorded
omp 18.15.0 documents through the production semantic renderers and terminal sheet, with a stub
preload and session source. Criteria 8 and 9 passed this local gate on 2026-11-02.
Criterion 8 covers Chrome accessibility-tree list selection, overlay
dialog labels, keyboard selection, sheet focus and composer focus restoration. Criterion 9 covers
960x620 in light and dark themes, using full motion at 100% text and reduced motion at 130%:
model and hook pickers, settings, slash-command output and the session tree. It checks wrapping action
rows, readable long labels, ancestor clipping, hit-test visibility, internal scrolling and reachable
action buttons after fonts load, and saves a screenshot for each fixture/theme/text-size combination.
The browser gate is opt-in; normal tests do not launch Chrome or write screenshots. Run it with:

```sh
TSP_UI_GATE=1 TSP_GATE_SHOTS=/tmp/vomp-gate-b-shots npx vitest run src/main/omp/tsp/testing/ui-gate.test.ts
```

An opted-in run fails if Chrome is unavailable. Set `CHROME_BIN` when Chrome is installed outside the
platform default. Without `TSP_GATE_SHOTS`, each run creates a unique temporary screenshot directory.

The idle omp screen now explains that no menu is open and retains its raw outline. TSP palette,
status-menu and tree fallback labels name the omp screen; classic labels still name the terminal.
A matched blocking hook points the composer to the chat's question card through a localized
availability reason. These automated checks do not replace manual criteria 11-13.

**Gate replay additions, 2026-11-02.** `OmpScreen.test.ts` enumerates all 45 kinds and exercises
readable fallback, once-only diagnostics, ordinary unknown-role layout, per-action disabling,
interactive descendants and the rendered "Other omp output" section. An unknown action disables
its own control with a reason; it no longer disables an entire picker or form. The recorded
`extensions` picker covers selecting a row and closing while its unsupported Expand action stays
disabled. The recorded hook submit/cancel tests remain in `OmpScreenHooks.test.ts`.
`TerminalSheet.escape.test.ts` now drives the actual sheet and semantic screen from overlay,
settings, custom-row, tree, import and collab-aware recordings, checking their next emitted input.
It also checks the timeout recovery button. Custom-row Escape reaches omp through guarded keys.

`NoticeRow.test.ts` replays `notice-error` and `startup-no-model`, presents one matching literal
notice row in each transcript mode and suppresses it when the collab duplicate arrives.
`host.test.ts` replays restart, new, resume, sibling continuation, startup import and both exit
recordings. Room changes and pending collab requests are injected at the host boundary.
The sibling recording uses a second isolated omp process to claim the same seeded file, then
renames from the first process; its warning and OSC path show the new sibling file. Retained
surface replacement is tested with constructed protocol input. The startup import recording
opens its screen before the first room, selects the synthetic Claude session, negotiates a second
hello and returns to the ordinary session. Startup hooks remain mirror-gated.
The recorded `handshake-timeout` probe withholds client replies, so omp withdraws its optimistic
surface and paints classic rows. Replay now detects that withdrawal, reaches `tspFailed` after
the surface deadline and offers Restart instead of waiting indefinitely on an empty screen.

The recorder accepts `VOMP_TSP_FIXTURE_DIR` so live comparisons do not overwrite the committed
baseline. `VOMP_TSP_FIXTURE_VERSION` defaults to `18.15.0`; another version requires an explicit
destination outside the baseline directory. The guard canonicalizes filesystem aliases and the
nearest existing parent of a new destination before checking that boundary.
`fixture-vocabulary.test.ts` checks roles, actions and
kinds, and reports per-scenario layout differences. Set `OMP_BIN`, `VOMP_TSP_FIXTURE_VERSION` and
`VOMP_TSP_LIVE_FIXTURE_DIR` to compare a scratch recording with the baseline.

The 2026-11-03 comparison recorded all 85 scenarios with standalone omp 18.16.0 into a temporary
directory, including every scripted-provider scenario. No added role, action, kind or layout was
observed. The cleanse capture omitted its transient `omp.cleanse.live` spinner, and the execute
plan capture included an extra spinner label; those observations do not establish an upstream
layout change. The TSP wire types, reference applier and encoder are unchanged at
[`v18.16.0`](https://github.com/can1357/oh-my-pi/tree/650f3a108229ee11bf68ba3377f4e8c3391cd424).
Source inspection adds unclaimed `omp.btw.inject` and read-only `inject` for the optional BTW
steering feature. Prediction alternatives expose the existing `omp.autocomplete` and `omp.select`
roles, now recognized without a native claim. The live application-overlay prediction test covers
exact first-choice transfers and second-Tab list selection in classic and TSP hosts.
The targeted `fixtures/18.16.0/image-reject` recording provides comparison evidence for image rejection and draft restoration. It does not replace the complete 18.15.0 fixture baseline or raise the minimum version.

Criterion 2 passed the opt-in headless Chrome gate against the pinned recordings on 2026-11-02
(`src/main/omp/tsp/testing/ui-gate.test.ts`), alongside the DOM checks.
Real Chrome pointer and keyboard input completes 26 overlay cases: slash menus, model/settings,
custom rows, hook submit/cancel/open variants, tree confirmation, extensions selection and Close,
and startup import in `starting` mode at generation zero before the collab link. The gate captures
application IPC without filtering semantic focus events and compares its raw keys and semantic
events exactly with the next accepted recording inputs. Complete hook answers use the production
`hookAnswerEvents` writer conversion. Recorded program responses close the live menu in the
rendered sheet; retained closed surfaces become read-only.
The preload is a stub: Chrome exercises the renderer and the shared hook wire conversion.
Main's arbitration, writer serialization and stale-authority refusals remain covered by host replays.

Open-only captures use their own final pre-close document and their completed counterpart's
accepted inputs/responses, without reusing message positions across independent captures.
`features/tsp/testing/documents.ts` owns the fixture loader and its `FIXTURE_VERSION` selector;
the Chrome gate has no versioned fixture path of its own. The notice-only `/usage` capture has no
menu to complete, and the open-only collab-aware hook remains an arbitration fixture under criterion 6.

**Manual evidence, 2026-11-02 (main, macOS, omp 18.14.0).**

- **Entry points (11).** The command palette and omp status menu opened the semantic sheet.
  The native session tree's refused navigation offered its omp-screen action, which opened
  omp's tree picker. Import from Claude Code opened the startup session picker before a collab
  room existed; the follow-up sheet fix enabled its controls while the chat was still starting.
  Pointer selection and Close worked without importing a conversation. The classic dialog card
  is deliberately absent in TSP chats; its terminal button is not a TSP entry point.
  `/extensions` opened automatically without an app card: pointer selection enabled Toggle,
  unsupported Expand stayed disabled with a reason, and both Escape and Close left the menu.
  Main also inspected the live extensions screen in Electron at a 960x620 viewport, in light
  and dark themes at 100% text/full motion and 130% text/reduced motion. Labels remained readable,
  lists scrolled inside the sheet and Close stayed visible. The broader fixture matrix is
  additionally covered by the Chrome gate above.
- **Sharing (12).** With the owner's approval, main published only a scratch chat through the
  default relay. A separate browser using its view link received the live transcript, was
  read-only and offered no question-answer controls. A second browser using the control link
  answered a replicated fixture question with "Second option"; omp reported that exact answer,
  and the app's pending request, semantic dialog and question card cleared. Main made no local
  answer submission; writer tests cover refusal of local answers for matched dialogs.
  A project-only custom relay setting showed the native confirmation naming both relay and
  browser-client endpoints before publication. Accessibility permission prevented cancelling
  that native dialog through automation, so main stopped the preview without approving it;
  the custom endpoint was not published. The default share was stopped and both guests closed.
- **Terminal follow (13).** A separately running terminal omp held a scratch session. Opening
  it in the preview reported `elsewhere`, stayed read-only, followed its transcript and created
  no app host. The existing controller regression for unknown ownership additionally proves
  that Continue here is refused and `host:start` is never invoked.

These observations do not establish the later composer, adapter, Windows or default-flip phases.

### 2.0 Minimum readiness, input and close

- **Readiness.** Extends Phase 1: `composer(doc)` returns the live editor with `p.sendable === true`, and Phase 2 adds blocking while an overlay or `screen` surface is open. The composer's send control shows that availability and its reason.
- **Send.** Phase 1's plain-text `send` path is unchanged; Phase 2 adds overlay and screen blocking above and the UI availability state. Pass-through slash commands use the same `send` path, including application-queued commands, with document-backed queue holds. Follow-up, images and omp editor queue restoration remain Phase 3 work.
- **Escape and overlays.** Escape on the omp screen uses the guarded local answer transaction for a unique unmatched hook dialog, preferring its declared cancel/close action. Matched and uncertain hooks refuse it. Other overlays retain `\x1b`; the protocol has no universal overlay close event ([`docs/architecture/tsp-migration.md:205-206`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L205-L206)).
- **Stop.** Collab `abort`, unchanged.
- **Close and quit.** Closing a chat or quitting uses the existing shutdown stages. On a TSP host, `/exit` is sent with `send` once the editor is sendable. Shutdown may first dismiss a non-hook overlay with Escape, but never writes raw Escape while any live hook exists. Its existing deadline and native force-stop decision remain available for an unresolved hook. Acknowledgment is the `omp.toast.status` "Closing session…" node, the addressed surface closing, or process exit, combined with the native shutdown stage and exit records. During application-driven shutdown, hook controls are unavailable with "This chat is closing."; interactive exit questions remain Phase 4b work. An unmatched question opened by typing `/exit` while the chat is still live remains answerable. Quit while working keeps the confirmations in `docs/SPEC.md` (Lifecycle).
- **Handshake failure.** If no hello arrives within 10 seconds of spawn while output flows, or no surface opens within 5 seconds after the reply, main marks the host `tspFailed`, shows "omp did not start its semantic screen" with Restart, and logs the first bytes it saw. If omp withdraws its last optimistic surface and paints classic rows, the five-second surface deadline starts again. A blank inspector is never the resting state.

### 2.1 Semantic omp screen

**Scope.** The omp screen draws omp's `layer` region (overlays, pickers, prefs, toasts), any `screen`-mode surface, and `dock` nodes that no consumer claims. It does not draw omp's `main` transcript or the `omp.editor` composer card, which collab and the app's composer already present (decision D1). A section titled "Other omp output" lists unclaimed `main` nodes whose roles the registry does not mark as replicated by collab, so nothing omp shows is unreachable.

**Files and modules.**

- `src/shared/tsp/roles.ts`: role, action and status registry; claims (Rule 7); per-role interaction overrides.
- `src/shared/tsp/question-match.ts`: the Rule 8 arbitration, including how main receives and invalidates the renderer's pending collab requests. It ships in this phase, before generic TSP dialogs in the omp screen become interactive, so the omp screen never offers a second control for a question the collab card already shows. Phase 4a adds native cards on top of it.
- `src/shared/tsp/document.ts`: renderer copy of the applied document with node subscriptions by id and reuse of unchanged nodes on resync, as studio does ([`docs/architecture/tsp-migration.md:113-115`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L113-L115)).
- `src/shared/tsp/view-state.ts`: pure derivations shared by main and renderer: `openOverlay`, `screenSurface`, `focusedNode`, `composer`, `unclaimed`.
- `src/renderer/src/features/tsp/`: `OmpScreenSheet.tsx`, `nodes/` (one component per kind group), `interactive/` (list, picker, prefs, input, editor, tabs), `ansi.ts` (SGR-only ANSI to spans), `keys.ts` (DOM key to xterm bytes for raw-key fallback), `labels.ts`.
- `src/renderer/src/features/palette/TerminalSheet.tsx`: `OmpScreenSheet` for TSP hosts, `TerminalMirror` for classic hosts.
- `src/renderer/src/features/palette/OverlayWatcher.tsx`: for TSP hosts, opens the sheet from `openOverlay` and `screenSurface` with no 300 ms wait.
- `src/renderer/src/registry/lazy.tsx`: a lazy chunk for `features/tsp`.

**Node coverage and fit with `docs/DESIGN.md`.**

| Group | Kinds | Rendering |
|---|---|---|
| Containers | `overlay`, `col`, `row`, `card`, `section`, `rule`, `spacer` | Overlay `head` becomes the sheet title ("omp screen: {head}"). Cards follow §5.10 without nesting a card inside the sheet card; `section` collapses with `toggle`. |
| Text | `text`, `md`, `code`, `diff`, `math`, `kbd`, `badge`, `icon`, `status`, `seg` | `md` uses the shared Markdown renderer; `code` and `diff` use the transcript highlighters; `kbd` uses the palette footer's mono style; icons map to Phosphor and Nerd Font private-use glyphs are dropped, as studio does ([`docs/architecture/tsp-migration.md:118`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L118)). |
| Lists and choice | `list`, `item`, `picker`, `tabs`, `checklist`, `tree`, `table`, `kv` | Rows follow §5.9, picker queries the §5.11 search input, tabs §5.8. Interaction follows each node's declared `actions` when present. Without them, a click highlights locally and Enter or a double-click sends `activate`. Components that treat `select` as a commitment are marked in the registry: omp's tree selector navigates on either `select` or `activate` ([`packages/tui/src/overlays/tree-selector.ts:1693-1705`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/tree-selector.ts#L1693-L1705)), so its rows send nothing until the user confirms. |
| Forms | `prefs`, `input`, `editor` inside overlays, `effort`, `button` | Switch, Select and Input rows from §5.11-5.12; `change` for typed values; `edit` with the observed `len`; native Button/IconButton for registered click actions, disabled reasons, busy state, keycaps and pressed state. |
| Progress and live | `spinner`, `shimmer`, `elapsed`, `progress`, `meter`, `rate`, `chart` | §5.14-5.15 primitives through `ui/motion.tsx`, static under reduced motion; `chart` uses `ui/Chart.tsx`. |
| Work items | `tool`, `agent`, `json` | Compact read-only rows; `json` uses the existing lazy JSON field tree from the eval renderer. |
| Media | `image`, `media` | Alt-text placeholder while `blobs` is not advertised. Advertising `blobs` is a separate recorded decision with its own fetch IPC. |
| Notices | `toast` | Inside the sheet, an inline status line. Elsewhere, see 2.2. |
| Fallback | `rows`, `ansi`, unknown kinds | Mono block on `--bg-inset` using the omp terminal palette the extension already reads (DESIGN §4.11). A focused `rows` node forwards raw keys through `keys.ts`, since custom extension components may need them. |

**Interfaces.**

- Phase 1's snapshot and update channel, unchanged.
- `sendTspEvent(hostId, event)`: a typed subset of `TspEvent` ([`packages/wire/src/tsp.ts:1019-1066`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L1019-L1066)) excluding `ack`, `resize`, `theme` and `motion`, which main owns.
- `host:keys` remains the raw-key route for `rows` and Escape.
- Main sends `theme` and `motion` on `nativeTheme` and reduced-motion changes, after the hello reply only; the sheet reports its width in mono columns and main sends `resize`.

### 2.2 TSP-only notices in the transcript

Some omp output exists only in TSP: `omp.toast.status` notices (reused node id, replaced text), `omp.notice.error` rows in `main` (studio, omp 18.14.0, [`docs/architecture/tsp-migration.md:177`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L177)), and `omp.notice.warning` startup and command warnings. The registry lists and claims these roles. A controller-owned renderer subscription projects them into literal notice bodies within `chat/transcript/NoticeRow.tsx`. It defers attribution until the current room has a synchronized collab snapshot, then uses the displayed branch's latest entry and user prompt as anchor and turn. Replacing a node preserves its assigned anchor. Displayed `custom_message` entries suppress equal text through their parent-chain turn; collab `notice` events use the displayed turn at receipt. This covers either arrival order within the attributed turn, but cannot identify a delayed event's earlier turn. New protocol epochs clear projections. Room and session changes discard pending attribution and retain observed node text so unchanged retained documents do not repeat notices. Roles collab replicates remain collab-owned and are never projected.

### Tests

Record (Rule 5): `slash-overlays` (`/jobs`, `/usage`, `/session`, `/hotkeys`, `/changelog`, `/tools`), `model-picker`, `settings-screen` (a `screen` surface), `hook-select`, `hook-input`, `hook-editor` (a fixture extension calls the hook UI, so no model is needed), `hook-collab-aware` (collab events injected), `extension-rows` (a fixture component without a semantic description), `tree-open`, `notice-error`, `startup-no-model`, `exit`, `exit-with-overlay`, and the transition fixtures `restart` (`/restart` negotiates a second hello over the same transport and reuses surface ids), `new`, `resume`, `sibling-continuation`, `surface-close-keep`, `handshake-timeout` (the fake omp delays its expectation of a reply past 1 second and then emits classic rows).

### Acceptance criteria

1. Replay: every kind in `TSP_KINDS` has a renderer or the documented fallback; a test enumerates the list so a new kind fails it.
2. Replay with headless Chrome: each overlay fixture completes through the omp screen, and the events emitted equal the recording's next expected event. On `tree-open`, clicking a row emits nothing until confirmation.
3. Replay: claims. With no TSP consumer registered, a hook dialog node is shown in the omp screen even though a classic `OmpDialogCard` exists.
4. Replay: unknown kinds use the readable mono fallback; known kinds with unknown roles keep their ordinary renderer and unknown actions remain read-only. Each unsupported name logs once, no normal view dumps node props as JSON, and unclaimed `main` content appears under "Other omp output".
5. Replay: `notice-error` and `startup-no-model` produce one notice row each, and a duplicate collab notice suppresses the projection.
6. Replay: transitions. `restart` starts a new protocol epoch on the same transport: live documents reset, the reused surface ids belong to the new epoch, and events addressed to the previous epoch are refused; `new`, `resume` and `sibling-continuation` keep the epoch's documents through the generation change; `surface-close-keep` keeps the old surface read-only and routes input to the new one; `handshake-timeout` ends in the `tspFailed` state with Restart. `hook-collab-aware`: with a unique match the generic omp screen offers no answer control and nothing is written to the PTY; with ambiguous candidates local answering is disabled and the collab question stays available.
7. Replay: `exit` and `exit-with-overlay` close cleanly through 2.0's sequence, and an application input after closing begins is rejected.
8. Headless Chrome, accessibility: lists expose `listbox` and `option` with selection; overlays are dialogs labeled by `head`; focus moves into the sheet on open and returns to the composer on close.
9. Headless Chrome, layout: at the 960×620 minimum window and at the 130% text-size setting, long picker labels wrap or truncate with a tooltip, action rows wrap, nested overlays scroll inside the sheet, and no action button is clipped or hidden.
10. Live (no-model): the overlay and hook fixtures re-record against the installed omp, and their roles and actions match the registry.
11. Manual (macOS): every terminal entry point opens the omp screen for TSP chats: `features/palette/commands.ts:97`, `shell/StatusBar.tsx:83`, `features/projects/ImportDialog.tsx:37`, `features/session-tools/OmpDialogCard.tsx:103`, `TreeSheet.tsx:170`. A menu without an app card (for example `/plugins`) opens automatically and can be completed with mouse and keyboard. Light and dark themes, reduced motion and text size render correctly.
12. Manual (macOS), collab and sharing in a TSP chat: Share creates a link; a guest in a browser joins and sees the live transcript; a guest without control cannot answer; a guest with control answers a replicated question, the app card closes and nothing is written to the PTY; a custom relay endpoint still shows the native endpoint confirmation before publishing. The study did not establish a decrypted guest join, so this criterion is the first evidence of sharing parity.
13. Manual (macOS): a chat whose session another terminal process owns still opens read-only through JSONL follow, and if ownership becomes unknown the chat stays read-only and starts no TSP host.

**Risks and gate.** The main risk is breadth: `packages/tui/src/overlays/` defines more than 30 `omp.overlay.*` roles. Usability gate (required before decision D7 can expose the preview beyond developers): criteria 1-13 pass, and the owner accepts the omp screen as the replacement for "Open omp terminal" (decision D2).

---

## Phase 3: input parity

**Goal.** Complete the composer for TSP chats: follow-up queueing, shell and Python modes, pastes, images, queue holds, Escape restore, approval interplay and ghost text, without reading painted rows.

**Implementation status (2026-11-02).** Main publishes `composerFacts()` on each TSP snapshot and the
host state used by the composer. Plain text, shell/Python prefixes and large messages use `send`.
Follow-up writes one len-checked edit plus Ctrl+Q. Images clear the editor, paste and confirm
each path separately, then append the prompt text and submit through the editor action. Protocol
acknowledgments remain available during attachment waits. omp's own image rejection restores the
pre-send editor through len-checked edit and waits for confirmation. The failed message retains
its images and literal error in the queue until an explicit retry. Uncertain restoration retains
the existing stranded-image recovery gate.

The app queue waits for omp's queue pills, ask ownership and panels. Escape pins the original
editor lifetime and retains its exact dequeued text in main before clearing. Snapshot delivery inserts
the text into the app draft with a persisted receipt, then acknowledges only after clear confirmation.
Failed or interrupted transfers remain recoverable without clearing a replacement editor or inserting
duplicate text. Approval sends deny and steer; slash routing,
model and thinking actions refuse while approval waits. Semantic ghost text uses the existing exact
Tab capture and recovery path without painted reads. Undo uses the advertised event.

The input recordings include the image's attached collab transcript,
`prediction-ghost` and `paste-follow-up`. The latter proves that a reflected image paste survives a
follow-up edit and reaches the next provider request. `input.test.ts` drives production operations against event-gated replay,
checks raw byte integrity and verifies image write ordering. `input.live.test.ts`, gated by `OMP_BIN`,
re-records follow-up, image and approval workflows in isolated profiles. The prediction recording
shows the semantic ghost, Tab acceptance and exact edit clear; extension capture and recovery retain
their consumer tests. Criterion 7 remains a manual Electron gate for main, including IME composition.
The `image-reject` recording adds the exact bad-CRC PNG rejection and Unicode draft/cursor restoration in standalone 18.15 and 18.16, with no provider request.
Host transaction tests cover delayed paste completion, follow-up text/identity races, changing ghosts,
Tab target replacement and restored-text retention across delayed clear confirmation or epoch change.


**Files and modules.** `src/main/omp/tsp/composer.ts` (reads the `editor` node and composer facts), `src/main/omp/host.ts` (`submit`, `paste`, `withEditorInput` by presentation), `src/renderer/src/state/session.ts` (queue holds), `src/renderer/src/chat/composer/` (readiness and ghost text), `src/main/omp/prediction-transfer.ts` (offer detection only).

| Area | Classic today | TSP | Source |
|---|---|---|---|
| Outer startup | `worktree.onStart: off` override | Keep the override; `sendable` precedes the startup worktree question | Background, Readiness |
| Follow-up (Ctrl+Q) | Bracketed paste plus `\x11` | omp defines no follow-up event; its composer actions are `thinking.cycle`, `dictation.toggle`, `submit` and `interrupt` ([`packages/tui/src/prompt/custom-editor.ts:1434-1452`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/prompt/custom-editor.ts#L1434-L1452)). Use `edit` to set the editor text with a `len` check, then the `\x11` key through the same writer | omp source |
| Shell and Python (`!`, `!!`, `$`) | Typed | `send` the text; studio observed omp running them as `omp.bash` and `omp.eval` | [`docs/architecture/tsp-real-omp-probes.md:22-30`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-real-omp-probes.md?plain=1#L22-L30) |
| Pastes | Bracketed paste | Unchanged key path; omp's paste handling is the same code | `host.ts` `paste` |
| Images | Path paste plus Enter | Clear the editor, bracketed-paste and confirm each image path, then append text and `action submit`. On rejection, restore the original text/cursor and retain the failed message for explicit retry. `send` drops staged images | Current 18.15/18.16 `image-reject` recordings and [`docs/architecture/tsp-migration.md:196`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L196) |
| Queue holds | Debug overlays and painted editor (A6) | `omp.queue` items in `dock`, an open overlay or `screen` surface, or the editor replaced by an ask | [`docs/architecture/tsp-real-omp-probes.md:36-41`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-real-omp-probes.md?plain=1#L36-L41) |
| Escape with queued items | Painted editor return | On Escape omp appends queued text to its own editor; read it from the `text` append operation, return it to the app composer, then clear omp's editor with `edit` | [`docs/architecture/tsp-real-omp-probes.md:40-41`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-real-omp-probes.md?plain=1#L40-L41) |
| Approval pending | "Sending a message now denies this request" | Same rule: `send` while an approval waits denies and steers (studio confirmed on omp 18.12.5); model, thinking and slash actions are refused while an approval waits | [`docs/architecture/tsp-migration.md:220-224`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L220-L224) |
| Panel open | Terminal sheet | Send refused with a message while a `screen` surface or the Agent Hub picker is open | [`docs/architecture/tsp-migration.md:226`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L226) |
| Ghost text | Painted cursor text (A17) | Editor `ghost` property; Tab still accepts | Background, Documents |
| Undo | Ctrl+Z | `undo` event when advertised | [`packages/wire/src/tsp.ts:1043-1050`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/wire/src/tsp.ts#L1043-L1050) |

**Interfaces.** `SessionHost.submit(text, mode)` keeps its signature. `SessionHost.composerFacts(): { sendable, text, cursor, ghost, editorId, surfaceId, queued: string[], blockedBy: "ask" | "approval" | "panel" | null }` is published over the Phase 1 channel. `EditorInputTransaction` gains `edit(from, to, text, cursor)` for TSP hosts; `keys` stays for Tab.

**Tests.** Fixtures: `send-busy-steer`, `follow-up-queue`, `queue-escape-restore`, `shell-bang`, `python-dollar`, `paste-large`, `image-attach`, `approval-send-denies`, `ask-replaces-editor`, `prediction-ghost` (scripted provider). Ordering tests interleave an `ack` with a multi-part image submission.

**Acceptance criteria.**

1. Replay: each fixture completes using only the new input path, and the written bytes match the recording's events.
2. Replay: `send` is never written while `sendable` is false, while a `screen` surface is open, or with a stale surface id; each refusal returns a distinct message the composer shows.
3. Replay: follow-up appears in `omp.queue` and is delivered after the turn ends; Escape during a queued follow-up returns its text to the app composer and leaves omp's editor empty.
4. Replay: an image submission produces a user message with the image in the collab transcript of the fixture.
5. Replay: classic ordinary text and generic dialog pastes retain their existing byte path. The Rule 2 attachment safety exception delays classic image submission until the production acknowledgement path confirms each upstream token, blocks unsupported or unavailable acknowledgement, and retains rejected attachments for explicit retry. Live (scripted provider): verify successful single and multiple image sends on 18.15 and 18.16, including provider image receipt.
6. Live (scripted provider): `follow-up-queue`, `image-attach` and `approval-send-denies` complete against the installed omp.
7. Manual (macOS): steer, follow-up, `!ls`, `$ 1+1`, a long paste, an image and a prediction in a TSP chat; IME composition (Japanese or Chinese) submits the committed text once. `[INFERENCE]` The app composer is unchanged, so IME should behave as before; it must still be checked by hand.

**Risks and gate.** Follow-up depends on a key after an `edit`, so in-flight paste work affects ordering ([`packages/tui/src/prompt/custom-editor.ts:1619-1620`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/prompt/custom-editor.ts#L1619-L1620)). Gate: criteria 1-7 pass and the owner confirms steer and follow-up behave as in classic chats.

---

## Phase 4: adapter cutover

**Goal.** Replace each screen adapter with document facts and TSP actions for TSP hosts. The classic path stays for classic hosts until Phase 7. Each step merges separately, and its consumer claims its nodes only in the change that makes it work (Rule 7).

| Step | Adapters | Why in this position |
|---|---|---|
| 4a | A9 hook dialogs | Builds the shared helpers later steps use: find a node by role, `activate` an item, `edit` a field, `action submit` or `cancel`, wait for the node to leave; and adds the native card on top of the Phase 2 arbitration (Rule 8). Most frequent card. |
| 4b | A15 worktree confirms and shutdown refinements | Reuses 4a; replaces main-process screen parsing in a lifecycle path. |
| 4c | A10 plan review | High value; explicit upstream roles and actions. |
| 4d | A11 model and thinking | Native picker and `thinking.cycle` actions; collab already confirms identity. |
| 4e | A14 command feedback | Needs a "new toast or notice after this command" helper, which 4a-4d exercise first. |
| 4f | A12 tree navigation | Depends on Phase 3 editor ownership; needs a recorded workflow. |
| 4g | A13 advisor apply | Rare; the file-preservation transaction stays. |
| 4h | A17 prediction offer | Small change on top of Phase 3 ghost text. |
| 4i | A16 startup diagnostics | Raw pre-TUI capture stays; only post-surface reading changes. |
| 4j | A6, A7 overlay watching, queue holds, slash watches | The catch-all, retired last once every specific card claims its nodes. |

**Collab authorities that stay.** Replicated asks and approvals are answered only through collab `ui-response` under Rule 8 (`state/session.ts`, `collab/lib/client.ts`). Stop stays collab `abort`. Subagent commands and model identity confirmation stay on collab. Work modes stay on the extension (`nativeModes.ts`, `plan.ts`).

### 4a. Hook dialogs (A9)

- **Today.** `ompDialog.ts` parses framed dialogs; `ompDialogActions.ts` drives arrows, deletion keys and Enter; `OmpDialogCard.tsx` defers to collab questions.
- **TSP.** `omp.overlay.hook-select`, `omp.overlay.hook-input`, `omp.overlay.hook-editor` with native events ([`packages/tui/src/overlays/hook-selector.ts:800-839`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/hook-selector.ts#L800-L839), [`packages/tui/src/overlays/hook-input.ts:119-177`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/hook-input.ts#L119-L177), [`packages/tui/src/overlays/hook-editor.ts:188-280`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/hook-editor.ts#L188-L280)). studio observed these dialogs in the `dock` region ([`docs/architecture/tsp-migration.md:95`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L95)).
- **Files.** `src/shared/tsp/dialogs.ts` (pure `hookDialog(doc)`), `OmpDialogCard.tsx` TSP source, `features/session-tools/ompDialogTsp.ts`. It reuses `src/shared/tsp/question-match.ts` from Phase 2.
- **Interfaces.** The card keeps its props; choose = `activate` on the list with the item id; text = `edit` over the full range with `len`, then `action submit`; cancel = `action cancel` or Escape.
- **Chat status.** A TSP hook dialog is local to omp and has no collab question. Today the classic card does not change chat status for local dialogs either, so this step keeps status unchanged. Showing "waiting for an answer" for local dialogs would be a SPEC change for the owner.
- **Automatic sheet ownership.** The watcher uses mounted-visible consumer availability independently of covering sheet state, and rechecks current registrations before opening. Hook and plan cards retain that availability while covered, avoiding claim/open/close feedback. A real-composition replay mounts ChatArea, native cards, OverlayWatcher, the terminal sheet and actual stores against input, confirm, editor, plan review and extension-row recordings. Native cards stay visible without an automatic sheet; unclaimed rows open the sheet.
- **Implementation status.** The native `OmpDialogCard` now reads TSP hook documents through pure shared projections and submits complete answers through main's existing `host:tsp-answer` transaction. It claims supported hooks, including the roleless 18.15 picker shape, so the omp screen does not duplicate their controls or automatically open for them. Matched requests retain the collab question card; ambiguous, unavailable, settling, answering and closing local cards are display-only. Full option lists have no hidden-options note or terminal offer. Local dialogs add no chat-status input. Physical hook ownership still blocks composer and slash delivery after presentation is claimed.
- **Active presentation ownership.** The registry declares which roles a consumer can present, without hiding nodes by shape alone. Mounted visible native and collab cards register exact host, epoch, surface and node ownership. A page covering the chat, an inert narrow split pane, another sheet or unmount releases ownership, restoring generic hook presentation with unchanged main arbitration. Disabled options remain inert for pointer and double-click input; arrow, Home and End navigation skip them.
- **Sheet Escape.** A covering sheet releases active suppression while retaining exact native-consumer availability. Escape returns to that card without answering its hook. Without an available native consumer, the generic guarded Escape path remains. Always-present composer model/effort consumers and notice projections retain static claims. The fixture baseline contains 57 raw recordings and matching integrity manifests.
- **Shared helpers.** `src/shared/tsp/dialogs.ts` documents exact-role lookup, item activation, full-range UTF-16 edits, declared actions, hook projection and node-departure facts. `ompDialogTsp.ts` adapts those facts to the unchanged card props and supplies a scoped, subscription-only node-departure wait. Consumers subscribe before writing and abort the wait when a write fails or the consumer unmounts.
- **Evidence.** Native-card replay covers all thirteen positive classic dialog captures with independently recorded 18.15.0 counterparts, all four hook answer/cancel forms, the custom-rows fallback, complete long lists and collab display arbitration. Main-writer replay covers request-before-node, node-before-request, reconnect and remote-guest completion ordering. The Chrome gate includes native card completion and light/dark captures at normal and enlarged text.
- **Acceptance.**
  1. Replay: each classic dialog fixture in `features/session-tools/fixtures/omp-dialogs/` has a TSP counterpart that renders the same card and completes; long option lists show every option, so the "options hidden" note and its Open terminal offer disappear for TSP chats.
  2. Replay, question ordering (`hook-collab-aware` with collab events injected): collab request before the node, node before the request, a reconnect while the dialog is open, and a guest answering remotely. Main writes no local answer once its mirror reports a match or ambiguity, and an authoritative unmatched dialog can answer through TSP. Under D10, delayed channel delivery can briefly offer both controls and produce a losing submission or cancellation; omp's first-answer race determines the single completed result and aborts the other branch. Live checks record those orderings and outcomes, rather than claiming the app always offers exactly one answer path.
  3. Live (no-model): hook fixtures re-record with identical roles and actions.

### 4b. Worktree confirms and shutdown (A15)

- **TSP.** Startup and exit worktree questions are hook selectors with title, detail and options. Shutdown is already handled by 2.0.
- **Files.** `src/main/omp/tsp/worktree.ts` (main-side matcher), `host.ts`.
- **Acceptance.** Replay: `worktree-exit-ask` (scratch git repo, `worktree.onExit: ask`) shows the native dialog with omp's risk text verbatim and Keep as default, and both Keep and Remove complete with `activate`. `worktree-start-ask` is recorded for evidence while the hosted override stays. Manual: quit while working still follows SPEC Lifecycle.
- **Implementation status (2026-11-02).** Application-driven TSP shutdown recognizes only the live
  `Remove worktree?` hook with enabled Yes and No options. Its existing native dialog retains
  omp's complete risk description, defaults and cancels to Keep, and activates the recorded
  No or Yes item for Keep or Remove. Main revalidates the question, host, generation and epoch
  at the serialized writer, then waits for physical node departure. Both ordinary hook answers
  and shutdown share arbitration ownership. Matched, ambiguous, settling and answering questions
  cannot open or submit a shutdown dialog; retained remote ownership stays blocked after disconnect.
  An otherwise unowned exact exit question can finish after collab teardown. Other application
  input remains unavailable while closing, and a live hook still prevents raw Escape.
- **Evidence and scope.** Three standalone, no-model recordings use fresh scratch git repositories:
  `worktree-exit-ask`, `worktree-exit-ask-remove` and `worktree-start-ask`. Both exit recordings
  include uncommitted changes and complete with `activate`. Startup creation remains disabled
  for hosted chats; the startup recording is evidence only. A typed `/exit` while the chat is
  live retains the existing arbitrated native hook card. The main-owned operating-system dialog
  is restricted to application-driven shutdown. Host replay checks both decisions, the exact risk
  text, Keep defaults, long native decisions, stale-question refusal and zero painted-screen reads.
  Manual quit while working remains a main-agent or owner check against SPEC Lifecycle.

### 4c. Plan review (A10)

- **TSP.** `omp.overlay.planReview` with `omp.plan.body`, `omp.plan.options`, `omp.plan.slider` and `omp.plan.tools` ([`packages/tui/src/overlays/plan-review-overlay.ts:1573-1618`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/plan-review-overlay.ts#L1573-L1618), [`packages/tui/src/overlays/plan-review-overlay.ts:1654-1700`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/plan-review-overlay.ts#L1654-L1700)).
- **Files.** `src/shared/tsp/plan-review.ts`, `PlanReviewCard.tsx` TSP source, `PlanPane.tsx` (direct Enter approval becomes `activate`).
- **Acceptance.** Replay: `plan-review` (scripted provider) drives Approve and run, Approve and compact first, Refine with a comment, Switch to Auto and run, Discard plan and Save and stop, each matching the recording. Live (scripted provider): the same fixture re-records. The pane's options action opens the omp screen. Permission-mode choices stay on the extension.
- **Implementation status (2026-11-02).** The card and Plan pane consume current TSP documents,
  including disabled options, execution tiers and committed compaction. Unknown interactive layouts
  and annotation choosers remain unclaimed. Only a mounted, visible card claims its exact host,
  epoch, surface and overlay node. Hidden pages, inert split panes and opening the omp screen
  release that claim. Physical overlays continue to block composer sends. Writes revalidate the
  live option after permission changes; only physical node departure completes a choice. Restart,
  room change and unavailable lifecycle cancel completion without refining, exiting or reporting success.
  Six standalone 18.15.0 loopback-provider recordings cover
  execute, compact, keep, refine with a submitted comment, cancel and the save-path confirmation.
  Production card, composer and screen controls replay every captured workflow, including the
  refinement comment and save-path confirmation. Deferred permission-config tests cover Auto's
  ordering and revalidation. The recorder does not capture Auto's config mutation or extension
  plan exit, so their combined live Electron workflows remain a manual check. The headless Chrome
  gate includes light and dark card captures.


### 4d. Model and thinking (A11)

- **Today.** `model.ts` types `/switch <selector>` after screen readiness and cycles Shift+Tab while reading the status border.
- **TSP.** Recommended: `action status.model` on the composer's model node opens the session model picker; `activate` the `provider/model` item; success is the picker closing plus collab model identity. Thinking uses `action thinking.cycle` on the effort node until `p.level` matches, stopping after one full cycle for an unsupported level ([`packages/tui/src/prompt/custom-editor.ts:1435-1437`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/prompt/custom-editor.ts#L1435-L1437); studio [`docs/architecture/tsp-migration.md:174-179`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L174-L179)). A switch to a smaller context window compacts first and can take minutes, so the wait follows the compaction row (studio, omp 18.14.0, [`docs/architecture/tsp-migration.md:177`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L177)).
- **Typed commands remain valid.** omp defines TUI handlers for `/model` and `/switch`; `/switch` explicitly accepts selector arguments ([`packages/coding-agent/src/slash-commands/builtin-modes.ts:413-490`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/coding-agent/src/slash-commands/builtin-modes.ts#L413-L490)), and `send` uses ordinary submission. studio's observation that `/model <id>` reached the model as a message does not establish a TSP rule. Sending `/switch <selector>` through `send` therefore stays an acceptable fallback; the picker route is preferred because it confirms the exact item.
- **Acceptance.** Replay: `model-switch`, `model-switch-compact`, `model-switch-compact-error`, `thinking-cycle`, and `switch-typed` complete through the composer controls; collab confirms identity. Live (scripted provider): `model-switch-compact` re-records.

**Implementation status (2026-11-02).** The TSP composer controls now use the session picker and
semantic thinking-cycle routes above. The existing provider/family/version menu activates the
exact provider/model item; success requires picker departure and collab identity. Missing picker
routes retain semantic `/switch` fallback. Model and thinking changes refuse pending approvals
before writing and distinguish unsupported thinking levels from general failure. Scoped document
subscriptions terminate on lifecycle changes, preserve the longer compaction wait, and never
read painted screens. Composer model and effort roles are claimed alongside these consumers.
At the serialized writer, model and thinking actions must still be declared by their current
target, and an activated picker item must still exist and be enabled. Other known action routes
retain their existing declaration rules. Active compaction has no fixed timeout; its departure
starts a bounded collab-confirmation interval.

The standalone 18.15.0 recorder adds `model-switch`, `thinking-cycle` and `switch-typed`, using
two isolated local models whose unused loopback endpoint receives no requests. Consumer replay
tests cover exact events, delayed or absent collab confirmation, picker closure, typed fallback,
full-cycle refusal, approval refusal, room changes and the native model tree and thinking menu.
Recorded `model-switch-compact` and `model-switch-compact-error` use the Phase 3 loopback provider
with a seeded eight-turn conversation. Consumer replays preserve the live compaction progress
row beyond the ordinary confirmation interval and distinguish the error outcome without
changing model identity. Both scenarios were recorded against standalone omp 18.15.0 in scratch
profiles. Main must still check both composer controls in Electron.

### 4e. Command feedback (A14)

- **TSP.** `omp.toast.status`, `omp.notice.error` and `section` with role `omp.compaction` (studio [`docs/architecture/tsp-migration.md:149-152`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L149-L152), [`docs/architecture/tsp-migration.md:212-213`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-migration.md?plain=1#L212-L213)). A local transaction records the document sequence before `send` and accepts only nodes added or changed after it.
- **Files.** `src/shared/tsp/command-result.ts` (pure `commandOutcome(before, after, spec)`), `typed.ts` TSP source, `results.ts`.
- **Interfaces.** A spec per command: success pattern, error patterns, or quiet success with a settle window (studio uses 1.5 seconds for `/jobs kill`).
- **Acceptance.** Replay: `rename`, `export` (the export path still comes from omp's message text), `compact-ok`, `compact-error`, `handoff`, `cleanse`, `jobs-kill`; each result row matches the classic text. These outcomes are not projected twice by 2.2.
- **Implementation status (2026-11-02).** `commandOutcome` compares the submitted host, room generation, protocol epoch and per-surface sequence against later documents. Semantic feedback content must change; style, TTL, collapsed state and descendant ids do not establish fresh output. Command-specific success, failure and cancellation patterns refuse unrelated errors. Jobs-kill patterns bind to the requested job, and quiet completion waits 1.5 seconds. Completed compaction requires a matching completed heading, a nonempty summary and omp's settled marker. The subscription starts before `send`. Host, room and epoch changes cancel the old result. Completed summaries remain collab transcript rows; separate later status messages remain notices.
- **Notice ownership.** The command provisionally holds its first matching outcome with its arrival anchor. Only a displayed typed result or a native presentation callback commits consumption. Submission failure, supersession, absent consumers and cancelled outcome collection release undisplayed feedback to notices. Additional matching feedback is never reserved after the first outcome. Native results carry semantic status; export failures display as errors, and its Show action preserves the complete printed path. Classic parsing and presentation are unchanged.
- **Recording evidence.** Eight standalone 18.15.0 recordings cover rename, export, successful soft compaction, scripted-provider compaction failure, handoff, cleanse cancellation, a jobs-kill missing-job error and cancellation of a running scripted bash job. Consumer replays check literal result text, error tone, export-path preservation, compaction-row suppression, notice deduplication and cleanse queue ownership through its exact recorded Escape. The cleanse recording cancels its local instruction prompt after the no-checker panel; a completed checker/fix workflow has not been recorded. Quiet jobs-kill timing has a synthetic consumer test because the captured omp reports its cancellation explicitly. Manual Electron checks remain with main.
- **Review regression coverage.** Pure tests reject unrelated command errors and cancellations as success, ignore presentation-only changes and require compaction completion evidence. Production-subscription tests cover feedback received during pending submission followed by rejection, supersession before row publication, later matching feedback, and overlay cancellation while the editor hold remains. Native export tests exercise both success and failure presentation.


### 4f. Session tree navigation (A12)

- **Classic.** `navigate.ts` and `tree.ts` retain the painted `/tree` row prediction and key path for classic hosts.
- **TSP.** Go here opens `/tree`, reads its live selector and sends one `activate` with the session entry id. omp 18.15.0 advertises a roleless tree-layout picker whose item ids are session entry ids. A hidden entry uses the declared All filter tab before activation, pinned to the original surface and selector ids throughout that wait. Selector departure or replacement refuses navigation. The serialized writer repeats the exact selector, surface, entry, disabled-state and filter checks, alongside host generation and protocol epoch checks. Missing, changed, disabled and filtered targets have distinct refusals.
- **Branch question.** When `branchSummary.enabled` is set, navigation opens the ordinary `Summarize branch?` hook selector. Go here chooses its observed No summary option through the guarded 4a answer transaction. A uniquely replicated question uses collab; ambiguous or unavailable arbitration refuses local answering. No row index or predicted option id is used.
- **Draft ownership.** Navigation waits for fresh success feedback, selector departure and the sendable editor. Its exact restored text enters Phase 3's retained editor-transfer record before a length-checked `edit` clears omp's editor. Persisted insertion receipts preserve an existing app draft and prevent duplicate restoration after renderer reload. Failed clears retain the exact text with the existing recovery action. The tree sheet no longer replaces it with trimmed session-file text.
- **Presentation ownership.** Only a mounted TreeSheet with an in-progress Go here action claims the exact selector for its pinned host, generation and epoch. Closing, unmounting, completion or a scope change releases that claim. Direct context-menu navigation leaves the generic omp screen available. After a TSP failure, Open omp screen displays the existing selector or question without submitting another `/tree` command or answering it. Classic fallback retains its command.
- **Recording gate.** Standalone omp 18.15.0 recordings `tree-navigate` and `tree-navigate-summary` contain a branched session, one entry-id activation, the optional guarded No summary choice, exact Unicode and whitespace-preserving draft restoration, a full-range edit clear and `/exit`. Both use the scripted loopback provider configuration with zero requests. They contain no Ctrl+C or row-order prediction.
- **Acceptance.** Replay: both recordings complete through the production navigation consumer and main writer; TreeSheet tests cover enabled user and assistant navigation, exact ids, failure fallback and scoped claims. Live (scripted provider): both recordings were made in isolated scratch profiles against the pinned standalone binary. The recorded workflow enables Go here for TSP chats. Main or the owner must still check tree navigation and draft recovery in Electron.

### 4g. Advisor apply (A13)

- **TSP.** `omp.overlay.advisor` ([`packages/tui/src/overlays/advisor-config.ts:920`](https://github.com/can1357/oh-my-pi/blob/v18.14.0/packages/tui/src/overlays/advisor-config.ts#L920)) with list and prefs actions. The main-owned preservation transaction is unchanged.
- **Acceptance.** Replay: `advisor-apply` chooses scope and Save and apply by id; the transaction's existing tests pass. The study did not exercise this workflow, so this fixture is its first evidence.
- **Implementation status (2026-11-03).** The Advisor sheet applies saved project and user
  configuration through semantic `/advisor configure`. With prefs advertised, omp 18.15.0
  describes a roleless advisor prefs page on a screen surface; the registered overlay and
  list path remains supported when prefs is absent. The app chooses scope by declared
  action or list item id. Save and Close share one writer operation. Completion requires
  physical page departure and a fresh matching saved status, since omp keeps the page open
  after Save and hides its status until Close. The existing main-owned file-preservation
  transaction is unchanged.
- **Authority and claims.** `host:tsp-advisor` binds the expected scope, host, room generation,
  protocol epoch, surface and node at the serialized writer. Missing or disabled actions,
  changed scope, a pending question or approval, and stale input have distinct refusals.
  Only the active apply driver claims the exact advisor page. Roleless prefs must use a
  screen surface with the recorded title, file section and complete file-action declarations.
  Foreign roles, inline prefs, active editors, malformed declarations and duplicate candidates
  stay unavailable to the driver. Manual pages and other unclaimed content remain visible
  in the omp screen. Scope invalidation, fresh advisor errors and timeouts release claims
  and subscriptions and finish preservation once without reporting success, including when
  omp refuses Close. No TSP advisor path reads painted rows.
- **Evidence.** Standalone 18.15.0 no-model recordings `advisor-apply` and
  `advisor-apply-project` capture both scopes, Save and Close. Consumer replay checks exact
  events, departure, confirmation, writer refusal, room changes, preservation finalization
  and the production Advisor sheet's busy and success states. Main-writer tests cover scope
  and declaration races and lifecycle refusals. Existing preservation tests remain applicable.
  Main must check Save and apply and Apply saved configuration for both scopes in Electron.

### 4h. Prediction offer (A17)

- Detection uses `composerFacts().ghost`. Tab, exact capture, compare and clear through the extension stay.
- **Implementation status.** Phase 3 displays `composerFacts().ghost` and uses the existing exact extension transfer for Tab acceptance. `prediction-ghost` records the ghost, Tab insertion and len-checked clear against standalone omp 18.15.0. Changing transport hides stale offers without starting the classic painted poll. Consumer tests cover semantic display and exact transfer without painted reads; manual Electron and IME checks remain with main.
- **Acceptance.** Replay: `prediction-ghost`; existing `prediction-transfer.test.ts` cases pass with a document source. Live (scripted provider): `prediction-ghost` re-records.

### 4i. Startup diagnostics (A16)

- After a surface opens, warnings arrive as nodes and 2.2 projects them. Before it opens, main keeps a bounded raw capture of non-TSP bytes with escape sequences removed, within the existing eight-line and 1,200-character limits.
- **Acceptance.** Replay: `startup-no-model`, and `startup-missing-resume` (a missing `--resume` file that fails before the TUI starts); both still offer their existing actions.
- **Implementation status.** Main captures recognized pre-surface failures from the non-TSP byte path with incremental UTF-8 decoding and escape-sequence removal. The retained failure text stays within eight lines and 1,200 characters. The first surface, collab connection or application input ends capture; post-surface warnings continue through 2.2 without painted-row reads. Both transports share diagnostic recognition and exact missing-resume classification, including omp 18.15.0's quoted session path.
- **Replay evidence.** `host.test.ts` replays `startup-missing-resume` in one-byte, 13-byte and complete reads, verifies fresh-chat recovery, and checks composer input availability after the recorded no-model warning. The no-model replay does not establish login or model-selection completion. It covers the capture bounds and first-surface boundary. `ChatView.test.ts` mounts the production banner and button, clicks the named fresh-chat and restart actions for both transports, and checks the resulting store/controller calls; `NoticeRow.test.ts` retains the recorded no-model warning. `startup-diagnostics.test.ts` covers split escape sequences, Unicode and oversized output. The missing-resume recording has no hello, emitted input or journal because omp exits before its TUI starts. Live Electron checks remain for main.

### 4j. Overlay watching, queue holds and slash watches (A6, A7)

- `OverlayWatcher.tsx` and `overlays.ts` use `openOverlay` and claims for TSP hosts; `typed.ts` screen watches use 4e outcomes; queue holds in `state/session.ts` use Phase 3 facts.
- **Implementation status (2026-11-03).** Immediate and queued pass-through slash commands, `readyEditor`, `editorBack` and the generic command runner use TSP availability and document subscriptions. Known commands collect 4e outcomes; other commands retain notices and an input-ownership hold. Readiness waits for the editor with an eight-second bound. A continuously available editor releases the queue after 600 ms without asserting command success; unrelated updates do not restart that timer. Scope changes release the old watch. Queue busy/drain decisions use semantic composer facts and availability exclusively for TSP, including when stale classic `tui.overlays` remains on a replacement host. A classic overlay hold releases when its replacement TSP host becomes ready. A classic readiness read that completes after transport replacement refuses before requesting the new host's debug focus. `statusReadError` also refuses TSP locally.
- **Background reads.** Native mode snapshots and `native:changed` retain Goal status and permission labels. The shared status source starts neither its 1-second nor its 450 ms painted poll for TSP, even with stale classic overlay counts. Plan pane and badge effects skip painted reads. Hook and Plan Review cards, model/thinking, tree navigation and advisor application use their converted consumers. The composer uses semantic ghost facts without its painted prediction poll. Classic polling and parsing remain available only to classic hosts.
- **Main boundary.** `SessionHost.screenReadAttempts()` records refused TSP reads for the host's lifetime. The public screen, buffer, focus, paint and debug-value methods record before refusing. The debug client's request boundary checks the same guard before connecting or sending `info`, `tree`, `text` or `values`; direct classic xterm-buffer readers are guarded too. A swallowed debug rejection therefore still appears in the audit. Raw pre-surface diagnostics, OSC status parsing, terminal-probe replies and the existing 500 ms native location/recap/appearance maintenance timer do not inspect painted rows.
- **Renderer replay evidence.** `ComposerPolling.test.ts` mounts the composer and shared status consumers, advances 60 simulated seconds with zero painted-screen or prediction IPC, and checks that neither painted-poll interval starts with zero or stale nonzero overlay counts. Classic controls exercise both timer cadences. Session tests cover semantic queue holds and release across host replacement. Typed-command, watcher, terminal-sheet and composition replays retain command feedback, physical overlay holds, exact presentation claims and the semantic fallback.
- **Acceptance.** Replay: no TSP code path calls `host:screen`, `host:buffer` or debug `tree`/`text` polling, and the TSP host never starts the 1-second or 450 ms poll.
- **Installed-host evidence (2026-11-03).** `src/main/omp/tsp/retire.live.test.ts` passed against standalone omp 18.15.0 and 18.16.0. One production `SessionHost`, PTY and collab guest complete startup, a scripted message, `/hotkeys` open/close, an exact Unicode hook answer, entry-id tree navigation and restored-draft clear, model selection, Auto and fixed thinking changes, Plan Review refinement and clean shutdown. The host id and PID stay unchanged, each stage records zero attempted painted/debug reads, and exact provider counts remain one through tree navigation and four after refinement. The gate shares the recorder's loopback provider and existing tree, hook and plan assets. It is enabled by `OMP_BIN` on macOS/Linux and included in the release watcher's compatibility step. It does not mount a renderer; the mounted zero-poll replay above supplies that evidence.
- **Verification (2026-11-03).** Final typecheck passed. The eight affected test files passed 398 tests. The full Vitest suite passed 3,281 tests in 256 files, with 49 tests in six gated files skipped. The installed retirement gate was then run explicitly against each standalone version, with one test passing per version. No Electron or packaged check was run. Phase 4j's automated criterion is met by the installed zero-read session and the mounted zero-poll replay; owner acceptance remains separate.

**Retirement audit after 4a-4i.** "Already semantic" means that the TSP branch existed before 4j; the classic adapter remains until Phase 7.

| Consumer | TSP status before 4j | Status after 4j |
|---|---|---|
| `host:screen`, `host:buffer`, `host:tui-focus`, main paint/debug-value methods | Already refused TSP, without an attempted-read ledger. | Refuse and record the attempted source before any painted/debug read. |
| Debug `info`, `tree`, `text`, `values` | Reachable internal calls depended on their classic branch checks. | The debug request boundary also refuses and records TSP before socket connection or request. |
| Main worktree preflight, confirmation rechecks and shutdown | Already semantic worktree hooks and shutdown facts for TSP; debug key/screen paths were classic-only. | Same routing, with guarded debug and direct painted-progress boundaries. |
| Main startup diagnostics and notices | Already raw bounded pre-surface capture and semantic post-surface notices. | Same routing; classic xterm-buffer readers also enforce the read guard. |
| Main focus/location/recap maintenance | The 500 ms timer ran for both transports; debug focus/tree reads were classic-only. | Unchanged timer and native facts; debug reads remain guarded and classic-only. |
| `screenPoller` and `parseStatusLine` | Already native snapshots/events for TSP; painted parsing and both timer cadences were classic-only. | Same routing, with explicit zero-timer replay assertions and classic cadence controls. |
| `readScreen`, `waitForScreen` | Already refused TSP before IPC. | Unchanged local refusal. |
| `readyEditor`, `statusReadError` | Semantic readiness existed; an in-flight classic read could request replacement TSP focus, and the error helper accepted direct TSP calls. | Transport replacement and direct TSP error calls refuse locally before debug IPC. |
| Prediction offer and exact transfer | Already semantic ghost facts and guarded extension transfer; classic polling/paint/debug values were separate. | Unchanged TSP facts, with guarded main read boundaries. |
| `OverlayWatcher`, `overlays.ts` | Already `openOverlay`, screen surfaces and exact presentation consumers for TSP. | Unchanged semantic decisions; regex titles and painting delay remain classic-only. |
| `TerminalSheet`, `TerminalMirror` | Already semantic content for TSP; painted title subscription and buffer mirror were classic-only. | Unchanged routing; main also records any attempted buffer read. |
| `typed.ts`, `results.ts`, generic slash watch | Already document subscriptions, 4e outcomes and notice reservations. | Unchanged semantic command ownership and outcomes; painted settling remains classic-only. |
| `state/session.ts` queue busy/drain and overlay holds | Semantic facts were checked, but stale `tui.overlays` could still block TSP delivery or retain a classic hold. | TSP uses semantic facts and availability exclusively; replacement-host readiness releases the obsolete classic hold. |
| Hook/plan cards, plan pane/badge, model/thinking, navigation, advisor | Already selected their 4a-4g semantic consumers before painted adapters. | Unchanged claims, actions and collab authorities. Remaining transport branches preserve classic adapters and transport-specific wording. |

**Phase 4 gate to Phase 7.** The gate remains closed until every step's replay and live criteria pass and the owner signs off each converted card. Automated evidence and owner acceptance are tracked separately:

| Gate item | Evidence available | Remaining acceptance |
|---|---|---|
| 4a hook dialogs | Recorded native-card and main-writer replay, composition and Chrome gates; main's 2026-11-02 Electron observations above. | Owner card sign-off; separate browser-guest coverage remains outside the scoped manual observations. |
| 4b worktree and shutdown | Both recorded Keep/Remove decisions and main-writer lifecycle/refusal replay. | Manual quit while working against SPEC Lifecycle and owner sign-off. |
| 4c Plan Review | Six scripted-provider recordings and production-consumer replay. | Combined Auto/config mutation and extension plan-exit Electron workflows, then owner sign-off. |
| 4d model and thinking | Picker/thinking/typed-switch replay and scripted compaction success/error recordings. | Both composer controls in Electron and owner sign-off. |
| 4e command feedback | Eight recordings plus literal-result, ownership and quiet-timing consumer replay. | Completed cleanse checker/fix workflow is unrecorded; manual Electron checks and owner sign-off remain. |
| 4f tree navigation | Two scripted-profile recordings and consumer/main-writer replay, including exact draft restoration. | Electron navigation and draft recovery, then owner sign-off. |
| 4g advisor apply | Both scopes recorded, with consumer/main-writer and preservation tests. | Both apply actions for each scope in Electron and owner sign-off. |
| 4h prediction offer | Ghost/Tab/clear recording and exact-transfer consumer tests. | Electron and IME checks and owner sign-off. |
| 4i startup diagnostics | Missing-resume raw-byte replay, bounded capture tests and production recovery-banner tests. | Owner recovery-flow sign-off; the no-model warning recording does not prove login/model-selection completion. |
| 4j catch-all retirement | Main attempted-read guard, renderer zero-poll/queue/slash replays and the installed zero-read session passed against 18.15.0 and 18.16.0. | Automated criterion met; owner acceptance remains. |

---

## Phase 5: native `/btw` pane

**Goal.** A native side-question pane for TSP chats, fed live from omp's `omp.overlay.btwHistory` overlay and reconciled with omp's durable `btw-history` sidecar files, with no second agent and no writes to omp's files.

**Why this channel.** Collab carries no BTW records, deltas or commands. omp 18.15.0 writes an initial running checkpoint and a terminal checkpoint, while streaming deltas remain in its live history overlay. Disk reads alone cannot show the streaming answer. The overlay supplies Markdown, status labels and declared close, stop, copy, follow-up, discard and send actions. A single-topic overlay omits its topic id; multi-topic list selections contain physical node paths whose final segment is the sidecar id. Durable ids, raw titles and exact timestamps come from `entry-<id>.json` and `.title` files. These behaviors are recorded by the six BTW fixtures and follow the [18.15.0 controller](https://github.com/can1357/oh-my-pi/blob/v18.15.0/packages/coding-agent/src/modes/controllers/btw-controller.ts), [panel](https://github.com/can1357/oh-my-pi/blob/v18.15.0/packages/tui/src/overlays/btw-history-panel.ts) and [history store](https://github.com/can1357/oh-my-pi/blob/v18.15.0/packages/coding-agent/src/session/btw-history.ts).

**Depends on.** Phase 2 claims (the pane claims the overlay), Phase 3 (`send` and `edit`), and Phase 4e's outcome helper. Phase 4j is not required, because claims arrive in Phase 2.

**Implementation status.** The developer preview now has a Side questions pane, read-only history watching, frame-based projection, serialized host actions and conditional presentation claims. Classic command delivery is unchanged. `btw.test.ts`, `btw-history.test.ts` and `BtwPane.test.ts` cover replay, persistence, resume recovery, drafts and visible ownership. `btw.live.test.ts` re-records the three scripted live criteria through `OMP_BIN`; no billed provider is used. The owner-run manual criterion 7 remains pending.

**Initial verification (2026-11-03, before review corrections).** Typecheck passed. The focused reader, driver, host, pane and slash
tests passed (233 tests), the installed-omp scripted live gate passed (1 test), and the full
suite passed with 258 files and 3,284 tests passing; 6 files and 49 tests were skipped by their
existing gates. Headless Chrome rendered the recorded pane and follow-up form in light and
dark themes at 960x620 and 130% text. The captures and input/layout evidence are in
`/tmp/vomp-btw-shots/`. The follow-up field received keyboard focus, Cmd+Enter preserved
multiline Unicode text and the displayed generation/epoch scope, and its controls remained
inside the viewport without horizontal overflow. Worker verification used headless Chrome.

The six 18.15.0 recordings include same-run sidecars in `<scenario>.artifacts/` and staged document and file evidence in `<scenario>.btw.json`. Ask, follow-up and main-abort were also recorded against the installed omp 18.16.0 in `/tmp/vomp-p5-btw-installed-18.16.0`, outside the committed baseline. In both runs, collab abort ended the main assistant with `stopReason: "aborted"` while the side answer remained running and completed after the scripted side response was released. No side-question action was sent at abort. This is scoped recording evidence; the pane continues to display the current document and file status.

omp 18.16.0's optional `omp.btw.inject` block is rendered as a separate steering prompt. Inject into main appears only while the current overlay explicitly declares `inject`, and the protocol writer repeats that declaration check. The 18.15.0 recordings never advertise it. Unknown additional controls release the pane's claim and remain available in the omp screen.

**Review corrections.** Topic identity is `{ scope, id }` throughout the reader, reconciliation,
aliases, history selection and IPC. Main and helper files may share the same id. The live
document's current view and a unique record match establish its history scope before the driver
translates an identity to a physical omp item. Unmatched helper histories remain readable and
copyable without native mutation controls. The pane claims an overlay only while displaying its
selected scoped topic; new overlays and selected topics replace an older local history selection.
Drafts remain bound to their original host, room, epoch and topic. Saved drafts remain available
for explicit copying, and late asynchronous responses cannot clear a newer draft or conversation.
History mutation is disabled while an operation is in progress.

Replay now advances the captured sidecar checkpoints with the recorded frames through
`BtwHistoryState`, and compares the independent terminal projection with disk before merging.
The recorded-frame pane test renders the corresponding frame/checkpoint projections. Main's omp 18.16 Electron
check observed `/btw`, the pane, a Unicode follow-up and Put away working. Its reported generic
main-composer blocker is replaced by "Put away the side question to send a message." with an
explicit Put away action. Sending never dismisses the side question automatically.

**Review verification (2026-11-03).** Typecheck and all 325 focused tests passed. The installed
omp 18.16 scripted live gate passed, then the full suite passed once with 260 files and 3,309
tests passing; 6 files and 49 tests were skipped by their gates. The design detector returned no
findings. Updated light/dark captures at 960x620 and 130% text include a readable Saved drafts
disclosure after generation/epoch replacement. No IPC action occurred during that replacement.
Restoring the original context and explicitly pressing Cmd+Enter sent its retained Unicode draft
with the original scoped topic and generation/epoch. Capture evidence remains in
`/tmp/vomp-btw-shots/evidence.json`. Worker Chrome, Vite and scratch configuration were removed.

**Empty-history ownership (2026-11-03).** A visible supported empty BTW overlay now registers
both presentation ownership and consumer availability while the pane shows its empty state and
question field. Viewing another saved topic leaves that empty overlay unclaimed. The
`BtwEmptyComposition.test.ts` regressions use the recorded `btw-empty` document with the actual
app store, BtwPane, OverlayWatcher and semantic sheet. They verify that the native field and
Put away remain available without an automatic omp screen, hiding the pane restores the generic
fallback, and showing it again returns ownership to the native pane. Typecheck and all 50
affected tests passed. The full suite ran once: 260 files and 3,310 tests passed, with one
failure in `OmpScreen.test.ts` where its single-warning assertion also captured KaTeX's
quirks-mode warning. Six files and 49 tests were skipped. The empty-history regressions passed.

**Files and modules.**

- `src/main/omp/btw-history.ts`: read-only reader for `<session artifacts>/btw-history/entry-<id>.json` and `.title`, and for focused subagent histories under `btw-history/sessions/<owning-session-id>/`. It watches the directory and skips unparseable files with a log entry.
- `src/shared/tsp/btw.ts`: pure projection of the overlay into topics, turns, streaming answer, status words and available actions.
- `src/main/omp/tsp/btw-driver.ts`: serialized interaction queue for ask, follow-up, stop and close.
- `src/renderer/src/features/btw/BtwPane.tsx`: a side panel pane (DESIGN §3.7); `routeSlash` (`session-tools/slash.ts`) routes the composer's `/btw` to it.

**Interfaces.**

- `btw:list(hostId)` returns a revisioned host, room and epoch snapshot with merged topics `{ id, title, turns: [{ question, answer, status, createdAt, updatedAt }], live, scope? }` and the current overlay's declared actions; `btw:changed` pushes replacements.
- Mutating IPC requests include `{ generation, epoch }` from the displayed state. Main refuses an old renderer scope before writing and retains that scope through the serialized operation.
- `btw:ask(hostId, question, inputScope)` sends `/btw <question>` to the live composer; an empty question opens history.
- `btw:followUp(hostId, topic, text, inputScope)` opens `/btw`, selects the verified scoped topic, sends `action follow-up`, edits the field and sends `action send`.
- `btw:stop(hostId, topic, inputScope)` sends `action stop` for the same selected topic, then closes it. `btw:close(hostId, topic, inputScope)` closes the same topic's overlay; an empty history has a null topic.
- `btw:select(hostId, topic, inputScope)` selects the declared physical list item after verifying `{ scope, id }`. `btw:inject(hostId, topic, inputScope)` sends the declared steering action for that selected topic.
- Identity: a live topic without an id gets `live:N` until its sidecar file appears, then the file's id replaces it (studio [`src/main/tasks/tsp-btw.ts:104-125`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/src/main/tasks/tsp-btw.ts#L104-L125)). Status comes from the document while live and from the file once persisted. The app never marks an answer complete because the stream went quiet.

**Rules.**

- While the pane presents the overlay, the pane claims it and the omp screen does not draw it.
- Main sends are refused while the follow-up composer owns the overlay; studio saw a main send swallowed otherwise ([`src/main/tasks/tsp-btw.ts:163-184`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/src/main/tasks/tsp-btw.ts#L163-L184)).
- Stopping the main turn uses collab `abort`, as everywhere else. Stopping a side question sends `action stop`, waits for omp to report that it stopped, then sends `action close`. Main-turn Stop sends no side-question action. The 18.15.0 and installed 18.16.0 scripted main-abort runs left the side question running until its scripted response completed; the app displays the current document rather than assuming that this observation applies to every future omp release.
- omp has no topic delete; `discard` only drops an unsent follow-up draft (studio [`docs/architecture/tsp-btw.md:83`](https://github.com/DawnJson/omp-studio/blob/4dbe037dc3bda4c37e831625450225cf102267d7/docs/architecture/tsp-btw.md?plain=1#L83)). The pane offers no delete (decision D6).
- Classic chats keep today's behavior.

**Tests.** Fixtures with the scripted provider: `btw-empty`, `btw-ask`, `btw-ask-again`, `btw-follow-up`, `btw-cancel`, `btw-open-main-abort`, with sidecar files captured from the same runs.

**Acceptance criteria.**

1. Replay: each fixture replays through the driver; the merged topic list equals the sidecar files after the run, with matching ids, titles, statuses and timestamps.
2. Replay: a streaming answer updates the pane per frame, and the final text equals the persisted record.
3. Replay: after a process restart with `--resume`, previous topics come from disk, and records that were running show omp's interrupted status.
4. Replay: `btw-open-main-abort` shows the main turn aborted through collab and no side-question action written. The recording documents the side question's state in that run; it does not confirm current omp behavior.
5. Replay: the app writes nothing under `btw-history/`.
6. Live (scripted provider): `btw-ask`, `btw-follow-up` and `btw-open-main-abort` re-record against the installed omp. The `btw-open-main-abort` result decides how the pane describes a main-turn stop while a side answer streams.
7. Manual (macOS): ask, follow up, stop and reopen in a TSP chat with a configured provider. This run is billed, so the owner runs it.

**Risks and gate.** The pane depends on `omp.btw.*` roles and action names that omp can change. Gate: criteria 1-6 pass and the owner accepts the placement.

---

## Phase 6: Windows

**Goal.** Evidence that developer-opt-in TSP works in a packaged Windows build in both directions. The developer flag is enabled for this evidence work; the default remains classic until the complete platform gate passes.

**Implementation status (2026-11-03).** Windows TSP launch, target-specific staging, PE layout checks,
Node live probes and a packaged Electron smoke probe are implemented. The first owner-approved PR
run (`41680836744`, PR #6) packaged both architectures but its bundled and system probes all failed
before TSP startup: the scratch environment supplied an absolute `PI_CONFIG_DIR`, which omp treats
as a directory name relative to home. The duplicated Windows drive path caused daemon-presence
directory creation to fail. This run establishes no APC-versus-OSC transport result.

The probe now writes configuration to its scratch `HOME/.omp/agent/config.yml`, sets scratch
`HOME` and `USERPROFILE`, and leaves `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and XDG overrides unset.
omp derives its ordinary config and runtime directories. Upstream 18.15.0 `packages/utils/src/dirs.ts`
defines `PI_CONFIG_DIR` as home-relative at lines 328-336 and joins it to home at lines 116-117.
Daemon scopes use that config root at lines 1121-1129; `launch/presence.ts:40-43` creates `clients`.
The system test's earlier pass masked this same crash. Unexpected omp exits and failed probe
subprocesses now fail that observation while retaining its capture; a running system ConPTY with
no APC remains an observational result. Criteria 5-6 still require an installed build on a Windows
machine.

**Second Windows run (`41684291878`).** The verified omp 18.15.0 binary completed hello, five
frames and five acknowledgments, chunked Unicode `edit`, and chunked Unicode `send` through both
APC and OSC 877 with bundled ConPTY. This succeeded with Node's addon and with the packaged x64
Electron-rebuilt addon. The x64 and arm64 layout checks produced their file listings. System
ConPTY produced a live classic TUI and no APC hello or frames during its 20-second observation;
its capture contains no startup crash.

The run still failed because both successful bundled probe children remained alive until the
coordinator's 30-second limits. Their first-output timestamps are exactly 30 seconds apart, and
the bundled test took about 60 seconds. The old diagnostic omitted exit code and signal.
`[INFERENCE]` node-pty 1.1's conout worker retained the event loop: its bundled kill path disposes
that worker only on a subsequent data event (`lib/windowsPtyAgent.js:153-159`), while the worker
owns a listening server (`lib/worker/conoutSocketWorker.js:12-20`).

The isolated probe CLI now explicitly exits after writing its completed report and applying the
same exchange, unexpected-exit and cleanup failure checks. This releases native worker resources
without treating a timeout or failed exchange as success. Reports now retain active resource names
before exit and structured subprocess exit code, signal, killed flag and elapsed time. A process
regression holds a referenced worker open and checks that passing probes exit zero while missing
exchanges, unexpected omp exits and cleanup failures exit nonzero. Another Windows CI run must
confirm clean probe-child exit; this does not establish the manual process-cleanup criterion.

**Local checkpoint (2026-11-03, after review, before rebasing onto refreshed main).** macOS
typecheck and all 47 packaging and CI-helper unit tests pass. One full Vitest run passes
253 files and 3,188 tests, with 5 files and
48 tests skipped. The probe regression tests cover profile setup failure, partial traffic before
cleanup, kill/removal errors, child timeout followed by OSC, startup failure and missing reports. The
Windows live suite is among the platform-gated skips, so these results make no Windows runtime
claim. `actionlint` is unavailable locally; the workflow and builder YAML parse without duplicate
keys, and the Windows step order and failure-path artifact upload were reviewed.

The Windows input policy retains APC based on the successful APC exchanges in the second run.
OSC 877 also delivered both tested operations; these captures provide no reason to change the
current framing. The probe continues to exercise APC first and OSC 877 second in isolated omp
processes, so a failure in one still preserves the other result. Both must complete with successful
probe-child exit before the bundled live and packaged smoke checks pass.

**Facts.**

- node-pty loads `<directory of conpty.node>\conpty\conpty.dll` when `useConptyDll` is set (`node_modules/node-pty/src/win/conpty.cc:181-183`). Its post-install script copies `third_party/conpty/<version>/win10-<arch>/{conpty.dll,OpenConsole.exe}` into `build/Release/conpty` (`node_modules/node-pty/scripts/post-install.js`). The installed tree has version `1.23.251008001` for x64 and arm64, with identical copies under `prebuilds/win32-<arch>/conpty/`.
- `electron-builder.yml` admits `build/Release/conpty/` through its Release filter, excludes `prebuilds` and `third_party`, and unpacks node-pty from asar. node-pty's `binding.gyp` does not copy the DLL or `OpenConsole.exe`, so the explicit staging hook supplies them. The second Windows run passed the x64 and arm64 layout checks and retained their file-size and SHA-256 listings.
- After-pack fuses keep Node mode on Windows because node-pty's console cleanup forks with `ELECTRON_RUN_AS_NODE` (`docs/ARCHITECTURE.md`, Renderer loading and packaging).

**Files and modules.**

- `src/main/omp/host.ts` enables Windows developer-opt-in TSP and passes `useConptyDll: true` only for Windows TSP hosts. Classic spawn options and input remain unchanged.
- `src/main/omp/tsp/encode.ts` selects input framing through one platform policy. APC remains selected following the successful bundled and packaged input exchanges in run `41684291878`.
- `scripts/stage-conpty.mjs` copies `third_party/conpty/<version>/win10-<arch>/{conpty.dll,OpenConsole.exe}` into `node_modules/node-pty/build/Release/conpty/` for the packaged architecture, failing unless exactly one version directory exists. It runs from `beforePack` and again from `afterExtract`. Source inspection of electron-builder 26.15.3 (`app-builder-lib/out/platformPackager.js:155-218`) found that `beforePack` precedes native dependency installation, while `afterExtract` follows installation and precedes `copyAppFiles`. The second idempotent staging call therefore restores the target files after rebuild. An `afterPack` source-tree copy would be too late.
- `scripts/after-pack.mjs`: asserts that both files exist in `resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty/` and match the architecture being packaged, and fails the build otherwise.
- `.github/workflows/ci.yml` keeps the macOS build commands and signing unchanged. All actions are SHA-pinned, checkouts discard credentials and token permissions are limited to `contents: read`. Windows downloads the exact app minimum from its matching GitHub release, verifies `SHA256SUMS.txt`, runs the Node live test before Electron rebuild, builds the existing x64 installer, checks its layout, runs the packaged x64 smoke probe, and builds and checks an arm64 directory package. Both Windows packaging steps have a 20-minute limit.

`scripts/windows-tsp-ci.mjs` supplies the CI commands. Download requests and response bodies share
a 30-second deadline; the version subprocess has 10 seconds. Download and layout errors write
bounded diagnostic JSON before rethrowing. The `windows-conpty-evidence` artifact retains available
file-size and SHA-256 listings, verified omp identity, per-probe snapshots and traffic journals.
Each framing uses an independent child with a 20-second work deadline, bounded cleanup and a
30-second coordinator timeout. An APC child timeout or cleanup failure is recorded before OSC
starts. The live and packaged outer subprocess limits are 90 seconds; each Vitest live case has
100 seconds.

Each probe writes its initial snapshot before profile setup, appends traffic records before parsing,
and saves snapshots before and after cleanup. The coordinator saves each result independently,
including startup or timeout diagnostics when a child has no completed report. These writes retain
available partial evidence after ordinary subprocess and cleanup failures. Failed filesystem writes,
runner loss, job cancellation or forced outer termination can prevent final snapshots or upload;
the artifact is therefore a record of the files successfully written, rather than a guarantee that
every failure produces a complete exchange.

**Tests and evidence.**

- **Live, Node (Windows CI, x64):** `src/main/omp/tsp/tsp-windows.live.test.ts`, gated on `OMP_BIN`, which CI sets so the test never skips there. It spawns omp through node-pty with `useConptyDll: true`, completes the hello, receives frames, sends `send` and `edit` through APC and then through OSC 877, and records both directions, including non-ASCII text split across chunks. A second case with `useConptyDll: false` records the system ConPTY behavior. This test loads node-pty as built for Node; the packaged smoke run below covers the Electron rebuild.
- **Packaged (Windows CI):** the layout assertion for x64 and arm64, and a smoke run of the packaged x64 app with `ELECTRON_RUN_AS_NODE=1` executing a script that loads the packaged, Electron-rebuilt node-pty and repeats the hello and `send` exchange. arm64 is packaged and checked for layout only, unless an arm64 Windows runner is added.
- **Unit:** staging tests select x64 and arm64 and reject zero or two versions; macOS staging is a no-op. Fixture PE tests reject missing, malformed and wrong-machine files before fuse changes. Host tests protect Windows TSP launch and byte-identical classic behavior; stream tests retain the current framing for chunked Unicode events.

**Acceptance criteria.**

1. Packaged: the CI artifact contains both files at the unpacked path for each architecture; disabling the staging step fails the build; the file listing is uploaded as evidence.
2. Live: the Windows test runs (not skipped), receives hello, frames and acks through bundled ConPTY, and the chosen framing delivers `send` and `edit` with non-ASCII text intact.
3. Live: the system ConPTY case is recorded; studio's observation predicts no APC frames, and the recorded result is kept either way.
4. Packaged: the x64 smoke run completes the exchange with the Electron-rebuilt node-pty.
5. Manual (Windows machine, installed build): a TSP chat starts, streams, opens and answers a hook dialog, opens `/btw` and exits cleanly; no `OpenConsole.exe` or `bun.exe` remains after closing the chat and after quitting.
6. Manual: Windows Defender and SmartScreen do not block the bundled `OpenConsole.exe`. `[INFERENCE]` It is signed by Microsoft, but this app has not tested it.

**Risks and gate.** `useConptyDll` is experimental in node-pty, a ConPTY update could drop APC again, and a node-pty upgrade can change the version folder, which the staging step detects. Ordinary Windows chats remain classic. The developer flag is available to collect evidence; the default flip and a claim of completed Windows support require criteria 1-6.

---

## Phase 7: default flip and removal

**Goal.** TSP becomes the presentation for every app-hosted chat, and the classic adapters A2-A17 and the hosted xterm path are deleted. File-based terminal-follow, the general Terminal pane and onboarding or login terminals stay.

**Sequence.**

1. **Flip release.** TSP is the default on each platform whose gates passed. The proposal in decision D3 keeps a hidden `VOMP_TSP=0` for this one release; it needs the owner's approval because it is an exception to clean removal.
2. **Removal release.** Classic code and the flag are deleted, but only when every supported platform runs TSP. If Windows is still classic, removal of the shared classic code waits for Phase 6.

| Area | Delete | Keep |
|---|---|---|
| A1 | Headless xterm and `SerializeAddon` for hosted chats; `host:data`, `host:buffer`, `host:screen` and `host:write` for hosted chats; `PI_TUI_NATIVE=0` and the `TERM_PROGRAM` deletion | OSC 7501 parser, raw pre-TUI capture |
| A2 | Debug `info`/`tree`/`text`/`values`/`keys` polling | `OMP_TUI_DEBUG` itself if restart still needs it; check before removing |
| A3-A4 | `screen.ts`, `status.ts` and `drive.ts` screen helpers; status-line pins in the config overlay | Collab model and thinking identity |
| A5 | Bracketed-paste prompt path | Paste and key paths Phase 3 uses |
| A6-A7 | `typed.ts` screen watches, `OverlayWatcher` regex titles, `overlays.ts` | Claims and the role-to-consumer map |
| A8 | `TerminalMirror.tsx` for hosted chats and the theme extraction only it uses | xterm for the Terminal pane and onboarding |
| A9 | `ompDialog.ts`, `ompDialogActions.ts`, `fixtures/omp-dialogs/` | `OmpDialogCard.tsx` with its TSP source |
| A10-A17 | Screen parsing in `screen.ts`, `model.ts`, `navigate.ts`, `tree.ts`, `advisorApply.ts`, `modes.tsx`, worktree matchers in `host-observations.ts`, painted shutdown and startup reading, painted ghost detection | Advisor preservation transaction, exact prediction transfer, native shutdown stage |
| Tests | Classic-only tests and fixtures | All TSP fixtures |

**Docs.** Rewrite the SPEC Engine statements about a hidden TUI and the terminal sheet, the ARCHITECTURE overview and SessionHost step 5, DESIGN §4.8 ("omp dialog") and §4.11, `docs/COMMANDS.md` handling notes and the Help text for the terminal sheet.

**Acceptance criteria.**

1. Replay: a test fails if any file under `src/` imports the deleted modules or names the deleted IPC channels.
2. Replay: typecheck and the full suite pass on macOS and Windows CI; every TSP fixture replays; JSONL follow tests pass unchanged.
3. Live: the no-model and scripted-provider suites pass against the current omp release.
4. Packaged, bundle: a build script reads the renderer build's chunk metadata and fails if the initial renderer entry chunk includes any module under `features/tsp/`, and it records the entry chunk's uncompressed size beside the size from the last classic release build. Growth above 20 KB fails the check unless the owner accepts it.
5. Manual (macOS and Windows release candidates, per the release rule in `AGENTS.md`): a checklist covering every former terminal entry point, every Phase 4 card, `/btw`, sharing with a guest, worktree exit, quit while working, crash restore with `--restore`, `/new`, `/resume`, fork and rewind.

**Gate.** Flip a platform only when: every terminal entry point has a semantic replacement, Phase 6 passed if the platform is Windows, Phase 4 shows zero screen reads in a scripted session, and the live suites pass for the current omp. Remove classic code only after one release with no TSP regression reported, or with the owner's explicit approval.

---

## Decisions for the owner

| Id | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | How much of omp's document the app draws | (a) Overlays, screens, unclaimed dock nodes and TSP-only notices; the app keeps its transcript and composer. (b) omp's whole session document, as studio does for its process view. | Decided by the owner on 2026-10-30: (a). It keeps collab's transcript, sharing and the current design. The cost is two presentation sources, which needs the notice deduplication in 2.2 and the claims in Rule 7. |
| D2 | What replaces "Open omp terminal" for TSP chats | (a) The semantic omp screen, named "omp screen". (b) Hand the session to the system terminal. (c) Remove the entry points. | Decided by the owner on 2026-10-30: (a). (b) is safe only after a confirmed shutdown of the hosted process, which ends app hosting of that chat while the terminal runs it; it suits an explicit "Continue in Terminal" action more than a menu fallback. |
| D3 | Escape hatch after the flip | (a) Hidden `VOMP_TSP=0` for one release, then none. (b) A permanent per-chat classic option. (c) None. | Decided by the owner on 2026-10-30: (a), approved as an exception to the clean-removal rule for one release. (b) would keep A2-A17 indefinitely. |
| D4 | Minimum omp version | (a) Keep 18.14.0. (b) Raise it when needed. | Superseded by the owner's 2026-11-02 decision to require omp 18.15.0. The pinned 18.14.0 recordings and omp-watch discovery baseline remain unchanged. Role churn is detected by the live suites in `omp-watch.yml`; their results inform whether to support a release, and raising the minimum alone does not fix a renamed role. |
| D5 | Windows timing | (a) Flip both platforms together. (b) Flip macOS first and keep Windows classic until Phase 6 passes. | (b). Flip macOS once its gates pass and retain classic Windows until Phase 6 passes. Shared classic-code removal waits for Windows. |
| D6 | `/btw` placement and actions | (a) Side panel pane. (b) Right sheet. omp has no topic delete. | (a) with no delete. A "Hide topic" action would need app-owned state, since the app does not write omp's files. |
| D7 | Preview exposure | (a) Developer flag only. (b) A Settings toggle labeled as a preview. | (a) until the Phase 2 usability gate passes; (b) afterwards only if the owner wants outside testers and the Phase 3 gate has also passed. |
| D8 | Wording in the omp screen | omp's own text is shown as omp wrote it, which the VOICE exemption for attributed omp output already covers. App-owned headings, labels and controls follow VOICE. | Confirm only if the owner wants a different boundary. |
| D9 | Upstream requests | Ask omp for an outer input-readiness flag, documented role names for hook dialogs and plan review, a collab BTW channel, and a `reqId` on collab-aware hook nodes. | Ask; none of them blocks this plan. |
| D10 | Unmatched local hook answers before collab channel ordering settles | Keep select, confirm, editor and input answerable from the omp screen, without a settle window. | D10 decided by the owner on 2026-11-02. This qualifies Rule 8's exactly-one-answer-path guarantee and removes the replay/live ordering prerequisite for unmatched local answering. The app can briefly offer both answer controls when channel delivery is delayed; omp's `#raceCollabDialog` accepts the first result and aborts the other branch. omp 18.14.0 shows collab-aware select/editor/approval dialogs locally and to collab at once, so a local answer racing an in-transit collab request cannot give omp two completed answers. Consequences can include a chat question card that appears and closes at once, or a losing submission or cancellation error. Input (`showHookInput`) and confirm (`showHookConfirm`) never reach collab (routing lines 185-209; race lines 969-994, linked in Rule 8). Main's 2026-11-02 manual Electron evidence under Rule 8 covers local input/confirm, naturally request-first select/editor, deliberately node-first delivery and reconnect. A separate browser guest remains untested. |

## Risks

- **Role churn.** omp defines its role strings outside the TSP v1 wire contract. Mitigation: the registry, pinned fixtures, and live suites in `omp-watch.yml`.
- **Loss of the painted terminal.** Proposed as a consequence of the owner's direction, conditional on the Phase 2 usability gate. A blank sheet at any entry point is a regression.
- **Two presentation sources.** Collab and TSP can both show the same question or notice. Mitigation: Rules 7 and 8 and the 2.2 deduplication, each with replay coverage.
- **Sharing parity unproven.** No guest join was established in the study. Mitigation: Phase 2 criterion 12 before any exposure beyond developers.
- **Startup readiness.** `sendable` precedes the startup worktree question. Mitigation: keep `worktree.onStart: off` until omp exposes outer readiness.
- **Custom extension UI.** `rows` nodes and PTY-mode editors need raw keys. Mitigation: the fallback forwards keys when such a node has focus.
- **Windows transport.** Bundled ConPTY is experimental in node-pty and its runtime behavior remains unverified. Mitigation: the developer flag alone enables TSP; the ordinary Windows default stays classic until Phase 6 passes.
- **Lifecycle transitions.** omp instance restart (a new protocol epoch, possibly on the same PTY), room rotation, session identity change and surface replacement need different handling (Rule 9). Mitigation: the Phase 2 transition fixtures.
- **Pre-TUI failures.** Raw capture stays.

## Verification summary

| Tier | What it proves | Who runs it | Phases |
|---|---|---|---|
| Replay | The app follows a recorded omp 18.15.0 workflow and sends the exact events | Any agent, CI | All |
| Headless Chrome | Rendering, interaction, accessibility, narrow window and large text against fixture snapshots | Any agent | 2-5 |
| Live, no model | The installed omp still uses the registered roles and actions | CI (`omp-watch.yml`), main agent | 1 onward |
| Live, scripted provider | Model-dependent workflows still complete on the installed omp | CI (`omp-watch.yml`), main agent | 3-5, required before the flip |
| Packaged | Bundled ConPTY files and the Electron-rebuilt node-pty work in the built app; the bundle check | CI | 6, 7 |
| Manual | The full app on macOS and Windows, sharing with a guest, billed `/btw` | Owner or main agent | End of each phase, release candidates |

## Estimated complexity

The migration is large. Planning judgment puts it at 30-47 engineer-days, about 6-9 weeks for one engineer familiar with the repository, with Phase 6 able to overlap Phases 2-5. The main drivers are the breadth of omp's overlay vocabulary for the omp screen, the ten adapter steps of Phase 4, and the Windows transport and packaging work.
