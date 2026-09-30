# visual-omp — Design Specification

One opinionated direction. Every value is exact. Implementation stack: React + Tailwind v4 (CSS-variable tokens via `@theme`), Radix primitives, lucide icons, xterm.js.

---

## 0. Design direction

**"Paper & π."** visual-omp looks like a calm, well-lit desk with omp's neon mark glowing on it — not a terminal with chrome, not a chat app skin. Light mode is the designed default; dark mode is omp's signature near-black, designed alongside, not inverted.

Five decisions everything else hangs on:

1. **One accent, three roles.** The mark gradient is magenta → violet → cyan. In UI these become three *solid* tokens with fixed jobs: **Pi Pink** is the only action accent (primary buttons, links, active states). **Cyan** is information + focus (info status, focus rings, @-mentions). **Violet** is agent presence (subagent avatars, AI-attributed UI, Plan surfaces). The full gradient appears *only* on the π mark, the working indicator, the context ring, and first-run/empty-state art — never on text or button fills. This keeps the brand loud in exactly four places and quiet everywhere else.
2. **Warm-neutral paper chassis (light) / true-black chassis (dark).** Light app background is a cool-neutral `#F5F5F7` with pure-white floating panels, so hierarchy comes from elevation + hairlines, not tints. Dark keeps omp's `#000`-family chassis so collab-web users feel at home.
3. **Friendly by default, honest on demand.** Every machine event collapses to a plain-language one-liner ("Edited 3 files"); raw diffs/output are one click or one `Ctrl/Cmd+O` away. Jargon never appears on primary surfaces; the mono-caps bracket style (`[ LABEL ]`) is the *only* stylistic nod to the terminal on calm surfaces.
4. **Structure over decoration.** No accent bars, no gratuitous gradients, no fake data, no icon soup. Emphasis is carried by weight, spacing rhythm (8px grid), and the single pink accent.
5. **Status is shape + color, never color alone.** Every status color pairs with an icon or glyph (✓ ▲ ✕ ●), so the UI survives color-blindness and grayscale.

---

## 1. Design tokens

