# visual-omp design specification

Every value in this document is exact. Implementation stack: React + Tailwind v4 (CSS-variable tokens via `@theme`), Radix primitives, Phosphor icons (`@phosphor-icons/react`), `motion` for animation, xterm.js.

---

## 0. Design direction

visual-omp is a working tool, so the interface stays quiet until something needs attention. The layout from the first release is unchanged. The finish is what changed: near-neutral surfaces with a faint teal cast, one teal accent for every action and active state, hairline borders between panels, and motion that shows where each surface came from. Light mode is the designed default. Dark mode uses a tinted off-black, which keeps panels distinct from the canvas without a blue cast.

Five decisions everything else hangs on:

1. **One accent.** Teal (`--accent`) marks primary actions, links, focus and the active tab or selection. Secondary emphasis uses neutral ink (`--accent-2`), and agent-attributed UI uses the accent (`--agent` resolves to it). The mark and app icon are ink with a single teal lens plate, and the working state is drawn in the accent alone. The UI has no gradients.
2. **Hairlines first, shadows only for floating layers.** Panels sit on the canvas with a 1px `--border` and no shadow. Menus, dialogs, sheets, toasts and the composer cast a shadow, and every shadow is tinted and tight: no blur reaches 16px, so a border and a shadow can share an element without a haze around it.
3. **Friendly by default, honest on demand.** Every machine event collapses to a plain-language line ("Edited 3 files"); raw diffs and output are one click or `Ctrl/Cmd+O` away. Jargon stays off primary surfaces. Group labels are sentence case (`.section-label`), and there are no bracketed or uppercase eyebrows.
4. **Motion with a job.** Springs are critically damped, so nothing bounces. Surfaces grow from the control that opened them, indicators slide between the items they mark, and lists cascade in over a fraction of a second. Under reduced motion every entrance becomes a short crossfade and every layout change is instant.
5. **Status is shape plus color.** Every status color pairs with an icon or glyph (✓ ▲ ✕ ●), so the UI survives color-blindness and grayscale.

---

## 1. Design tokens

All colors are authored in OKLCH in `src/renderer/src/theme/tokens.css`, the only file allowed to hold raw color values. Hex values below are how Chromium renders them, for reference. Surfaces use hue 195 at very low chroma; the accent uses hue 192. Tailwind v4 mapping: every token is re-exposed in `@theme inline` as `--color-*`, `--radius-*` and `--font-*`.

### 1.1 Surfaces, light (default)

| Token | Value | Hex | Used for |
|---|---|---|---|
| `--bg` | `oklch(0.975 0.003 195)` | `#F4F7F7` | canvas, behind everything |
| `--panel` | `oklch(0.994 0.0015 195)` | `#FCFDFD` | sidebar, panes, cards, composer |
| `--bg-inset` | `oklch(0.963 0.004 195)` | `#F0F4F3` | code blocks, terminal, sunken inputs, segmented tracks |
| `--bg-raised` | `oklch(0.997 0.001 195)` | `#FDFEFE` | popovers, menus, tooltips, toasts |
| `--bg-overlay` | `oklch(0.997 0.001 195)` | `#FDFEFE` | dialogs, sheets, command palette |
| `--glass` | `var(--bg)` | `#F4F7F7` | title bar and sticky chrome; opaque, no backdrop blur (the name stays for existing callers) |
| `--hover` | `oklch(0.3 0.02 195 / 0.045)` | | row and control hover wash |
| `--selected` | `oklch(0.3 0.02 195 / 0.08)` | | selected row, pressed state, skeleton fill |
| `--backdrop` | `oklch(0.22 0.015 195 / 0.32)` | | dialog and sheet scrim |

Panels differ from the canvas by about two lightness points. The hairline border does the separating, so no panel needs a shadow to stand out.

### 1.2 Surfaces, dark

| Token | Value | Hex |
|---|---|---|
| `--bg` | `oklch(0.172 0.005 195)` | `#0D1110` |
| `--panel` | `oklch(0.2 0.006 195)` | `#131717` |
| `--bg-inset` | `oklch(0.158 0.005 195)` | `#0A0E0D` |
| `--bg-raised` | `oklch(0.232 0.007 195)` | `#1A1E1E` |
| `--bg-overlay` | `oklch(0.24 0.007 195)` | `#1C2020` |
| `--hover` | `oklch(0.95 0.01 195 / 0.05)` | |
| `--selected` | `oklch(0.95 0.01 195 / 0.09)` | |
| `--backdrop` | `oklch(0.08 0.005 195 / 0.6)` | |

The electron window's `backgroundColor` in `src/main/index.ts` matches `--bg` in each theme so the first frame does not flash.

### 1.3 Text

| Token | Light | Dark | Role |
|---|---|---|---|
| `--fg` | `oklch(0.22 0.012 195)` `#141C1C` | `oklch(0.945 0.005 195)` `#E9EEEE` | body, titles |
| `--fg-muted` | `oklch(0.45 0.013 195)` `#4D5857` | `oklch(0.745 0.01 195)` `#A6AEAE` | secondary labels, metadata, section labels |
| `--fg-faint` | `oklch(0.535 0.012 195)` `#66706F` | `oklch(0.645 0.011 195)` `#869090` | placeholders, timestamps, shortcuts |
| `--fg-inverse` | `oklch(0.995 0.002 195)` | `oklch(0.18 0.006 195)` | text on `--err` fills |

WCAG contrast, measured from the rendered sRGB values. Every pair passes AA (4.5:1) for body text.

| Pair | Light | Dark |
|---|---|---|
| `--fg` on `--bg` | 16.1:1 | 16.2:1 |
| `--fg` on `--panel` | 17.0:1 | 15.4:1 |
| `--fg-muted` on `--bg` | 6.9:1 | 8.4:1 |
| `--fg-muted` on `--panel` | 7.3:1 | 8.0:1 |
| `--fg-faint` on `--bg` | 4.8:1 | 5.8:1 |
| `--fg-faint` on `--panel` | 5.1:1 | 5.5:1 |
| `--fg-faint` on `--bg-inset` | 4.6:1 | 5.9:1 |
| `--fg-faint` on `--bg-overlay` | 5.1:1 | 5.0:1 |

### 1.4 Accent

| Token | Light | Dark | Job |
|---|---|---|---|
| `--accent` | `oklch(0.5 0.082 192)` `#10726F` | `oklch(0.78 0.1 192)` `#5FCCC8` | primary action, links, active tab and selection marker, the mark's lens plate (5.7:1 / 9.4:1 on panel) |
| `--accent-hover` | `oklch(0.45 0.076 192)` | `oklch(0.84 0.09 192)` | hover of the above |
| `--accent-active` | `oklch(0.405 0.07 192)` | `oklch(0.89 0.07 192)` | pressed |
| `--accent-fg` | `#FFFFFF` | `oklch(0.2 0.03 192)` | text on filled accent (5.8:1 light, 9.4:1 dark; 7.2:1 and 11.4:1 on hover) |
| `--accent-muted` | `oklch(0.95 0.022 192)` | `oklch(0.29 0.04 192)` | tinted chip and badge background (accent text on it: 5.0:1 / 7.2:1) |
| `--accent-2` | `oklch(0.4 0.014 195)` | `oklch(0.83 0.01 195)` | neutral ink for secondary emphasis: @-mentions, the `blue` chip tone (9.0:1 / 10.7:1 on panel) |
| `--accent-2-muted` | `oklch(0.945 0.005 195)` | `oklch(0.27 0.008 195)` | neutral tint behind `--accent-2` text (7.8:1 / 8.9:1) |
| `--agent`, `--agent-muted` | `var(--accent)`, `var(--accent-muted)` | same | agent-attributed UI uses the accent |

Retired spectrum. `--mark-a`, `--mark-b` and `--mark-c` resolve to `--accent`. `--mark-gradient` and `--work-gradient` resolve to a flat `linear-gradient(var(--accent), var(--accent))` so any remaining `background-image` caller paints solid teal. `--ambient-a`, `--ambient-b` and `--grid-line` are `transparent`, which removes the hero washes and the blueprint grid wherever they are still referenced. `--plug` resolves to `--warn`. These names stay only until the last caller moves off them.

### 1.5 Status

Slightly desaturated so status colors sit next to the teal accent without competing with it.

| Token | Light | Dark | Pairs with glyph |
|---|---|---|---|
| `--ok` | `oklch(0.5 0.1 160)` | `oklch(0.77 0.12 160)` | ✓ check (5.6:1 / 9.2:1 on panel) |
| `--ok-bg` | `oklch(0.957 0.022 160)` | `oklch(0.26 0.035 160)` | text on bg: 5.1:1 / 7.8:1 |
| `--warn` | `oklch(0.53 0.11 65)` | `oklch(0.8 0.115 80)` | ▲ triangle (5.3:1 / 9.6:1) |
| `--warn-bg` | `oklch(0.962 0.028 78)` | `oklch(0.27 0.035 80)` | 4.9:1 / 8.0:1 |
| `--err` | `oklch(0.52 0.16 25)` | `oklch(0.72 0.14 25)` | ✕ cross (5.9:1 / 6.9:1) |
| `--err-bg` | `oklch(0.955 0.02 20)` | `oklch(0.26 0.04 22)` | 5.2:1 / 6.0:1 |
| `--err-hover` | `oklch(0.47 0.15 25)` | `oklch(0.78 0.13 25)` | danger button hover |
| `--info` | `oklch(0.52 0.12 255)` | `oklch(0.75 0.1 255)` | ● dot (5.4:1 / 8.1:1) |
| `--info-bg` | `oklch(0.955 0.018 255)` | `oklch(0.26 0.035 255)` | 4.9:1 / 7.0:1 |
| `--live` | `var(--ok)` | same | ● pulsing dot, reserved for real-time presence (collab live, session running elsewhere) |

### 1.6 Diff

| Token | Light | Dark |
|---|---|---|
| `--diff-add-bg` | `oklch(0.962 0.025 160)` | `oklch(0.24 0.035 160)` |
| `--diff-add-line` | `oklch(0.925 0.045 160)` | `oklch(0.29 0.045 160)` |
| `--diff-add-text` | `oklch(0.47 0.1 160)` | `oklch(0.8 0.12 160)` (5.9:1 / 9.1:1 on own bg) |
| `--diff-del-bg` | `oklch(0.958 0.02 22)` | `oklch(0.245 0.04 22)` |
| `--diff-del-line` | `oklch(0.925 0.04 22)` | `oklch(0.29 0.055 22)` |
| `--diff-del-text` | `oklch(0.5 0.15 25)` | `oklch(0.79 0.12 20)` (5.7:1 / 8.1:1) |
| `--diff-hunk-bg` | `oklch(0.95 0.006 195)` | `oklch(0.232 0.007 195)` |
| `--diff-hunk-text` | `var(--fg-muted)` | same |

