# visual-omp — Design Specification

One opinionated direction: **Signal Grid**, executed as a polished modern SaaS product (quality bar: Linear, Vercel, Raycast, Supabase). Every value is exact. Implementation stack: React + Tailwind v4 (CSS-variable tokens via `@theme`), Radix primitives, lucide icons, xterm.js.

---

## 0. Design direction

**"Signal Grid."** visual-omp looks like a precision SaaS instrument panel: crisp white panels floating on a cool light-gray canvas, one cyan action color carrying every signal, and a thin cyan→blue→fuchsia spectrum reserved for the few moments that deserve ceremony. Light mode is the designed default; dark mode is a deep blue-black with softly lifted panels — related to omp's dark chassis, but bluer, gentler, and never pure black.

Five decisions everything else hangs on:

1. **One accent, inverted roles.** omp uses pink for action and cyan for information; visual-omp inverts that. **Signal Cyan** is the only action accent (primary buttons, links, active states). **Electric Blue** is information + secondary actions (@-mentions, info status, update chips). **Fuchsia** is agent presence (subagent avatars, question/plan rails, AI-attributed UI). The full cyan→blue→fuchsia gradient appears in exactly five places: the Circuit V mark, the app icon, the working-state shimmer border, hero/empty-state ambient glows, and the primary-button focus glow — never on text or button fills.
2. **Modern SaaS surfaces.** Light: `#FFFFFF` panels on a `#F5F7FA` cool-gray canvas; separation comes from 1px low-contrast borders plus soft, cool-tinted layered shadows on anything floating (composer, menus, dialogs, hovering cards). The title bar and sticky headers are glass (backdrop-blur). Dark: deep blue-black `#090D14` ground with panels lifted to `#0F1622`, same border+shadow logic.
3. **Friendly by default, honest on demand.** Every machine event collapses to a plain-language one-liner ("Edited 3 files"); raw diffs/output are one click or one `Ctrl/Cmd+O` away. Jargon never appears on primary surfaces; the mono-caps bracket style (`[ LABEL ]`) survives only as small section eyebrows — a whisper of the terminal, never a texture.
4. **Restraint reads as premium.** Emphasis is carried by weight, spacing rhythm (8px grid), and the single cyan accent. No gratuitous gradients, no neon, no icon soup, no fake data. The omp-orange appears exactly once in the brand system: the apex node of the Circuit V mark — the point where the visual layer plugs into omp.
5. **Status is shape + color, never color alone.** Every status color pairs with an icon or glyph (✓ ▲ ✕ ●), so the UI survives color-blindness and grayscale.

---

## 1. Design tokens

All colors are authored in hex (sRGB); the three `--mark-*` gradient stops are the Signal Grid spectrum. Naming follows `--<role>` for theme-flipped tokens. Tailwind v4 mapping: every token below is re-exposed in `@theme inline` as `--color-*`, `--radius-*`, `--spacing-*`, `--font-*` with identical values; the tables below are the source of truth.

### 1.1 Surfaces — light (default)

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#F5F7FA` | window background, behind everything |
| `--panel` | `#FFFFFF` | sidebar, panes, cards, composer |
| `--bg-inset` | `#F6F8FB` | code blocks, terminal sheet padding, sunken inputs |
| `--bg-raised` | `#FFFFFF` | popovers, menus, dialogs (with `--shadow-pop` + 1px `--border`) |
| `--bg-overlay` | `#FFFFFF` | modal sheets, command palette |
| `--glass` | `rgba(245,247,250,0.72)` | title bar / sticky headers over scrolled content (`backdrop-filter: blur(16px) saturate(1.5)`) |
| `--hover` | `rgba(16,24,40,0.04)` | row/control hover wash |
| `--selected` | `rgba(16,24,40,0.07)` | selected row wash, pressed state |
| `--backdrop` | `rgba(15,23,42,0.35)` | dialog/sheet scrim |

*Rationale: pure-white panels keep light mode crisp; alpha washes let one hover value work on every surface step; the glass bar is the signature SaaS touch.*

### 1.2 Surfaces — dark

| Token | Value |
|---|---|
| `--bg` | `#090D14` |
| `--panel` | `#0F1622` |
| `--bg-inset` | `#0B111B` |
| `--bg-raised` | `#141D2C` |
| `--bg-overlay` | `#16202F` |
| `--glass` | `rgba(15,22,34,0.72)` |
| `--hover` | `rgba(226,236,248,0.05)` |
| `--selected` | `rgba(226,236,248,0.09)` |
| `--backdrop` | `rgba(3,6,10,0.60)` |

### 1.3 Text

| Token | Light | Dark | Role |
|---|---|---|---|
| `--fg` | `#0F1722` | `#E9EEF4` | body, titles |
| `--fg-muted` | `#4B5866` | `#9DA9B8` | secondary labels, metadata |
| `--fg-faint` | `#67737F` | `#7B8A9C` | placeholders, timestamps, disabled labels |
| `--fg-inverse` | `#FFFFFF` | `#0A0F16` | text on accent fills |

Contrast (on `--panel`): light `--fg` 18.0:1, `--fg-muted` 7.3:1, `--fg-faint` 4.8:1 (4.5:1 on `--bg` — AA). Dark on `--panel`: 15.5:1 / 7.6:1 / 5.1:1. All body-text pairs ≥ 4.5:1. ✓

### 1.4 Accent — the Signal Grid spectrum

Mark stops: `--mark-a: #22D3EE` (cyan) · `--mark-b: #3B82F6` (blue) · `--mark-c: #E879F9` (fuchsia).
`--mark-gradient: linear-gradient(120deg, var(--mark-a) 0%, var(--mark-b) 50%, var(--mark-c) 100%)`.
`--work-gradient: linear-gradient(120deg, var(--mark-a) 0%, var(--mark-b) 33%, var(--mark-c) 66%, var(--mark-a) 100%)` — the working-shimmer border gradient (§5.16).

| Token | Light | Dark | Job |
|---|---|---|---|
| `--accent` | `#0E7490` | `#22D3EE` | Signal Cyan — primary action, links, active tab/selection marker (5.4:1 / 10.0:1 on panel) |
| `--accent-hover` | `#155E75` | `#67E8F9` | hover of the above (white on light hover: 7.4:1) |
| `--accent-active` | `#164E63` | `#A5F3FC` | pressed (white on light: 9.1:1) |
| `--accent-fg` | `#FFFFFF` | `#062832` | text on filled accent (5.4:1 light; 8.6:1 dark) |
| `--accent-muted` | `#E0F2F7` | `#10303C` | tinted chip/badge background; accent text on it: 4.7:1 (light), 7.7:1 (dark) ✓ |
| `--accent-2` | `#2563EB` | `#60A5FA` | Electric Blue — info, secondary actions, @-mention chips (5.2:1 / 7.0:1 on panel) |
| `--accent-2-muted` | `#EBF1FE` | `#152742` | blue tint bg (accent-2 text on it: 4.6:1 / 5.9:1) ✓ |
| `--agent` | `#A21CAF` | `#E879F9` | Fuchsia — subagents, question/plan rails, AI presence (6.3:1 / 7.3:1 on panel) |
| `--agent-muted` | `#FBEFFE` | `#34153F` | fuchsia tint bg (agent text on it: 5.7:1 / 6.4:1) ✓ |
| `--ambient-a` | `rgba(14,116,144,0.05)` | `rgba(34,211,238,0.06)` | hero/empty-state wash, cyan end |
| `--ambient-b` | `rgba(37,99,235,0.05)` | `rgba(96,165,250,0.06)` | hero wash, blue end |

*Light accent choice: raw cyan `#22D3EE` fails AA on white (2.1:1); it is deepened along the same hue to cyan-700 `#0E7490` (5.4:1). Dark accent is the raw signal cyan at full brightness. `--agent` light is fuchsia-700 `#A21CAF` so agent text survives on its own tint.*

### 1.5 Status

