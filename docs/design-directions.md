# visual-omp — Three Visual Directions

Three complete, mutually exclusive visual languages for visual-omp. Each inherits selectively from omp's DNA and transforms it — none copies the π-gradient-on-black hero look. Everything below is exact: hex values, measured WCAG 2.2 contrast ratios, SVG coordinates, spacing. All three keep the functional layout, screens, and microcopy of DESIGN.md §3–§4/§8 unchanged, and all use the same Tailwind v4 token names as DESIGN.md §1 — only values change.

## At a glance

| | **1 · Warm Ledger** | **2 · Signal Grid** | **3 · Soft Machine** |
|---|---|---|---|
| Temperature | Warm paper, ink, orange | Cool slate, blueprint cyan | Soft lavender, violet-pink |
| Primary accent | Plug Orange `#C2410C` | Signal Cyan `#0E7490` | Orb Violet `#6D28D9` |
| Geometry | Small radii (3–10px), solid 1px rules | Near-square (2–8px), hairlines, no shadows | Large radii (8–24px), borderless, soft shadows |
| Type voice | Editorial grotesk + typewriter mono | Engineered geometric + squared mono | Friendly geometric + rounded mono |
| Working indicator | Pencil underline sweep | Crawling dashed outline | Three bouncing gradient dots |
| Personality | A calm desk ledger | An instrument panel | A helpful companion |

---

# Direction 1 — Warm Ledger

## 1.1 Concept

A well-kept desk ledger: warm paper, dark ink, and one orange thread running through it — the exact orange of omp's plug connector, promoted from a detail to the voice of the whole app. Where omp glows neon on black, visual-omp sits quietly in daylight; the machine does its work *on the page*, and the orange pencil underline tells you it's thinking. Editorial restraint (small radii, solid ruled lines, near-flat elevation) makes it feel like a tool you'll trust with real work, while the warmth keeps it welcoming to people who have never opened a terminal.

**Inherits from omp**
- The plug-orange `#F97316` from omp's icon — here it *is* the brand (omp uses it as a 20-pixel detail; visual-omp builds the palette around it).
- The mono-caps bracket style `[ LABEL ]` for eyebrows and status readouts.
- Dot-led status language (`● live`, `○ idle`) and shape+color status pairing.

**Deliberately different from omp**
- Warm paper chassis instead of true-black/cool-gray; light mode is obviously the home theme.
- Orange leads; omp's magenta/violet/cyan triad is gone from the UI (violet survives only as the muted `--agent` role).
- Solid ruled hairlines and near-zero shadow, versus omp's alpha hairlines and glowing elevation.

## 1.2 Palette

**Light (default)** — measured on `--panel #FBF9F5`:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#EFEAE0` | window ground, warm paper |
| `--panel` | `#FBF9F5` | sidebar, cards, composer |
| `--bg-inset` | `#F4F0E8` | code blocks, sunken inputs |
| `--fg` | `#211C16` | **16.1:1** on panel |
| `--fg-muted` | `#6B6053` | **5.8:1** on panel |
| `--fg-faint` | `#776D5E` | **4.8:1** on panel |
| `--accent` | `#C2410C` | **4.9:1** on panel — Ledger Orange |
| `--accent-hover` | `#9A3412` | white on it 7.3:1 |
| `--accent-fg` | `#FFFFFF` | **5.2:1** on `--accent` |
| `--accent-muted` | `#FCEFDF` | accent text on it 4.6:1 |
| `--accent-2` | `#0F766E` | teal — info/secondary, 5.2:1 on panel |
| `--agent` | `#7E22CE` | plum — agent presence, 6.6:1 on panel |
| `--ok` | `#15803D` | 4.8:1 on panel |
| `--warn` | `#A16207` | 4.7:1 on panel |
| `--err` | `#B42318` | 6.3:1 on panel |
| `--border` | `#E5DDCE` | solid ruled line, 1px |
| `--border-strong` | `#CFC4AF` | inputs, interactive outlines |
| `--ring` | `#9A3412` | **7.0:1** on panel (≥3:1 ✓) |

**Dark** — measured on `--panel #1E1A15`:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#171310` | warm near-black, never pure black |
| `--panel` | `#1E1A15` | |
| `--bg-inset` | `#1A1611` | |
| `--fg` | `#F1EBE0` | **14.6:1** |
| `--fg-muted` | `#AEA294` | **6.9:1** |
| `--fg-faint` | `#8D8271` | **4.6:1** |
| `--accent` | `#F97316` | omp's exact plug orange — **6.2:1** on panel |
| `--accent-hover` | `#FB923C` | |
| `--accent-fg` | `#261304` | **6.4:1** on `--accent` |
| `--accent-muted` | `#3A2412` | accent text on it 5.2:1 |
| `--accent-2` | `#5EEAD4` | 11.7:1 on panel |
| `--agent` | `#C084FC` | 6.6:1 on panel |
| `--ok` | `#4ADE80` | 9.9:1 |
| `--warn` | `#FBBF24` | 10.4:1 |
| `--err` | `#F87171` | 6.3:1 |
| `--border` | `#352D23` | |
| `--border-strong` | `#4E4334` | |
| `--ring` | `#FB923C` | **8.2:1** on `--bg` (≥3:1 ✓) |