### 1.7 Syntax highlighting (code blocks, diffs, file viewer)

Code keeps a few muted hues so tokens stay distinguishable. Measured on `--bg-inset`, the worst pair is the light comment color at 4.5:1; every dark pair is 5.9:1 or higher.

| Role | Light | Dark |
|---|---|---|
| `--syn-text` | `var(--fg)` | same |
| `--syn-keyword` | `oklch(0.48 0.085 192)` teal | `oklch(0.78 0.1 192)` |
| `--syn-string` | `oklch(0.48 0.1 150)` green | `oklch(0.8 0.12 155)` |
| `--syn-number` | `oklch(0.52 0.11 60)` amber | `oklch(0.82 0.11 75)` |
| `--syn-function` | `oklch(0.5 0.11 255)` blue | `oklch(0.77 0.1 255)` |
| `--syn-type` | `oklch(0.5 0.11 300)` violet | `oklch(0.76 0.1 305)` |
| `--syn-operator` | `oklch(0.52 0.13 25)` red | `oklch(0.73 0.13 25)` |
| `--syn-comment` | `oklch(0.54 0.01 195)` | `oklch(0.645 0.011 195)` |
| `--syn-punct` | `var(--fg-muted)` | same |

The terminal gets its own ANSI blue and magenta (`--term-blue`, `--term-magenta`) because `--accent-2` and `--agent` no longer carry those hues.

### 1.8 Borders & focus

| Token | Light | Dark | Role |
|---|---|---|---|
| `--border` | `oklch(0.3 0.02 195 / 0.1)` | `oklch(0.95 0.01 195 / 0.09)` | hairlines: panel edges, separators, cards |
| `--border-strong` | `oklch(0.3 0.02 195 / 0.17)` | `oklch(0.95 0.01 195 / 0.16)` | secondary button outlines, hovered cards, keycaps, progress track |
| `--control-border` | `oklch(0.62 0.012 195)` `#7E8988` | `oklch(0.54 0.012 195)` `#677171` | boundaries that identify a control or its state: checkbox and radio outlines, the off switch track, input and select borders, slider track, todo step dots |
| `--ring` | `oklch(0.56 0.09 192)` | `oklch(0.78 0.1 192)` | focus ring (4.4:1 on light panel, 9.4:1 on dark panel) |
| `--ring-soft` | `oklch(0.56 0.09 192 / 0.18)` | `oklch(0.78 0.1 192 / 0.24)` | text selection, ring halo |

Focus style, everywhere: `outline: 2px solid var(--ring); outline-offset: 2px;` on `:focus-visible`. Never removed, never color change alone. Card tone (`Card rail`) tints the hairline toward the tone color, mixed in sRGB; there is no colored left stripe.

Non-text contrast (WCAG 1.4.11). Decorative separators (`--border`, `--border-strong`) stay faint. `--control-border` is at least 3:1 against every surface a control sits on:

| `--control-border` on | Light | Dark |
|---|---|---|
| `--bg` | 3.4:1 | 3.8:1 |
| `--panel` | 3.6:1 | 3.6:1 |
| `--bg-inset` | 3.3:1 | 3.9:1 |
| `--bg-raised` | 3.6:1 | 3.3:1 |
| `--bg-overlay` | 3.6:1 | 3.3:1 |

The switch thumb (`--panel`) against the off track is 3.6:1 in both themes. Checked states use `--accent`, at 5.2:1 or more against every light surface and 8.6:1 or more against every dark one.

### 1.9 Elevation & shadows

Shadows are tinted with the surface hue (`--shadow-tint`) and kept tight. No blur is 16px or larger, which is why any 1px border may pair with any shadow token. Panels on the canvas use none of these; they rely on `--border`.

| Token | Light | Use |
|---|---|---|
| `--shadow-card` | `0 1px 1px` tint / 0.05 | buttons, segmented thumb, cards marked `floating` |
| `--shadow-pop` | `0 1px 2px` / 0.06, `0 6px 12px -4px` / 0.14 | menus, popovers, tooltips, toasts |
| `--shadow-overlay` | `0 2px 4px` / 0.06, `0 12px 12px -8px` / 0.2 | dialogs, sheets, palette |
| `--shadow-composer` | `0 1px 2px` / 0.05, `0 4px 8px -4px` / 0.1 | composer |
| `--shadow-primary` | `inset 0 1px 0` white / 0.14, `0 1px 1px` / 0.18 | primary and danger buttons |
| `--work-glow` | `0 0 0 3px` accent / 0.14 | working halo (spread only, no blur) |

Light tint is `oklch(0.28 0.03 195)`; dark tint is `oklch(0.06 0.01 195)` at higher opacities (0.4 to 0.6) with the same geometry.

### 1.10 Radii

| Token | Value | Role |
|---|---|---|
| `--radius-sm` | `6px` | chips, badges, small buttons, inline code |
| `--radius` | `8px` | buttons, inputs, menus, tabs |
| `--radius-lg` | `12px` | cards, tool cards, dialogs, sheets (cards never exceed this) |
| `--radius-xl` | `14px` | composer, large modal panels |
| `--radius-full` | `999px` | pills, toggles, avatars, status dots, context ring |

### 1.11 Spacing (4px base, 8px rhythm)

`--s-1:4px · --s-2:8px · --s-3:12px · --s-4:16px · --s-5:20px · --s-6:24px · --s-8:32px · --s-10:40px · --s-12:48px · --s-16:64px · --s-20:80px`.
Component density: control height sm 28px / md 32px / lg 40px; list row 36px; chat message gap 24px; card padding 16px; pane padding 16-24px.

### 1.12 Motion

Motion is expressive and physical, and it never bounces. JavaScript animation uses `motion/react` through the presets and components in `src/renderer/src/ui/motion.tsx`; CSS animation (Radix surfaces, indicators) uses the matching tokens in `tokens.css`.

**Presets**

| Name | Value | Use |
|---|---|---|
| `ease.outQuart` / `--ease-out-quart` | `cubic-bezier(0.25, 1, 0.5, 1)` | opacity and color tweens, press feedback |
| `ease.outExpo` / `--ease-out-expo`, `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | longer entrances |
| `spring.snappy` | `{ type: "spring", visualDuration: 0.22, bounce: 0 }` | indicators, toggles, menus, the default transition in `MotionProvider` |
| `spring.gentle` | `{ type: "spring", visualDuration: 0.4, bounce: 0 }` | dialogs, sheets, list entrances, height changes, toasts |
| `--ease-spring` + `--dur-spring` (320ms) / `--dur-spring-gentle` (520ms) | critically damped spring sampled into `linear()` | the CSS equivalent of the two springs |
| `--dur-fast` / `--dur` / `--dur-slow` / `--dur-xl` | 100 / 160 / 240 / 360ms | hovers and presses / menus and tabs / exits and settles / tour transitions |
| `--dur-fade` | 140ms | the crossfade that remains under reduced motion |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | looped animations (pulse, breathe) |

Exits are shorter than entrances and use an ease-in (`cubic-bezier(0.4, 0, 1, 1)`), so a closing surface gets out of the way.

**Components** (`import { … } from "@/ui"`)

- `MotionProvider`: mounted once in `App`. Wraps `MotionConfig` and follows `data-motion` on `<html>`: `reduced` → `reducedMotion="always"`, `full` → `"never"`, absent (the app follows the OS) → `"user"`. `useMotionReduced()` returns the resolved answer.
- `Expand`: animated height-auto disclosure for accordions, tool steps and "show more". Clips overflow only while moving; put padding on its `className` so the collapsed height reaches 0.
- `Stagger` / `StaggerItem`: list entrance, 25ms between items by default, capped at the eighth item so long lists never wait. A list present at the app's first render shows at rest; a list inserted later cascades in; items added to a resting list rise in one at a time.
- `Rise` / `FadeIn`: entrances for content inserted after the first render (a new message, a newly opened panel). At rest on first render unless `animateOnMount` is set.
- `play` on `StaggerItem`, `Rise` and `FadeIn`: when the caller knows better than the automatic rule (a transcript that remounts on tab switch, history loaded after mount), `play={false}` renders at rest and `play={true}` plays the entrance. The value is read at mount.
- `PresenceSwap`: crossfade (`fade`), `rise` or directional `slide` between keyed children, for tab, pane and screen switches.

**Shared-element transitions.** Give the moving element a `layoutId` that is unique to its component instance, derived from `useId()`, so two instances on screen never trade elements. `Tabs` and `Segmented` do this for their indicators. `<LayoutGroup id>` is the alternative when several components must coordinate one layout animation. Keep `transform` utilities off `layoutId` elements, since motion owns their transform while it animates.

**Primitives**

| Primitive | Motion |
|---|---|
| Dialog | scale 0.95 → 1 on the spring with a fade; exit scales to 0.97 and fades |
| Sheet | slides in from its edge on the gentle spring; exit slides partway back and fades |
| Menu, Popover, Tooltip, Select | scale 0.96 → 1 from the Radix transform origin, drifting 4px away from the trigger |
| Tabs, Segmented | one indicator slides between items (`layoutId`) |
| Switch | thumb travels on the spring and stretches toward its destination while pressed |
| Toaster | toasts rise in, the stack reflows with layout animation, a rightward swipe throws the toast off |
| Progress | width follows the value on the gentle spring |
| Button, IconButton | press scales to 0.98; primary lifts 1px on hover |
| Checkbox | the check draws itself in; the box presses to 0.9 |

**Reduced motion** (`data-motion="reduced"`, or the OS setting when the app follows it): motion skips transform and layout animations and keeps opacity, so entrances become crossfades and indicators jump. CSS movement durations collapse to 0.01ms, and Radix surfaces switch to a `--dur-fade` crossfade. The working halo stops breathing, the pulse dot freezes at 60%, the streaming caret stops blinking, and skeletons hold a static fill.

**No hidden content.** A reveal never hides content that would be visible without it, and two mechanisms guarantee it. `Stagger`, `Rise` and `FadeIn` read the app-settled flag: `MotionProvider` sets it after its first effect, and those components play an entrance only for content mounted after that, or when a caller passes `animateOnMount`. `Expand` and `PresenceSwap` do not read the flag. Their presence wrappers use `initial={false}` per instance (unless `animateOnMount` is set), so whatever they show when they mount renders at rest, and they animate only later open, close or swap changes. No entrance waits on scroll or viewport triggers.

### 1.13 Z-index layers

`--z-base:0 · --z-sticky:10 · --z-pane-header:20 · --z-sidebar:30 · --z-titlebar:40 · --z-dropdown:50 · --z-scrim:60 · --z-sheet:70 · --z-dialog:80 · --z-palette:90 · --z-toast:100 · --z-tooltip:110`.

---

## 2. Typography

### 2.1 Families

| Token | Stack | Use |
|---|---|---|
| `--font-ui` | `"Geist Variable", "Geist", -apple-system, "Segoe UI Variable Text", Roboto, sans-serif` | all UI text **and** display headings (600/700, tight tracking) |
| `--font-mono` | `"Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | code, diffs, terminal, wordmark, numbers in the status bar |