| Token | Light | Dark | Pairs with glyph |
|---|---|---|---|
| `--ok` | `#047857` | `#34D399` | ✓ check (5.5:1 / 9.3:1 on panel) |
| `--ok-bg` | `#E6F6EF` | `#0F2B1F` | — (text on bg: 4.9:1 / 7.9:1 ✓) |
| `--warn` | `#B45309` | `#FBBF24` | ▲ triangle (5.0:1 / 10.7:1) |
| `--warn-bg` | `#FDF3E2` | `#2E2410` | (4.6:1 / 9.1:1 ✓) |
| `--err` | `#C81E1E` | `#F87171` | ✕ cross (5.7:1 / 6.5:1) |
| `--err-bg` | `#FCECEC` | `#311518` | (5.0:1 / 6.1:1 ✓) |
| `--info` | `#2563EB` | `#60A5FA` | ● dot (= `--accent-2`) |
| `--info-bg` | `#EBF1FE` | `#152742` | — (= `--accent-2-muted`) |
| `--live` | `#047857` | `#34D399` | ● pulsing dot — **reserved for real-time presence only** (collab live, session running elsewhere), never for generic success |

### 1.6 Diff

| Token | Light | Dark |
|---|---|---|
| `--diff-add-bg` | `#E4F5EC` | `#0F2B1F` |
| `--diff-add-line` | `#CFEFDE` | `#14382A` | (stronger line highlight within hunk) |
| `--diff-add-text` | `#0E6E45` | `#5BD9A3` | gutter `+`, added-code accents (5.6:1 / 8.6:1 on own bg) |
| `--diff-del-bg` | `#FDECEA` | `#311518` |
| `--diff-del-line` | `#FADAD5` | `#42191D` |
| `--diff-del-text` | `#C2291F` | `#FF9AA0` | (5.1:1 / 8.3:1) |
| `--diff-hunk-bg` | `#EDF1F5` | `#141D2C` | `@@` header rows |
| `--diff-hunk-text` | `#4B5866` | `#9DA9B8` |

### 1.7 Syntax highlighting (code blocks, diffs, file viewer)

Light — base text `#0F1722` on code bg `#F6F8FB`; dark — `#E9EEF4` on `#0B111B`. All pairs ≥ 4.5:1 (measured: worst is light number 4.7:1, dark comment 5.4:1).

| Role | Light | Dark |
|---|---|---|
| `--syn-text` | `#0F1722` | `#E9EEF4` |
| `--syn-keyword` | `#0E7490` (cyan) | `#22D3EE` |
| `--syn-string` | `#047857` (green) | `#5BD9A3` |
| `--syn-number` | `#B45309` (amber) | `#FBBF24` |
| `--syn-function` | `#2563EB` (blue) | `#60A5FA` |
| `--syn-type` | `#A21CAF` (fuchsia) | `#E879F9` |
| `--syn-operator` | `#C81E1E` (red) | `#F87171` |
| `--syn-comment` | `#64707D` | `#7B8A9C` |
| `--syn-punct` | `#4B5866` | `#9DA9B8` |

*The syntax palette reuses the brand spectrum (keyword=cyan, function=blue, type=fuchsia) so code "sounds like" Signal Grid without any new hues.*

### 1.8 Borders & focus

| Token | Light | Dark |
|---|---|---|
| `--border` | `rgba(15,23,34,0.08)` | `rgba(226,236,248,0.08)` | hairlines, separators (decorative, exempt) |
| `--border-strong` | `rgba(15,23,34,0.14)` | `rgba(226,236,248,0.16)` | interactive component outlines, inputs (paired with fill/label; focus adds the ring below) |
| `--ring` | `#0891B2` | `#22D3EE` | focus ring (3.7:1 on white, 10.8:1 on `#090D14` — ≥3:1 ✓) |
| `--ring-soft` | `rgba(8,145,178,0.16)` | `rgba(34,211,238,0.22)` | ring halo on tinted surfaces |
| `--grid-line` | `rgba(15,35,60,0.05)` | `rgba(120,170,220,0.07)` | blueprint grid lines (hero, setup, empty states only — never on work surfaces) |

Focus style, everywhere: `outline: 2px solid var(--ring); outline-offset: 2px;` on `:focus-visible`. Never remove; never rely on color change alone.

### 1.9 Elevation & shadows

Soft, cool-tinted, layered. Light shadows use a slate-blue base (`15,35,60`); dark shadows use pure black at lower opacity, since dark surfaces separate mostly by lift.

| Token | Light | Dark |
|---|---|---|
| `--shadow-card` | `0 1px 2px rgba(15,35,60,0.06)` | `0 1px 2px rgba(0,0,0,0.40)` |
| `--shadow-pop` | `0 4px 12px rgba(15,35,60,0.08), 0 1px 3px rgba(15,35,60,0.06)` | `0 4px 12px rgba(0,0,0,0.40), 0 1px 3px rgba(0,0,0,0.35)` |
| `--shadow-overlay` | `0 16px 48px rgba(15,35,60,0.14), 0 4px 12px rgba(15,35,60,0.08)` | `0 16px 48px rgba(0,0,0,0.55), 0 4px 12px rgba(0,0,0,0.40)` |
| `--shadow-composer` | `0 1px 2px rgba(15,35,60,0.06), 0 8px 24px rgba(15,35,60,0.08)` | `0 1px 2px rgba(0,0,0,0.40), 0 8px 24px rgba(0,0,0,0.35)` |

Primary-button depth (the one allowed inset highlight): light `inset 0 1px 0 rgba(255,255,255,0.16), 0 1px 2px rgba(15,35,60,0.12)`; dark `inset 0 1px 0 rgba(255,255,255,0.22), 0 1px 2px rgba(0,0,0,0.40)`.

### 1.10 Radii (modern rounded scale)

| Token | Value | Role |
|---|---|---|
| `--radius-sm` | `6px` | chips, badges, small buttons, inline code |
| `--radius` | `8px` | buttons, inputs, menus, tabs |
| `--radius-lg` | `12px` | cards, tool cards, dialogs |
| `--radius-xl` | `16px` | composer, sheets, large panels |
| `--radius-full` | `999px` | pills, toggles, avatars, status dots, context ring |

### 1.11 Spacing (4px base, 8px rhythm)

`--s-1:4px · --s-2:8px · --s-3:12px · --s-4:16px · --s-5:20px · --s-6:24px · --s-8:32px · --s-10:40px · --s-12:48px · --s-16:64px · --s-20:80px`.
Component density (comfortable-compact SaaS): control height sm 28px / md 32px / lg 40px; list row 36px; chat message gap 24px; card padding 16px; pane padding 16–24px.