All colors are authored in hex (sRGB); the three `--mark-*` gradient stops are authored in oklch (from omp's own tokens) with sRGB fallbacks. Naming follows `--<role>` for theme-flipped tokens and `--<role>-<step>` for ramps. Tailwind v4 mapping: every token below is re-exposed in `@theme inline` as `--color-*`, `--radius-*`, `--spacing-*`, `--font-*` with identical values; the tables below are the source of truth.

### 1.1 Surfaces — light (default)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#F5F5F7` | window background, behind everything |
| `--panel` | `#FFFFFF` | sidebar, panes, cards, composer |
| `--bg-inset` | `#FAFAFC` | code blocks, terminal sheet padding, sunken inputs |
| `--bg-raised` | `#FFFFFF` | popovers, menus, dialogs (with shadow) |
| `--bg-overlay` | `#FFFFFF` | modal sheets, command palette |
| `--glass` | `rgba(255,255,255,0.82)` | title bar / sticky headers over scrolled content (12px backdrop-blur) |
| `--hover` | `rgba(26,26,33,0.04)` | row/control hover wash |
| `--selected` | `rgba(26,26,33,0.07)` | selected row wash, pressed state |
| `--backdrop` | `rgba(24,24,30,0.28)` | dialog/sheet scrim |

*Rationale: one white panel value everywhere keeps light mode airy; alpha washes let one hover value work on every surface step (same trick as omp's own tokens).*

### 1.2 Surfaces — dark

| Token | Value |
|---|---|
| `--bg` | `#060608` |
| `--panel` | `#0E0E11` |
| `--bg-inset` | `#0A0A0D` |
| `--bg-raised` | `#141418` |
| `--bg-overlay` | `#17171B` |
| `--glass` | `rgba(14,14,17,0.78)` |
| `--hover` | `rgba(237,237,240,0.045)` |
| `--selected` | `rgba(237,237,240,0.09)` |
| `--backdrop` | `rgba(0,0,0,0.55)` |

### 1.3 Text

| Token | Light | Dark | Role |
|---|---|---|---|
| `--fg` | `#1A1A21` | `#EDEDF0` | body, titles |
| `--fg-muted` | `#575761` | `#A2A2AB` | secondary labels, metadata |
| `--fg-faint` | `#6B6B76` | `#82828C` | placeholders, timestamps, disabled labels |
| `--fg-inverse` | `#FFFFFF` | `#0A0A0B` | text on accent fills |

Contrast (on `--panel`): light `--fg` 17.3:1, `--fg-muted` 7.1:1, `--fg-faint` 5.3:1 (4.8:1 on `--bg` — still AA). Dark on `--panel`: 16.5:1 / 7.6:1 / 5.1:1. All body-text pairs ≥ 4.5:1. ✓

### 1.4 Accent — derived from the mark gradient

Mark stops (omp's own, oklch → sRGB): `--mark-a: oklch(0.70 0.24 340)` `#F84FCC` (magenta) · `--mark-b: oklch(0.62 0.21 295)` `#9362F4` (violet) · `--mark-c: oklch(0.81 0.14 200)` `#00DBE4` (cyan).
`--mark-gradient: linear-gradient(135deg, var(--mark-a) 0%, var(--mark-b) 46%, var(--mark-c) 100%)`.

| Token | Light | Dark | Job |
|---|---|---|---|
| `--accent` | `#B01E86` | `#F068C8` | Pi Pink — primary action, links, active tab/selection marker |
| `--accent-hover` | `#97176F` | `#F58BD6` | hover of the above |
| `--accent-active` | `#7F1360` | `#F9ADE1` | pressed |
| `--accent-fg` | `#FFFFFF` | `#241021` | text on filled accent (`#241021` on `#F068C8` = 6.4:1; white on `#B01E86` = 6.2:1) |
| `--accent-muted` | `#FBE9F6` | `#2B1224` | tinted chip/badge background; accent text on it: 5.4:1 (light), 6.2:1 (dark) ✓ |
| `--accent-2` | `#0E7490` | `#5AD8E6` | Cyan — info, focus-adjacent accents, @-mention chips (5.4:1 / 11.4:1 on panel) |
| `--accent-2-muted` | `#E4F4F8` | `#10262B` | cyan tint bg (accent-2 text on it: 4.7:1 / 9.3:1) ✓ |
| `--agent` | `#6D28D9` | `#A78BFA` | Violet — subagents, plan surfaces, AI presence (7.1:1 / 7.1:1) |
| `--agent-muted` | `#F0EAFB` | `#1D1530` | violet tint bg |
| `--ambient-a` | `rgba(176,30,134,0.05)` | `rgba(240,104,200,0.07)` | hero/empty-state wash, magenta end |
| `--ambient-b` | `rgba(14,116,144,0.05)` | `rgba(90,216,230,0.06)` | hero wash, cyan end |

*Light accent choice: the raw magenta stop `#F84FCC` fails AA on white (3.0:1); it is darkened along hue 330° until 6.2:1 → `#B01E86`. Same family, readable. Dark accent is omp collab-web's own `#F068C8` for continuity.*

### 1.5 Status

| Token | Light | Dark | Pairs with glyph |
|---|---|---|---|
| `--ok` | `#0B7A52` | `#3ECF8E` | ✓ check |
| `--ok-bg` | `#EBF8F1` | `#12291D` | — (text on bg: 4.9:1 / 7.7:1 ✓) |
| `--warn` | `#9A6200` | `#F5A524` | ▲ triangle |
| `--warn-bg` | `#FDF3E0` | `#2A2110` | (4.6:1 / 7.8:1 ✓) |
| `--err` | `#C62F35` | `#FF6166` | ✕ cross |
| `--err-bg` | `#FDEDEB` | `#2E1518` | (4.8:1 / 5.8:1 ✓) |
| `--info` | `#0E7490` | `#5AD8E6` | ● dot (= `--accent-2`) |
| `--info-bg` | `#E4F4F8` | `#10262B` | — |
| `--live` | `#0B7A52` | `#3ECF8E` | ● pulsing dot — **reserved for real-time presence only** (collab live, session running elsewhere), never for generic success |

### 1.6 Diff

| Token | Light | Dark |
|---|---|---|
| `--diff-add-bg` | `#E7F6EE` | `#12291D` |
| `--diff-add-line` | `#D2F0DF` | `#173826` | (stronger line highlight within hunk) |
| `--diff-add-text` | `#146C43` | `#6FDBA9` | gutter `+`, added-code accents (5.8:1 / 9.1:1 on own bg) |
| `--diff-del-bg` | `#FDEDEB` | `#2E1518` |
| `--diff-del-line` | `#FADCD8` | `#3A1B1E` |
| `--diff-del-text` | `#B42318` | `#FF8A8E` | (5.8:1 / 7.5:1) |
| `--diff-hunk-bg` | `#F0F0F4` | `#141418` | `@@` header rows |
| `--diff-hunk-text` | `#575761` | `#A2A2AB` |

### 1.7 Syntax highlighting (code blocks, diffs, file viewer)

Light — base text `#1A1A21` on code bg `#FAFAFC`; dark — `#EDEDF0` on `#0A0A0D`. All pairs ≥ 4.5:1 (measured: worst is light comment 4.6:1, dark comment 4.9:1).

| Role | Light | Dark |
|---|---|---|
| `--syn-text` | `#1A1A21` | `#EDEDF0` |
| `--syn-keyword` | `#A21C7E` (magenta) | `#F068C8` |
| `--syn-string` | `#0B7A52` (green) | `#6FDBA9` |
| `--syn-number` | `#9A6200` (amber) | `#F5A524` |
| `--syn-function` | `#6D28D9` (violet) | `#A78BFA` |
| `--syn-type` | `#0E7490` (cyan) | `#5AD8E6` |
| `--syn-operator` | `#B42318` (red) | `#FF8A8E` |
| `--syn-comment` | `#71717C` | `#82828C` |
| `--syn-punct` | `#575761` | `#A2A2AB` |

*The syntax palette reuses the brand triad (keyword=magenta, function=violet, type=cyan) so code "sounds like" omp without any new hues.*

### 1.8 Borders & focus

| Token | Light | Dark |
|---|---|---|
| `--border` | `rgba(26,26,33,0.09)` | `rgba(237,237,240,0.08)` | hairlines, separators (decorative, exempt) |
| `--border-strong` | `rgba(26,26,33,0.16)` | `rgba(237,237,240,0.16)` | interactive component outlines, inputs (≈1.9:1 — always paired with fill/label, and focus adds the ring below) |
| `--ring` | `#0891B2` | `#5AD8E6` | focus ring (3.7:1 on white, 12.4:1 on `#060608` — ≥3:1 ✓) |
| `--ring-soft` | `rgba(8,145,178,0.18)` | `rgba(90,216,230,0.22)` | ring halo on tinted surfaces |

Focus style, everywhere: `outline: 2px solid var(--ring); outline-offset: 2px;` on `:focus-visible`. Never remove; never rely on color change alone.

### 1.9 Elevation & shadows

| Token | Light | Dark |
|---|---|---|
| `--shadow-card` | `0 1px 2px rgba(16,16,20,0.05)` | `0 1px 2px rgba(0,0,0,0.5)` |
| `--shadow-pop` | `0 8px 24px rgba(16,16,20,0.10), 0 2px 6px rgba(16,16,20,0.05)` | `0 8px 24px rgba(0,0,0,0.5), 0 2px 6px rgba(0,0,0,0.4)` |
| `--shadow-overlay` | `0 24px 64px rgba(16,16,20,0.16), 0 4px 16px rgba(16,16,20,0.06)` | `0 24px 64px rgba(0,0,0,0.7), 0 1px 0 rgba(255,255,255,0.06) inset` |
| `--shadow-composer` | `0 1px 2px rgba(16,16,20,0.05), 0 8px 24px rgba(16,16,20,0.06)` | `0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.4)` |

### 1.10 Radii (role-based, from omp's own scale)

| Token | Value | Role |
|---|---|---|
| `--radius-sm` | `6px` | chips, badges, small buttons, inline code |
| `--radius` | `8px` | buttons, inputs, menus, tabs |
| `--radius-lg` | `12px` | cards, tool cards, dialogs |
| `--radius-xl` | `16px` | composer, sheets, large panels |
| `--radius-full` | `999px` | pills, toggles, avatars, context ring |

### 1.11 Spacing (4px base, 8px rhythm)

`--s-1:4px · --s-2:8px · --s-3:12px · --s-4:16px · --s-5:20px · --s-6:24px · --s-8:32px · --s-10:40px · --s-12:48px · --s-16:64px · --s-20:80px`.
Component density: control height sm 28px / md 32px / lg 40px; list row 36px; chat message gap 24px; card padding 16px; pane padding 16–24px.

### 1.12 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | `120ms` | hovers, presses, toggles |
| `--dur` | `180ms` | menus, popovers, tab switch |
| `--dur-slow` | `280ms` | sheets, dialogs, pane resize settle |
| `--dur-xl` | `420ms` | first-run tour transitions, empty-state art entrance |
| `--ease-out` | `cubic-bezier(0.16,1,0.3,1)` | default entrance (omp's own) |
| `--ease-in-out` | `cubic-bezier(0.65,0,0.35,1)` | looped animations (sheen, pulse) |
| `--ease-spring` | `cubic-bezier(0.34,1.56,0.64,1)` | popover/tooltip pop |

`prefers-reduced-motion` / app "Reduce motion" setting: all durations → `0.01ms`; the π-sheen working indicator freezes to a static gradient π with a slowly-fading (opacity-only, 2s) status dot; skeleton shimmer → static `--hover` fill; no translate/scale ever.

### 1.13 Z-index layers

`--z-base:0 · --z-sticky:10 · --z-pane-header:20 · --z-sidebar:30 · --z-titlebar:40 · --z-dropdown:50 · --z-scrim:60 · --z-sheet:70 · --z-dialog:80 · --z-palette:90 · --z-toast:100 · --z-tooltip:110`.

---

## 2. Typography

### 2.1 Families

| Token | Stack | Use |
|---|---|---|
| `--font-ui` | `-apple-system, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | all UI text |
| `--font-mono` | `ui-monospace, "SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace` | code, diffs, terminal, bracket labels, numbers in status bar |
| `--font-display` | `"Space Grotesk", var(--font-ui)` | wordmark, setup/empty-state headings, big dashboard numbers |

**Space Grotesk** (OFL, bundled as woff2, weights 500+700 only, ≈60 KB) is the single bundled face: its geometric, monoline letterforms are the closest licensed match to omp's geometric "omp" wordmark, and it gives first-run and dashboard moments a distinct voice without renting a font. Everything else is system fonts — zero layout shift, native feel on both OSes.

### 2.2 Scale (root 16px; user text-size setting scales root 90–130%, i.e. 14.4–20.8px)

| Token | Size / line-height | Weight / spacing | Use |
|---|---|---|---|
| `--text-xs` | 11px / 15px | 500, +0.02em | chips, badges, status bar, table metadata |
| `--text-sm` | 12px / 16px | 400/500 | tool-card summaries, secondary labels, menu shortcuts |
| `--text-md` | 13px / 18px | 400/500/600 | **base UI size**: buttons, inputs, list rows, menus |
| `--text-base` | 14px / 22px | 400 | chat body, markdown, plan text |
| `--text-lg` | 16px / 24px | 400/600 | section titles, dialog titles |
| `--text-xl` | 20px / 28px | 600 | pane titles, dashboard cards |
| `--text-2xl` | 24px / 30px | 700 display | empty-state heading |
| `--text-3xl` | 32px / 38px | 700 display | setup screen, dashboard numbers |
| `--text-code` | 12.5px / 18px | 400 mono | code blocks, diffs |
| `--text-terminal` | 13px / 19px | 400 mono | terminal sheet (user-adjustable ±) |

### 2.3 The bracket style — `[ LABEL ]`

omp's mono-caps signature. Rules: `font-mono`, `--text-xs` (11px), uppercase, `letter-spacing: 0.14em`, `--fg-faint`; brackets included in the string. Used **only** for: (a) section eyebrows on calm surfaces (setup screen `[ WELCOME ]`, settings group labels), (b) the empty-state tagline, (c) the status bar's mode readout `[ AUTO ]`. Never on buttons, never interactive, max one per surface. It is a whisper of the terminal, not a texture.

---

## 3. App shell layout

Default window **1440×900**, minimum **1100×700**. Regions (light values shown):

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ TITLE BAR — 40px, --glass over content, --z-titlebar                           │ 40px
│ ⊙⊙⊙  ≡  visual-omp        ·  my-shop / Fix checkout bug        ⌄    ☐  ✕ (win) │
├──────────────┬─────────────────────────────────────────────────────────────────┤
│              │ TAB STRIP — 36px, --bg, bottom hairline                         │ 36px
│              │ [✚ New] │ Fix checkout bug ● │ Styles pass ○ │ ▦ split │        │
│  SIDEBAR     ├──────────────────────────────────────────────┬──────────────────┤
│  264px       │ SESSION HEADER — 48px, --panel               │ RIGHT DOCK       │ 48px
│  --panel     │ ◈ title ✎  [model chip][mode chip]   buttons │ tabs 32px        │
│  (200–320,   ├──────────────────────────────────────────────┤ 420px            │
│   hideable)  │                                              │ (320–640)        │
│              │   CHAT COLUMN — max 760px centered, 24px     │ ┌──────────────┐ │
│              │   side gutters, scrolls                      │ │ Diff / Files │ │
│              │                                              │ │ Preview/Tasks│ │
│              │                                              │ │ Plan/Terminal│ │
│              ├──────────────────────────────────────────────┤ │              │ │
│              │ COMPOSER — max 760px, floating card          │ └──────────────┘ │
│              │ min 96px, bottom-pinned, 16px bottom margin  │                  │
├──────────────┴──────────────────────────────────────────────┴──────────────────┤
│ STATUS BAR — 28px, --panel, top hairline, --text-xs mono accents               │ 28px
│ ⎇ main  +12 −3   ◔ 62% context   $1.24 today   ● omp 18.4.4 connected          │
└────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Title bar (40px)

Frameless window with a custom bar; `-webkit-app-region: drag` on the bar, `no-drag` on controls.

- **macOS**: traffic lights inset at x=12, vertically centered; content starts at **x=92**. Window controls hidden (native).
- **Windows**: content starts at x=12; caption buttons (minimize / maximize / close) at right, each **46×40**, lucide icons 14px, close hover `#E81123` + white icon (platform convention — the one allowed off-palette color).
- Content: sidebar toggle (≡, only when sidebar hidden) · app mark (π, 20px, mark-gradient) + `visual-omp` wordmark (Space Grotesk 600, 15px) · centered: current project / session breadcrumb (`--fg-muted`, 13px, ⌄ opens session switcher) · right (macOS): nothing — right side stays empty so it never collides with traffic-light muscle memory.

### 3.2 Sidebar (264px default, drag 200–320px, `Cmd/Ctrl+B` hides)

```
┌────────────────────────────┐
│ 🔍 Search chats…      ⌘K   │ 40px search field (--bg-inset, radius-md)
│ ＋ New chat                │ 36px primary ghost row, accent text
│────────────────────────────│
│ PROJECTS                   │ bracket eyebrow, 11px mono
│ ▾ ▣ my-shop           📌   │ project row 36px, chevron + folder icon
│   ● Fix checkout bug   2m  │ session row 32px indent 28px
│   ○ Styles pass        1h  │ ● live  ○ idle  ! needs-input(--warn)
│   ↺ Terminal session  read │ ↺ = started outside app (read-only chip)
│ ▸ ▣ landing-page           │ collapsed project
│ ▸ ▣ api-server             │
│                            │
│ [Archived ▾]               │ muted disclosure
│────────────────────────────│
│ ⌂ Home   ⚙ Settings   ?    │ bottom stack, 36px rows, --fg-muted
└────────────────────────────┘
```

- Sections: search · New chat · projects with nested sessions · Archived · bottom nav (Home / Settings / Help).
- Session row anatomy: status dot (8px) · title (13px/500, 1-line ellipsis) · relative time (`--text-xs`, `--fg-faint`) · hover reveals ⋯ menu (Rename, Pin, Fork, Archive, Delete).
- Badges: `needs-input` = warn dot + subtle `--warn-bg` pill on the title; `live elsewhere` = `--live` dot + "read-only" chip; Dispatch/scheduled = violet dot.
- Pinned sessions float to top of their project, pin icon at right.
- Collapse behavior: `Cmd/Ctrl+B` hides to 0; a slim 16px hover strip remains at the left window edge; hovering it (or pressing the shortcut) slides the sidebar back as an overlay with scrim-free shadow (`--shadow-pop`). No icon-rail intermediate state — two states only, less to learn.

### 3.3 Tab strip + split view (36px)

- Tabs: min 120px, max 200px, height 28px, `--radius` top-only, active = `--panel` fill + 2px accent underline + title 500; inactive = transparent, `--fg-muted`. Status dot left (8px); close ✕ on hover (16px hit area 24px); spinner-mini (π-sheen 12px) replaces dot while working.
- `＋` button at strip end (28×28 ghost) → new chat in current project.
- **Split view**: `Cmd/Ctrl+\` splits the focused chat column left/right (equal 50%, divider 4px `--border`, drag 30–70%). Each split has its own header + chat + composer but shares the tab strip, right dock, and status bar (status bar reflects focused split). `Cmd/Ctrl+click` a sidebar session opens it in the second split. Max 2 splits — more is what tabs are for.

### 3.4 Session header bar (48px, `--panel`, bottom hairline)

```
│ ◈ Fix checkout bug ✎   [ Sonnet 4.5 ▾ ] [ Auto ▾ ]   │  ↻ Restart  ⧉ Compact  │
│                                                        │  ☰ Plan  🤖 Agents  ⋯  │
```

- Left: session icon ◈ (16px, `--fg-muted`), inline-editable title (15px/600; click ✎ or double-click → input), then **model chip** (`--accent-muted`, accent text, ⌄ → model picker, §4.12) and **mode chip** (neutral `--hover` fill; `Plan` mode = `--agent-muted` violet; `Yolo/Auto` = neutral) — chips are 24px tall, `--radius-full`, `--text-xs` 600.
- Right (icon+label buttons, 28px, ghost): **Restart ↻**, **Compact ⧉**, **Plan ☰** (toggle, violet when on), **Agents 🤖** (opens Agents hub as sheet), **New ＋**, overflow ⋯ (Rewind, Fork, Branch tree, Handoff, Share, Export, Rename, Archive).
- Contextual rule: Compact shows a tiny `!` badge when context ≥ 75%; Plan button appears only when a plan exists or Plan mode is on, otherwise it lives in ⋯. No more than 5 visible buttons + ⋯ — everything else is in the palette.

### 3.5 Chat column

- Max width **760px**, horizontally centered, 24px side gutters, top padding 24px, bottom padding 16px above composer. Transcript view toggle (**Normal / Thinking / Verbose**) lives as a segmented control in the ⋯ overflow *and* cycles with `Ctrl/Cmd+O`; Normal is default.
- **User message**: right-aligned? No — full-width rows for everyone (chat-app bubbles read as consumer messaging; this is a work log). User messages: `--bg-inset` card, `--radius-lg`, 12px/16px padding, left 2px `--border-strong` rail; attachments as 48px thumbnails above text; small "You" label (`--text-xs` muted) + timestamp on hover; hover actions: Rewind ↩, Fork ⑂, Copy.
- **Assistant message**: no card — bare markdown on the chat background with a 20px π mark (mark-gradient) + model name + time header row; hover actions: Copy, Rewind to here, Read aloud (TTS). Streaming text renders inline with a 2px blinking caret (`--accent`, 1s blink, suppressed in reduced motion).
- **Thinking block**: collapsed one-liner "Thought for 12s" (`--fg-faint`, italic off, chevron ▸); expanded = `--fg-muted` text on `--bg-inset`, left 2px `--agent` rail. Visible in Normal only after expansion; always visible in Thinking view.
- **Tool cards**: §4.7.
- **System notices** (compaction, mode change, restarts): centered `--text-xs` `--fg-faint` line with 24px hairline rules either side — "· Context summarized ·".
- **Questions & approvals**: §4.8. **Errors**: §5 cards, `--err` rail + "Try again" button.
- **Queued messages tray**: §3.6.
- Day/time dividers: centered `--text-xs` `--fg-faint` "Today 14:32".

### 3.6 Composer (floating card, max 760px, `--radius-xl`, `--shadow-composer`)

```
┌──────────────────────────────────────────────────────────────────┐
│ ⏳ 2 queued: "also update the tests"  [Send now] [Edit] [✕]      │ queued tray (only when non-empty), --warn-bg hairline-tinted rows
│──────────────────────────────────────────────────────────────────│
│ 📎 shot.png ×2                                                   │ attachment chips row (when present)
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Ask visual-omp to change something…                    ⌘↵    │ │ textarea: auto-grow 24→200px, 14px/22
│ └──────────────────────────────────────────────────────────────┘ │
│ [＋] [Auto ▾]  [! Shell] [$ Python]   Sonnet 4.5 ▾  Thinking ▾   │ bottom row 1: 32px controls
│              🎤  ◔ 62%                                    ➤ / ■  │ bottom row 2 overlays right side of row 1 — see below
└──────────────────────────────────────────────────────────────────┘
```

One bottom row, 40px tall, contents left→right: **＋** (28px ghost; menu: Attach file, @-mention file, Prompt library, Skills, Custom commands) · **permission-mode selector** (pill, 28px) mapping 1:1 to omp's `tools.approvalMode`: `Ask me first` (`always-ask`: asks before edits and commands) · `Edits OK` (`write`: edits run, commands ask) · `Auto` (`yolo`: runs everything, no questions). Default for new users is **Auto** (spec: auto-approve everything); Auto carries a quiet `--fg-muted` label "no questions asked", no warn dot · mode quick-toggles **!** and **$** (28px ghost, active = `--accent-2-muted` fill + cyan text) · flexible space · **voice 🎤** (28px ghost; recording = `--err` pulse ring) · **context ring** (20px, §5.17) · **model ⌄** (text button, 13px/500) · **thinking ⌄** (text button, `--fg-muted`; hidden if model doesn't support) · **send ➤** (32×32, `--radius`, filled `--accent`; while working becomes **stop ■** `--err`-tinted ghost with same geometry). `Enter` sends, `Shift+Enter` newline, `Cmd/Ctrl+Enter` interrupts-and-sends-now.
- **@-mention**: typing `@` opens fuzzy picker (§5 menus) listing project files; selected files appear as cyan chips inline.
- **Queued tray** rows: 32px, `--text-sm`, drag-handle to reorder, per-row [Send now] [Edit] [✕]; tray max 3 rows + "N more".
- **Drag-drop**: files dropped anywhere on the chat column → full-column drop veil (`--accent-2-muted` 60% + dashed `--accent-2` outline, `--radius-xl`).

### 3.7 Right dock (default 420px, drag 320–640px, `Cmd/Ctrl+.` toggles, remembers tab+width per project)

- Tab strip 32px: **Diff · Files · Preview · Tasks · Plan · Terminal** — 13px/500 labels, active = accent text + 2px accent underline; badges: Diff shows `+N −M`, Tasks shows running count dot, Plan shows `!` when awaiting approval, Terminal shows `●` when a command runs.
- One dock per window (shared across splits; reflects focused session). Pop-out button (⧉ 24px ghost) floats any pane to its own window.
- **Diff**: file list left (140px, collapsible) + per-file unified diff; line-comment `＋` on gutter hover → comment box, `Cmd/Ctrl+Enter` sends all comments to omp; header: file path breadcrumb, "Review code" button (accent), Accept/Reject per hunk in Manual mode.
- **Files**: tree (24px rows, 12px indent steps) + viewer tabs; click file → viewer; `⌘click` or right-click → "Mention in chat" (@-chip). Syntax colors §1.7; images render inline.
- **Preview**: address bar (back/fwd/reload, URL, open-external ⧉, select-element ⌖) + webview; empty state: "Start a dev server and it shows up here."
- **Tasks**: three groups — Checklist (todo phases, checkbox rows), Helpers (subagents: violet avatar, name, one-line status, live token count, Stop), Background (shell jobs, dev servers; live tail on expand).
- **Plan**: current plan markdown + Approve / Refine bar (§4.9 when approval pending).
- **Terminal**: xterm.js, `--bg-inset` padding 8px, font `--text-terminal`; tab `+` for extra shells; this is a plain project shell, distinct from the omp terminal sheet (§4.11).

### 3.8 Status bar (28px, `--panel`, top hairline, `--text-xs`)

Left: **git branch** (⎇ glyph + name, mono; click → branch menu incl. Worktree toggle) · **changes** `+12 −3` (`--diff-add-text` / `--diff-del-text`; click → Diff dock) · **PR/CI chip** when a PR exists (✓ green / ▲ amber / ✕ red + "Fix CI" on failure).
Center (absolute-centered): nothing — keep it empty.
Right: **context ring + %** (§5.17, click → Compact dialog) · **cost today** `$1.24` (mono; click → Usage dashboard; turns `--warn` at 80% of the user's daily cap) · **omp status** (`● omp 18.4.4` — `--ok` dot connected / `--warn` reconnecting / `--err` stopped; click → diagnostics menu: Open terminal sheet, Restart omp, Copy diagnostics).
All status-bar items are buttons with tooltips; bar is 28px exactly, never wraps, items truncate middle with ellipsis.

---

## 4. Screen specs

Conventions: wireframes are schematic, not to scale; every screen lists its component inventory (§5) and states. All screens obey §3 shell unless noted.

### 4.1 omp-missing setup screen

Full-window replacement (no sidebar/dock), centered 560px column on `--bg` with ambient wash (radial `--ambient-a` top-left → `--ambient-b` bottom-right, 480px radius each, static).

```
                 ╭──────╮
                 │  π   │                       96px π mark, mark-gradient
                 ╰──────╯
              [ WELCOME ]                       bracket eyebrow
        Let's get omp installed                 Space Grotesk 700, 32px
   visual-omp is a friendly window around omp,  15px, --fg-muted, 440px max
   the AI coding agent. omp isn't on this
   computer yet — it takes about a minute.

   ┌────────────────────────────────────────┐
   │ 1  Install omp                         │ step row: 28px number circle
   │    One command, runs in a window you   │ (--border-strong outline),
   │    can watch.                          │ title 14/600 + desc 13 muted
   │    [ ▶ Run installer ]  [ Copy ]       │ primary button + ghost
   ├────────────────────────────────────────┤
   │ 2  Check again                         │ step 2 disabled until step 1 done
   │    [ ↻ Check again ]                   │ secondary button
   └────────────────────────────────────────┘
   Having trouble?  Open the help guide →    13px link, accent
```

- Inventory: π mark, bracket label, display heading, 2 step cards (card, `--radius-lg`), primary/secondary/ghost buttons, copy button (toast on copy), footer link.
- States: **missing** (above) · **installing** (step 1 expands inline into a 240px mini-terminal showing the installer output live — user-initiated, visible, with Cancel) · **too old** (same layout; heading "Your omp is out of date", shows installed vs required version, step 1 becomes "Update omp") · **done** (both steps get ✓ `--ok`, auto-advances to first-run tour after 600ms).

### 4.2 First-run guided tour

5 steps, spotlight overlay: scrim `--backdrop` over full app, target element gets 8px-padded cutout with `--ring` 2px outline, popover card 320px (`--bg-overlay`, `--shadow-overlay`, `--radius-lg`) with: step eyebrow `[ 1 OF 5 ]`, title 15/600, body 13px, footer [Skip] ····· [Next →] (last step [Start chatting →]). Transitions `--dur-xl` `--ease-out`; reduced motion → instant, no spotlight pan.

1. **Sidebar** — "Your projects and chats live here. Everything you ask for becomes a chat you can return to."
2. **Composer** — "Type what you want in plain words. Enter sends. You never need commands — they're optional shortcuts."
3. **Permission selector** — "This controls how much omp does on its own. 'Auto' is a good start: it works by itself and you can always rewind."
4. **Right dock** — "Watch changes happen: files, diffs, previews, and helpers working in parallel."
5. **Status bar** — "Keep an eye on context and cost. Click anything here to learn more."

Tour is skippable at every step, re-runnable from Help → "Show the tour again". A persistent 6th element: the empty chat (§4.5) appears immediately after with example prompts.

### 4.3 Project home dashboard

Shown when a project is selected and no chat is open (or via ⌂ Home). Content column max 880px, 24px padding, 3-zone vertical stack.

```
┌─────────────────────────────────────────────────────────────┐
│ [ PROJECT ]              my-shop                        ⚙ ▾ │ eyebrow + Space Grotesk 700 28px + settings menu
│ ⎇ main · clean · 3 chats this week · $4.10 this week        │ 13px muted meta row, mono numbers
├─────────────────────────────────────────────────────────────┤
│ ┌─ Recent chats ────────────────────────────┐  [ See all → ]│
│ │ ● Fix checkout bug        Sonnet · 2m ago  │             │ rows 44px: status dot, title 14/500,
│ │ ○ Styles pass             Haiku  · 1h ago  │             │ model + time muted; click resumes
│ │ ↺ Deploy script (terminal) read-only       │             │
│ └────────────────────────────────────────────┘             │
│ ┌─ Start something ────────────────────────────────────────┐│
│ │ [ ✨ Fix a bug ] [ 🧪 Add tests ] [ 📝 Explain this ]    ││ quick-start prompt chips, 40px,
│ │ [ 🚀 Build a feature ]                                    ││ --panel cards, hover --hover + lift
│ └──────────────────────────────────────────────────────────┘│
│ ┌─ Project health ──────────┐ ┌─ Instructions ─────────────┐│
│ │ ⎇ main  +12 −3  2 stashes │ │ AGENTS.md · 1.2 KB  [Edit] ││ two 50% cards, 120px tall
│ │ ahead 2 · CI ✓ passing    │ │ 3 rules loaded      [View] ││
│ └───────────────────────────┘ └────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

- States: **no git repo** (health card replaced by "Not a git project yet — [Initialize git]" ghost card) · **no chats** (Recent chats card replaced by example prompts §8) · **loading** (3 skeleton rows per card).

### 4.4 New project wizard

Modal dialog 560px (`--bg-overlay`), 3 steps with dot progress header `[ STEP 1 OF 3 ]`. Enter/⌘↵ advances, Esc cancels (confirm if fields filled).

1. **Where?** — three full-width option cards (48px, radio-left): **Empty folder** (＋ icon, "Start fresh in a new folder") · **Open existing** (▣, "Use a folder already on this computer") · **Clone from GitHub** (⎇, "Download a project from a GitHub link"). Selected card: `--accent` 2px outline + `--accent-muted` wash.
2. **Details** — contextual: empty→ name field + location picker (default `~/Projects`); existing→ folder picker + recent folders list (5 rows); clone→ URL field with live validation (✓ "Found: owner/repo" `--ok` / ✕ `--err`) + destination picker.
3. **First chat?** — toggle row "Start a chat right away" (on) + optional first-message textarea. [Create project →] primary, right-aligned.
- States: field errors inline below inputs (`--err`, 12px, with ▲); cloning shows determinate progress bar with Cancel; existing folder that's already a project → warn notice "This folder is already a project — opening it instead" + [Open].

### 4.5 Empty chat (new session)

Chat column, vertically centered 520px block:

```
                      π  (48px, mark-gradient, slow sheen)
            What should we work on?        Space Grotesk 700, 24px, --fg
   ┌────────────────────┐ ┌────────────────────┐
   │ 🐞 Something's     │ │ ✨ Build something  │  2×2 grid of prompt cards,
   │    broken…         │ │    new…             │  156×88px, --panel, 12px pad,
   ├────────────────────┤ ├────────────────────┤  icon 20px accent, title 13/600,
   │ 📖 Explain this    │ │ 🧹 Clean this up…   │  2-line sample text 12px muted
   │    project…        │ │                     │
   └────────────────────┘ └────────────────────┘
        Press / for shortcuts · @ to mention a file     12px --fg-faint hints
```

- Each card carries a full example prompt (§8) into the composer on click (not auto-send). Hover: lift 2px + `--shadow-card`; focus: ring.
- States: **first-ever chat in app** → heading "What should we work on?" + hint line under it: "Tip: just describe what you want in plain words."; **returning** → heading "Back to it — what's next?".

### 4.6 Live chat, mid-stream

```
│ You · 14:32                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ The checkout total is wrong when a coupon is applied. Fix it?    │ │ user card
│ └──────────────────────────────────────────────────────────────────┘ │
│ π  Sonnet 4.5 · 14:32                                                │
│ I'll trace how coupons flow into the total.                          │ streamed markdown
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ▸ 🔍 Searched for "coupon" — 12 matches                       ✓ │ │ tool card collapsed
│ ├──────────────────────────────────────────────────────────────────┤ │
│ │ ▾ ✏️ Edited 2 files — cart.ts +8 −3, pricing.ts +1 −1  [View] ✓ │ │ expanded state shown
│ │   │ diff preview, 2 file blocks, --bg-inset …                    │ │
│ ├──────────────────────────────────────────────────────────────────┤ │
│ │ ▸ 🧪 Running tests…                                        ● ◌  │ │ running: π-EQ + live tail
│ └──────────────────────────────────────────────────────────────────┘ │
│ π◌ Working… 14s                                      ■ Stop          │ working row: π-sheen + elapsed
```

- Streaming caret on text; tool cards stream in-place (no layout jump — cards reserve final height once result arrives via 160ms height animation).
- Working row pinned just above composer while active: π-sheen mark + "Working… {elapsed}s" + current activity ("Running tests") in `--fg-muted` + Stop. Also mirrored in the session's tab and sidebar row.
- Scroll behavior: auto-scroll locks to bottom; scrolling up shows a floating "↓ New activity" pill (accent) bottom-right of the column.

### 4.7 Tool cards — collapsed & expanded

Anatomy (all tools): full-width card, `--panel`, 1px `--border`, `--radius-lg`, min-height 40px collapsed. Left 2px status rail (running `--accent-2` / ok `--ok` / err `--err`). Header row 40px: chevron ▸/▾ (16px) · tool glyph (16px, `--fg-muted`) · **friendly summary** 13px/500 · flexible space · meta (duration, counts, `--text-xs` `--fg-faint`) · status glyph. Expanded body: 12px pad, `--bg-inset` inner well (`--radius`), raw args/output; footer row with [Copy] [Open in Files/Diff] context actions. Secrets always masked `•••` with eye toggle.

| Tool | Glyph | Collapsed friendly summary (exact patterns) | Expanded body |
|---|---|---|---|
| bash | `▸_` | "Ran `npm test` — passed ✓" / "Ran `npm test` — failed ✕" / running: "Running `npm test`…" | command line (mono) + live-tail output (last 2,000 lines, ANSI colors mapped to tokens) + exit code chip |
| edit | ✏️ | "Edited `cart.ts` — +8 −3" / multi: "Edited 3 files — +21 −6" | per-file unified diff (§1.6 colors), file header rows link to Diff dock |
| write | ✏️＋ | "Created `README.md` — 84 lines" | full file content, syntax-highlighted |
| read | 📄 | "Read `pricing.ts` — 212 lines" | file excerpt with line numbers; collapsed again at 200 lines with "Show all" |
| grep/glob | 🔍 | "Searched for `coupon` — 12 matches in 4 files" | match list grouped by file, each row: line no + context line, click → Files pane |
| task (subagents) | 🤖 | "Helper: explore-auth — working… 12k tokens" / "…done ✓ — 3 findings" | violet-tinted body: live activity feed (tool one-liners), final report markdown, [Open as chat] |
| todo | ☑ | "Checklist — 4 of 7 done" | checkbox rows, phase headers; current item accented |
| web_search | 🌐 | "Searched the web — 5 sources" | source cards: favicon, title link, 2-line snippet, [Open] |

Running state adds π-EQ mini (§5.16) where the status glyph sits. Error state: `--err` rail + "— failed" + [Try again] button in footer. Verbose view: cards start expanded and also show raw JSON args; Thinking view: collapsed as Normal.

### 4.8 Ask / approval question card

Appears inline in the transcript when omp asks (`ask`, tool approvals, select/confirm/input UI requests). Card: `--panel`, `--agent` violet 2px left rail, `--radius-lg`, 16px padding, violet `[ QUESTION ]` eyebrow.

```
┌──────────────────────────────────────────────────────────┐
│ [ QUESTION ]                                             │
│ I found two coupon code paths. Which should I fix?       │ 14px question
│ ┌──────────────────────┐ ┌──────────────────────┐        │
│ │ ○ The cart page one  │ │ ○ The checkout one   │        │ option cards 44px,
│ │   src/cart/coupon.ts │ │   src/checkout/…     │        │ radio + title + hint
│ └──────────────────────┘ └──────────────────────┘        │
│ ☐ Remember this choice for the rest of the chat          │ when omp offers "always"
│              [ Skip ]                    [ Answer → ]    │ ghost + primary
└──────────────────────────────────────────────────────────┘
```

Variants: **approval** (tool permission) → option cards replaced by: command/diff preview well + buttons [ Deny ] [ Allow ] [ Always allow ] (danger-y actions get `--err`-rail + "This can delete data" warn line); **text input** → single input + [Send]; **editor request** → multiline + [Send]. Timeout never auto-answers; unanswered cards persist at top of the queued tray as a `! Question waiting` chip. States: answered (collapses to one-line "You chose: the checkout one ✓", `--fg-muted`), expired/stale (greyed, "superseded by a later question").

### 4.9 Plan Review card

Inline card when a plan awaits decision: violet rail, `[ PLAN READY ]` eyebrow, plan title 15/600, collapsible plan body (markdown), footer:

```
│ [ Approve & run ] [ Approve & summarize first ] [ Keep planning ▾ ] │
│                                                    [ Save & quit ]  │
```

- **Approve & run** (primary, accent): executes with current permission mode. **Approve & summarize first** (secondary): compacts context, then runs — recommended chip "Frees context" when context ≥ 60%. **Keep planning ▾** (ghost menu): "Refine with a comment" (focuses composer with `About this plan: ` prefilled) · "Switch to Auto after approval" · "Discard plan". **Save & quit** (ghost): persists plan to the Plan dock, ends turn.
- States: executing (footer replaced by progress row "Step 2 of 5 — editing files" + Stop), approved (card collapses to "Plan approved ✓ — 5 steps" linking to Plan dock), refined (version chip "v3" appears on title).

### 4.10 Command palette (`Cmd/Ctrl+K`)

Centered overlay 640px, top-offset 18vh, `--bg-overlay`, `--radius-lg`, `--shadow-overlay`, scrim `--backdrop`.

```
┌──────────────────────────────────────────────────────────────┐
│ 🔍 Type a command or search…                                 │ input 16px, 48px row
├──────────────────────────────────────────────────────────────┤
│ ACTIONS                                                      │ group eyebrow 11px mono
│ ▶ Fix a bug…                          Run a helper      ⏎    │ row 36px: glyph 16px,
│ ⧉ Compact this chat — summarize to free space   ⌘⇧C          │ title 13px, right hint
│ ↻ Restart omp — start the engine fresh                       │ + shortcut 11px mono muted
├──────────────────────────────────────────────────────────────┤
│ CHATS                                                        │
│ ● Fix checkout bug — my-shop · 2m ago                        │
│ FILES                                   (only while typing)  │
│ src/cart/coupon.ts — my-shop                                 │
└──────────────────────────────────────────────────────────────┘
```

- Every omp command searchable **by plain-language alias first** ("compact" → also matches "summarize", "free space", "shrink"); the omp slash command shows as the right hint (`/compact`). Groups: Actions → Chats → Files → Settings. Footer bar 28px: `↑↓ move · ⏎ run · esc close`.
- States: empty query → "Suggested" group (5 most-used); no results → "No matches — press Enter to ask omp this instead" (sends query as chat message); destructive commands show `--err` glyph and require `⌘⏎`.

### 4.11 Terminal sheet (full-screen omp menus)

Bottom sheet, 80% window height, `--radius-xl` top corners, `--shadow-overlay`, scrim. Header 40px: terminal glyph · title "omp terminal — Settings" (the open omp screen's name, 13px/600) · hint "This is omp's own screen — click or type to use it" (`--fg-muted`) · [⤢ Expand to full] [✕ Close]. Body: xterm.js mirroring the live hidden TUI, `--bg-inset`, 12px padding. Opens automatically whenever omp shows a screen visual-omp doesn't draw natively (detected via omp's TUI focus/overlay state: `/settings` fallback, `/login`, `/tree`, `/resume` picker, `/extensions`, confirm/input prompts); closing with a menu open sends Esc and asks "Leave this omp screen? Your choice won't be saved." States: connected (live mirror), reconnecting (amber banner row inside header), read-only session (input disabled + "This chat is open elsewhere — viewing only" notice bar).

### 4.12 Settings

Modal sheet 880×640, left nav 200px + content 640px (24px padding). Tabs: **General · Appearance · Permissions · Models · Sounds & alerts · Shortcuts · About · Advanced**.

- **General**: default permission mode (segmented), default transcript view (segmented), auto-compact toggle, restore chats on launch toggle.
- **Appearance**: theme segmented (Light / Dark / System), text size slider 90–130% (live preview sentence), reduce motion toggle, chat density (Comfortable / Compact).
- **Permissions**: per-tool allow/ask/deny table backed by omp's `tools.approval.<tool>` (rows: tool glyph + plain name + segmented Ask/Allow/Deny).
- **Models**: link-button to Model roles editor (§4.13) + default model picker + thinking default.
- **Sounds & alerts**: notification toggles (chat finished, needs input, CI finished), sound toggle, do-not-disturb schedule.
- **Shortcuts**: searchable shortcut table with click-to-rebind (capture pill "Press keys…"), conflict shown `--err` inline, [Reset all].
- **About**: app + omp versions, π mark, links (omp docs, report issue), [Check for updates].
- **Advanced**: single searchable list of *every* omp setting (`omp config list`): search field sticky top; rows 40px: setting key (mono 12px) · plain-language description · value control (toggle/input/select by type) · "edited" dot when non-default; footer [Reset all to defaults] danger-ghost. Group headers by domain (collab, model, ui, …). 400+ rows virtualized.
- States: settings write failures → inline `--err` toast "Couldn't save — omp said: {reason}"; external edits (config.yml changed) → info banner "Settings changed outside the app — [Reload]".

### 4.13 Model roles editor

Modal sheet 960×640. Layout: left role list 240px, right editor.

```
│ ROLES                    │  default                             │
│ ● default    Sonnet 4.5  │  Model        [ Sonnet 4.5      ▾ ]  │ 40px select w/ provider badge
│ ○ smol       Haiku 4.5   │  Thinking     [ Auto            ▾ ]  │
│ ○ plan       Opus 4.5    │  Used for                            │
│ ○ commit     Haiku 4.5   │  Every chat unless you switch.       │ plain-language explainer per role
│ ○ advisor    Opus 4.5    │  ─────────────────────────           │
│ … 15 roles, scroll       │  Presets                             │
│                          │  [ Fast & cheap ] [ Balanced ]       │ preset cards apply a full role set
│ [+ Add preset]           │  [ Thorough ]                        │
```

- Roles (all 15, fixed order): default · plan · commit · advisor · smol · slow · vision · tiny · memory · task · image · web · speech · dictation · judge. Each row: enable dot, role name (mono 12px) + assigned model (12px muted).
- Editor per role: model select (grouped by provider, capability icons 👁 🧠 ⚡, context size hint), thinking level select (Off/Low/Medium/High/Max/Auto), one-line "Used for" explainer in plain words.
- Presets row applies all roles at once with undo toast. Unsaved-changes dot on sheet title; [Save] / [Revert] sticky footer. Invalid model id (from edited yml) → warn row "This model isn't available — pick another".

### 4.14 Agents hub

Modal sheet 960×640. Header: title "Helpers" + plain subtitle "Reusable specialists omp can hand work to." + [＋ New helper] primary + [✨ Create with AI] secondary (asks for a description, generates the agent file).
List rows 64px: violet avatar (agent initial on `--agent-muted`) · name 14/600 + scope chip (Built-in / This project / All projects) · one-line description (from frontmatter) · model chip · enable toggle · ⋯ (Edit, Duplicate, Run now, Delete).
Row states: disabled (40% opacity, toggle off), running now (π-EQ mini + "Running in Fix checkout bug"), error in definition file (warn chip + [Fix] opens editor).
Editor drawer (right, 400px): name, description, model override select, tools checklist (plain names), instructions markdown editor (mono, preview toggle), footer [Save] [Test in new chat]. Built-in agents (scout, reviewer, security-reviewer, task, sonic) are editable-as-copy ("Customize" duplicates to All-projects scope).

### 4.15 MCP servers manager

Modal sheet 880×560. Header: "Connected tools" + subtitle "MCP servers give omp extra powers, like reading a database or filing tickets." + [＋ Add server].
Scope segmented: **All projects / This project**. Rows 56px: status dot (`--ok` connected / `--warn` slow / `--err` failed / grey disabled) · server name 14/600 · transport chip (stdio/http) + command/URL (mono 11px, truncated) · tools count ("12 tools") · enable toggle · ⋯ (Test, Reconnect, Edit, View tools, Remove).
Add flow = mini-wizard: preset gallery first (common servers with icons + [Add]) → "Custom" → fields (name, command/URL, env vars key-value rows, scope) → [Test connection] (spinner → ✓ "Found 12 tools" / ✕ error verbatim) → [Save]. States: failed test keeps form with `--err` banner; server with 0 tools gets warn chip "No tools found — check the command".

### 4.16 Skills & plugins browser

Modal sheet 960×640, two tabs: **Skills · Plugins**. Search field + scope filter chips (Installed / This project / Registry).
Skills: card grid (3 columns, 200×120 cards): skill icon (first letter tile, `--accent-2-muted`) · name 13/600 · 2-line description · footer: scope chip + toggle. Click → detail drawer (what it does, when omp uses it, source, [Open file], [Remove]).
Plugins: row list: name, version, author, installed/available state, [Install]/[Update]/[Remove], update-available chip (`--info-bg`, "v1.3 → v1.4"). Registry browse section header `[ FROM THE SKILL SHARE REGISTRY ]` with install counts. States: offline → "Can't reach the registry — showing installed only" banner; installing → inline progress.

### 4.17 Memory viewer

Modal sheet 800×560. Header: "What omp remembers" + backend chip (e.g. "Local files") + search.
Layout: left list 280px (entries: key/title 13/500 + preview line + age), right reader (markdown rendered, meta row: created/updated/accessed count, source session link). Toolbar: [Export…] [Forget this] (danger-ghost per entry) [Forget everything] (danger, type-to-confirm dialog). States: empty → friendly empty state "omp hasn't saved any memories yet. It only remembers what you ask it to."; backend error → banner + raw file path link.

### 4.18 Usage & limits dashboard

Modal sheet 880×600. Top stat row: four 160×88 stat cards (Space Grotesk 700 28px number + 12px label): **Today $1.24 · This week $8.90 · Chats 23 · Tokens 1.2M**.
Middle: 7-day bar chart (bars 24px, `--accent-2` fill, today `--accent`; hover tooltip exact $; no gridlines, baseline hairline only).
Limits section: per-limit rows: label ("5-hour window") + progress bar (thin 6px, `--ok`→`--warn` at 70%→`--err` at 90%) + resets-at text; at-limit row shows "Resets in 1h 12m — queued messages will send then" with auto-continue toggle.
Per-chat table (virtualized): chat title, model, tokens in/out, cost, duration; sortable columns; footer [Export CSV] [Open omp stats page ↗]. States: no API key / local-only → "Usage tracking needs a provider account — [Set up]" empty state; fetch error → cached data + "as of 14:02" muted chip.

### 4.19 Session tree navigator

Modal sheet 960×640, opened from ⋯ → Branch tree (or `/tree`). Canvas: horizontal tree, main line left→right.
- Nodes: message pills 180×40 (`--panel`, 1px border): user/assistant glyph + first 6 words; current node 2px `--accent` outline; branch points split vertically with 24px rounded elbow connectors (2px `--border-strong`); rewind checkpoints = small ◇ on the line; compacted ranges collapse into "⋯ 14 messages" pills (`--fg-faint`).
- Click node → right preview pane 320px (message excerpt + [Resume from here ⑂] ghost + [Rewind to here ↩] danger-ghost). Zoom: ⌘+/−/0 (fit), pan drag, minimap bottom-right 120px. States: single-line history → "No branches yet — fork a chat to explore a different approach" hint overlay; huge trees virtualize beyond 500 nodes with level collapsing.

### 4.20 Share dialog

Modal 520px. Title "Share this chat". Segmented: **Link · File · Invite**.
- **Link**: explainer "Creates an encrypted link — only people with it can read the chat." + [Create link] (omp `/share`) → readonly field + [Copy].
- **File**: [Export as web page…] (omp HTML export, save dialog) — note "Secrets are masked before export."
- **Invite**: live-collab: "Let someone watch or join this chat live" + [Copy invite link] + active guests list (avatar, name, role chip Viewer/Editor, [Remove]).
States: sharing on → session header gains a `--live` dot + "Shared" chip; link revoked → dialog shows "Sharing is off" grey state.

### 4.21 Help / glossary

Modal sheet 720×560. Search field; two groups: **Guides** (rows: "Your first chat", "Staying safe with Auto mode", "Rewinding and forking", "When omp asks questions" — each opens a short illustrated article in-place with a 4-step visual) and **Words we use** (glossary table: term (mono 12px chip) → one-sentence plain definition: context, token, compaction, plan mode, worktree, MCP, agent, skill, hook, subagent, checkpoint, TUI). Footer: [Show the tour again] [Keyboard shortcuts] [omp docs ↗] [Report a problem]. Empty search → "No matches — ask omp instead" (sends question to a new chat).

### 4.22 System surfaces

**Update notice** — toast, bottom-right, 360px: π mark + "visual-omp 1.3 is here" + one-line highlight + [Restart to update] [Later]; also a persistent quiet version: ⋯ menu → "Update ready" accent dot. omp-engine update appears separately: status bar omp chip gets `--info` dot + menu item "Update omp to 18.5".
**Quit-warning dialog** — modal 420px when quitting/closing a tab with work in flight: warn glyph, "omp is still working in 2 chats", list of chat titles with activity, [ Keep waiting ] (ghost) [ Stop and quit ] (danger). "Don't ask again — always stop" checkbox. Sessions auto-resume next launch (stated in one muted line: "Your chats pick up where they left off.").
**Notifications** — native OS toasts (macOS Notification Center / Windows): title = chat title, body = outcome one-liner ("Finished: Edited 3 files and tests pass ✓" / "Needs your answer"), click focuses window + chat + scrolls to card. In-app mirror: bell-less design — the sidebar `!` badges are the inbox; no notification center chrome.
**Toast system** (in-app): bottom-right stack (max 3), 320px, `--bg-raised` + `--shadow-pop`, `--radius-lg`, 12px pad: status glyph + 13px message + optional action + ✕; autodismiss 5s (info) / sticky (error); enter `translateY(8px)→0` `--dur` `--ease-out`.

---

## 5. Component library spec

Geometry is exact; colors always by token. All interactive components: `:focus-visible` ring (§1.8), tooltip where icon-only, `aria-label` matching tooltip text, disabled = 45% opacity + `not-allowed` cursor (never hidden).

### 5.1 Buttons

| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--accent` (hover `--accent-hover`, active `--accent-active`) | `--accent-fg` | none | one per surface; the only pink rectangle |
| Secondary | `--panel` | `--fg` | 1px `--border-strong` | default action |
| Ghost | transparent (hover `--hover`, active `--selected`) | `--fg-muted` → `--fg` on hover | none | toolbars, headers |
| Danger | `--err` (hover darkened 8%) | `#FFFFFF` | none | destructive confirm only |
| Danger-ghost | transparent (hover `--err-bg`) | `--err` | none | destructive in menus/lists |

Sizes: **sm** 28px h / 12px pad-x / `--text-sm` · **md** 32px / 14px / `--text-md` · **lg** 40px / 18px / `--text-md` 600. Radius `--radius`. Icon+label gap 6px, icon 16px (14px in sm). Press feedback: `scale(0.97)` 120ms (off in reduced motion). Loading: label replaced by spinner (§5.15) same width — no layout shift.

### 5.2 Icon buttons + tooltips

28px square (sm 24px, lg 32px), `--radius`, ghost styling, icon 16px lucide 1.5px stroke. **Every icon button carries a tooltip**: 11px/500 `--fg` on `--bg-raised` + `--shadow-pop`, `--radius-sm`, 6px pad, 8px offset, 400ms hover intent, includes shortcut in `--fg-faint` mono ("Restart · ⌘R"). Menus/tooltips render in `--z-tooltip`.

### 5.3 Chips & badges

Chip: 24px h, `--radius-full`, 10px pad-x, `--text-xs` 600; tint variants = the six `*-muted`/`*-bg` tokens with their matching text tokens (accent / cyan / violet / ok / warn / err / neutral `--hover`+`--fg-muted`). Badge (count): 16px min h, 6px pad-x, `--accent` fill + `--accent-fg` text (or `--err` for failures). Status dot: 8px, ringed 2px `--panel` when overlapping avatars.

### 5.4 Segmented controls

Container `--bg-inset`, `--radius`, 2px pad, 1px `--border`; segments 26px h, `--radius-sm`, `--text-sm` 500 `--fg-muted`; active = `--panel` fill + `--shadow-card` + `--fg`. Used for theme, transcript view, permission presets, share tabs. Keyboard: arrow keys move, follows-focus.

### 5.5 Menus & popovers

Radix DropdownMenu: min-width 200px, `--bg-raised`, `--shadow-pop`, 1px `--border`, `--radius`, 4px pad; items 30px, 8px pad-x, `--radius-sm`, `--text-md`, icon 16px left, shortcut right `--fg-faint` mono; destructive item `--err` text; separators 1px `--border` with 4px margins; submenu chevron. Enter animation: `opacity 0→1 + scale(0.96→1)` `--dur` `--ease-spring` from anchor point.

### 5.6 Dialogs & sheets

Dialog: centered, max 560px (wizards 560, editors as sheets), `--bg-overlay`, `--radius-lg`, `--shadow-overlay`, scrim `--backdrop` (click-outside = cancel, Esc = cancel; destructive dialogs require button click). Title 16/600, body `--text-md`, footer right-aligned [Cancel][Action] with 8px gap, 20px padding. Sheet: right or bottom docked, `--radius-xl`, width per screen spec; enter `translateY(24px)→0` `--dur-slow`. Focus trapped; return focus on close.

### 5.7 Toasts

See §4.22.

### 5.8 Tabs

Two styles: window tabs (28px, 2px accent underline, per §3.3) and dock tabs (32px, same underline, tighter padding, per §3.7). Overflow tabs collapse into a `▾ N more` menu; never scroll horizontally.

### 5.9 List rows

36px (comfortable) / 30px (compact); 8px pad-x; hover `--hover`; selected `--selected` + 2px `--accent` left inset bar; leading icon/avatar 16–20px, trailing meta `--text-xs` `--fg-faint`; single-line ellipsis. Right-click = context menu identical to ⋯.

### 5.10 Cards

`--panel`, 1px `--border`, `--radius-lg`, 16px padding, `--shadow-card` only when floating over content (composer, hover-lift). Status-railed variant: 2px left rail in a status token — rail + glyph carries meaning, never full-card tint (tinted cards are reserved for `--accent-muted` question/plan emphasis and empty-state prompt cards).

### 5.11 Inputs

Text: 32px h, `--panel`, 1px `--border-strong`, `--radius`, 10px pad-x, `--text-md`; focus → border `--ring` + 2px outline; placeholder `--fg-faint`; error → `--err` border + 12px `--err` message below with ▲. Search variant: 🔍 14px leading icon, `--bg-inset` fill, `esc` clears. Textarea: composer rules §3.6. Number/key-value rows: 28px controls on 32px rhythm.

### 5.12 Toggles

40×22 track, `--radius-full`; off `--border-strong` fill, on `--accent`; knob 18px `--panel` + `--shadow-card`, slides 18px `--dur-fast` `--ease-out`; label `--text-md` left, description `--text-sm` `--fg-muted` below. Instant apply with undo toast where reversible.

### 5.13 Sliders

Track 4px `--border-strong`, fill `--accent`, thumb 16px `--panel` + 2px `--accent` border + `--shadow-card`; value bubble above thumb while dragging (mono 11px). Text-size slider shows live preview sentence.

### 5.14 Progress

Determinate bar: 6px, `--radius-full`, `--border-strong` track, `--accent` fill, 300ms width easing. Indeterminate: 120px wide, two-segment slide `--ease-in-out` 1.2s loop. Step progress: dot row `●●○○` 8px dots, done `--accent`, current `--accent` + 8px pulse ring, todo `--border-strong`.

### 5.15 Spinner

14px arc, 2px stroke, `--accent` on transparent, 0.8s linear rotation. Only for buttons and inline loads ≤2s; anything longer uses π-EQ or a progress bar.

### 5.16 The working indicator — "π-sheen" + π-EQ ⭐

The signature motion of the app, derived from the mark itself.

- **π-sheen (hero form, 20px / 28px):** the π glyph filled with `--mark-gradient`; a 40%-width diagonal sheen band (white at 35% opacity, masked to the glyph) sweeps left→right across the mark every 1.6s `--ease-in-out`. Reads as "the mark is thinking." Used on: chat working row, empty-chat art, setup screen, share/collab presence.
- **π-EQ (compact form, 12–16px):** inside the π's legs, three 2px-wide vertical bars (gradient-filled) animate heights 20%→100%→20% in a 0.9s staggered loop (0/150/300ms offsets) — a tiny equalizer under the mark's roof. Used in: tool-card running glyph, tab strip, sidebar rows, Tasks pane.
- **Reduced motion:** sheen/EQ freeze; a 6px `--accent-2` dot next to the mark fades opacity 1→0.35 over 2s instead. No rotation, no translation anywhere.
- Always paired with text ("Working… 14s", "Running tests") — motion is never the only signal.

### 5.17 Context-usage ring

20px ring, 2.5px stroke: track `--border-strong`, fill = `--mark-gradient` rotated to start at 12 o'clock, rounded cap. Zones: <60% gradient as-is · 60–80% shifts hue toward `--warn` · >80% `--err` + slow pulse. Click → popover: exact tokens used/limit, per-category breakdown bars, [Compact now] [Change model]. At 100%: ring fills and a "Context full — summarize to continue" card appears above the composer with one-click Compact. Screen reader: `aria-valuenow` + text "62% of context used".

### 5.18 Skeletons

`--hover`-filled rounded blocks with 1.6s sheen sweep (`--ease-in-out`, opacity-only band); used for dashboard cards, sidebar session list, usage numbers. Reduced motion → static fill. Never skeleton the composer or buttons.

---

## 6. App icon

**"π-window"**: omp's π mark rebuilt as a little window — the top bar of π *is* the window's title bar, complete with traffic-light dots — with omp's signature orange plug still attached to the right leg, now reading as "plugged into omp". Dark tile + full mark gradient so it pops on both macOS and Windows taskbars.

### 6.1 Master artboard — 1024×1024

- **Tile**: full-bleed 1024². macOS supplies the squircle mask — keep all art inside the safe area, a centered **824×824** box (inset 100px all sides). Windows/png export: rounded rect `x=32 y=32 w=960 h=960 rx=220` with same fill.
- **Tile fill**: vertical linear gradient `#191224` (0%) → `#0A0A10` (100%). Two static glows: radial `rgba(244,83,180,0.20)` centered (360,300) r=420 fading to transparent; radial `rgba(0,219,228,0.14)` centered (700,760) r=380.
- **Mark gradient** (`userSpaceOnUse`, x1=232 y1=276 → x2=792 y2=724, i.e. 135° across the full mark): `0% #F84FCC` (mark-a) · `46% #9362F4` (mark-b) · `100% #00DBE4` (mark-c).
- **π geometry** (all fills = mark gradient, shapes unioned so the gradient reads continuously):
  - Title bar: `rect x=232 y=276 w=560 h=104 rx=20` — the π's top bar, window-height.
  - Left leg: `rect x=372 y=380 w=88 h=344 rx=18` (bottom edge y=724).
  - Right leg: `rect x=588 y=380 w=88 h=236 rx=18` (bottom edge y=616).
  - Leg vertical centers sit at 40% and 62% of the bar — slightly wider stance than type-π, matching omp's icon proportions.
- **Traffic dots** (the "visual" tell): three `r=15` circles, cy=328, cx=**284 / 340 / 396**, fills `#FF5F57` / `#FEBC2E` / `#28C840` (macOS convention — instantly reads "window"). They sit inside the bar, clear of the legs (legs start y=380).
- **Plug** (omp's signature, kept): body `rect x=572 y=616 w=120 h=92 rx=20`, fill `#F97316`, centered on the right leg (leg center x=632). Two slot holes: `rect x=604 y=634 w=14 h=44 rx=7` and `rect x=650 y=634 w=14 h=44 rx=7`, fill `#171107` (≈ tile color — reads as cut-out).
- Optional 4px inner edge light along tile top (`rgba(255,255,255,0.08)`, 1px) for depth on dark docks.

### 6.2 Small sizes

- **32px**: drop the tile glows (flat `#100C18` tile), gradient simplifies to 2 stops (`#F84FCC → #00DBE4`), traffic dots shrink to r=1.5px equivalents (keep — they're the distinguishing feature at dock size), plug slots removed (solid orange plug).
- **16px**: solid dark squircle, π reduced to three solid gradient rectangles (bar + 2 legs, no dots, no rounding below 1px), plug = 3×3 orange block at right-leg foot. Recognizable at a glance: colored roof, two legs, orange foot.
- Monochrome (Windows tray / macOS menu bar template): single-color mask of bar+legs+plug silhouette (dots become cut-outs).

---

## 7. README hero banner — 1500×540 (dark, matches omp's hero)

GitHub renders the README on both themes, so the banner is intentionally dark like omp's own hero.png — a window-locked asset, not theme-following.

- **Background**: `#07070C`. Grid: 60px squares, 1px `rgba(255,255,255,0.035)` lines, full-bleed. Radial glow behind the mark: `rgba(244,83,180,0.16)` center (750,190) r=360 → transparent; faint secondary `rgba(0,219,228,0.08)` center (750,420) r=300.
- **Corner brackets**: four 48×48 L-brackets, 2px stroke `#2A2A33`, inset 28px from each corner (omp hero signature).
- **Side braces**: one `{` at left center (x=30, vertically centered on the mark block) and one `}` at right (x=1470), 64px tall, 2px stroke `#9362F4` at 60% opacity (omp hero signature).
- **Mark**: the π-window icon (§6.1 shapes only, no tile) drawn at 1.5× relative scale: bounding box 150×132 centered at x=750, top y=88 (bar 150×28 equivalent, gradient `135deg #F84FCC 0% #9362F4 46% #00DBE4 100%`, traffic dots r=3.5 kept, plug kept at right-leg foot, `#F97316`).
- **Wordmark**: `visual-omp` in Space Grotesk 700, 64px, `#FAFAFC`, letter-spacing −0.02em, centered, baseline y=330. (`visual` may render 500 weight, `-omp` 700 — two-tone weight is the product-name lockup.)
- **Bracket tagline**: `[ A FRIENDLY FACE FOR OMP ]` — mono (JetBrains Mono or SF Mono), 18px, uppercase, letter-spacing 0.35em, `#A2A2AB`, centered, y=388.
- **Dot feature line**: 8px `#ED4ABF` dot centered-left of the text group + `LIGHT BY DEFAULT · DARK TOO · EVERY OMP SUPERPOWER` — mono 14px, uppercase, letter-spacing 0.18em, `#8B8B94`, centered as one group, y=452.
- Export: PNG @1x (1500×540) and @2x (3000×1080); no text smaller than 14px so it survives social-card downscaling.

---

## 8. Microcopy

Voice: plain words, no jargon, no exclamation marks, second person. Buttons are verbs; tooltips are one sentence that says what happens.

### 8.1 Header buttons & major commands

| UI name | One-line tooltip |
|---|---|
| New chat | "Start a fresh conversation in this project." |
| Restart | "Start omp's engine over. Your chat history is kept." |
| Compact | "Summarize this chat so far to free up working room." |
| Plan mode | "Ask omp to think through an approach and show you a plan before changing anything." |
| Model | "Choose which AI model answers you." |
| Agents | "Reusable specialists omp can hand work to, like a reviewer or an explorer." |
| Goal | "Describe the finish line; omp plans the steps and works toward it." |
| Vibe | "omp directs a team of quick helper sessions to build things fast." |
| Loop | "Repeat a task a set number of times, for a while, or until a check passes." |
| Advisor | "A second model watches each step and adds notes when something looks off." |
| Handoff | "Start a fresh chat that picks up from a summary of this one." |
| Rewind | "Go back to an earlier point — undo changes, the conversation, or both." |
| Fork | "Branch this chat to try a different direction without losing this one." |
| Branch tree | "See every fork and rewind of this chat as a map." |
| Share | "Send someone a link or a file of this chat." |
| Export | "Save this chat as a web page you can open anywhere." |
| Model roles | "Pick which model does which job — everyday chat, planning, commit messages, and more." |
| MCP | "Connect outside tools, like a database or ticket tracker, so omp can use them." |
| Skills | "Add-on abilities that teach omp new tricks." |
| Memory | "See — and delete — what omp has remembered between chats." |
| Worktree | "Give this chat its own copy of the project so experiments never touch your main files." |
| Commit | "Save the current changes to git; omp writes the message." |
| Create PR | "Propose these changes on GitHub as a pull request." |
| Review code | "Have omp check the changes for real problems — bugs, not style." |
| Security scan | "Check the project for leaked secrets and common vulnerabilities." |
| Cleanse | "Find and fix errors and warnings across the project with parallel helpers." |
| Transcript view | "Choose how much detail you see: just answers, plus thinking, or every step." |
| Send now | "Send this now — omp reads it at its next step instead of waiting for the reply to finish." |
| Permission mode | "How much omp may do on its own before asking you." |

### 8.2 Empty states

- **No projects**: "No projects yet. A project is just a folder omp works in." + [New project]
- **No chats in project**: "Nothing here yet — start a chat and it will show up in this list."
- **Empty chat**: heading "What should we work on?" + hint "Just describe what you want in plain words."
- **Diff dock empty**: "No changes yet. When omp edits files, the before-and-after shows up here."
- **Tasks dock empty**: "Nothing running. Helpers and background jobs appear here while they work."
- **Search no results**: "No chats match '{q}'."
- **Memory empty**: "omp hasn't saved any memories yet. It only remembers what you ask it to."
- **Usage empty**: "No usage yet this week. Costs appear here after your first chats."

### 8.3 Example prompts (empty chat cards)

1. 🐞 "Something on my site is broken — the checkout total is wrong when I apply a coupon. Find out why and fix it."
2. ✨ "Build a simple contact page for this project with a form that checks the email looks right."
3. 📖 "Explain what this project does and how its main parts fit together, in plain language."
4. 🧹 "Clean up this folder: find unused files and duplicated code, and tell me before deleting anything."
5. 🧪 "Write tests for the login flow and run them until they pass."
6. 🎨 "Make this page look better on phones — keep the design, fix the layout."

### 8.4 Confirmations & guardrails (exact strings)

- Quit guard: "omp is still working in {n} chats." / sub: "Your chats pick up where they left off next time."
- Delete chat: "Delete '{title}'? This removes the saved conversation from this computer. This can't be undone."
- Auto mode (default) needs no confirmation; switching a project to Auto from a stricter mode shows once: "Auto lets omp run commands without asking. Only use it in projects you trust." + [I understand]
- Detach read-only: "This chat is open in another window. You can look, but only that window can type."

---

*End of spec. Tokens in §1 are the single source of truth; implementation maps them 1:1 into Tailwind v4 `@theme` and never hardcodes a raw color outside `theme/`.*