Two bundled families, both OFL: **Geist** (`@fontsource-variable/geist`, variable 100-900, ≈95 KB woff2) and **Geist Mono** (`@fontsource-variable/geist-mono`, variable 100-900, ≈90 KB woff2). Geist carries display duties at 700 with −0.02em tracking, so no third display family is needed. System stacks are fallbacks only.

### 2.2 Scale (root 16px; the text-size setting scales root 90-130%, i.e. 14.4-20.8px)

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

### 2.3 The wordmark and mark

`visual-omp`, lowercase, Geist Mono 600, tracking −0.02em, `--fg`, with no cursor or suffix. `Wordmark withMark` places the mark before the text with an 8px gap and the mark box at about 1.3× the text size: sm is 14px text with an 18px mark (the title bar), md 16px with 21px, lg 24px with 31px.

The mark is periscope C1 "Heavy" (§6). With the default `tone="accent"`, the ink shapes use `--fg` and the lens plate uses `--accent`, so the mark follows the theme. With `tone="current"`, every shape uses the surrounding text color. Its geometry lives only in `src/renderer/src/ui/BrandMark.tsx` (exported as both `BrandMark` and `Mark`); the app icon SVGs and the README hero carry copies of the same shapes.

Streaming text uses a thin 2px accent caret (`.stream-caret`), and working states use the pulse dot and the working halo (§5.16).

### 2.4 Section labels

`.section-label` (or the `SectionLabel` component): `--font-ui`, `--text-sm` (12px), weight 500, `--fg-muted`, sentence case, no tracking, no brackets. Use it to name a group the heading does not already name, such as a settings group or a sidebar list. A label that repeats the heading under it is removed.

---

## 3. App shell layout

The window opens at 1440×920 and can shrink to 960×620 (`src/main/index.ts`). Regions, with light values shown:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ TITLE BAR 40px · opaque --glass (--bg) · bottom hairline                 │
│ ● ● ●  ›▟ visual-omp            my-shop / Fix checkout bug ⌄             │
├─────────────┬────────────────────────────────────────────────────────────┤
│ SIDEBAR     │ TAB STRIP 36px · --bg · bottom hairline                    │
│ 264px       │ ◌ Fix checkout bug × │ ○ Styles pass │ 2 more ⌄   ＋  ▥    │
│ --panel     ├───────────────────────────────────────┬────────────────────┤
│ 200-320     │ SESSION HEADER 48px · --panel         │ RIGHT DOCK 420px   │
│             │ title [model ⌄][mode ⌄] buttons ⋯     │ 320-640 · closed   │
│             ├───────────────────────────────────────┤ by default         │
│             │ CHAT COLUMN · max 760px · scrolls     │ Diff  Files        │
│             │                                       │ Preview  Tasks     │
│             ├───────────────────────────────────────┤ Plan  Terminal     │
│             │ COMPOSER · max 760px card             │                    │
├─────────────┴───────────────────────────────────────┴────────────────────┤
│ STATUS BAR 28px · --panel · top hairline · mono --text-xs                │
│ ⎇ main  +12 −3  PR #4 ✓                 ◔ 62%  $1.24 today  ● omp 18.4.5 │
└──────────────────────────────────────────────────────────────────────────┘
```

The sidebar and dock slide in from their own edge (12px on the gentle spring, with a fade) and fade out when hidden. The main area swaps between the project home and the chat with a `PresenceSwap` rise. Sidebar and dock visibility, widths and the open dock pane are saved app-wide in `localStorage` under `visual-omp:layout`.

### 3.1 Title bar (40px)

The window is frameless. The bar is a drag region with `no-drag` controls, filled with the opaque `--glass` (the canvas color) and a bottom 1px `--border`. No translucency or backdrop blur.

- **macOS**: `hiddenInset`, with the traffic lights at (16, 16). Content starts at 92px.
- **Windows and Linux**: the caption buttons (minimize, maximize, close) are Electron's native title bar overlay: 44px tall, transparent background, symbol color `#6c6c74`. The renderer draws none of them and keeps 150px clear on the right. `--win-close` is defined in tokens but nothing uses it.
- **Contents, left to right**:
  - "Show sidebar" (`SidebarSimple`, ⌘B), an IconButton that appears only while the sidebar is hidden.
  - The lockup, `Wordmark withMark size="sm"`: the 18px C1 mark and the 14px `visual-omp` wordmark with an 8px gap. It is decorative.
  - Centered, while a project is active: a breadcrumb button with the project name, "/", the focused chat's title and a `CaretDown`, in `--text-md` `--fg-muted`. It opens the command palette (§4.10) and crossfades when the chat changes.
  - The right side stays empty on macOS.

### 3.2 Sidebar (264px, drag 200-320px, ⌘B hides)

```
┌────────────────────────────┐
│ ⌕ Search chats…       ⌘K   │ search field, 32px, --bg-inset
│ ＋ Start chat…             │ 36px row, accent text
│────────────────────────────│
│ Projects               ＋  │ section label and "Add project" menu
│ › ▭ my-shop            ⋯   │ project row, 36px
│     ◌ Fix checkout bug  2m │ chat row, 32px, 28px indent
│     ? Styles pass       1h │
│     ○ Copy review       3d │
│ › ▭ landing-page           │
│ › Archived · 3             │ only when chats are archived
│────────────────────────────│
│ ⌂ Home                     │ bottom nav, 36px rows
│ ⚙ Settings                 │
│ ? Help                     │
└────────────────────────────┘
```

- The column is a `nav` labelled "Projects and chats" on `--panel` with a right hairline. Its resize handle is keyboard operable: arrow keys move it 16px, or 48px with Shift.
- **Search** ("Search chats…") matches chat titles, previews and project names across every project, loads collapsed projects to search them, and opens every group that matches. Esc clears it. Its ⌘K hint refers to the command palette, which also finds chats.
- **Start chat…** is a 36px row in `--accent` semibold text with an `--accent-muted` hover. It opens the "Start a chat in…" folder chooser.
- **Projects** is a `SectionLabel`. Its + button ("Add project") opens a menu with Open folder… (⌘O), Create folder… and Clone from GitHub….
- **Project rows** are 36px and sorted with pinned projects first, then by last activity. Each row has:
  - a disclosure caret that turns 90°
  - a folder icon (`FolderMinus` in `--warn` when the folder is missing)
  - the name in semibold
  - a pin icon when pinned
  - a "Project options" ⋯ button that shows on hover or focus
  - The row is `--selected` while that project's home is open.
  - The options menu and the right-click menu offer Start chat here, Open project home, Show in folder, Pin project or Unpin project, Settings, and Remove project from list.
- **Chats** open inside `Expand`. A project shows its first eight chats and then "Show N more chats". An empty project reads "No chats yet. New chats in this project appear here."
- **Chat rows** are 32px: `ChatStatusMark` (below), the title (falling back to "Untitled chat"), a pin icon, and the relative time in mono `--text-xs` `--fg-faint`, which gives way to a ⋯ "Chat options" button on hover.
  - The active chat's `--selected` fill is one element that slides between rows. Its `layoutId` is unique to the sidebar, and the split partner has its own.
  - ⌘ or Ctrl-click opens a chat in the split.
  - The menu offers Open chat, Open side by side, Pin chat or Unpin chat, Archive chat or Restore chat, Show in folder, and Delete chat… (danger). Delete confirms in a destructive dialog: "Delete '{title}'?", with [Keep chat] and [Delete chat].
- **Motion**: new rows rise 4px on the snappy spring, and groups reflow with layout animation.
- **Bottom nav**: Home, Settings and Help rows (`House`, `Gear`, `Question`).
- **Collapse**: ⌘B (Ctrl+B) or View → Toggle Sidebar slides the column away, and the title bar then shows "Show sidebar". There is no hover strip and no overlay mode.
- **Empty**: with no projects, an empty state reads "No projects yet. A project is a folder that omp works in." with [Create project].

**Chat status marks** (`shell/ChatStatusMark.tsx`). Sidebar rows, tabs and the tab overflow menu all use the same 14px shape, and each carries sr-only text. The status comes from `chatStatus()` in `shell/hooks.ts`, checked in this order: a pending omp question, then working, then open, otherwise saved.

| Status | Shape | Color | Screen-reader text |
|---|---|---|---|
| Working | `CircleNotch`, bold, spinning (static under reduced motion) | `--accent` | "omp is working" |
| Waiting for an answer | `Question`, bold | `--warn` | "Waiting for your answer" |
| Open | filled circle, 10px | `--ok` | "Open" |
| Saved | hollow circle, 10px | `--fg-faint` | "Saved" |

### 3.3 Tab strip and split view (36px)

- The strip is hidden while no chats are open. It sits on `--bg` with a bottom hairline, and its `role="tablist"` is labelled "Open chats".
- **Tabs**: 28px tall, 120-200px wide, with rounded top corners. Each holds a `ChatStatusMark`, the title (falling back to "New chat") and a close button ("Close {title}") that shows on hover or focus. Each title button is `role="tab"` with `aria-selected` and `aria-controls` pointing at the chat panel.
- **Selected tab**: medium `--fg` text on a `--panel` fill with a 2px accent underline. That fill and underline are one element that slides between tabs; its `layoutId` is unique to the strip, and the split partner has its own. Tabs enter and leave with a 6px rise on the snappy spring.
- **Keyboard**: a roving tab stop, so the strip is one Tab stop. Left and Right wrap, Home and End jump, Enter and Space activate, and Delete closes; middle-click also closes. Closing a working chat asks first. ⌘1-⌘8 pick a tab, ⌘9 picks the last one, and ⌘⇧[ and ⌘⇧] step through them.
- **Overflow**: a `ResizeObserver` measures the strip, and tabs that do not fit at the 120px minimum move into an "N more" menu button whose rows show the status mark and title. The active tab and the split partner always stay visible.
- **End of the strip**: ＋ "Start new chat" (⌘N) and, with two or more tabs, a `Columns` toggle ("Open split view" or "Close split view", ⌘\).
- **Split view** shows two chats side by side.
  - The left pane starts at 50%, and the resize handle keeps each pane at least 360px wide.
  - Each pane has its own header, transcript and composer. The tab strip, dock and status bar are shared.
  - ⌘ or Ctrl-click in the sidebar, or ⌘⏎ on a chat in the palette, opens a chat in the second pane.
  - The second pane enters from the right.
  - The pane without focus drops to 97% opacity.