### 1.12 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | `100ms` | hovers, presses, toggles |
| `--dur` | `160ms` | menus, popovers, tab switch |
| `--dur-slow` | `240ms` | sheets, dialogs, pane resize settle |
| `--dur-xl` | `360ms` | first-run tour transitions, empty-state art entrance |
| `--ease-out` | `cubic-bezier(0.16,1,0.3,1)` | default entrance (omp's own) |
| `--ease-in-out` | `cubic-bezier(0.65,0,0.35,1)` | looped animations (pulse, sheen) |
| `--ease-spring` | `cubic-bezier(0.34,1.3,0.64,1)` | popover/tooltip pop — gentle overshoot, never bouncy |

`prefers-reduced-motion` / app "Reduce motion" setting: all durations → `0.01ms`; the working shimmer freezes to a static gradient border at 50% opacity with no glow; the gradient pulse dot freezes at 60% opacity; the streaming caret stops blinking (solid); skeleton shimmer → static `--hover` fill; no translate/scale ever.

### 1.13 Z-index layers

`--z-base:0 · --z-sticky:10 · --z-pane-header:20 · --z-sidebar:30 · --z-titlebar:40 · --z-dropdown:50 · --z-scrim:60 · --z-sheet:70 · --z-dialog:80 · --z-palette:90 · --z-toast:100 · --z-tooltip:110`.

---

## 2. Typography

### 2.1 Families

| Token | Stack | Use |
|---|---|---|
| `--font-ui` | `"Geist Variable", "Geist", -apple-system, "Segoe UI Variable Text", Roboto, sans-serif` | all UI text **and** display headings (600/700, tight tracking) |
| `--font-mono` | `"Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | code, diffs, terminal, bracket labels, wordmark, numbers in status bar |

Two bundled families, both OFL: **Geist** (`@fontsource-variable/geist`, variable 100–900, ≈95 KB woff2) and **Geist Mono** (`@fontsource-variable/geist-mono`, variable 100–900, ≈90 KB woff2). Geist carries display duties at 700 with −0.02em tracking, so no third display family is needed (Space Grotesk was considered and cut to respect the two-family budget — Geist's engineered grotesque voice *is* the Signal Grid personality). System stacks are fallbacks only.

### 2.2 Scale (root 16px; user text-size setting scales root 90–130%, i.e. 14.4–20.8px)

| Token | Size / line-height | Weight / spacing | Use |
|---|---|---|---|
| `--text-xs` | 11px / 15px | 500, +0.02em | chips, badges, status bar, table metadata |
| `--text-sm` | 12px / 16px | 400/500 | tool-card summaries, secondary labels, menu shortcuts |
| `--text-md` | 13px / 18px | 400/500/600 | **base UI size**: buttons, inputs, list rows, menus |
| `--text-base` | 14px / 22px | 400 | chat body, markdown, plan text |
| `--text-lg` | 16px / 24px | 400/600 | section titles, dialog titles |
| `--text-xl` | 20px / 28px | 600 | pane titles, dashboard cards |
| `--text-2xl` | 24px / 30px | 700, −0.02em | empty-state heading |
| `--text-3xl` | 32px / 38px | 700, −0.02em | setup screen, dashboard numbers |
| `--text-code` | 12.5px / 18px | 400 mono | code blocks, diffs |
| `--text-terminal` | 13px / 19px | 400 mono | terminal sheet (user-adjustable ±) |

### 2.3 The wordmark + block cursor

`visual-omp`, lowercase, Geist Mono 600, tracking 0, `--fg`, followed by a **solid block cursor** (0.55em wide × 1em tall, `--accent` fill, 4px left gap). The cursor is static in the title bar; it blinks (1.1s `steps(1)`) only in the README hero and the about screen. The block cursor is the app's smallest brand asset and appears **nowhere else** — working states use the shimmer and pulse dot (§5.16), and streaming text uses a thin 2px caret, not the block.

### 2.4 The bracket style — `[ LABEL ]`

omp's mono-caps signature, kept quiet. Rules: `font-mono`, `--text-xs` (11px), uppercase, `letter-spacing: 0.14em`, `--fg-faint`; brackets included in the string. Used **only** for: (a) section eyebrows on calm surfaces (setup screen `[ WELCOME ]`, settings group labels, question/plan card eyebrows), (b) the hero/empty-state tagline, (c) the status bar's mode readout `[ AUTO ]`. Never on buttons, never interactive, max one per surface.

---

## 3. App shell layout

Default window **1440×900**, minimum **1100×700**. Regions (light values shown):

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ TITLE BAR — 40px, --glass + backdrop-blur over content, --z-titlebar           │ 40px
│ ⊙⊙⊙  ≡  visual-omp▌       ·  my-shop / Fix checkout bug        ⌄    ☐  ✕ (win) │
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

Frameless window with a custom bar; `-webkit-app-region: drag` on the bar, `no-drag` on controls. The bar is `--glass` with `backdrop-filter: blur(16px) saturate(1.5)` and a bottom 1px `--border` that appears only when content scrolls beneath it.

- **macOS**: traffic lights inset at x=12, vertically centered; content starts at **x=92**. Window controls hidden (native).
- **Windows**: content starts at x=12; caption buttons (minimize / maximize / close) at right, each **46×40**, lucide icons 14px, close hover `#E81123` + white icon (platform convention — the one allowed off-palette color).
- Content: sidebar toggle (≡, only when sidebar hidden) · app mark (Circuit V, 20px, mark-gradient with orange apex node) + `visual-omp` wordmark lockup (§2.3, 15px) · centered: current project / session breadcrumb (`--fg-muted`, 13px, ⌄ opens session switcher) · right (macOS): nothing — right side stays empty so it never collides with traffic-light muscle memory.

### 3.2 Sidebar (264px default, drag 200–320px, `Cmd/Ctrl+B` hides)

```
┌────────────────────────────┐
│ 🔍 Search chats…      ⌘K   │ 32px search field (--bg-inset, radius-md, 1px --border)
│ ＋ New chat                │ 36px primary ghost row, accent text
│────────────────────────────│
│ [ PROJECTS ]               │ bracket eyebrow, 11px mono
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
- Session row anatomy: status dot (8px, `--radius-full`) · title (13px/500, 1-line ellipsis) · relative time (`--text-xs`, `--fg-faint`) · hover reveals ⋯ menu (Rename, Pin, Fork, Archive, Delete).
- Badges: `needs-input` = warn dot + subtle `--warn-bg` pill on the title; `live elsewhere` = `--live` dot + "read-only" chip; Dispatch/scheduled = fuchsia dot.
- While a session is working, its status dot becomes the **gradient pulse dot** (8px, `--mark-gradient` fill, §5.16).
- Pinned sessions float to top of their project, pin icon at right.
- Collapse behavior: `Cmd/Ctrl+B` hides to 0; a slim 16px hover strip remains at the left window edge; hovering it (or pressing the shortcut) slides the sidebar back as an overlay with scrim-free shadow (`--shadow-pop`). No icon-rail intermediate state — two states only, less to learn.

### 3.3 Tab strip + split view (36px)

- Tabs: min 120px, max 200px, height 28px, `--radius` top-only, active = `--panel` fill + 2px accent underline + title 500; inactive = transparent, `--fg-muted`. Status dot left (8px); close ✕ on hover (16px hit area 24px); gradient pulse dot (§5.16) replaces the status dot while working.
- `＋` button at strip end (28×28 ghost) → new chat in current project.
- **Split view**: `Cmd/Ctrl+\` splits the focused chat column left/right (equal 50%, divider 4px `--border`, drag 30–70%). Each split has its own header + chat + composer but shares the tab strip, right dock, and status bar (status bar reflects focused split). `Cmd/Ctrl+click` a sidebar session opens it in the second split. Max 2 splits — more is what tabs are for.

### 3.4 Session header bar (48px, `--panel`, bottom hairline)

```
│ ◈ Fix checkout bug ✎   [ Sonnet 4.5 ▾ ] [ Auto ▾ ]   │  ↻ Restart  ⧉ Compact  │
│                                                        │  ☰ Plan  🤖 Agents  ⋯  │
```

- Left: session icon ◈ (16px, `--fg-muted`), inline-editable title (15px/600; click ✎ or double-click → input), then **model chip** (`--accent-muted`, accent text, ⌄ → model picker, §4.12) and **mode chip** (neutral `--hover` fill; `Plan` mode = `--agent-muted` fuchsia; `Yolo/Auto` = neutral) — chips are 24px tall, `--radius-full`, `--text-xs` 600.
- Right (icon+label buttons, 28px, ghost): **Restart ↻**, **Compact ⧉**, **Plan ☰** (toggle, fuchsia when on), **Agents 🤖** (opens Agents hub as sheet), **New ＋**, overflow ⋯ (Rewind, Fork, Branch tree, Handoff, Share, Export, Rename, Archive).
- Contextual rule: Compact shows a tiny `!` badge when context ≥ 75%; Plan button appears only when a plan exists or Plan mode is on, otherwise it lives in ⋯. No more than 5 visible buttons + ⋯ — everything else is in the palette.

### 3.5 Chat column

- Max width **760px**, horizontally centered, 24px side gutters, top padding 24px, bottom padding 16px above composer. Transcript view toggle (**Normal / Thinking / Verbose**) lives as a segmented control in the ⋯ overflow *and* cycles with `Ctrl/Cmd+O`; Normal is default.
- **User message**: right-aligned? No — full-width rows for everyone (chat-app bubbles read as consumer messaging; this is a work log). User messages: `--bg-inset` card, `--radius-lg`, 12px/16px padding, left 2px `--border-strong` rail; attachments as 48px thumbnails above text; small "You" label (`--text-xs` muted) + timestamp on hover; hover actions: Rewind ↩, Fork ⑂, Copy.
- **Assistant message**: no card — bare markdown on the chat background with a 20px Circuit V mark (mark-gradient, orange apex node) + model name + time header row; hover actions: Copy, Rewind to here, Read aloud (TTS). Streaming text renders inline with a 2px blinking caret (`--accent`, 1.1s blink, suppressed in reduced motion).
- **Thinking block**: collapsed one-liner "Thought for 12s" (`--fg-faint`, italic off, chevron ▸); expanded = `--fg-muted` text on `--bg-inset`, left 2px `--agent` rail. Visible in Normal only after expansion; always visible in Thinking view.
- **Tool cards**: §4.7.
- **System notices** (compaction, mode change, restarts): centered `--text-xs` `--fg-faint` line with 24px hairline rules either side — "· Context summarized ·".
- **Questions & approvals**: §4.8. **Errors**: §5 cards, `--err` rail + "Try again" button.
- **Queued messages tray**: §3.6.
- Day/time dividers: centered `--text-xs` `--fg-faint` "Today 14:32".

### 3.6 Composer (floating card, max 760px, `--radius-xl`, `--shadow-composer`, 1px `--border-strong`)

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

One bottom row, 40px tall, contents left→right: **＋** (28px ghost; menu: Attach file, @-mention file, Prompt library, Skills, Custom commands) · **permission-mode selector** (pill, 28px) mapping 1:1 to omp's `tools.approvalMode`: `Ask me first` (`always-ask`: asks before edits and commands) · `Edits OK` (`write`: edits run, commands ask) · `Auto` (`yolo`: runs everything, no questions). Default for new users is **Auto** (spec: auto-approve everything); Auto carries a quiet `--fg-muted` label "no questions asked", no warn dot · mode quick-toggles **!** and **$** (28px ghost, active = `--accent-2-muted` fill + blue text) · flexible space · **voice 🎤** (28px ghost; recording = `--err` pulse ring) · **context ring** (20px, §5.17) · **model ⌄** (text button, 13px/500 `--fg-muted`) · **thinking ⌄** (same styling) · **send/stop** (32px, `--radius`, primary: `--accent` fill + §1.9 primary-button depth, ➤ `--accent-fg`; while working: `--err`-text ghost ■ Stop).
While the agent works, the composer frame carries the **signal shimmer border** (§5.16).
- **@-mention**: typing `@` opens fuzzy picker (§5 menus) listing project files; selected files appear as blue chips inline (`--accent-2-muted` fill, `--accent-2` text).
- **Queued tray** rows: 32px, `--text-sm`, drag-handle to reorder, per-row [Send now] [Edit] [✕]; tray max 3 rows + "N more".
- **Drag-drop**: files dropped anywhere on the chat column → full-column drop veil (`--accent-muted` at 60% + 2px solid `--accent` outline inset 8px, `--radius-xl`).

### 3.7 Right dock (default 420px, drag 320–640px, `Cmd/Ctrl+.` toggles, remembers tab+width per project)

- Tab strip 32px: **Diff · Files · Preview · Tasks · Plan · Terminal** — 13px/500 labels, active = accent text + 2px accent underline; badges: Diff shows `+N −M`, Tasks shows running count dot, Plan shows `!` when awaiting approval, Terminal shows `●` when a command runs.
- One dock per window (shared across splits; reflects focused session). Pop-out button (⧉ 24px ghost) floats any pane to its own window.
- **Diff**: file list left (140px, collapsible) + per-file unified diff; line-comment `＋` on gutter hover → comment box, `Cmd/Ctrl+Enter` sends all comments to omp; header: file path breadcrumb, "Review code" button (accent), Accept/Reject per hunk in Manual mode.
- **Files**: tree (24px rows, 12px indent steps) + viewer tabs; click file → viewer; `⌘click` or right-click → "Mention in chat" (@-chip). Syntax colors §1.7; images render inline.
- **Preview**: address bar (back/fwd/reload, URL, open-external ⧉, select-element ⌖) + webview; empty state: "Start a dev server and it shows up here."
- **Tasks**: three groups — Checklist (todo phases, checkbox rows), Helpers (subagents: fuchsia avatar, name, one-line status, live token count, Stop), Background (shell jobs, dev servers; live tail on expand).
- **Plan**: current plan markdown + Approve / Refine bar (§4.9 when approval pending).
- **Terminal**: xterm.js, `--bg-inset` padding 8px, font `--text-terminal`; tab `+` for extra shells; this is a plain project shell, distinct from the omp terminal sheet (§4.11).

### 3.8 Status bar (28px, `--panel`, top hairline, `--text-xs`)

Left: **git branch** (⎇ glyph + name, mono; click → branch menu incl. Worktree toggle) · **changes** `+12 −3` (`--diff-add-text` / `--diff-del-text`; click → Diff dock) · **PR/CI chip** when a PR exists (✓ green / ▲ amber / ✕ red + "Fix CI" on failure).
Center (absolute-centered): nothing — keep it empty.
Right: **context ring + %** (§5.17, click → Compact dialog) · **cost today** `$1.24` (mono; click → Usage dashboard; turns `--warn` at 80% of the user's daily cap) · **omp status** (`● omp 18.4.4` — `--ok` dot connected / `--warn` reconnecting / `--err` stopped; click → diagnostics menu: Open terminal sheet, Restart omp, Copy diagnostics) · **mode readout** `[ AUTO ]` (bracket style, §2.4) when not in the default mode.
All status-bar items are buttons with tooltips; bar is 28px exactly, never wraps, items truncate middle with ellipsis.

---

## 4. Screen specs

Conventions: wireframes are schematic, not to scale; every screen lists its component inventory (§5) and states. All screens obey §3 shell unless noted.

### 4.1 omp-missing setup screen

Full-window replacement (no sidebar/dock), centered 560px column on `--bg` with ambient wash (radial `--ambient-a` top-left → `--ambient-b` bottom-right, 480px radius each, static) and a faint blueprint grid (`--grid-line`, 40px squares, radially masked to transparent at 70% of the window diagonal).

```
                 ╭──────╮
                 │  ◇   │                       96px Circuit V mark, mark-gradient
                 ╰──────╯                       (orange apex node, soft cyan glow
              [ WELCOME ]                       rgba(34,211,238,0.18) Ø160 behind)
        Let's get omp installed                 Geist 700, 32px, -0.02em
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

- Inventory: Circuit V mark, bracket label, display heading, 2 step cards (card, `--radius-lg`), primary/secondary/ghost buttons, copy button (toast on copy), footer link.
- States: **missing** (above) · **installing** (step 1 expands inline into a 240px mini-terminal showing the installer output live — user-initiated, visible, with Cancel; the mark's glow gently pulses) · **too old** (same layout; heading "Your omp is out of date", shows installed vs required version, step 1 becomes "Update omp") · **done** (both steps get ✓ `--ok`, auto-advances to first-run tour after 600ms).

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
│ [ PROJECT ]              my-shop                        ⚙ ▾ │ eyebrow + Geist 700 28px + settings menu
│ ⎇ main · clean · 3 chats this week · $4.10 this week        │ 13px muted meta row, mono numbers
├─────────────────────────────────────────────────────────────┤
│ ┌─ Recent chats ────────────────────────────┐  [ See all → ]│
│ │ ● Fix checkout bug        Sonnet · 2m ago  │             │ rows 44px: status dot, title 14/500,
│ │ ○ Styles pass             Haiku  · 1h ago  │             │ model + time muted; click resumes
│ │ ↺ Deploy script (terminal) read-only       │             │
│ └────────────────────────────────────────────┘             │
│ ┌─ Start something ────────────────────────────────────────┐│
│ │ [ ✨ Fix a bug ] [ 🧪 Add tests ] [ 📝 Explain this ]    ││ quick-start prompt chips, 40px,
│ │ [ 🚀 Build a feature ]                                    ││ --panel cards, hover --hover + lift 1px
│ └──────────────────────────────────────────────────────────┘│   + --shadow-card
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
                      ◇  (48px Circuit V, mark-gradient, orange apex,
            What should we work on?        soft glow rgba(34,211,238,0.14) Ø96)
              Geist 700, 24px, -0.02em, --fg
   ┌────────────────────┐ ┌────────────────────┐
   │ 🐞 Something's     │ │ ✨ Build something  │  2×2 grid of prompt cards,
   │    broken…         │ │    new…             │  156×88px, --panel, 12px pad,
   ├────────────────────┤ ├────────────────────┤  1px --border, icon 20px accent,
   │ 📖 Explain this    │ │ 🧹 Clean this up…   │  title 13/600, 2-line sample
   │    project…        │ │                     │  text 12px muted
   └────────────────────┘ └────────────────────┘
        Press / for shortcuts · @ to mention a file     12px --fg-faint hints
```

- Each card carries a full example prompt (§8) into the composer on click (not auto-send). Hover: lift 1px + `--shadow-card`; focus: ring.
- States: **first-ever chat in app** → heading "What should we work on?" + hint line under it: "Tip: just describe what you want in plain words."; **returning** → heading "Back to it — what's next?".

### 4.6 Live chat, mid-stream

```
│ You · 14:32                                                          │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ The checkout total is wrong when a coupon is applied. Fix it?    │ │ user card
│ └──────────────────────────────────────────────────────────────────┘ │
│ ◇  Sonnet 4.5 · 14:32                                                │ Circuit V 20px header
│ I'll trace how coupons flow into the total.                          │ streamed markdown
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ▸ 🔍 Searched for "coupon" — 12 matches                       ✓ │ │ tool card collapsed
│ ├──────────────────────────────────────────────────────────────────┤ │
│ │ ▾ ✏️ Edited 2 files — cart.ts +8 −3, pricing.ts +1 −1  [View] ✓ │ │ expanded state shown
│ │   │ diff preview, 2 file blocks, --bg-inset …                    │ │
│ ├──────────────────────────────────────────────────────────────────┤ │
│ │ ▸ 🧪 Running tests…                                           ◉ │ │ running: shimmer border + dot
│ └──────────────────────────────────────────────────────────────────┘ │
│ ◉ Working… 14s — Running tests                       ■ Stop          │ working row: pulse dot + elapsed
```

- Streaming caret on text; tool cards stream in-place (no layout jump — cards reserve final height once result arrives via 160ms height animation).
- Running tool cards carry the **signal shimmer border** (§5.16) in place of their static `--border`.
- Working row pinned just above composer while active: gradient pulse dot + "Working… {elapsed}s" + current activity ("Running tests") in `--fg-muted` + Stop. Also mirrored in the session's tab and sidebar row.
- Scroll behavior: auto-scroll locks to bottom; scrolling up shows a floating "↓ New activity" pill (accent) bottom-right of the column.

### 4.7 Tool cards — collapsed & expanded

Anatomy (all tools): full-width card, `--panel`, 1px `--border`, `--radius-lg`, min-height 40px collapsed. Left 2px status rail (running `--accent` / ok `--ok` / err `--err`). Header row 40px: chevron ▸/▾ (16px) · tool glyph (16px, `--fg-muted`) · **friendly summary** 13px/500 · flexible space · meta (duration, counts, `--text-xs` `--fg-faint`) · status glyph. Expanded body: 12px pad, `--bg-inset` inner well (`--radius`), raw args/output; footer row with [Copy] [Open in Files/Diff] context actions. Secrets always masked `•••` with eye toggle.

| Tool | Glyph | Collapsed friendly summary (exact patterns) | Expanded body |
|---|---|---|---|
| bash | `▸_` | "Ran `npm test` — passed ✓" / "Ran `npm test` — failed ✕" / running: "Running `npm test`…" | command line (mono) + live-tail output (last 2,000 lines, ANSI colors mapped to tokens) + exit code chip |
| edit | ✏️ | "Edited `cart.ts` — +8 −3" / multi: "Edited 3 files — +21 −6" | per-file unified diff (§1.6 colors), file header rows link to Diff dock |
| write | ✏️＋ | "Created `README.md` — 84 lines" | full file content, syntax-highlighted |
| read | 📄 | "Read `pricing.ts` — 212 lines" | file excerpt with line numbers; collapsed again at 200 lines with "Show all" |
| grep/glob | 🔍 | "Searched for `coupon` — 12 matches in 4 files" | match list grouped by file, each row: line no + context line, click → Files pane |
| task (subagents) | 🤖 | "Helper: explore-auth — working… 12k tokens" / "…done ✓ — 3 findings" | fuchsia-tinted body: live activity feed (tool one-liners), final report markdown, [Open as chat] |
| todo | ☑ | "Checklist — 4 of 7 done" | checkbox rows, phase headers; current item accented |
| web_search | 🌐 | "Searched the web — 5 sources" | source cards: favicon, title link, 2-line snippet, [Open] |

Running state replaces the static border with the signal shimmer (§5.16) and the status glyph with an 8px gradient pulse dot. Error state: `--err` rail + "— failed" + [Try again] button in footer. Verbose view: cards start expanded and also show raw JSON args; Thinking view: collapsed as Normal.

### 4.8 Ask / approval question card

Appears inline in the transcript when omp asks (`ask`, tool approvals, select/confirm/input UI requests). Card: `--panel`, `--agent` fuchsia 2px left rail, `--radius-lg`, 16px padding, fuchsia `[ QUESTION ]` eyebrow.

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

Inline card when a plan awaits decision: fuchsia rail, `[ PLAN READY ]` eyebrow, plan title 15/600, collapsible plan body (markdown), footer:

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

Bottom sheet, 80% window height, `--radius-xl` top corners, `--shadow-overlay`, scrim. Header 40px: terminal glyph · title "omp terminal — Settings" (the open omp screen's name, 13px/600) · hint "This is omp's own screen — click or type to use it" (`--fg-muted`) · [⤢ Expand to full] [✕ Close]. Body: xterm.js mirroring the live hidden TUI, `--bg-inset`, 12px padding. Opens automatically whenever omp shows a screen visual-omp doesn't draw natively (detected via omp's TUI focus/overlay state: `/settings` fallback, `/login`, `/tree`, `/resume` picker, `/extensions`, confirm/input prompts); closing with a menu open sends Esc and asks "Leave this omp screen? Your choice won't be saved." States: connected (live mirror), reconnecting (amber banner row inside header), disconnected (err banner + [Restart omp]).

### 4.12 Settings

Modal sheet 880×640, left nav 200px + content 640px (24px padding). Tabs: **General · Appearance · Permissions · Models · Sounds & alerts · Shortcuts · About · Advanced**.

- **General**: default permission mode (segmented), default transcript view (segmented), auto-compact toggle, restore chats on launch toggle.
- **Appearance**: theme segmented (Light / Dark / System), text size slider 90–130% (live preview sentence), reduce motion toggle, chat density (Comfortable / Compact).
- **Permissions**: per-tool allow/ask/deny table backed by omp's `tools.approval.<tool>` (rows: tool glyph + plain name + segmented Ask/Allow/Deny).
- **Models**: link-button to Model roles editor (§4.13) + default model picker + thinking default.
- **Sounds & alerts**: notification toggles (chat finished, needs input, CI finished), sound toggle, do-not-disturb schedule.
- **Shortcuts**: searchable shortcut table with click-to-rebind (capture pill "Press keys…"), conflict shown `--err` inline, [Reset all].
- **About**: app + omp versions, Circuit V mark (48px) + wordmark lockup with blinking block cursor, links (omp docs, report issue), [Check for updates].
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
List rows 64px: fuchsia avatar (agent initial on `--agent-muted`) · name 14/600 + scope chip (Built-in / This project / All projects) · one-line description (from frontmatter) · model chip · enable toggle · ⋯ (Edit, Duplicate, Run now, Delete).
Row states: disabled (40% opacity, toggle off), running now (gradient pulse dot + "Running in Fix checkout bug"), error in definition file (warn chip + [Fix] opens editor).
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

Modal sheet 880×600. Top stat row: four 160×88 stat cards (Geist 700 28px number, −0.02em + 12px label): **Today $1.24 · This week $8.90 · Chats 23 · Tokens 1.2M**.
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

**Update notice** — toast, bottom-right, 360px: Circuit V mark + "visual-omp 1.3 is here" + one-line highlight + [Restart to update] [Later]; also a persistent quiet version: ⋯ menu → "Update ready" accent dot. omp-engine update appears separately: status bar omp chip gets `--info` dot + menu item "Update omp to 18.5".
**Quit-warning dialog** — modal 420px when quitting/closing a tab with work in flight: warn glyph, "omp is still working in 2 chats", list of chat titles with activity, [ Keep waiting ] (ghost) [ Stop and quit ] (danger). "Don't ask again — always stop" checkbox. Sessions auto-resume next launch (stated in one muted line: "Your chats pick up where they left off.").
**Notifications** — native OS toasts (macOS Notification Center / Windows): title = chat title, body = outcome one-liner ("Finished: Edited 3 files and tests pass ✓" / "Needs your answer"), click focuses window + chat + scrolls to card. In-app mirror: bell-less design — the sidebar `!` badges are the inbox; no notification center chrome.
**Toast system** (in-app): bottom-right stack (max 3), 320px, `--bg-raised` + `--shadow-pop`, `--radius-lg`, 12px pad: status glyph + 13px message + optional action + ✕; autodismiss 5s (info) / sticky (error); enter `translateY(8px)→0` `--dur` `--ease-out`.

---

## 5. Component library spec

Geometry is exact; colors always by token. All interactive components: `:focus-visible` ring (§1.8), tooltip where icon-only, `aria-label` matching tooltip text, disabled = 45% opacity + `not-allowed` cursor (never hidden).

### 5.1 Buttons

| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--accent` (hover `--accent-hover`, active `--accent-active`) + §1.9 primary-button depth | `--accent-fg` | none | one per surface; the only cyan rectangle |
| Secondary | `--panel` (hover `--bg-inset`) | `--fg` | 1px `--border-strong` | default action |
| Ghost | transparent (hover `--hover`, active `--selected`) | `--fg-muted` → `--fg` on hover | none | toolbars, headers |
| Danger | `--err` (hover darkened 8%) | `#FFFFFF` | none | destructive confirm only |
| Danger-ghost | transparent (hover `--err-bg`) | `--err` | none | destructive in menus/lists |

Sizes: **sm** 28px h / 12px pad-x / `--text-sm` · **md** 32px / 14px / `--text-md` · **lg** 40px / 18px / `--text-md` 600. Radius `--radius`. Icon+label gap 6px, icon 16px (14px in sm). Press feedback: `scale(0.98)` 100ms (off in reduced motion). Hover transitions: `background-color/border-color/box-shadow` `--dur-fast` `--ease-out`. Loading: label replaced by spinner (§5.15) same width — no layout shift.

### 5.2 Icon buttons + tooltips

28px square (sm 24px, lg 32px), `--radius`, ghost styling, icon 16px lucide **1.75px stroke, round caps and joins**. **Every icon button carries a tooltip**: 11px/500 `--fg` on `--bg-raised` + `--shadow-pop` + 1px `--border`, `--radius-sm`, 6px pad, 8px offset, 400ms hover intent, includes shortcut in `--fg-faint` mono ("Restart · ⌘R"). Menus/tooltips render in `--z-tooltip`.

### 5.3 Chips & badges

Chip: 24px h, `--radius-full`, 10px pad-x, `--text-xs` 600; tint variants = the six `*-muted`/`*-bg` tokens with their matching text tokens (accent / blue / fuchsia / ok / warn / err / neutral `--hover`+`--fg-muted`). Badge (count): 16px min h, 6px pad-x, `--accent` fill + `--accent-fg` text (or `--err` for failures). Status dot: 8px `--radius-full`, ringed 2px `--panel` when overlapping avatars.

### 5.4 Segmented controls

Container `--bg-inset`, `--radius`, 2px pad, 1px `--border`; segments 26px h, `--radius-sm`, `--text-sm` 500 `--fg-muted`; active = `--panel` fill + `--shadow-card` + `--fg`. Used for theme, transcript view, permission presets, share tabs. Keyboard: arrow keys move, follows-focus.

### 5.5 Menus & popovers

Radix DropdownMenu: min-width 200px, `--bg-raised`, `--shadow-pop`, 1px `--border`, `--radius`, 4px pad; items 30px, 8px pad-x, `--radius-sm`, `--text-md`, icon 16px left, shortcut right `--fg-faint` mono; destructive item `--err` text; separators 1px `--border` with 4px margins; submenu chevron. Enter animation: `opacity 0→1 + scale(0.97→1) + translateY(-2px→0)` `--dur` `--ease-spring` from anchor point.

### 5.6 Dialogs & sheets

Dialog: centered, max 560px (wizards 560, editors as sheets), `--bg-overlay`, `--radius-lg`, `--shadow-overlay`, scrim `--backdrop` (click-outside = cancel, Esc = cancel; destructive dialogs require button click). Title 16/600, body `--text-md`, footer right-aligned [Cancel][Action] with 8px gap, 20px padding. Sheet: right or bottom docked, `--radius-xl`, width per screen spec; enter `translateY(24px)→0` `--dur-slow` `--ease-out`. Focus trapped; return focus on close.

### 5.7 Toasts

See §4.22.

### 5.8 Tabs

Two styles: window tabs (28px, 2px accent underline, per §3.3) and dock tabs (32px, same underline, tighter padding, per §3.7). Overflow tabs collapse into a `▾ N more` menu; never scroll horizontally.

### 5.9 List rows

36px (comfortable) / 30px (compact); 8px pad-x; hover `--hover`; selected `--selected` + 2px `--accent` left inset bar; leading icon/avatar 16–20px, trailing meta `--text-xs` `--fg-faint`; single-line ellipsis. Right-click = context menu identical to ⋯.

### 5.10 Cards

`--panel`, 1px `--border`, `--radius-lg`, 16px padding. `--shadow-card` only when floating over content or on hover-lift (composer always floats; prompt cards and dashboard chips lift on hover). Status-railed variant: 2px left rail in a status token — rail + glyph carries meaning, never full-card tint (tinted cards are reserved for `--accent-muted`/`--agent-muted` question/plan emphasis and empty-state prompt cards).

### 5.11 Inputs

Text: 32px h, `--panel`, 1px `--border-strong`, `--radius`, 10px pad-x, `--text-md`; focus → border `--ring` + 2px outline; placeholder `--fg-faint`; error → `--err` border + 12px `--err` message below with ▲. Search variant: 🔍 14px leading icon, `--bg-inset` fill, `esc` clears. Textarea: composer rules §3.6. Number/key-value rows: 28px controls on 32px rhythm.

### 5.12 Toggles

40×22 track, `--radius-full`; off `--border-strong` fill, on `--accent`; knob 18px `--panel` + `--shadow-card`, slides 18px `--dur-fast` `--ease-out`; label `--text-md` left, description `--text-sm` `--fg-muted` below. Instant apply with undo toast where reversible.

### 5.13 Sliders

Track 4px `--border-strong`, fill `--accent`, thumb 16px `--panel` + 2px `--accent` border + `--shadow-card`; value bubble above thumb while dragging (mono 11px). Text-size slider shows live preview sentence.

### 5.14 Progress

Determinate bar: 6px, `--radius-full`, `--border-strong` track, `--accent` fill, 240ms width easing. Indeterminate: 120px wide, two-segment slide `--ease-in-out` 1.2s loop. Step progress: dot row `●●○○` 8px dots, done `--accent`, current `--accent` + 8px pulse ring, todo `--border-strong`.

### 5.15 Spinner

14px arc, 2px stroke, `--accent` on transparent, 0.8s linear rotation. Only for buttons and inline loads ≤2s; anything longer uses the signal shimmer / pulse dot (§5.16) or a progress bar.

### 5.16 The working indicator — signal shimmer + gradient pulse dot ⭐

The signature motion of the app, drawn from the mark spectrum. Two forms, one rule: **motion is never the only signal** — always paired with text ("Working… 14s", "Running tests").

- **Signal shimmer (surface form — running tool cards, composer while working):** the component's static 1px `--border` is replaced by an animated gradient border. Exact CSS:
  ```css
  .working {
    border: 1px solid transparent;
    background:
      linear-gradient(var(--panel), var(--panel)) padding-box,
      var(--work-gradient) border-box;
    background-size: 100% 100%, 300% 100%;
    background-position: 0% 0%, 0% 0%;
    animation: signal-shimmer 2.4s linear infinite;
    box-shadow: 0 0 16px rgba(34,211,238,0.14); /* dark: rgba(34,211,238,0.20) */
  }
  @keyframes signal-shimmer {
    to { background-position: 0% 0%, 300% 0%; }
  }
  ```
  The spectrum travels along the frame once every 2.4s — "the circuit is live." The glow is the only colored shadow in the app.
- **Gradient pulse dot (compact form, 8px):** an 8px `--radius-full` dot filled with `--mark-gradient`, opacity pulsing 1 → 0.45 → 1 over 1.6s `--ease-in-out` infinite. Used in: the chat working row, tab strip, sidebar session rows, Tasks pane, Agents hub running rows, tool-card status-glyph slot while running.
- **Reduced motion:** shimmer freezes to a static `--work-gradient` border at 50% opacity, glow removed; pulse dot freezes at 60% opacity; the streaming caret (2px, `--accent`) stops blinking and stays solid. No translation, no rotation, ever.

### 5.17 Context-usage ring

20px ring, 2.5px stroke: track `--border-strong`, fill `--accent`, round cap, starting at 12 o'clock. Zones: <60% `--accent` · 60–80% `--warn` · >80% `--err` + slow opacity pulse. Click → popover: exact tokens used/limit, per-category breakdown bars, [Compact now] [Change model]. At 100%: ring fills and a "Context full — summarize to continue" card appears above the composer with one-click Compact. Screen reader: `aria-valuenow` + text "62% of context used".

### 5.18 Skeletons

`--hover`-filled blocks (`--radius-sm`) with 1.6s sheen sweep (`--ease-in-out`, opacity-only band); used for dashboard cards, sidebar session list, usage numbers. Reduced motion → static fill. Never skeleton the composer or buttons.

---

## 6. App icon

**"Circuit V"**: a V for *visual*, drawn as a circuit trace with node dots at its vertices — the apex node is omp's plug-orange, the exact point where the visual layer connects to the omp engine. The trace carries the Signal Grid gradient (cyan → blue → fuchsia — omp's magenta→violet→cyan spectrum re-sequenced), so the icon is unmistakably omp-family without copying the π.

### 6.1 Master artboard — 1024×1024

- **Tile**: full-bleed 1024². macOS supplies the squircle mask — keep all art inside the safe area, a centered **824×824** box (inset 100px all sides, `rx=185` when drawn explicitly). Windows/png export: rounded rect `x=32 y=32 w=960 h=960 rx=220` with same fill.
- **Tile fill**: vertical linear gradient `#0B1220` (0%) → `#090D14` (100%). Subtle inner top light: 1px `rgba(255,255,255,0.06)` along the top edge. Blueprint grid inside the tile (clipped to the 824 safe area): 1px lines `rgba(120,170,220,0.05)` every 64px both axes. One static glow: radial `rgba(249,115,22,0.30)` Ø190 centered on the apex node (below) — the single point of warmth.
- **Mark geometry** (`userSpaceOnUse`):
  ```svg
  <defs>
    <linearGradient id="markGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"   stop-color="#22D3EE"/>
      <stop offset="0.5" stop-color="#3B82F6"/>
      <stop offset="1"   stop-color="#E879F9"/>
    </linearGradient>
  </defs>
  <path d="M302 292 L512 732 L722 292" fill="none"
        stroke="url(#markGrad)" stroke-width="76"
        stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="302" cy="292" r="52" fill="#22D3EE"/>
  <circle cx="722" cy="292" r="52" fill="#E879F9"/>
  <circle cx="512" cy="732" r="64" fill="#F97316"/>
  ```
  Trace spans y=292→732 (plus 38px stroke overhang each end); the V's legs sit at 30% and 70% of the width — a confident, open stance. The apex node (r=64, `#F97316`, omp's exact plug orange) is 12px larger than the upper nodes so the eye lands on the connection point.