**Brand gradient** (mark, working indicator, empty-state art only):
`--mark-gradient: linear-gradient(135deg, #EA580C 0%, #F97316 52%, #FBBF24 100%)` — ember → plug-orange → amber. Feature color: **Plug Orange `#F97316`**.

## 1.3 Typography

| Role | Family | Package |
|---|---|---|
| UI + wordmark | **Instrument Sans** (variable, 400–700) | `@fontsource-variable/instrument-sans` (OFL) |
| Mono | **IBM Plex Mono** (400, 500, 600) | `@fontsource/ibm-plex-mono` (OFL) |

No third family: Instrument Sans at 700 with −0.01em tracking covers display duties. Scale per DESIGN.md §2.2 unchanged.

**Wordmark**: lowercase `visual-omp`, Instrument Sans 650, tracking −0.01em; the whole word in `--fg` **except the hyphen, set in `--accent`** — the orange thread in miniature. Never uppercase, never gradient.

## 1.4 Logo mark — "The Plugged Window"

A rounded window frame (the GUI — what visual-omp *is*) with a live text caret inside, and omp's own plug connector docked on its right rail. The π is retired; the plug — omp's friendliest, least literal asset — carries the lineage.

**1024×1024 artboard, light version** (ink `#262019` on transparent):

```svg
<defs>
  <linearGradient id="ledgerGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#EA580C"/>
    <stop offset="0.52" stop-color="#F97316"/>
    <stop offset="1" stop-color="#FBBF24"/>
  </linearGradient>
</defs>
<!-- window frame -->
<rect x="192" y="232" width="560" height="560" rx="120"
      fill="none" stroke="#262019" stroke-width="68"/>
<!-- text line inside window -->
<rect x="310" y="440" width="220" height="52" rx="26" fill="#262019" opacity="0.28"/>
<!-- live caret, gradient -->
<rect x="310" y="524" width="56" height="160" rx="28" fill="url(#ledgerGrad)"/>
<!-- omp plug, docked on right rail (rail centerline x=752) -->
<rect x="690" y="566" width="124" height="96" rx="22" fill="#F97316"/>
<rect x="722" y="590" width="14" height="48" rx="7" fill="#262019"/>
<rect x="768" y="590" width="14" height="48" rx="7" fill="#262019"/>
```

Dark version: ink strokes become `#F1EBE0`; plug and gradient unchanged.

**macOS app-icon tile**: 824×824 body at inset 100 on the 1024 canvas, `rx="185"`. Fill: vertical gradient `#FBF7EF → #F0E9DB`; 1px inner stroke `rgba(38,32,25,0.08)`. Mark group scaled ×0.72 about (512,512). Windows tile: same mark on a rounded-square (rx 20%) `#FBF9F5` tile.

**Relation to omp**: keeps the plug exactly (shape language, prongs, orange) and omp's decorative-dot warmth in the gradient; replaces the π (a CLI glyph) with a window + caret (a GUI glyph) — same family, next generation.

## 1.5 UI character

- **Radii**: `--radius-sm 3px` · `--radius 5px` · `--radius-lg 8px` · `--radius-xl 10px` · `--radius-full 999px`.
- **Borders**: solid 1px `--border` everywhere panels meet; `--border-strong` on inputs and interactive outlines. No alpha borders — the "ruled page" look depends on opaque lines.
- **Shadows**: near-flat. `--shadow-card: 0 1px 2px rgba(62,50,32,0.07)` · `--shadow-pop: 0 6px 20px rgba(62,50,32,0.10)` · `--shadow-overlay: 0 20px 48px rgba(62,50,32,0.14)`. Dark: same geometry, `rgba(0,0,0,0.5/0.55/0.65)`.
- **Density**: roomy — control heights 28/34/40, list rows 38px, card padding 18px, chat gap 28px.
- **Iconography**: lucide at **1.5px stroke**, round caps and joins, 16px default (18px in headers). Thin strokes match the editorial voice; never filled.
- **Motion**: unhurried, paper-like. `--dur-fast 160ms` · `--dur 240ms` · `--dur-slow 320ms`, all `cubic-bezier(0.22,1,0.36,1)`. Opacity + ≤2px translate only; no springs, no scale.
- **Working indicator — "the pencil line"**: beneath the active tab title and the session-header title sits a 2px baseline in `--accent` at 25% opacity; while the agent works, a 32px fully-opaque `--accent` segment sweeps left→right across it, 1400ms `cubic-bezier(0.65,0,0.35,1)` infinite — someone underlining a line in a ledger. The status bar shows mono `working` with a stepped ellipsis (`"" → . → .. → ...`, 400ms steps). Reduced motion: static 40%-opacity baseline; ellipsis frozen at `…`.

## 1.6 Hero banner (1500×540)

- **Ground**: `#F6F1E8`, with ruled ledger lines — 1px `#E7DECE` horizontal rules every 36px full-bleed, and one 2px vertical margin rule in `#E5A076` at x=190.
- **Text block** starts x=254 (right of the margin rule): eyebrow `[ A FRIENDLY FACE FOR OMP ]` IBM Plex Mono 20px, tracking 0.14em, `#776D5E`, baseline y=150. Headline (Instrument Sans 700, 84px, lh 1.02, `#262019`, y=190–380): "Your AI agent, / plain as paper." Subline (24px, `#6B6053`, y=420): "visual-omp wraps the omp agent in a calm desktop app — no terminal required." Dot-led feature line (18px, y=480): `● Projects  ● Chats  ● Approvals`, dots `#C2410C`, text `#211C16`.
- **Right**: the Plugged Window mark at 330px, centered at (1215, 270), soft shadow `0 24px 48px rgba(60,45,20,0.12)`; plug faces the headline like it's plugging into the page.
- **Distinct from omp's hero**: daylight instead of neon, paper rules instead of a tech grid, an orange caret instead of a glowing π, and zero corner brackets — omp's own signature left behind deliberately.