### 3.4 Session header (48px)

- **Bar**: `--panel` with a bottom hairline and 16px padding. It holds a `ChatCenteredText` icon and the chat title (15px semibold), which rises in when it changes. The title is not edited in place; "Rename chat" in the ⋯ menu opens a rename dialog.
- **Chips** are 24px pills in `--text-xs` semibold:
  - The **model chip** (`--hover` fill, `--fg` text) opens the model list (⌘⇧M).
  - The **mode chip** shows the permission level ("Ask me first", "Edits OK", "Auto") on `--hover` in `--fg-muted`. When a work mode is on it shows that mode on `--accent-muted` in `--accent`: "Plan", "Plan paused", "Goal", "Goal paused", "Vibe" or "Loop". Its menu has a "Permission level" radio group, then "Work modes": Plan mode and Vibe mode checkboxes, Set a goal…, Repeat a task…, and Toggle advisor.
  - While the chat is shared, a **"Shared" chip** with a dot appears (accent while live, warn otherwise). It opens the share dialog on the Invite tab.
- **Buttons**: up to five ghost icon-and-label buttons, each with a tooltip that shows its hint and shortcut: Restart omp (`ArrowsClockwise`), Compact this chat (`ArrowsIn`), Plan mode (`ClipboardText`), Helpers (`Robot`) and Share chat… (`ShareNetwork`).
- **⋯ "More actions"**:
  - First a "Transcript view" radio group (Normal, Thinking, Verbose).
  - Then every chat and mode command that is not already a header button, in registration order. Examples: Start new chat, Close chat, Start chat in folder…, Set a goal, Guided goal, Vibe mode, Repeat a task, Toggle advisor, Write a handoff, Run security scan, Cleanse project, Export chat, Rename chat, Stop turn (while working), Choose model, Open session tree and Fork chat.

### 3.5 Chat column

- **Layout**: up to 760px wide and centered, with 24px side gutters, 24px top padding and 24px between messages. The transcript is a polite `role="log"`. It renders the last 120 entries; "Show N earlier messages" loads more, and does so on its own when you scroll near the top.
- **Banners** above the transcript:
  - "omp stopped (exit N)." with [Start omp again]
  - "Reconnecting to omp…" (warn)
  - "Showing the saved chat. omp starts when you send a message." (info)
  - For a chat open in another window, a follow row with a live dot: "Open in another window. This view updates as that window works; reply from there."
- **Transcript view**: Normal, Thinking or Verbose, chosen in the header ⋯ menu or in Settings → General. Thinking opens every thinking block. Verbose also shows thinking-level notices, starts tool steps expanded and adds their raw JSON arguments.
- **User message**:
  - A right-aligned bubble up to 85% of the column: `--bg-inset`, 1px `--border`, `--radius-lg`, 12px by 16px padding, `--text-base`. There is no side rail and no speech tail.
  - Images show as 48px thumbnails above the text.
  - A line above the bubble reads "You" (or "From {name}" in shared chats), with the time on hover.
  - Hover or focus shows Rewind to here, Fork from here and Copy message under the bubble.
- **Assistant message**:
  - No card and no hover actions.
  - Each turn starts with a header row: the 18px C1 mark, then "{model} · {time}" in `--text-sm` `--fg-faint`.
  - Markdown is 14/22 `--fg`. Inline code sits on `--selected`; code blocks are on `--bg-inset` with a hairline.
  - While a reply streams, a 2px accent caret follows the last character and blinks every second.
- **Thinking**: a 28px toggle row, "Thinking" (or "Thinking (hidden by the model)"), in `--text-sm` `--fg-faint`, with a caret that turns when it opens. The text opens with `Expand`, indented 20px, in `--text-sm` `--fg-muted`, with no background and no rail.
- **Tool steps** (§4.7) are borderless rows, and the steps of one turn stack as one list.
- **Notices** are a centered `--text-xs` `--fg-faint` line between two hairlines:
  - "Context summarized"
  - "Continued from another branch"
  - "Switched to {model}"
  - "Thinking set to {level}" (Verbose only)
  Output from extensions shows in a bordered `--bg-inset` box in `--text-sm` `--fg-muted`.
- **Errors**: when a turn stops, an inline status follows it. An error shows on `--err-bg` with `XCircle`: "The reply stopped with an error", plus omp's message. A cancelled turn shows on `--warn-bg` with `Warning`: "Stopped".
- **Questions** are §4.8 and **plan review** is §4.9. The **working row** is §4.6.
- **Scrolling**: the log follows new content while you are within 48px of the bottom. Scroll further up and new content shows a "Show new activity" pill (primary, `ArrowDown`) at the bottom right.

### 3.6 Composer (card up to 760px, `--radius-xl`, `--shadow-composer`, 1px `--border-strong`)

```
┌──────────────────────────────────────────────────────────────────┐
│ ? Question waiting · omp needs your answer to continue           │ only while omp asks
│ ⧗ 2 queued. They send in order when omp finishes.                │ queued tray
│ ⠿ also update the tests          Send message now   ✎   ×        │ 32px rows on --bg-inset
│──────────────────────────────────────────────────────────────────│
│ [▣ shot.png ×]                                                   │ attached images
│ Ask omp to change something…                                ⌘↵   │ grows 24-200px
│ ＋ ▭my-shop⌄ (Auto⌄) !Shell $Python      🎙 ◔ Sonnet 4.5⌄ Auto⌄ ↑ │ one 40px row
└──────────────────────────────────────────────────────────────────┘
```

- **Card**: `--panel` (`--bg-inset` when read-only). The frame does not change while omp works; the working row above it carries that state.
- **Question chip**: while omp is asking, a "Question waiting" pill heads the card. Clicking it scrolls to the question and focuses it.
- **Queued tray**: messages sent while omp works queue here, in 32px `--bg-inset` rows. The title reads "{n} queued. They send in order when omp finishes." Each row has a drag handle that also works with arrow keys, "Send message now", an inline edit and "Remove from queue". Three rows show, then "Show N more".
- **Attachments**: attached images show as 40px chips with a thumbnail, name and remove button.
- **Text box**: `--text-base`, growing from 24 to 200px.
  - Placeholders: "Ask omp to change something…" when idle, "Queue a message for when omp finishes this reply" while working, and prompts for Shell and Python mode.
  - A mono hint shows ⌘↵, or "⌘↵ send now" while working.
  - `@` mentions are highlighted inline on `--accent-muted` in `--accent`.
- **Bottom row**, left to right:
  1. ＋ opens a menu: Attach file, Mention a file, Open prompt library, Browse skills, Browse custom commands.
  2. The folder chip appears only before the first message; the folder can change until then.
  3. The permission pill, a 28px pill: "Ask me first", "Edits OK" or "Auto · runs without asking". Its popover explains each level. The first switch to Auto asks for confirmation.
  4. The Shell (!) and Python ($) toggles show `--accent-muted` fill when pressed.
  5. Voice (recording shows `--err-bg` with a ping ring).
  6. The context ring (§5.17).
  7. The model button (⌘⇧M).
  8. The thinking-level button (⇧⇥).
  9. While working, "Stop reply" (danger-ghost).
  10. Send: a 32px `--accent` square with `ArrowUp`.
- **Keys**:
  - Enter sends, or queues while working.
  - Shift+Enter adds a new line.
  - ⌘/Ctrl+Enter sends now and steers the running turn.
  - Esc closes the mention picker, or stops omp when the box is empty.
  - Typing `!` or `$` in an empty box enters Shell or Python mode, and Backspace in an empty box leaves it.
- **@-mention picker**: a floating list above the text box: "Mention a file so omp reads it with your message". Rows are 32px, with fuzzy matches in accent semibold. Picking one inserts `@path`.
- **Drag and drop**: dragging files over the chat column shows a veil (`--accent-muted` with an inset `--accent` outline): "Drop to add to your message". Images attach, and other files are mentioned.

### 3.7 Right dock (420px default, drag 320-640px, ⌥⌘B toggles)

- **Frame**: an `aside` labelled "Side panel" on `--panel` with a left hairline. It is closed by default.
- **Tab strip**: 32px, with 28px tabs: Diff (`GitDiff`), Files (`TreeStructure`), Preview (`MonitorPlay`), Tasks (`ListChecks`), Plan (`ClipboardText`) and Terminal (`TerminalWindow`).
  - The active tab has `--accent` text and a 2px accent underline that slides between tabs.
  - Tabs use a roving tab stop with manual activation.
  - Panes slide in from the side of the chosen tab.
  - A close button ("Close side panel") ends the strip.
- **Badges**:
  - Diff: `+N −M` in the diff colors.
  - Tasks: an accent count pill of running helpers and jobs.
  - Plan: an accent "!" while a plan waits for a decision.
  - Terminal: a live dot while a command runs.
- **Diff**: changes since the last commit, per file, with a hideable file list. Line comments are sent to omp together. "Review code" asks omp to review the changes (`/review`), and a file's changes can be discarded after a confirmation.
- **Files**: the project tree and viewer tabs. ⌘-click or right-click mentions a file in chat; there are also Copy path and Show in folder.
- **Preview**: back, forward, reload, an address field (local addresses and `https://` pages only) and "Open page in your browser". Links found in the chat are offered, and the empty state reads "Nothing to preview".
- **Tasks**: the checklist, the helpers at work (helper definitions are managed in §4.14) and background jobs:
  - The checklist has a progress bar, and a highlight slides to the step in progress.
  - Helper rows use a letter avatar with a status dot.
  - Background jobs show a live tail.
- **Plan**: the plan file, polled every 2 seconds while visible. While omp waits for a decision, an `--accent-muted` bar offers [See all options] and [Approve plan].
- **Terminal**: the project's own shells ("Shell 1", "Shell 2"…), separate from omp's terminal screen (§4.11).

### 3.8 Status bar (28px, `--panel`, top hairline, mono `--text-xs`)