- Mark scaled ×0.78 about (512,512) for the macOS tile (occupies ≈540×470px inside the safe area); ×1.0 for the Windows 960 rect.

### 6.2 Small sizes

- **32px**: flat `#0B1220` tile (drop grid, glow, and top light), gradient simplifies to 2 stops (`#22D3EE → #E879F9`), nodes kept (they are the distinguishing feature at dock size), apex node still orange.
- **16px**: solid `#0B1220` squircle; V reduced to a single 2px `#22D3EE` polyline (no gradient, no upper nodes); apex = 3×3 `#F97316` square. Recognizable at a glance: cyan trace, orange foot.
- **Monochrome** (Windows tray / macOS menu bar template): single-color mask of the trace + all three nodes unioned into one silhouette.

---

## 7. Brand surfaces

### 7.1 README hero banner — 1500×540 (dark, window-locked)

GitHub renders the README on both themes, so the banner is intentionally dark like omp's own hero.png — a window-locked asset, not theme-following. Modern-SaaS composition: one centered column, soft spectrum glows, a grid that fades out at the edges.

- **Background**: `#090D14`. Blueprint grid: 40px squares, 1px `rgba(120,170,220,0.055)`, full-bleed, radially masked (opaque within r=300 of center (750,270), fading to transparent by r=820).
- **Glows** (static): radial `rgba(34,211,238,0.10)` center (430,110) r=420 · radial `rgba(59,130,246,0.08)` center (1080,470) r=400 · radial `rgba(232,121,249,0.06)` center (1240,140) r=340.
- **Wordmark lockup** top-left: `visual-omp` Geist Mono 600, 20px, `#E9EEF4`, baseline y=72, x=64, followed by a static block cursor 11×20px `#22D3EE` with a 6px gap.
- **Mark**: the Circuit V (§6.1 path, no tile) scaled ×0.20, centered horizontally at x=750, top y=92 (trace occupies ≈y 92–188, upper nodes at (708,96) and (792,96), apex node (750,188) r=13). Behind the apex node only: radial `rgba(249,115,22,0.30)` Ø110, center (750,188).
- **Eyebrow**: `[ A FRIENDLY FACE FOR OMP ]` — Geist Mono 500, 13px, uppercase, letter-spacing 0.32em, `#67E8F9`, centered, baseline y=252.
- **Headline**: Geist 700, 64px, letter-spacing −0.02em, `#F2F6FA`, centered, baseline y=324: "The agent stays. The terminal goes."
- **Subline**: Geist 400, 20px, `#9DA9B8`, centered, baseline y=376: "visual-omp is a friendly desktop window around omp, the AI coding agent."
- **Feature line**: one centered group, baseline y=444 — 6px `--mark-gradient` dot + 10px gap + Geist Mono 500, 13px, uppercase, letter-spacing 0.18em, `#8B95A5`: "LIGHT BY DEFAULT · DARK TOO · EVERY OMP SUPERPOWER".
- Export: PNG @1x (1500×540) and @2x (3000×1080); no text smaller than 13px so it survives social-card downscaling.