## 1.7 Mini mock — 1200×760 slice

Geometry per the shared wireframe in §W below. Warm Ledger styling:

| Element | Style |
|---|---|
| Window | `--bg`; titlebar 40px `--panel`, bottom 1px `--border`; wordmark per §1.3, 15px/650 |
| Sidebar | `--panel`, right 1px `--border`; search field `--bg-inset` fill, 1px `--border-strong`, r5, placeholder `--fg-faint`; New chat row: `--accent` text 13px/600, hover `--accent-muted` fill |
| Project rows | 13px/600 `--fg`, folder icon `--fg-muted` 1.5px; chat rows 13px/400 `--fg-muted`, status dot 8px (live `--ok`, idle `--border-strong`, needs-input `--warn`); active chat: `--selected`-style `#F0E9DB` fill, r5, 2px `--accent` left bar, text `--fg` 500 |
| Eyebrow `PROJECTS` | IBM Plex Mono 11px, caps, +0.14em, `--fg-faint`, bracketed |
| Session header | `--panel`, bottom 1px `--border`; title 15px/650 `--fg`; model chip `--accent-muted` fill, `--accent` text 11px/600, r999, h24; buttons ghost 28px, `--fg-muted` icon+label, hover `--bg-inset`, r5 |
| User bubble | right-aligned, `--accent-muted` fill, **no border**, r8 with bottom-right corner 3px, text 14px/22 `--fg`, padding 12×16 |
| Assistant reply | no container — markdown directly on `--bg`; body 14px/22 `--fg`; inline code IBM Plex Mono 12.5px, `--bg-inset` fill, 1px `--border`, r3, padding 1×5 |
| Tool cards | `--panel` fill, 1px `--border`, r8, h40, padding 0×14; left: chevron `--fg-faint` + icon `--fg-muted`; summary 13px/500 `--fg`; right meta IBM Plex Mono 12px — `+8` `--ok`, `−3` `--err`; "passed ✓" `--ok` |
| Question card | `--panel`, 1px `--border-strong`, r10, `--shadow-card`; title 14px/600; option rows h48, 1px `--border`, r8, radio circle 16px 1.5px `--border-strong`; Recommended chip `--accent` fill, `--accent-fg` text, r999, 11px/600; hovered option: `--bg-inset` fill + border `--accent` |
| Composer | `--panel`, 1px `--border-strong`, r10, `--shadow-card`; placeholder `--fg-faint` 14px; permission pill `--bg-inset`, 1px `--border`, r999, 12px/500 `--fg-muted`, leading `◆` in `--accent`; send button 36px circle `--accent` fill, `--accent-fg` ↑ icon 1.5px→2px stroke, hover `--accent-hover` |
| Status bar | `--panel`, top 1px `--border`; IBM Plex Mono 11px `--fg-muted`; `+8 −3` in `--ok`/`--err`; connection dot `--ok` + `--fg-muted` text |

Dark theme: same geometry; every fill/border/shadow swaps to the dark token values; the user bubble becomes `--accent-muted` dark fill with `--accent` text.

---

# Direction 2 — Signal Grid

## 2.1 Concept

An instrument panel for the agent age: cool slate surfaces, blueprint grid discipline, and cyan as the color of action. Signal Grid takes omp's terminal heritage the most seriously of the three — mono type, dashed "crawling ants", coordinate annotations — but civilizes it: high-contrast ink, generous AA margins, square-cornered cards that snap to an 8px grid. Where omp's UI glows like a nightclub, Signal Grid reads like avionics: everything labeled, everything measured, nothing decorative. It is the most technical of the three directions and the closest cousin to omp — transformed by a light-first chassis and a cyan-led hierarchy that omp reserves for information only.