Left:
- **Branch** (⎇ plus the branch name). Its menu switches branches, opens other GitHub branches, creates a branch, turns on "Work in a separate copy", commits changes, opens or creates a pull request, and refreshes git status. Outside git it reads "No git", with "Set up git".
- **Changes**: `+A −D` in the diff colors, hidden when clean. It opens the Diff pane.
- **Pull request**: "PR #N" with ✓, ▲ or ✕ for its checks. It opens a checks popover with [Refresh checks], [Fix CI] (when failing) and [Open on GitHub]. A failing check also adds a separate "Fix CI" item.

Right, in order:
- **Context**: a 14px context ring and "{n}%", shown when the chat reports usage. It is a readout without a click action.
- **Cost**: "{cost} today". It opens Usage & limits.
- **App update**: "v{version} available" with an accent dot, only when a newer visual-omp exists. It opens Settings → About.
- **omp status**: a dot and label. Dot and label pairs: `--ok` "omp {version}"; `--warn` "Starting omp…" or "Reconnecting to omp…"; `--err` "omp stopped". An accent dot marks an available omp update. The menu holds Show omp terminal (⌘J), Restart omp, Update omp to {version} (when there is one) and Copy diagnostics.

Every item is a button with a tooltip, apart from the context readout. The bar never wraps.

---

## 4. Screen specs

Wireframes are schematic. Every screen uses the §3 shell unless noted, and the strings quoted here come from `src/renderer/src/i18n/en/`, which is authoritative when they differ.

### 4.1 omp-missing setup screen

A full-window screen on `--bg` with no sidebar or dock. It has a 40px drag strip at the top and a centered 560px column starting at 12vh.

```
                         ›▟                    C1 mark, 56px
                    Install omp                28px semibold, −0.02em
     visual-omp is a desktop app for omp, the AI coding agent.
          omp isn't installed on this computer yet.           --text-base, --fg-muted

   ┌────────────────────────────────────────┐
   │ ① Install omp                          │ numbered step, 28px badge
   │   The installer is a single command,   │
   │   and its output appears in this window│
   │   [curl -fsSL … | sh]                  │ command in --bg-inset mono
   │   [▶ Run installer]  [Copy command]    │ primary + ghost
   ├────────────────────────────────────────┤
   │ ② Check for omp                        │ dims until step 1 finishes
   │   [↻ Check for omp]                    │ secondary
   └────────────────────────────────────────┘
           Having trouble?  Open the help guide →
```

- **States**:
  - **missing**: as shown.
  - **installing**: an inline terminal (240px) shows the installer's output, with [Cancel install] and a status line that ends in "The installer finished." or an error with its exit code.
  - **too old**: "Your omp is out of date" shows the installed and required versions, and step 1 becomes "Update omp".
  - **still missing after a check**: a `--warn-bg` note suggests reopening the app.
  - **done**: "omp is ready". Both step badges turn `--ok` with a check, and the app opens after 600ms.
- The heading and body swap with a rise. [Copy command] shows the toast "Command copied". The help link opens a limited help sheet.

### 4.2 First-run guided tour

The tour runs 800ms after the first launch, once omp is found. Five steps spotlight their targets: the scrim is `--backdrop` with an 8px-padded cutout (radius 12) and a `--ring` outline, and it glides between targets on the gentle spring.

- **Card**: 320px, `--bg-overlay`, `--radius-lg`, `--shadow-overlay`, placed beside the target. Title `--text-base` semibold, body `--text-md` `--fg-muted`.
- **Footer**: [Skip tour], step dots (screen readers hear "Step N of 5"), and [Show next step →], which becomes [Start chatting] on the last step. Content slides in the direction of travel.
- **Keys**: Esc finishes, → and ← step, and focus stays in the card.
- **Steps**:
  1. **Projects and chats**: "The sidebar lists your projects and chats. Each request becomes a chat you can return to."
  2. **Say what you want**: "Type what you want in plain words and press Enter to send. Commands are optional shortcuts."
  3. **How much omp does on its own**: "This setting controls how much omp does before asking you. Auto lets omp edit files and run commands without approval, so commit or back up your work before you use it."
  4. **Watch the work**: "This panel shows files, diffs, previews and helpers while omp works." The dock opens for this step and closes again afterwards.
  5. **Context and cost**: "The status bar shows context use and cost. Click an item for details."
- The tour can be replayed from Help → "Show the tour again".

### 4.3 Project home

Shown when a project is selected and no chat is open.

- **Layout**: a column up to 920px, with a container query that moves Git and Instructions into a side column once it is 46rem wide.
- **Header**:
  - The project name as the heading (28px bold, −0.02em).
  - A meta row joined by "·": branch in mono, "{n} changed files" (or "no changes" or "not a git project"), "{n} chats this week" and "{cost} this week".
  - Actions: [Chat in another folder…], primary [Start chat] and a "Project options" menu: Project settings…, Project instructions…, Import a chat…, Show in folder, and Remove project from list.
- **Sections** are a heading row and their content, without boxes:
  - **Recent chats**: 40px rows with a `ChatStatusMark`, the title, a "read-only" chip when another window has the chat, and the age. After five rows, "Show all {n} chats" opens the rest.
  - **Start from an example**: a list of example prompts that fill the composer: Fix a bug, Build a feature, Explain this, Clean up, Add tests, Fix mobile layout.
  - **Git**: branch and `+N −N`, the sync state, a checks chip (passing, running, failing) and "Show changes". A folder outside git reads "This folder isn't a git project yet…" with [Set up git].
  - **Instructions**: the instructions file and size, or "No instructions yet", with [Edit instructions] or [Write instructions] and the rules count.
- **Other states**:
  - With no projects, an empty state shows the 48px mark: "No projects yet. A project is a folder that omp works in." It offers [Open folder…], [Create project] and primary [Start chat in folder…].
  - A project whose folder is missing reads "Can't find “{name}”" and offers [Find folder…] or [Remove project from list].

### 4.4 New project wizard

A 560px dialog with three steps: "New project", "Details" and "First chat". Step dots sit beside "Step N of 3", and the steps slide in the direction of travel.

1. **Where?** One bordered list of three options, each with a native radio: "Empty folder" (Start fresh in a new folder), "Open existing" (Use a folder already on this computer) and "Clone from GitHub" (Download a project from a GitHub link). The selected option is filled with `--accent-muted`.
2. **Details**, depending on the kind:
  - Empty folder: project name and location.
  - Open existing: a folder picker and "Recent folders". A folder that is already a project gets a warn note, "This folder is already a project, so it opens instead."
  - Clone from GitHub: a GitHub link field that confirms "Found: {repo}" in `--ok`, then the folder name.
3. **First chat**: "Start a chat right away", with an optional first message.

- **Footer**: [Go back], [Cancel] and the primary action: [Continue setup], then [Create project] or [Open project].
- **Keys**: Enter advances; in a text area, ⌘/Ctrl+Enter does. Esc asks before discarding: "Discard this project?"
- **States**: errors show inline on `--err-bg`, and cloning shows a progress bar with its phase.

### 4.5 Empty chat (new session)

A centered block up to 520px:

- The 40px mark.
- The heading "What should we work on?", or "What should we work on next?" once you have other chats (24px bold).
- On the first chat only, the tip "Describe the change in plain words, or start from an example."
- Four example rows, each a title with a one-line example below it:
  - "Fix a bug"
  - "Build a page"
  - "Explain this project"
  - "Clean up this folder"
  Clicking one fills the composer without sending.
- The hint "Type @ to mention a file. Start a message with / to run an omp command."

### 4.6 Live chat, mid-stream

```
│                                         You · 14:32 │
│              ┌────────────────────────────────────┐ │
│              │ The checkout total is wrong when a │ │ user bubble, right-aligned
│              │ coupon is applied. Can you fix it? │ │
│              └────────────────────────────────────┘ │
│ ›▟ claude-sonnet-4-5 · 14:32                        │ turn header, 18px mark
│ I'll trace how coupons reach the total.             │ streamed markdown
│ ⌕ Searched for “coupon”                          ✓  │ tool step rows
│ ✎ Edited 2 files                          +9 −4  ✓  │
│ ▭ Running npm test…                              ●  │ running: accent icon, pulse dot
│                                                     │
│ ● Working… 14s · Running npm test…      ■ Stop omp  │ working row above the composer
```

- **Working row**: while omp works it opens (with `Expand`) just above the composer.
  - It shows the accent pulse dot, "Working… {elapsed}", and the current step's summary, or "Thinking…" when no text is streaming.
  - [Stop omp] sits on the right.
  - It is not a live region, and the tab and sidebar row show the working mark.
- **Streaming**: text streams with the 2px caret. Live tool rows rise in as they start; history renders at rest.

### 4.7 Tool steps

Each tool call is a borderless 32px row. Consecutive rows stack with no gap.

- **Row**: a tool icon (`--fg-faint`, or `--accent` while running), the friendly summary in `--text-md` (`--fg-muted`, or `--fg` on hover and while running), `+N −M` for edits, and a 16px status slot.
- **Status slot**: the pulse dot while running, a bold check in `--fg-faint` when done, and a bold cross in `--err` ("Failed") on failure. Each status has its own shape.
- **Caret**: appears on hover and opens the row.
- **Open row**: shows the model's intent line and omp's own rendering of the call. Verbose adds the raw JSON arguments and starts rows open.
- **Running output**: a running command's last output shows in a small `--bg-inset` well under its row.

| Tool | Icon | Summary while running / done / failed |
|---|---|---|
| edit | `PencilSimpleLine` | "Editing {file}…" / "Edited {file}" (or "Edited {n} files") / "Couldn't edit {file}" |
| write | `FilePlus` | "Writing {file}…" / "Wrote {file} ({lines} lines)" / "Couldn't write {file}" |
| read | `BookOpen` | "Reading {file}…" / "Read {file}" / "Couldn't read {file}" |
| grep, search | `MagnifyingGlass` | "Searching for “{pattern}”…" / "Searched for “{pattern}”" / "Search for “{pattern}” failed" |
| glob, find | `FileMagnifyingGlass` | "Looking for files…" / "Listed files matching “{pattern}”" / "Couldn't list files" |
| bash | `TerminalWindow` | "Running {command}…" / "Ran {command}" / "{command} failed with exit code {code}" |
| task (helpers) | `Robot` | "Helper “{agent}” is working…" / "Helper “{agent}” finished" / "Helper “{agent}” failed" |
| todo | `ListChecks` | "Updated the checklist" / "Checklist: {done} of {total} done" |
| web search, fetch | `Globe` | "Searching the web for “{query}”…" / "Searched the web for “{query}”" / "Web search failed" |
| eval | `CodeSimple` | "Running Python…" / "Ran Python" / "Python raised an error" |
| other tools | `Wrench` | "Using {tool}…" / "Used {tool}" / "{tool} failed" |