### 7.2 App-slice mock — 1200×760 (light; dark = token swap)

One representative window slice for preview rendering. Geometry is exact; every color is a §1 token. Content: sidebar (3 projects, 5 chats), session header (title + model chip + 3 buttons), one user message, one assistant markdown reply, two collapsed tool cards, one question card with two options, composer (permission pill + send), status bar.

**Frame & chrome**

- Window 1200×760, `--bg` fill. Title bar (0,0,1200,40): `--glass` + blur over `--bg`, bottom 1px `--border`. Traffic lights Ø12 at (20,14) (36,14) (52,14) fills `#FF5F57` / `#FEBC2E` / `#28C840`. Wordmark at x=84, baseline y=26: `visual-omp` Geist Mono 600 15px `--fg` + block cursor 8×15px `--accent`, 4px gap (static). Breadcrumb centered x=600, baseline y=26: "my-shop / Fix checkout bug ⌄" 13px `--fg-muted`.
- Status bar (0,732,1200,28): `--panel`, top 1px `--border`. Left x=16, baseline y=746, Geist Mono 11px: "⎇ main" `--fg-muted` · gap 16 · "+8" `--diff-add-text` " −3" `--diff-del-text`. Right group, right edge x=1184, same baseline: "◔ 41%" `--fg-muted` (14px ring, `--accent` fill 41% arc) · gap 16 · "$0.87 today" `--fg-muted` · gap 16 · "●" 8px `--ok` + " omp 18.4.4" `--fg-muted`.