**Inherits from omp**
- The cyan→violet→magenta spectrum, re-sequenced into a cyan→blue→fuchsia gradient (omp's stops reversed and blue-shifted).
- Terminal mechanics as texture: block cursor, dashed-outline "ants", mono annotations, bracket labels.
- omp's alpha-free flatness and `cubic-bezier(0.16,1,0.3,1)` entrance ease.

**Deliberately different from omp**
- Cyan is the *primary action color* (omp: pink action, cyan info) — a full role inversion.
- Light mode is a cool daylight slate; dark mode is blue-black `#0A1017`, never true black.
- Magenta is demoted to `--agent` (AI presence) only; no pink buttons anywhere.
- Square geometry (2–8px radii) vs omp's soft 6–16px scale.

## 2.2 Palette

**Light (default)** — measured on `--panel #FFFFFF`:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#EEF1F4` | cool slate ground |
| `--panel` | `#FFFFFF` | |
| `--bg-inset` | `#F4F6F8` | |
| `--fg` | `#10151C` | **18.3:1** |
| `--fg-muted` | `#4B5866` | **7.3:1** |
| `--fg-faint` | `#67737F` | **4.8:1** |
| `--accent` | `#0E7490` | **5.4:1** on panel — Signal Cyan (deep) |
| `--accent-hover` | `#155E75` | white on it 7.4:1 |
| `--accent-fg` | `#FFFFFF` | **5.4:1** on `--accent` |
| `--accent-muted` | `#DFF1F7` | accent text on it 4.6:1 |
| `--accent-2` | `#2563EB` | electric blue — secondary action, 5.2:1 |
| `--agent` | `#C026D3` | fuchsia — agent presence, 4.7:1 |
| `--ok` | `#047857` | 5.5:1 |
| `--warn` | `#B45309` | 5.0:1 |
| `--err` | `#DC2626` | 4.8:1 |
| `--border` | `#DCE3EA` | 1px hairlines |
| `--border-strong` | `#BCC8D4` | inputs, outlines |
| `--ring` | `#0891B2` | **3.7:1** on panel (≥3:1 ✓) |

**Dark** — measured on `--panel #101823`:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#0A1017` | blueprint black-blue |
| `--panel` | `#101823` | |
| `--bg-inset` | `#0C141E` | |
| `--fg` | `#E9EEF4` | **15.3:1** |
| `--fg-muted` | `#9DA9B8` | **7.5:1** |
| `--fg-faint` | `#7B8A9C` | **5.1:1** |
| `--accent` | `#22D3EE` | **9.9:1** on panel |
| `--accent-hover` | `#67E8F9` | |
| `--accent-fg` | `#062832` | **8.6:1** on `--accent` |
| `--accent-muted` | `#10303C` | accent text on it 7.7:1 |
| `--accent-2` | `#60A5FA` | 7.0:1 |
| `--agent` | `#E879F9` | 7.3:1 |
| `--ok` | `#34D399` | 9.3:1 |
| `--warn` | `#FBBF24` | 10.7:1 |
| `--err` | `#F87171` | 6.5:1 |
| `--border` | `#1F2C3C` | |
| `--border-strong` | `#35485E` | |
| `--ring` | `#22D3EE` | **10.6:1** on `--bg` (≥3:1 ✓) |

**Brand gradient**: `--mark-gradient: linear-gradient(120deg, #22D3EE 0%, #3B82F6 50%, #E879F9 100%)` — cyan → blue → fuchsia. Feature color: **Signal Cyan `#22D3EE`** (dark) / **`#0E7490`** (light).

## 2.3 Typography

| Role | Family | Package |
|---|---|---|
| UI + display | **Space Grotesk** (variable, 400–700) | `@fontsource-variable/space-grotesk` (OFL) |
| Mono | **Geist Mono** (variable, 400–600) | `@fontsource/geist-mono` (OFL) |

Space Grotesk's engineered geometry carries both UI and headings; Geist Mono's squared terminals match the grid. Scale per DESIGN.md §2.2; base UI size may drop to 12.5px for the compact density.

**Wordmark**: `visual-omp` in Geist Mono 600, lowercase, tracking 0, `--fg` — followed by a **solid block cursor** (0.55em × 1em, `--accent` fill, static in the title bar, blinking 1s steps in the hero). The wordmark *is* a command line.

## 2.4 Logo mark — "Circuit V"

A V for *visual*, drawn as a circuit trace with node dots at its vertices — the apex node is omp's plug-orange, the point where the visual layer connects to the omp engine.

**1024×1024 artboard** (for dark tile; standalone light version uses `--fg #10151C` trace):

```svg
<defs>
  <linearGradient id="gridGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#22D3EE"/>
    <stop offset="0.5" stop-color="#3B82F6"/>
    <stop offset="1" stop-color="#E879F9"/>
  </linearGradient>
</defs>
<!-- the trace -->
<path d="M302 292 L512 732 L722 292" fill="none"
      stroke="url(#gridGrad)" stroke-width="76"
      stroke-linecap="round" stroke-linejoin="round"/>
<!-- vertex nodes -->
<circle cx="302" cy="292" r="52" fill="#22D3EE"/>
<circle cx="722" cy="292" r="52" fill="#E879F9"/>
<circle cx="512" cy="732" r="64" fill="#F97316"/>  <!-- omp orange apex -->
```

**macOS app-icon tile**: 824×824 at inset 100, `rx="185"`. Fill: vertical gradient `#0A1017 → #0E1A26`. Clipped blueprint grid inside the tile: 1px lines `rgba(103,163,209,0.07)` every 64px both axes. Behind the apex node, a radial halo `rgba(249,115,22,0.35)`, 190px diameter, centered (512,732)·0.78-offset. Mark scaled ×0.78 about (512,512).

**Relation to omp**: the orange apex dot is the direct descendant of omp's orange plug and its decorative orange dots — the connector point of the system; the gradient trace re-sequences omp's three stops instead of repeating them.

## 2.5 UI character

- **Radii**: `--radius-sm 2px` · `--radius 4px` · `--radius-lg 6px` · `--radius-xl 8px` · `--radius-full 999px` (pills only).
- **Borders**: 1px solid `--border` as the *only* separation between panels — no shadows on cards at all; hierarchy comes from the grid. `--border-strong` on inputs and interactive outlines.
- **Shadows**: `--shadow-card: none` · `--shadow-pop: 0 4px 16px rgba(10,20,32,0.12)` (dark: `rgba(0,0,0,0.6)`) + 1px `--border-strong` on the popover itself · `--shadow-overlay: 0 16px 40px rgba(10,20,32,0.18)` (dark: `rgba(0,0,0,0.7)`).
- **Density**: compact — control heights 26/28/32, list rows 32px, card padding 12px, chat gap 20px.
- **Iconography**: lucide at **2px stroke with square line-caps** (`stroke-linecap="square"`), 16px everywhere; no filled variants. Icons align to the 4px grid, optical corrections forbidden — the grid wins.
- **Motion**: fast and mechanical. `--dur-fast 90ms` · `--dur 140ms` · `--dur-slow 200ms`, `cubic-bezier(0.3,0,0.2,1)` (near-linear). No springs, no overshoot; things switch more than they move.
- **Working indicator — "crawling ants"**: the active tool card and the composer frame get a 1px dashed outline (`stroke: --accent; stroke-dasharray: 5 4`) whose `stroke-dashoffset` animates 0→−18 over 900ms, linear, infinite — the classic selection-marquee, signaling "the machine is on this." The status bar shows a blinking block cursor (12×16px, `--accent` fill, 1s `steps(1)`). Reduced motion: static dashes, solid cursor.

## 2.6 Hero banner (1500×540)

- **Ground**: `#0A1017` with a blueprint grid — 1px `rgba(103,163,209,0.08)` every 40px, major lines `rgba(103,163,209,0.14)` every 200px; four 24px registration crosses (`#33485E`) at the corners, inset 32px.
- **Mark**: Circuit V at 360px tall, centered at (1130, 260); only the orange apex node glows (radial halo `rgba(249,115,22,0.35)`, 190px). Thin 1px cyan leader lines run from the two upper nodes to mono annotation labels in `#7B8A9C` 14px Geist Mono: `input: intent` (left node) and `output: working software` (right node).
- **Text block** x=110: eyebrow `[ SIGNAL / VISUAL-OMP ]` Geist Mono 18px, `#67E8F9`, tracking 0.2em, y=128. Headline Space Grotesk 700, 76px, `#E9EEF4`, y=170–350: "The agent stays. / The terminal goes." Feature row (Geist Mono 16px, `#9DA8B8`, cyan slashes, y=430): `projects / chats / diffs / approvals`. Status readout (Geist Mono 14px, y=496): `● connected — omp 18.4.4`, dot `#34D399`. Wordmark top-right (x≈1230, y=72): `visual-omp` Geist Mono 24px `#E9EEF4` + block cursor `#22D3EE`.
- **Distinct from omp's hero**: omp centers one glowing magenta π on a black grid; Signal Grid puts a cyan trace-diagram off-center right with *annotations*, white-on-blueprint text, and a single point of orange heat. Same universe, different instrument.

## 2.7 Mini mock — 1200×760 slice

Geometry per §W (with compact-density deltas noted). Signal Grid styling:

| Element | Style |
|---|---|
| Window | `--bg`; titlebar `--panel`, bottom 1px `--border`; wordmark per §2.3, 15px |
| Sidebar | `--panel`, right 1px `--border`; search `--bg-inset`, 1px `--border-strong`, r4, mono placeholder; New chat: `--accent` text 13px/600, hover `--accent-muted` |
| Project rows | 12.5px/600 `--fg`; chat rows 12.5px/400 `--fg-muted`, 32px tall; status dots 8px square-ish (r2 — squares, not circles: the grid voice); active chat: `--accent-muted` fill, r4, text `--accent` 600, no left bar |
| Eyebrow | Geist Mono 11px caps +0.14em `--fg-faint`, bracketed |
| Session header | `--panel`, 1px bottom border; title 15px/700 Space Grotesk; model chip `--accent-muted`, `--accent` text 11px/600 Geist Mono, r2, h24; buttons 28px ghost, `--fg-muted`, hover 1px `--border-strong` outline + `--bg-inset` |
| User bubble | right-aligned, `--bg-inset` fill, 1px `--border-strong`, r4 (all corners equal), 14px/21 `--fg`, padding 11×14 |
| Assistant reply | on `--bg`; body 14px/21; inline code Geist Mono 12.5px, `--accent-muted` fill, r2, padding 1×5, text `--accent` |
| Tool cards | `--panel`, 1px `--border`, r4, h36, padding 0×12; summary 12.5px/500; meta Geist Mono 12px: `+8` `--ok`, `−3` `--err`, "passed ✓" `--ok`; active/working card gets the crawling-ants outline instead of `--border` |
| Question card | `--panel`, 1px `--border-strong`, r6; title 14px/600; options h44, 1px `--border`, r4, square radio 14px (1.5px `--border-strong`); Recommended chip: `--accent` fill, `--accent-fg` text, r2, 11px/600 mono caps; hover: border `--accent` |
| Composer | `--panel`, 1px `--border-strong`, r6; while working, frame becomes ants-outline; permission pill `--bg-inset`, 1px `--border`, r2, Geist Mono 11px/500 `--fg-muted`, leading `◆` `--accent`; send 32×32 r4 `--accent` fill, `--accent-fg` ↑ icon 2px, hover `--accent-hover` |
| Status bar | `--panel`, top 1px `--border`; Geist Mono 11px `--fg-muted`; `+8 −3` in `--ok`/`--err`; block cursor indicator right of `working` when active |

Dark theme: identical geometry; tokens swap; the ants outline and cursor glow slightly (shadow `0 0 6px rgba(34,211,238,0.35)`).

---

# Direction 3 — Soft Machine

## 3.1 Concept

The friendly one: a soft, rounded, lavender-lit workspace where the agent feels like a helpful companion rather than a process. Soft Machine is built for the non-technical user first — big touch targets, pillowy cards, gentle spring motion, and status you can read from across the room. Its brand story is *the meeting point*: two orbs — you and the machine — overlapping to make something warm (the overlap is omp's plug-orange). Of the three directions it travels farthest from omp's look while keeping omp's magenta-violet heart, extended into orange. It risks feeling consumer-y; disciplined type sizes and strict 8px spacing keep it a work tool, not a toy.

**Inherits from omp**
- The magenta/violet core of omp's gradient — re-anchored to violet and extended into plug-orange.
- The plug-orange itself, as the literal *product* of the brand metaphor (the overlap).
- Shape+color status pairing; the bracket label (used even more sparingly — settings only).

**Deliberately different from omp**
- Borderless, shadow-built elevation vs omp's hairline-built flatness.
- Large radii (up to 24px) vs omp's 6–16px.
- Violet leads, pink supports, cyan *becomes the agent color* (role swap: `--agent` = cyan).
- Spring motion and scale entrances — motion omp never uses.

## 3.2 Palette

**Light (default)** — measured on `--panel #FFFFFF`:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#F6F5FA` | soft lavender-gray |
| `--panel` | `#FFFFFF` | |
| `--bg-inset` | `#F3F2F9` | |
| `--fg` | `#251F33` | **15.9:1** |
| `--fg-muted` | `#5C5470` | **7.1:1** |
| `--fg-faint` | `#767088` | **4.7:1** |
| `--accent` | `#6D28D9` | **7.1:1** on panel — Orb Violet |
| `--accent-hover` | `#5B21B6` | white on it 9.0:1 |
| `--accent-fg` | `#FFFFFF` | **7.1:1** on `--accent` |
| `--accent-muted` | `#F0EAFC` | accent text on it 6.1:1 |
| `--accent-2` | `#DB2777` | orchid pink — secondary, 4.6:1 |
| `--agent` | `#0E7490` | cyan — agent presence (role swap), 5.4:1 |
| `--ok` | `#15803D` | 5.0:1 |
| `--warn` | `#B45309` | 5.0:1 |
| `--err` | `#DC2626` | 4.8:1 |
| `--border` | `#E9E6F2` | used sparingly; shadows separate |
| `--border-strong` | `#D3CDE4` | inputs only |
| `--ring` | `#7C3AED` | **5.7:1** on panel (≥3:1 ✓) |

**Dark** — measured on `--panel #1C1728`:

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#14101D` | deep plum, never black |
| `--panel` | `#1C1728` | |
| `--bg-inset` | `#181226` | |
| `--fg` | `#EFEBF8` | **14.9:1** |
| `--fg-muted` | `#ACA4C2` | **7.4:1** |
| `--fg-faint` | `#8B82A1` | **4.8:1** |
| `--accent` | `#A78BFA` | **6.4:1** on panel |
| `--accent-hover` | `#C4B5FD` | |
| `--accent-fg` | `#22123F` | **6.3:1** on `--accent` |
| `--accent-muted` | `#2E2450` | accent text on it 5.2:1 |
| `--accent-2` | `#F472B6` | 6.6:1 |
| `--agent` | `#67E8F9` | 12.1:1 |
| `--ok` | `#4ADE80` | 10.0:1 |
| `--warn` | `#FBBF24` | 10.5:1 |
| `--err` | `#FB7185` | 6.5:1 |
| `--border` | `#2A2340` | |
| `--border-strong` | `#453A66` | |
| `--ring` | `#A78BFA` | **6.9:1** on `--bg` (≥3:1 ✓) |

**Brand gradient**: `--mark-gradient: linear-gradient(135deg, #8B5CF6 0%, #EC4899 55%, #FB923C 100%)` — violet → pink → plug-orange. Feature color: **Orb Violet `#8B5CF6`**.

## 3.3 Typography

| Role | Family | Package |
|---|---|---|
| UI + display | **Sora** (variable, 400–800) | `@fontsource-variable/sora` (OFL) |
| Mono | **JetBrains Mono** (variable, 400–600) | `@fontsource-variable/jetbrains-mono` (OFL) |

Sora's geometric-but-soft letterforms keep screens friendly at small sizes and warm at headline sizes; JetBrains Mono's rounded italics aside, its plain romans read gently in diffs. Scale per DESIGN.md §2.2, with base chat size 14.5px for extra legibility.

**Wordmark**: lowercase `visual-omp`, Sora 700, tracking −0.02em; `visual` in `--fg`, `omp` in the mark gradient (background-clip text). The only place gradient text is allowed in the entire UI.

## 3.4 Logo mark — "Twin Orbs"

Two soft circles — you and the agent — overlapping; the overlap is omp-orange with a white spark: what the collaboration produces. No letterform, no π, no terminal reference.

**1024×1024 artboard**:

```svg
<defs>
  <clipPath id="orbA"><circle cx="420" cy="470" r="210"/></clipPath>
  <linearGradient id="orbGrad" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#8B5CF6"/>
    <stop offset="1" stop-color="#EC4899"/>
  </linearGradient>
</defs>
<!-- orb A: you -->
<circle cx="420" cy="470" r="210" fill="#8B5CF6"/>
<!-- orb B: the agent -->
<circle cx="604" cy="554" r="210" fill="#EC4899"/>
<!-- the overlap: what we make together (omp orange) -->
<circle cx="604" cy="554" r="210" fill="#FB923C" clip-path="url(#orbA)"/>
<!-- the spark, centered in the lens -->
<path d="M512 452 C524 492 532 500 572 512 C532 524 524 532 512 572
         C500 532 492 524 452 512 C492 500 500 492 512 452 Z"
      fill="#FFFFFF"/>
```

(For one-color contexts the two orbs may merge into `url(#orbGrad)` — gradient def above — with the overlap and spark unchanged.)

**macOS app-icon tile**: 824×824 at inset 100, `rx="185"`. Fill: vertical gradient `#FBFAFE → #F1EDFA`; 1px inner stroke `rgba(76,55,140,0.06)`; mark scaled ×0.80 about (512,512), soft shadow under the mark group `0 12px 28px rgba(76,55,140,0.15)`. Dark tile: `#1C1728 → #231B33` fill, mark unchanged.

**Relation to omp**: magenta + violet are omp's gradient heart, orange is omp's plug; the mark literally *computes* the orange from the meeting of the other two — the same ingredients, a new chemistry. No π, no grid, no neon.

## 3.5 UI character

- **Radii**: `--radius-sm 8px` · `--radius 12px` · `--radius-lg 18px` · `--radius-xl 24px` · `--radius-full 999px`.
- **Borders**: mostly none — surfaces separate by fill steps and shadow. Borders only on inputs (`--border-strong`) and the status bar (`--border`).
- **Shadows**: soft and diffuse, plum-tinted. `--shadow-card: 0 2px 10px rgba(76,55,140,0.08)` · `--shadow-pop: 0 10px 30px rgba(76,55,140,0.13)` · `--shadow-overlay: 0 24px 60px rgba(76,55,140,0.18)`. Dark: `rgba(0,0,0,0.35/0.45/0.55)`.
- **Density**: spacious — control heights 32/36/42, list rows 40px, card padding 20px, chat gap 28px.
- **Iconography**: lucide at **2px stroke, round caps, drawn at 18px** (slightly larger than default for friendliness); active sidebar/nav items switch the same glyph to `fill: currentColor; stroke: none` — the only filled icons in the system.
- **Motion**: gentle springs. Popovers/tooltips `--dur 260ms` `cubic-bezier(0.34,1.4,0.64,1)`; entrances fade + scale 0.97→1 over 220ms; sheets 380ms. Everything decelerates softly; nothing snaps.
- **Working indicator — "thinking dots"**: three 7px dots in a row, colored `#8B5CF6`, `#EC4899`, `#FB923C` (the mark gradient, left to right), each animating translateY 0→−4px→0 over 900ms with a 150ms stagger, infinite. They replace the send arrow while the agent works, sit beside the session title in the sidebar and tab, and appear in the status bar. Reduced motion: opacity-only pulse (1.6s), no translation.

## 3.6 Hero banner (1500×540)

- **Ground**: diagonal gradient `#FBFAFE → #F4F0FC`, with three soft radial color fields: violet `rgba(139,92,246,0.18)` Ø640 at (1150,140); pink `rgba(236,72,153,0.16)` Ø600 at (1350,420); orange `rgba(251,146,60,0.14)` Ø520 at (980,460). No grid, no lines — pure light.
- **Left**: Twin Orbs mark at 300px, centered (300, 280), shadow `0 16px 40px rgba(76,55,140,0.15)`. Wordmark above it (x=64, y=84): `visual-omp` Sora 700 28px per §3.3.
- **Text block** x=560: headline Sora 700, 64px, lh 1.05, `#251F33`, y=170–330: "Finally, a friendly face / for your coding agent." Subline 22px `#5C5470`, y=356: "visual-omp — the power of omp, the calm of a desktop app." Chip row (y=430, h40, r999, white fill, 1px `#E9E6F2`, `--shadow-card`, 14px/500 `#5C5470`, padding 0×18, 12px gaps): "No commands to learn" · "Approvals in one click" · "Every project in one window".
- **Distinct from omp's hero**: light, soft, and round where omp is dark, sharp, and gridded; an emblem of two equals meeting instead of one machine glyph glowing; plain sentences instead of bracketed mono. The family resemblance is in the hues only.

## 3.7 Mini mock — 1200×760 slice

Geometry per §W (with spacious-density deltas noted). Soft Machine styling:

| Element | Style |
|---|---|
| Window | `--bg`; titlebar transparent over `--bg` (no border — the first shadow-free surface); wordmark per §3.3, 15px/700 |
| Sidebar | `--panel`, **no border** — separated by `--shadow-card` cast right; search `--bg-inset`, no border, r999 (pill search), placeholder `--fg-faint`; New chat: `--accent` text 13px/600, hover `--accent-muted`, r12 |
| Project rows | 13px/600 `--fg`; chat rows 13px/400 `--fg-muted`, 40px tall, r12; status dots 10px circles with 2px `--panel` ring; active chat: `--accent-muted` fill, text `--accent` 600, folder icon switches to filled variant |
| Eyebrow | JetBrains Mono 11px caps +0.14em `--fg-faint` (brackets omitted — Soft Machine drops the bracket habit outside settings) |
| Session header | `--panel` floating card look: actually inset into `--bg` with bottom `--shadow-card`, r0; title 15px/700; model chip `--accent-muted`, `--accent` text 11px/600, r999, h26; buttons 30px ghost `--fg-muted`, hover `--bg-inset` r10 |
| User bubble | right-aligned, `--accent` fill, `--accent-fg` text, r18 with bottom-right 6px, 14.5px/22, padding 12×18, `--shadow-card` |
| Assistant reply | on `--bg`; body 14.5px/23; inline code JetBrains Mono 13px, `--accent-muted` fill, r6, padding 2×6, text `--accent` |
| Tool cards | `--panel`, no border, `--shadow-card`, r14, h44, padding 0×16; summary 13px/600; meta JetBrains Mono 12px: `+8` `--ok`, `−3` `--err`, "passed ✓" `--ok` with a 16px `--ok`-fill circle-check icon |
| Question card | `--panel`, `--shadow-pop`, r18, padding 20; title 15px/700; options h52, `--bg-inset` fill, r14, round radio 18px (2px `--border-strong`); Recommended chip `--accent-2` fill, white text, r999, 11px/700; hover: fill `--accent-muted`, radio border `--accent` |
| Composer | `--panel`, `--shadow-pop`, r20; placeholder `--fg-faint` 14.5px; permission pill `--agent`-tinted: `rgba(14,116,144,0.10)` fill (light) / `--bg-inset` (dark), `--agent` text 12px/600, r999, leading `◆`; send 38px circle `--accent`, `--accent-fg` ↑ 2px round, hover `--accent-hover` + scale 1.05 (260ms spring); while working, arrow swaps to thinking dots |
| Status bar | `--panel`, top 1px `--border`; JetBrains Mono 11px `--fg-muted`; `+8 −3` in `--ok`/`--err`; connection = 10px `--ok` dot + text |

Dark theme: identical geometry; tokens swap; shadows deepen per §3.5; user bubble keeps `--accent` fill with `--accent-fg` text.

---

# §W — Shared wireframe for the mini mocks (1200×760)

All three mock slices use this geometry; per-direction tables above override only styling and the density deltas they name.

- **Titlebar**: (0,0,1200,40). Traffic lights Ø12 at x=20/36/52, centered y=20. Wordmark x=84. Centered breadcrumb `my-shop / Fix checkout bug` at x=600, 13px `--fg-muted`.
- **Sidebar**: (0,40,264,692). Search field (16,56,232,32) placeholder `Search chats…`, `⌘K` right. New chat row (16,96,232,36). Divider (16,144,232,1). Eyebrow `PROJECTS` at (16,158). Project row `my-shop` (8,178,248,34) with ▾ + folder + name + 📌. Chat rows (8,y,248,32), status dot at x=28, title at x=44, time right: `Fix checkout bug` y=216 (active, `2m`), `Styles pass` y=248 (`1h`), `Copy review` y=280 (`3h`). Project `landing-page` y=318; chats `Hero rework` y=356, `SEO meta` y=388. Project `api-server` y=430, collapsed (▸). Bottom nav: `Home` (8,650,248,36), `Settings` (8,686,248,36).
- **Session header**: (264,40,936,48). Title `Fix checkout bug` x=288, 15px/600→700. Model chip `Sonnet 4.5 ▾` at (452,52,112,24). Right buttons, 28px high, right margin 16: `↻ Restart`, `☰ Plan`, `⋯` (ending x=1184).
- **Chat column**: content x=392–1072 (w680), scroll region y=88–620.
  - User bubble: right edge x=1072, w≈452, y=112, h≈68 — "The checkout total is wrong when a discount code is applied. Can you fix it?" (2 lines).
  - Assistant reply: (392,204,680,~88) — "Found it — the discount was applied *before* tax, so the percentage was computed on the pre-tax subtotal. I've moved the calculation after tax in `checkout/total.ts` and updated the tests." (4 lines).
  - Tool card 1: (392,316,680,40) — `▸  ✎ Edited 2 files` · right `+8 −3`.
  - Tool card 2: (392,364,680,40) — `▸  ✓ Ran tests` · right `passed ✓`.
  - Question card: (392,428,680,170) — title "Apply the same fix to the cart page too?"; option A (408,476,648,48) "Yes — same calculation there" + `Recommended` chip; option B (408,532,648,48) "No — checkout only".
- **Composer**: (392,620,680,96), floating (bottom margin 16 above status bar). Placeholder `Ask follow-up…` at (408,632). Permission pill `◆ Auto-edit ▾` (408,668,128,28). Send button (1020,664,36,36).
- **Status bar**: (0,732,1200,28). Left, x=16, 11px mono: `⎇ main` · `+8 −3` · `◔ 41% context` · `$0.87 today`. Right: `● omp connected`.

---

# Recommendation

**Ship Direction 1, Warm Ledger.** It is the only direction whose light theme is unambiguously the home theme — warm paper and ink read as "approachable work tool" to non-technical users in a way neither avionics-blue nor lavender-softness does — and building the entire brand on omp's plug-orange gives visual-omp an ownable, single-color identity that no competitor (and not even omp itself) claims. Keep Signal Grid's mono annotations and Soft Machine's thinking-dots in your back pocket as future personality dials; the ledger is the one that will still look right in five years.