The full set of patterns is in `i18n/en/tools.json` and `chat/friendly.ts`.

### 4.8 Question and approval card

Shown after the stream whenever omp asks a question or needs approval.

- **Card**: `--panel`, 1px `--border`, `--radius-lg`, 16px padding, `--shadow-card`. It has an 18px icon beside the title and no side rail or eyebrow. It rises in and leaves once the question is answered.
- **Choice**: `Question` icon in accent, the title and omp's help text (or "Choose any that apply").
  - Options are 48px bordered tiles in a two-column grid, each with a radio or checkbox that scales in.
  - For single choice, the `--accent-muted` highlight slides between options.
  - Arrow keys, Home and End move between options, and a double-click answers a single choice at once.
  - An "Other" field accepts a typed answer.
  - Footer: omp's optional "Chat about this", [Skip question], and [Send answer] (or [Send choices]).
- **Approval**: `ShieldWarning` in `--warn`, "Permission needed", the request in a mono `--bg-inset` well, then [Deny action] and primary [Allow action].
- **Text answer**: a text area ("Type your answer…"), with [Skip question] and [Send answer].

### 4.9 Plan review card

Shown at the end of the transcript while a plan waits for a decision.

- **Card**: a 12px-radius card with `ClipboardText` in accent, the plan's first heading as the title (or "Untitled plan") and "omp is waiting for your approval before it starts."
- **Plan body**: [Hide plan] or [Show plan] toggles the rendered plan (up to 384px, scrolling). With more than one role, "Continue with" offers a role switcher.
- **Footer**:
  - primary [Approve and run]
  - [Approve and compact first], with a "Frees context" chip at 60% context or more
  - a [More options] menu: Refine with a comment, Approve and keep context, Switch to Auto and run, Discard plan
  - [Save and stop]
- **After a decision**, the card gives way to a status line, for example "Plan approved. omp is starting the work." The line clears 8 seconds after the run ends.

### 4.10 Command palette (⌘K)

A centered 640px dialog 18vh from the top, on `--bg-overlay` with `--radius-lg`, `--shadow-overlay` and the `--backdrop` scrim.

```
┌──────────────────────────────────────────────────────────────┐
│ ⌕ Type a command or search…                                  │ 48px input row
├──────────────────────────────────────────────────────────────┤
│ Suggested                                                    │ sentence-case group label
│ ▤ Start new chat                                  /new  ⌘N   │ 36px rows
│ ⇲ Compact this chat                           /compact  ⌘⇧C  │
│ Recent chats                                                 │
│ ▤ Fix checkout bug                                           │
├──────────────────────────────────────────────────────────────┤
│ ↑↓ move · ⏎ run · ⌘⏎ open side by side (chats) · esc close   │ footer
└──────────────────────────────────────────────────────────────┘
```

- **Groups**: with an empty query, "Suggested" (the five most used commands) and "Recent chats". While you type: "Actions", "Chats", "Files" and "Settings".
- **Scope**: the palette searches the app's registered commands; slash commands typed in the composer still go to omp. With no match, the last row sends the query to omp as a message.
- **Danger**: danger commands show in `--err` and need ⌘⏎. The first Enter shows "Press ⌘⏎ to run this".

### 4.11 omp terminal sheet

A bottom sheet at 80% of the window height, which can expand to fill the window. It mirrors omp's own terminal screen whenever omp shows a screen the app does not draw natively.

- **Title**: "omp terminal" or "omp terminal: {screen}", with the description "This is omp's terminal screen. Click or type to use it."
- **States**:
  - Reconnecting: a warn strip.
  - Stopped: an error strip with [Restart omp].
  - Starting: "Starting omp…".
  - Read-only: when another window owns the chat, "You can look, but only that window can type."
- **Leaving**: leaving while an omp menu is open asks "Leave this omp screen?", with [Stay on this screen] and [Leave screen].

### 4.12 Settings

A centered 880×640 sheet with a 200px `--bg-inset` tab list and a slide-in `--selected` indicator.

- **Header**: a "Save for" switch between "All projects" and "This project ({name})" appears on the General, Permissions, Models and Advanced tabs.
- **Tabs**:
  - **General**: Permission mode, Transcript view, Voice input, Summarize long chats automatically, and omp's tone.
  - **Appearance**: Theme (Light, Dark, System), a text size slider with a preview sentence, and Reduce motion (Match system, On, Off).
  - **Permissions**: tool-by-tool Default, Ask, Allow or Deny. Tools on Default follow the permission mode.
  - **Models**: default models and a link to Model roles (§4.13).
  - **Providers**: which providers omp can use, and signing in through omp.
  - **Sounds & alerts**: desktop notifications and a test notification.
  - **Shortcuts**: a searchable table of the app's shortcuts.
  - **About**: see below.
  - **Advanced**: a searchable list of every omp setting, with "Changed only" and per-setting reset.
- **About**: the 48px mark beside the large wordmark and "A desktop app for omp, the coding agent."
  - Rows for the visual-omp version (and how it updates), the omp version and channel, the omp location, and the last update check.
  - Actions: [Check for updates], [Read release notes], [Read omp docs] and [Report an issue].
  - When a newer version exists, the row offers [Update visual-omp] or [Update omp].
- **States**:
  - A change made outside the app shows an info banner with [Reload settings].
  - A read failure reads "Couldn't read omp's settings: {reason}", with [Try again].

### 4.13 Model roles

A 960×640 sheet titled "Model roles", with an accent dot while changes are unsaved.

- **Role list**: 240px. Each row has a status dot: accent when a model is set, hollow for "Let omp choose", warn when the model is missing. Then the role id in mono and the model name.
- **Editor**: the role name with its id, "Custom" and "This project" chips, a "Used for:" line, a Model picker (with "Let omp choose instead") and a Thinking level. A missing model shows "This model isn't available. Pick another one."
- **Presets**: "Save as preset" stores the whole set, and each preset can be applied or deleted.
- **Footer**: the unsaved count or scope note, [Revert changes] and [Save roles]. Leaving with changes asks "Discard your changes?"

### 4.14 Helpers

A 960×640 sheet: "Helpers", with the subtitle "Reusable specialists omp can hand work to."

- **Header actions**: [Reload helpers], [Create helper with omp] and primary [New helper].
- **Toolbar**: search, plus a "Show" switch between All, Built-in, All projects and This project.
- **Rows**: 64px.
  - A 32px letter tile on `--bg-inset` in `--fg-muted` mono.
  - The name, scope chip and "Customized" chip. While running, a pulse dot and "Running in {chat}…".
  - The description, a model chip, an on/off switch, and a menu: Edit helper or Customize helper, Duplicate helper, Run helper now, Delete helper.
  - A broken definition file shows a warn tile, "Can't be used" and [Fix file].

### 4.15 Connected tools (MCP)

A right sheet, 880px wide: "Connected tools", with the subtitle "MCP servers let omp use outside tools, such as a database or a ticket tracker." and [Add server].

- **Scope**: a switch between "All projects" and "This project", beside the config path.
- **Rows**: in a bordered list. Each row has:
  - a `StatusDot` with a glyph ("Connected", "Couldn't connect", "Connected, but slow to start", "Turned off" and others)
  - the name and transport
  - the tool count
  - an on/off switch
  - a menu: Test connection, View tools, Edit server, Remove server
  - warn chips for "No tools found. Check the command." and "Needs sign-in"
- **Empty**: "Add a server to let omp use an outside tool, like GitHub, a database or your notes."

### 4.16 Skills and plugins

A right sheet, 960px wide, with Skills and Plugins tabs, search, and a switch between "Installed", "This project" and "Registry" ("Available" for plugins).

- **Skills**: rows with a letter tile, name, scope chip, description and switch. Clicking a row opens a detail drawer: What it does, When omp uses it, Show file, Remove skill.
- **Skill registry**: under "From the skill share registry", rows with install counts and [Install skill].
- **Plugins**: installed plugins show their version and an update chip ("v1.3 → v1.4"). "Install by name" and "From your marketplaces" list what is available.
- **Activity**: installs and updates appear in an Activity list with progress.

### 4.17 Memory

A right sheet, 800px wide: "What omp remembers", with a backend chip and the subtitle "Notes omp keeps between chats so it doesn't start from scratch."

- **Toolbar**: a scope select, search and [Forget everything]. Forget everything asks you to type "forget".
- **List**: 280px, keyboard navigable, beside a reader that shows the entry's kind, dates, tags and content, with [Export memory…] and [Forget this].
- **Empty**: "omp hasn't saved any memories yet."

### 4.18 Usage and limits

A right sheet, 880px wide: "Usage & limits", with the subtitle "What your chats cost this week, and how much of your plan is left."

- **Summary**: Today, This week, Chats and Tokens.
- **"Last 7 days"**: bars in `--accent-2` ink, with today in `--accent`. Each bar has a tooltip with the date, cost and reply count.
- **Plan limits**: provider cards with "{n}% used" and the reset time on bars that turn warn at 70% and err at 90%.
- **"Chats this week"**: a sortable table.
- **Footer**: [Export CSV] and [Open omp stats page]. Costs are marked as estimates at public API prices.

### 4.19 Session tree

A 960×640 dialog: "Session tree", with the 20px mark, the description "Every branch of this chat, from the first message to the current point." and [Close].

- **Canvas**: on `--bg-inset`, 180×40 message nodes with 2px `--border-strong` connectors. The current node has an accent outline, and the selection ring glides between nodes.
- **Navigation**: drag to pan; zoom with ⌘+, ⌘− and ⌘0.
- **Side panel**: a 320px preview of the selected message, with [Rewind to here] or [Resume from here] and [Fork from here].
- **Empty**: "No branches yet. Fork or rewind to try another approach."

### 4.20 Share dialog

A 520px dialog, "Share this chat", with a Link, File and Invite switch.

- **Link**: "Creates an encrypted link. Only people who have the link can read the chat." An optional secret GitHub gist is available. [Create link] returns a link with a copy button.
- **File**: "Save this chat as a web page you can open anywhere." Secrets are masked before export.
- **Invite**: "Let someone watch or join this chat live." [Start sharing] produces two invite links, one to join and one to watch, and a list of the people present with Editor and Viewer chips. [Stop sharing] ends it.
- **While shared**: the session header shows the "Shared" chip (§3.4).

### 4.21 Help

A 720×560 dialog: "Help", with the subtitle "Short guides and definitions of the terms visual-omp uses."