**Sidebar** (0,40,264,692): `--panel`, right 1px `--border`.

- Search field (16,56,232,32): `--bg-inset` fill, 1px `--border`, `--radius`; "🔍 Search chats…" 13px `--fg-faint` at x=28; "⌘K" Geist Mono 11px `--fg-faint` right at x=222.
- New chat row (16,96,232,36): "＋ New chat" 13px/600 `--accent` at x=28.
- Divider (16,144,232,1) `--border`.
- Eyebrow `[ PROJECTS ]` at (16,162): Geist Mono 11px, caps, +0.14em, `--fg-faint`.
- Project row **my-shop** (8,176,248,36): chevron ▾ 12px `--fg-faint` x=20 · folder icon 16px lucide 1.75px `--fg-muted` x=36 · "my-shop" 13px/600 `--fg` x=60 · pin icon 14px `--fg-faint` right x=236.
- Chat rows (8,y,248,32), status dot 8px at (30,cy−4), title 13px at x=48, time 11px `--fg-faint` right:
  - y=216 **Fix checkout bug** — active: row fill `--selected`, `--radius`, 2px `--accent` left inset bar, title `--fg` 500, dot `--ok`, "2m".
  - y=248 Styles pass — dot `--border-strong`, title `--fg-muted` 400, "1h".
  - y=280 Copy review — dot `--warn`, title `--fg-muted` 400, "3h".