- **Contents**: search, then "Guides" and "Glossary".
- **Guides**: Your first chat, Staying safe with Auto mode, Rewinding and forking, and When omp asks questions. Each opens a four-step article.
- **Glossary**: 13 terms.
- **No match**: "No matches. Ask omp instead." with [Ask omp].
- **Footer**: [Show the tour again], [Keyboard shortcuts], [omp docs] and [Report a problem].

### 4.22 System surfaces

**Update notice**: an info toast (§5.7) titled "visual-omp v{version} is available" with the line "The release notes list what changed." Its action row holds [Dismiss notice] (quiet) and [Update visual-omp] (accent). Settings → About lists both versions and updates visual-omp and omp from one place. The strings live in `i18n/en/onboarding.json` (`update.*`) and `manage.json`, which are authoritative over this summary.
**Quit-warning dialog**: a modal shown when quitting or closing a tab while omp is working. Warn glyph, title "omp is still working in N chats." (or "in 1 chat."), body "Your chats pick up where they left off next time.", actions [Keep waiting] and [Stop and quit] (danger), and the checkbox "Always stop working chats when quitting". The strings live in `i18n/en/onboarding.json` (`quit.*`).
**Notifications**: native OS notifications (macOS Notification Center, Windows). The title is the chat title and the body a one-line outcome ("Finished: Edited 3 files and tests pass ✓" or "Needs your answer"). Clicking one focuses the window and the chat and scrolls to the card. There is no in-app notification center; the sidebar `!` badges serve as the inbox.
**In-app toasts**: see §5.7 for geometry, the action row, timing and motion.

---

## 5. Component library spec

These primitives live in `src/renderer/src/ui/` and are imported from `@/ui`. Colors always come from tokens. Every interactive component has a `:focus-visible` ring (§1.8); icon-only controls carry a tooltip and an `aria-label` that matches it; disabled means 45% opacity and a `not-allowed` cursor, never hidden. Icons are Phosphor (`@phosphor-icons/react`). `App` mounts `IconContext` with size `1em`, regular weight and `currentColor`, so callers size icons with `size-*` classes and pass `weight` only to deviate (`bold` for heavier strokes, `fill` for solid status glyphs).

### 5.1 Buttons

| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--accent`, hover `--accent-hover`, active `--accent-active`, `--shadow-primary` | `--accent-fg` | none | the main action on a surface |
| Secondary | `--panel`, hover `--bg-inset`, active `--selected`, `--shadow-card` | `--fg` | 1px `--border-strong` | default action |
| Ghost | transparent, hover `--hover`, active `--selected` | `--fg-muted`, `--fg` on hover | none | toolbars, headers |
| Danger | `--err`, hover `--err-hover`, `--shadow-primary` | `--fg-inverse` (near-white in light, near-black in dark; 5.9:1 and 7.1:1) | none | destructive confirmation |
| Danger-ghost | transparent, hover `--err-bg` | `--err` | none | destructive rows in menus and lists |

Sizes: sm 28px / 12px padding / `--text-sm`; md 32px / 14px / `--text-md`; lg 40px / 18px / `--text-md` 600. Radius `--radius`. Icon gap 6px, icon 16px (14px in sm). Press feedback: `scale(0.98)`; primary lifts 1px on hover. Transitions use `--dur-fast` and `--ease-out-quart`. `loading` sets `aria-busy`, ignores clicks and overlays a spinner; the label turns transparent at the same width, so it stays in the accessibility tree and the button keeps its name.

### 5.2 Icon buttons and tooltips

`IconButton`: 28px square (sm 24px, lg 32px), `--radius`, ghost or secondary styling, 16px icon, same press feedback as Button. Every icon button carries a tooltip: 11px/500 `--fg` on `--bg-raised`, 1px `--border`, `--shadow-pop`, `--radius-sm`, 6px padding, 8px offset, 400ms hover intent, optional shortcut in `--fg-faint` mono ("Restart · ⌘R"). Programmatic focus does not open the tooltip; keyboard focus does. Menus, popovers and tooltips render in `--z-tooltip`.

### 5.3 Chips, badges and status dots

Chip: 24px tall, `--radius-full`, 10px horizontal padding, `--text-xs` 500. Tones: `accent` and `agent` (`--accent-muted` + `--accent`), `blue` (neutral ink: `--accent-2-muted` + `--accent-2`), `ok`, `warn`, `err` (their `-bg` + text tokens) and `neutral` (`--hover` + `--fg-muted`). Optional 6px dot, 12px icon, and a remove button with a 24px target.

Badge (count): 16px minimum height, 6px padding, `--accent` + `--accent-fg`, `--err` + `--fg-inverse`, or `--selected` + `--fg-muted`.

StatusDot: 8px dot with sr-only text; `live` pings (static under reduced motion). Color alone never carries status: where the dot is the only signal, pass `glyph` (a 14px check, triangle, cross, broadcast, ring or sparkle per status) or `showLabel` (visible text beside the dot).

### 5.4 Segmented controls

Track `--bg-inset`, 1px `--border`, `--radius`, 2px padding. Segments 26px (24px in sm), `--radius-sm`, `--text-sm` 500 `--fg-muted`, selected `--fg`. The selected fill is one shared element (`--panel`, 1px `--border`, `--shadow-card`) that slides to the chosen segment; its `layoutId` is unique to the control instance. Arrow keys move between segments; the selected segment cannot be deselected.

### 5.5 Menus and popovers

Radix DropdownMenu and ContextMenu share one style: min width 200px, `--bg-raised`, 1px `--border`, `--shadow-pop`, `--radius`, 4px padding. Rows 30px, 8px padding, `--radius-sm`, `--text-md`, 16px leading icon, shortcut right in `--fg-faint` mono, destructive rows `--err`, 1px `--border` separators, group labels in sentence case (`--text-sm` 500 `--fg-muted`). Submenus open with a caret. Popover uses the same surface with `--radius-lg` and 12px padding. Select lists match the trigger width.

Motion: open scales 0.96 → 1 on the snappy spring from the Radix transform origin and drifts 4px away from the trigger; close fades and scales to 0.97 over `--dur-fast`.

### 5.6 Dialogs and sheets

Dialog: centered with translate utilities, widths 400 / 480 / 560 / 720px, `--bg-overlay`, 1px `--border`, `--radius-lg`, `--shadow-overlay`, 20px padding. The scrim is `--backdrop`, a translucent dimming wash (alpha 0.32 in light, 0.6 in dark) with no blur; only the window chrome is opaque. Click outside or Esc cancels; `destructive` dialogs show a warning glyph and ignore scrim clicks. Title 16/600, body `--text-md`, footer right-aligned with 8px gaps. Opens with a spring scale 0.95 → 1 and fade; closes with a short scale-down.

Sheet: docked right (default width 480px) or bottom (default 60vh), 8px from the window edges, `--bg-overlay`, 1px `--border`, `--radius-lg`, `--shadow-overlay`. 48px header (title, actions, close), scrolling body, optional sticky footer. Slides in from its edge on the gentle spring and slides partway back while fading on close. Both trap focus and return it on close.

### 5.7 Toasts

Bottom-right stack of up to three, 320px wide (never wider than the window minus 32px), `--bg-raised`, 1px `--border`, `--shadow-pop`, `--radius-lg`. Row one holds the tone icon, the message (13px/500) and description (12px `--fg-muted`), and the close button. Message and description wrap anywhere, so long versions and file names never push the close button out. When a toast has actions, they sit in their own right-aligned, wrapping row below: the quiet `secondaryAction` first, then `action` in accent. Both dismiss the toast. info and ok toasts dismiss after 5 seconds unless sticky, and hover or focus pauses the timer; warn and err stay until dismissed. Toasts rise in on the gentle spring, the stack reflows with layout animation, and a rightward swipe (past 80px or 500px/s) throws a toast off.

### 5.8 Tabs

Underline variant: 28px (sm, window tabs) or 32px (md, dock tabs), 1px `--border` baseline, active text `--fg`. Pill variant: 24 or 28px pills, active fill `--selected`. The active marker (2px `--accent` underline, or the pill fill) is one element that slides between triggers; its `layoutId` comes from `useId()` in each `Tabs` instance. Triggers rendered outside `Tabs` fall back to a static marker. Overflowing window tabs collapse into a "N more" menu and never scroll horizontally.

### 5.9 List rows

36px (comfortable) or 30px (compact), 8px padding, hover `--hover`, selected `--selected`. Leading icon or avatar 16-20px, trailing meta `--text-xs` `--fg-faint`, single-line ellipsis. Right-click opens the same menu as the row's overflow button. The fill shows selection; rows do not get colored side bars.

### 5.10 Cards

`--panel`, 1px `--border`, `--radius-lg` (12px, the maximum for cards), 16px padding (12px for `padding="sm"`). No shadow at rest. `floating` adds `--shadow-card`; `interactive` lifts 1px and strengthens the border on hover. `rail` tints the hairline toward a tone (accent, ok, warn, err, info); pair it with a glyph or text. `working` is the working state (§5.16).

### 5.11 Inputs

Text input: 32px (28 sm, 40 lg), `--panel`, 1px `--control-border`, `--radius`, 10px padding, `--text-md`. Hover `--fg-muted` border; focus `--ring` border plus the 2px outline; placeholder `--fg-faint`; error `--err` border and a 12px `--err` message with ▲. Search input: `--bg-inset` fill, leading magnifier, Esc clears, clear button when filled. Textarea grows between `minRows` and `maxRows`. The Select trigger matches the text input, and its caret turns when the list opens.

### 5.12 Toggles, checkboxes and radios

Switch: 40×22 track, `--radius-full`, off `--control-border`, on `--accent`; 18px `--panel` thumb with `--shadow-card`. The thumb travels 18px on the spring and stretches to 22px toward its destination while pressed. With a label it renders a settings row: label left, description below, switch right.

Checkbox and radio: 16px box (radio round), 1px `--control-border`, `--panel` fill, checked `--accent`. A padded 24px pointer target surrounds the box, and the label text is clickable. The check draws itself in; the box presses to 0.9. Indeterminate shows a bold minus. Radio groups are native, so arrow keys move and select.

### 5.13 Sliders

Track 4px `--control-border`, fill `--accent`, thumb 16px `--panel` with a 2px `--accent` border and `--shadow-card` (24px hit area). A mono 11px value bubble shows above the thumb while dragging or keyboard-focused.

### 5.14 Progress

Determinate bar: 6px, `--radius-full`, `--border-strong` track, `--accent` fill that follows the value on the gentle spring. Indeterminate: a 120px and a 48px segment sliding across in a 1.2s loop; under reduced motion one full-width segment fades instead. Step dots: 8px, done `--accent`, current `--accent` with a ring and ping, todo `--control-border`.

### 5.15 Spinner

14px arc, 2px stroke, `--accent` (or the current text color inside filled buttons), 0.8s rotation, static under reduced motion. Use it for button and inline loads up to about two seconds; longer work uses the working indicator (§5.16) or a progress bar.

### 5.16 The working indicator

Shown while omp is working. Motion is never the only signal: it always sits beside text ("Working… 14s", "Running tests").

- **Surface form** (`Card working`, `.vo-working`, and `GlowBorder` for components such as the composer): the 1px border turns accent (a 60% mix) and a 3px accent halo with no blur breathes between 8% and 22% strength over 2s. It uses one color and no travelling gradient.
- **Compact form** (`PulseDot`, `WorkingIndicator`): an 8px solid `--accent` dot pulsing 1 → 0.45 → 1 over 1.6s.
- **Streaming caret**: a 2px `--accent` bar after streaming text, blinking at 1s.
- **Reduced motion**: the halo holds still, the dot freezes at 60% opacity, and the caret stops blinking.

### 5.17 Context-usage ring

20px ring, 2.5px stroke: track `--border-strong`, fill `--accent`, round cap, starting at 12 o'clock. Zones: under 60% `--accent`, 60-80% `--warn`, over 80% `--err` with a slow opacity pulse. The arc eases to new values over `--dur-slow`. Screen readers get `role="meter"` and "62% of context used".

### 5.18 Skeletons

`--selected` fill, `--radius-sm`, breathing opacity (1 → 0.55) over 1.6s; static under reduced motion. Decorative (`aria-hidden`). Never skeleton the composer or buttons.

---

## 6. App icon

The mark is periscope variation C1 "Heavy". The concept files are in `docs/logo-concepts/2-periscope/variants/c-prompt/variations/c1-heavy/` (`mark.svg`, `mark-mono.svg`, `app-icon.svg`, `lockup.svg`, `board.png`). omp runs as a terminal program that visual-omp keeps out of view, and a periscope is the object built for seeing what is out of direct sight. The mark is a shell prompt, `>` and an underscore, with a periscope rising from the underscore. The heavy chevron gives the prompt the same visual mass as the periscope, and the teal lens plate is the only colored part.

### 6.1 Geometry (1024 grid)

| Part | Shape | Color |
|---|---|---|
| Chevron | `M230 600 L342 682 L230 764`, stroke 88, round caps and joins | ink |
| Underscore | rect x 420, y 712, 382×72 | ink |
| Periscope | `M474 392 L650 216 H762 V392 H606 V748 H474 Z` (132px tube, head with a 45° mirror cut) | ink |
| Lens plate | rect x 790, y 234, 48×140, rx 10 | teal |

The shapes span x 186-838 and y 216-808 and are centered on (512, 512). In the app the mark uses the square crop `186 186 652 652`.

| Role | Light | Dark |
|---|---|---|
| Ink | `#141C1C` (`--fg`) | `#E9EEEE` |
| Lens | `#10726F` (`--accent`) | `#5FCCC8` |
| Icon tile | `#F5F7F7` | same tile in both |

### 6.2 Tiles and small sizes

- macOS (`assets/icon-macos.svg`): the 824×824 tile at (100, 100) with a 185 corner radius on the 1024 grid, with the mark at full size. macOS applies its own squircle mask.
- Windows and PNG (`assets/icon.svg`): the 960×960 tile at (32, 32) with a 220 corner radius, with the mark scaled ×1.165 (960 / 824) about the center so it fills the tile the same way.
- At 32px the chevron, the tube and the lens stay distinct. At 16px the drawing reduces to a prompt and a post, with the lens as a single teal point at the top right.
- One-color uses (menu bar template, favicon, print) use `mark-mono.svg`, which in the app is `tone="current"`.

### 6.3 Packaged icons and how to regenerate them

electron-builder reads `build/icon.icns` (macOS) and `build/icon.ico` (Windows). `build/icon-macos.png` and `build/icon.png` are the 1024px sources for those files. To regenerate them after editing the SVGs:

1. Rasterize `assets/icon-macos.svg` to `build/icon-macos.png` and `assets/icon.svg` to `build/icon.png` at 1024×1024 with a transparent background. Headless Chrome works: load the SVG in a page and take a Puppeteer screenshot with `omitBackground: true`. Quick Look (`qlmanage`) adds a white background, and Chrome's `--screenshot` flag writes the file but never exits.
2. Build the iconset and the `.icns`:
   ```sh
   mkdir icon.iconset
   for s in 16 32 128 256 512; do
     sips -z $s $s build/icon-macos.png --out icon.iconset/icon_${s}x${s}.png
     sips -z $((s*2)) $((s*2)) build/icon-macos.png --out icon.iconset/icon_${s}x${s}@2x.png
   done
   iconutil -c icns icon.iconset -o build/icon.icns
   ```
3. Resize `build/icon.png` to 256px with `sips` and write it into `build/icon.ico` as a single PNG entry: a 6-byte header (0, type 1, count 1) plus one 16-byte directory entry (width and height 0, 1 plane, 32 bpp, the PNG's byte length, offset 22), followed by the PNG bytes.
4. Check that the PNG corners are transparent and view the 16px iconset entry.

---

## 7. Brand surfaces

### 7.1 README hero banner

`assets/hero.svg` (1500×540) is the source and `assets/hero.png` (3000×1080) is the image `README.md` shows. The canvas is flat `#F4F7F7` (`--bg`). The C1 lockup, the title-bar lockup from the concept files scaled ×6 (a 108px mark and the `visual-omp` wordmark outlined in Geist Mono 600), sits at (417, 175). Below it, centered on a baseline at y 365, one line in Geist 400 24px `#4D5857` (`--fg-muted`) reads "A desktop app for omp, the AI coding agent." There is no gradient, grid, glow or eyebrow, and the teal lens is the only accent.

The PNG is rendered at 2× in headless Chrome with Geist embedded through `@font-face`, since the tagline is live text and GitHub displays the PNG.

---

## 8. Microcopy

Every string follows the voice guide:
- Plain words in sentence case, with no exclamation marks and no dashes.
- Buttons name a verb and an object ("Start chat", "Allow action").
- A tooltip is one sentence that says what happens.
- An empty state is a heading and at most one sentence.

The strings live in `src/renderer/src/i18n/en/`. Those files are authoritative, and the tables below quote them.

### 8.1 Commands and their hints

| Command | Hint |
|---|---|
| Restart omp | "Restart the omp process for this chat. The chat history is kept." |
| Compact this chat | "Summarize the chat so far to free context space." |
| Plan mode | "omp drafts a plan for your approval before it changes anything." |
| Set a goal | "Describe the outcome you want. omp plans the steps and works toward it." |
| Guided goal | "omp asks a few questions, then sets up a goal." |
| Vibe mode | "omp directs background helpers that do the editing and running, then checks their work." |
| Repeat a task | "Repeat a request a set number of times, for a set time, or until a check passes." |
| Toggle advisor | "Turn the advisor on or off. It is a second model that reviews each turn and adds notes." |
| Write a handoff | "Summarize this chat into a handoff document and continue from it with less context." |
| Rewind to here | "Go back to this point. The original path stays in the tree as a branch." |
| Fork chat | "Copy this chat into a new one to try another direction." |
| Fork from here | "Start a new chat from this message and leave this one unchanged." |
| Open session tree | "Show every branch of this chat as a map." |
| Share chat… | "Send someone a link or a file of this chat." |
| Export chat | "Save this chat as an HTML file." |
| Run security scan | "Start omp's security scan for this project." |
| Cleanse project | "Find and fix errors and warnings across the project with parallel helpers." |
| Connected tools | "Connect outside tools, like a database or ticket tracker, so omp can use them." |
| Skills & plugins | "Install and manage the skills and plugins omp can use." |
| Memory | "View and delete what omp has remembered between chats." |
| Usage & limits | "See what your chats cost and how close you are to your plan's limits." |
| Review code (Diff pane) | "Ask omp to review these changes for bugs (runs /review)." |
| Permission pill | "How much omp may do before it asks you." |
| Send now (while omp works) | "Send this now. omp reads it at its next step, before this reply finishes." |

### 8.2 Empty states

- **No projects**: "No projects yet. A project is a folder that omp works in." with [Create project].
- **No chats in a project** (sidebar): "No chats yet. New chats in this project appear here." On the project home: "No chats in this project yet."
- **Empty chat**: "What should we work on?" (or "What should we work on next?"). The first chat adds "Describe the change in plain words, or start from an example."
- **Diff pane**: "No uncommitted changes" and "Edits made since your last commit appear here, whether omp or you made them."
- **Tasks pane**: "Nothing running" and "omp's checklist, helpers and background jobs appear here while a chat works."
- **Preview pane**: "Nothing to preview" and "Type a local address above, or start a dev server in this chat to get a link."
- **Terminal pane**: "No terminal open" and "Run your own commands in this project. These shells are separate from omp's."
- **Chat search**: "No chats match '{q}'."
- **Memory**: "omp hasn't saved any memories yet."
- **Usage**: "No usage yet this week. Costs appear here after your first chats."

### 8.3 Example prompts (empty chat)

Clicking an example fills the composer without sending it.

1. **Fix a bug**: "The checkout total on my site is wrong when a coupon is applied. Find the cause and fix it."
2. **Build a page**: "Build a contact page for this project with a form that checks the email address is valid."
3. **Explain this project**: "Explain what this project does and how its main parts fit together, in plain language."
4. **Clean up this folder**: "Find unused files and duplicated code in this folder. List them and ask me before deleting anything."

The project home lists six shorter starters: Fix a bug, Build a feature, Explain this, Clean up, Add tests, Fix mobile layout.

### 8.4 Confirmations and guardrails

- **Quit while working**: "omp is still working in {n} chats." with "Your chats pick up where they left off next time." and [Keep waiting] / [Stop and quit].
- **Close a working tab**: "Closing stops the current step. The chat is saved and picks up where it left off when you open it again."
- **Delete chat**: "Delete '{title}'?" with "This removes the saved conversation from this computer. You can't undo it." and [Keep chat] / [Delete chat].
- **First switch to Auto**: "Turn on Auto?" with "Auto lets omp edit files and run commands without asking. Use it only in projects you trust." and [Turn on Auto].
- **Discard a file's changes** (Diff pane): "The file goes back to how it was at your last commit. You can't undo this."
- **Read-only chat**: "Replies are off here while another omp window may have this chat open."

---

*End of spec. Tokens in §1 are the single source of truth; implementation maps them 1:1 into Tailwind v4 `@theme` and never hardcodes a raw color outside `theme/`.*