- Project row **landing-page** (8,320,248,36), expanded; chat rows: y=360 Hero rework (idle dot, "1d"), y=392 SEO meta (idle dot, "2d").
- Project row **api-server** (8,432,248,36), collapsed (▸ chevron).
- Bottom nav: Home (8,648,248,36) and Settings (8,684,248,36): 16px lucide icons + 13px/500 labels, `--fg-muted`.

**Session header** (264,40,936,48): `--panel`, bottom 1px `--border`.

- "◈" 16px `--fg-muted` at (288,56); title "Fix checkout bug" 15px/600 `--fg` at x=312, baseline y=68; "✎" 12px `--fg-faint` at x=452.
- Model chip (482,52,112,24): `--accent-muted` fill, `--radius-full`, "Sonnet 4.5 ▾" 11px/600 `--accent` centered.
- Right buttons (28px h, ghost, `--fg-muted`, 13px/500, 6px icon-text gap): "↻ Restart" (964,50,106,28) · "☰ Plan" (1078,50,66,28) · "⋯" (1152,50,28,28). Hover state (not depicted): `--hover` fill, `--radius-sm`.

**Chat column** — content x=352–1112 (760px), scroll region y=88–620:

- User message: "You" label 11px/500 `--fg-muted` at (352,104), baseline y=114. Card (352,128,760,64): `--bg-inset` fill, `--radius-lg`, left 2px `--border-strong` rail, padding 12×16; text 14px/22 `--fg`, two lines: "The checkout total is wrong when a discount code is applied. Can you fix it?"
- Assistant header at y=216: Circuit V mark 20px at (352,212) + "Sonnet 4.5 · 14:33" 12px `--fg-faint` at x=380, baseline y=226.
- Assistant markdown (352,244,760,66): 14px/22 `--fg`, three lines: "Found it — the discount was applied *before* tax, so the percentage was computed on the pre-tax subtotal. I've moved the calculation after tax in `checkout/total.ts` and updated the tests." Inline code: Geist Mono 12.5px, `--accent-muted` fill, `--radius-sm`, padding 1×5, text `--accent`.
- Tool card 1 (352,326,760,40): `--panel`, 1px `--border`, `--radius-lg`, left 2px `--ok` rail. Contents baseline y=350: "▸" 12px `--fg-faint` x=368 · ✏️ 16px x=388 · "Edited 2 files" 13px/500 `--fg` x=414 · right side: "+8" Geist Mono 12px `--diff-add-text` + " −3" `--diff-del-text`, right edge x=1096.
- Tool card 2 (352,374,760,40): same chrome; "▸" + 🧪 + "Ran tests" 13px/500 `--fg`; right: "passed ✓" 12px `--ok`, right edge x=1096.
- Question card (352,428,760,188): `--panel`, 1px `--border`, `--radius-lg`, left 2px `--agent` rail, `--shadow-card`, padding 16.
  - Eyebrow `[ QUESTION ]` at (368,442), baseline y=452: Geist Mono 11px caps +0.14em `--agent`.
  - Question at (368,466), baseline y=482: "Apply the same fix to the cart page too?" 14px/20 `--fg`.
  - Option A (368,496,356,56): `--bg-inset` fill, 1px `--accent` border (selected), `--radius`; radio circle Ø16 at (384,516) — `--accent` fill with white check; "Yes — same calculation there" 13px/500 `--fg` at x=412, baseline y=524; `Recommended` chip (584,508,108,20): `--accent` fill, `--radius-full`, 11px/600 `--accent-fg`.
  - Option B (740,496,356,56): `--panel` fill, 1px `--border-strong`, `--radius`; radio Ø16 at (756,516) — 1.5px `--border-strong` outline, empty; "No — checkout only" 13px/500 `--fg` at x=784, baseline y=524.
  - Footer: [ Skip ] ghost (940,568,56,32) `--fg-muted` · [ Answer → ] primary (1004,568,92,32): `--accent` fill + §1.9 primary depth, `--accent-fg` 13px/600, `--radius`.

**Composer** (352,620,760,96): `--panel`, 1px `--border-strong`, `--radius-xl`, `--shadow-composer`.

- Placeholder at (368,634), baseline y=650: "Ask visual-omp to change something…" 14px `--fg-faint`; "⌘↵" Geist Mono 11px `--fg-faint` right at x=1052.
- Bottom row y=676–704: "＋" ghost icon button (368,676,28,28) `--fg-muted` · permission pill (404,676,96,28): `--hover` fill, `--radius-full`, 1px `--border`, "Auto ▾" 12px/500 `--fg` centered · flexible space · context ring 20px at (1000,680) (track `--border-strong`, 41% arc `--accent`) · send button (1056,676,32,32): `--accent` fill + §1.9 primary depth, `--radius`, "➤" 14px `--accent-fg` centered.

**Dark variant**: identical geometry; all fills/borders/text swap to §1 dark tokens; shadows become the dark values; the title-bar glass is `rgba(15,22,34,0.72)`; traffic lights unchanged.

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
