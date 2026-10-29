# visual-omp design specification

Every value in this document is exact. Implementation stack: React + Tailwind v4 (CSS-variable tokens via `@theme`), Radix primitives, Phosphor icons (`@phosphor-icons/react`), `motion` for animation, xterm.js.

---

## 0. Design direction

visual-omp is a working tool with a consistent app-wide system. Light mode is the default: an ink sidebar band and status bar frame a light main sheet, with rounded left corners; the gray page canvas and floating side panel remain distinct surfaces. Dark mode preserves this hierarchy with darker surfaces. One teal accent marks actions and selection, with stronger border tokens defining boundaries. Settings, Usage & limits, Help and project screens open as pages in the main area.

1. **Surface hierarchy.** Near-neutral surfaces use a faint teal cast. The ink chrome is a deliberate exception to the near-neutral palette. In dark mode, chrome is darkest, followed by canvas, sheet, cards and raised layers. A two-tone backdrop veil remains visible over both the sheet and chrome.
2. **Proportional radii.** Components use the shared radius scale and concentric rounding rule (§1.10). Spacing follows named steps (§1.11), with documented compact-control exceptions.
3. **One accent.** Teal (`--accent`) marks primary actions, links, focus and selected states. Secondary emphasis uses neutral ink (`--accent-2`), and agent-attributed UI uses the accent (`--agent` resolves to it). The mark and app icon are ink with a teal lens plate.
4. **Honest work summaries.** Work cards use omp's available todo, helper, job and tool data. Edit totals come from omp edit and write results and retain their partial-data labels.
5. **Motion with a job.** JavaScript animation uses the presets and components in `src/renderer/src/ui/motion.tsx`. Reduced motion is respected. Surfaces do not use gradients, glass, eyebrow labels, side stripes, nested cards or repeated identical card grids. The one card-row exception is Home's three section cards (§4.24), which the owner chose for clearer separation between the sections.
6. **Status is shape plus color.** Status colors pair with an icon or glyph, so color is not the only signal.

---

## 1. Design tokens

All colors are authored in OKLCH in `src/renderer/src/theme/tokens.css`, the only file allowed to hold raw color values. Hex values below are how Chromium renders them, for reference. Surfaces use hue 195 at very low chroma; the accent uses hue 192. Tailwind v4 mapping: every token is re-exposed in `@theme inline` as `--color-*`, `--radius-*` and `--font-*`.

### 1.1 Surfaces, light (default)

| Token | Value | Used for |
|---|---|---|
| `--chrome-bg` | `oklch(0.21 0.008 195)` | ink sidebar band and status bar |
| `--chrome-line` | `oklch(0.95 0.01 195 / 0.14)` | divider on ink chrome |
| `--sheet` | `oklch(0.998 0.001 195)` | title bar and chat area |
| `--canvas` | `oklch(0.966 0.004 195)` | page interiors and side-panel gap |
| `--bg` | `var(--canvas)` | current surface, re-declared by sheet and chrome regions |
| `--panel` | `oklch(0.997 0.001 195)` | cards and floating side panel |
| `--bg-inset` | `oklch(0.953 0.005 195)` | inset wells and controls |
| `--bg-raised` | `oklch(0.998 0.001 195)` | menus, popovers, tooltips and toasts |
| `--bg-overlay` | `oklch(0.998 0.001 195)` | dialogs and sheets |
| `--backdrop` | `oklch(0.36 0.012 195 / 0.42)` | visible veil over sheet and chrome |

The page canvas is gray, with grouped content on white cards. The main sheet has 12px rounded left corners where it meets the ink band. The side panel is a separate rounded floating sheet.

### 1.2 Surfaces, dark

| Token | Value | Hex or role |
|---|---|---|
| `--chrome-bg` | `oklch(0.145 0.005 195)` | darkest chrome |
| `--canvas` | `oklch(0.188 0.006 195)` | page canvas and panel gap |
| `--sheet` | `oklch(0.21 0.007 195)` | main chat sheet |
| `--panel` | `oklch(0.235 0.007 195)` | cards and floating side panel |
| `--bg-inset` | `oklch(0.163 0.005 195)` | inset wells |
| `--bg-raised` | `oklch(0.255 0.008 195)` | raised surfaces |
| `--bg-overlay` | `oklch(0.265 0.008 195)` | overlays |
| `--backdrop` | `oklch(0.2 0.006 195 / 0.62)` | visible veil over sheet and chrome |

The hierarchy progresses from chrome to canvas, sheet, cards and raised layers. `[data-region="chrome"]` re-declares semantic ink tokens, including text, status, border, accent and focus values, so components keep using their normal semantic classes. It also defines `--page-card` (`oklch(0.65 0.09 192)`, `#3FA19D`), the fill of the sidebar's header card while a page is open (§3.2). The owner chose this teal with white text, accepting that white reads only 3.1:1 on it, below the 4.5:1 the rest of the app meets. Inside the filled card, `[data-page-card="filled"]` makes text, the version and the mark white, the hover wash darkens the fill (12% black) the way a filled button's hover does (white reads 3.9:1 on it), and the focus ring is ink (`--fg-inverse`, 6.1:1 against the fill), since a white ring would not show clearly on it. The Electron window background follows the selected theme.

### 1.3 Text

| Token | Light | Dark | Role |
|---|---|---|---|
| `--fg` | `oklch(0.22 0.012 195)` `#141C1C` | `oklch(0.945 0.005 195)` `#E9EEEE` | body, titles |
| `--fg-muted` | `oklch(0.45 0.013 195)` `#4D5857` | `oklch(0.745 0.01 195)` `#A6AEAE` | secondary labels, metadata, section labels |
| `--fg-faint` | `oklch(0.535 0.012 195)` `#66706F` | `oklch(0.645 0.011 195)` `#869090` | placeholders, timestamps, shortcuts |
| `--fg-inverse` | `oklch(0.995 0.002 195)` | `oklch(0.18 0.006 195)` | text on `--err` fills |

This section lists the semantic text tokens and their roles. It does not report measured contrast ratios.

### 1.4 Accent

| Token | Light | Dark | Job |
|---|---|---|---|
| `--accent` | `oklch(0.5 0.082 192)` `#10726F` | `oklch(0.78 0.1 192)` `#5FCCC8` | primary action, links, active tab and selection marker, the mark's lens plate |
| `--accent-hover` | `oklch(0.45 0.076 192)` | `oklch(0.84 0.09 192)` | hover of the above |
| `--accent-active` | `oklch(0.405 0.07 192)` | `oklch(0.89 0.07 192)` | pressed |
| `--accent-fg` | `#FFFFFF` | `oklch(0.2 0.03 192)` | text on filled accent |
| `--accent-muted` | `oklch(0.95 0.022 192)` | `oklch(0.29 0.04 192)` | tinted chip and badge background |
| `--accent-2` | `oklch(0.4 0.014 195)` | `oklch(0.83 0.01 195)` | neutral ink for secondary emphasis: @-mentions and the `blue` chip tone |
| `--accent-2-muted` | `oklch(0.945 0.005 195)` | `oklch(0.27 0.008 195)` | neutral tint behind `--accent-2` text |
| `--agent`, `--agent-muted` | `var(--accent)`, `var(--accent-muted)` | same | agent-attributed UI uses the accent |

Former spectrum aliases remain for compatibility with existing callers. `--mark-a`, `--mark-b` and `--mark-c` resolve to `--accent`. `--mark-gradient` and `--work-gradient` resolve to a flat `linear-gradient(var(--accent), var(--accent))` so any remaining `background-image` caller paints solid teal. `--ambient-a` and `--ambient-b` are `transparent`, which removes the hero washes wherever they are still referenced. `--plug` resolves to `--warn`. `--grid-line` is removed; chart gridlines use `--border`.

### 1.5 Status

Slightly desaturated so status colors sit next to the teal accent without competing with it.

| Token | Light | Dark | Pairs with glyph |
|---|---|---|---|
| `--ok` | `oklch(0.5 0.1 160)` | `oklch(0.77 0.12 160)` | ✓ check |
| `--ok-bg` | `oklch(0.957 0.022 160)` | `oklch(0.26 0.035 160)` | status background |
| `--warn` | `oklch(0.53 0.11 65)` | `oklch(0.8 0.115 80)` | ▲ triangle |
| `--warn-bg` | `oklch(0.962 0.028 78)` | `oklch(0.27 0.035 80)` | status background |
| `--err` | `oklch(0.52 0.16 25)` | `oklch(0.72 0.14 25)` | ✕ cross |
| `--err-bg` | `oklch(0.955 0.02 20)` | `oklch(0.26 0.04 22)` | status background |
| `--err-hover` | `oklch(0.47 0.15 25)` | `oklch(0.78 0.13 25)` | danger button hover |
| `--info` | `oklch(0.52 0.12 255)` | `oklch(0.75 0.1 255)` | ● dot |
| `--info-bg` | `oklch(0.955 0.018 255)` | `oklch(0.26 0.035 255)` | status background |
| `--live` | `var(--ok)` | same | ● pulsing dot, reserved for real-time presence (collab live, session running elsewhere) |

**Project folder colors** are the one place the user picks a color. A project can take one of the seven macOS Finder tag colors, stored per project path in the app preferences (`projectColors`) and painted with `--folder-red`, `--folder-orange`, `--folder-yellow`, `--folder-green`, `--folder-blue`, `--folder-purple` and `--folder-gray`. They are visual-omp's own: they don't set Finder tags or change the folder on disk. One set serves every theme: the folder icons appear on the ink sidebar, where each reads 5.6:1 or more; menu swatches carry a hairline and the color's name, and the wizard's swatches, which are its controls, take the 3:1 control border (§3.2, §4.4).

**Home's ping field** (§4.24) paints with `--plot-dot` (`oklch(0.42 0.013 195)` light, `oklch(0.78 0.009 195)` dark) at low alpha set in the canvas code, and with `--plot-accent` (`var(--accent)`) for the inner band of each ping.

**The activity grid** (§4.18) shades its days with `--heat-0` to `--heat-4`, mixed in `tokens.css` from the theme's own tokens so one set serves both themes: `--heat-0` is 7% `--fg` over `--panel` (a day with no requests), `--heat-1` to `--heat-3` are 28%, 50% and 75% `--accent` over `--panel`, and `--heat-4` is `--accent`.

### 1.6 Diff

| Token | Light | Dark |
|---|---|---|
| `--diff-add-bg` | `oklch(0.962 0.025 160)` | `oklch(0.24 0.035 160)` |
| `--diff-add-line` | `oklch(0.925 0.045 160)` | `oklch(0.29 0.045 160)` |
| `--diff-add-text` | `oklch(0.47 0.1 160)` | `oklch(0.8 0.12 160)` |
| `--diff-del-bg` | `oklch(0.958 0.02 22)` | `oklch(0.245 0.04 22)` |
| `--diff-del-line` | `oklch(0.925 0.04 22)` | `oklch(0.29 0.055 22)` |
| `--diff-del-text` | `oklch(0.5 0.15 25)` | `oklch(0.79 0.12 20)` |
| `--diff-hunk-bg` | `oklch(0.95 0.006 195)` | `oklch(0.232 0.007 195)` |
| `--diff-hunk-text` | `var(--fg-muted)` | same |

### 1.7 Syntax highlighting (code blocks, diffs, file viewer)

Code uses muted hues to distinguish syntax tokens.

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
| `--border` | `oklch(0.3 0.02 195 / 0.14)` | `oklch(0.95 0.01 195 / 0.12)` | hairlines: panel edges, separators, cards |
| `--border-strong` | `oklch(0.3 0.02 195 / 0.22)` | `oklch(0.95 0.01 195 / 0.2)` | secondary button outlines, hovered cards, keycaps, progress track |
| `--control-border` | `oklch(0.62 0.012 195)` | `oklch(0.56 0.012 195)` | boundaries for checkboxes, radios, switches, inputs, selects, sliders and todo step dots |
| `--ring` | `oklch(0.56 0.09 192)` | `oklch(0.78 0.1 192)` | focus ring |
| `--ring-soft` | `oklch(0.56 0.09 192 / 0.18)` | `oklch(0.78 0.1 192 / 0.24)` | text selection and ring halo |

Focus style, everywhere: `outline: 2px solid var(--ring); outline-offset: 2px;` on `:focus-visible`. Every focusable control keeps this outline, and focus is always marked by more than a color change. Card tone (`Card rail`) tints the hairline toward the tone color, mixed in sRGB; there is no colored left stripe.

The theme-token source requires `--control-border` to meet the 3:1 non-text contrast target across common control surfaces. This specification omits per-pair measured ratios.

The focus ring remains visible on interactive controls, and status colors are paired with glyphs or labels so color is not the only cue.

### 1.9 Elevation & shadows

Shadows are tinted with the surface hue (`--shadow-tint`). Panels on the canvas use no shadow; they rely on `--border`.

| Token | Light | Use |
|---|---|---|
| `--shadow-card` | `0 1px 1px` tint / 0.05 | buttons, segmented thumb, cards marked `floating` |
| `--shadow-pop` | `0 1px 2px` / 0.06, `0 8px 16px -6px` / 0.18 | menus, popovers, tooltips, toasts |
| `--shadow-overlay` | `0 2px 4px` / 0.06, `0 12px 12px -8px` / 0.2 | dialogs, sheets, palette |
| `--shadow-primary` | `inset 0 1px 0` white / 0.14, `0 1px 1px` / 0.18 | primary and danger buttons |
| `--work-glow` | `0 0 0 3px` accent / 0.14 | working halo (spread only, no blur) |

Light tint is `oklch(0.28 0.03 195)`; dark tint is `oklch(0.06 0.01 195)` at higher opacities (0.4 to 0.6) with the same geometry.

### 1.10 Radii

| Token | Value | Role |
|---|---|---|
| `--radius-sm` | `6px` | compact controls, row insets and small surfaces |
| `--radius-md` (`--radius`) | `8px` | controls and menus |
| `--radius-lg` | `12px` | cards and sheets |
| `--radius-xl` | `14px` | larger controls and overlays |
| `--radius-full` | `999px` | pills, toggles, avatars and dots |

The scale is sm 6, md 8, lg 12, xl 14 and full. Use concentric radii: an inset rounded element uses the outer radius minus its inset. For example, a 12px menu with 6px inset padding uses 6px rows. Cards and sheets use 12px radii.

### 1.11 Spacing

Tailwind provides the 4px base scale. Named spacing steps standardize recurring layouts: `menu` 6px for menu insets and separator margins; `row` 8px for row padding; `toolbar` 8px for control gaps; `stack` 12px between a section heading and content; `card` 16px for card padding; `page` 24px for page padding; and `section` 32px between page sections. These values are rem-based and follow the text-size setting.

Compact controls may use half steps, including 2px and 6px. The native traffic-light inset is 92px, which leaves 16px between the green button and the first element with the 14px buttons of current macOS (more with the older 12px buttons), and does not scale with text. Palette rows use a fixed 36px height. Formula viewport widths remain explicit because they encode viewport layout constraints.

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

**Reduced motion** (`data-motion="reduced"`, or the OS setting when the app follows it): motion skips transform and layout animations and keeps opacity, so entrances become crossfades and indicators jump. CSS animations collapse to one 0.01ms run and CSS transitions apply at once. The rule sets the transition duration on every element, and a nonzero duration there also enabled transitions on elements left at the default `transition-property: all`; their margin and size changes took effect a frame late, so it is 0s. Radix surfaces switch to a `--dur-fade` crossfade. The working halo stops breathing, the pulse dot freezes at 60%, the streaming caret stops blinking, and skeletons hold a static fill.

**No hidden content.** This rule applies to entrance animations. `Stagger`, `Rise` and `FadeIn` read the app-settled flag: `MotionProvider` sets it after its first effect, and those components play an entrance only for content mounted after that, or when a caller passes `animateOnMount`. `Expand` and `PresenceSwap` do not read the flag. Their presence wrappers use `initial={false}` per instance (unless `animateOnMount` is set), so whatever they show when they mount renders at rest, and they animate only later open, close or swap changes. No entrance waits on scroll or viewport triggers. Streaming text is the one intentional delay: it trails what omp has sent by an adaptive playout buffer (§4.6), and reduced motion bypasses it.

### 1.13 Z-index layers

`--z-base:0 · --z-sticky:10 · --z-pane-header:20 · --z-sidebar:30 · --z-titlebar:40 · --z-dropdown:50 · --z-scrim:60 · --z-sheet:70 · --z-dialog:80 · --z-palette:90 · --z-toast:100 · --z-tooltip:110`.

### 1.14 Scrollbars

The renderer uses CSS-styled native scrollbars, defined in `theme/base.css`: a 10px gutter with a transparent track and a 6px `--radius-full` thumb. The thumb uses `--control-border` at rest (§1.8), `--fg-faint` on hover and `--fg-muted` while it is dragged. Measured against the surface tokens, the resting thumb reaches 3.1:1 to 3.6:1 in light (lowest on `--bg-inset`) and 3.3:1 to 4.2:1 in dark (lowest on `--bg-overlay`), and 3.8:1 or more on the ink chrome. The geometry matches the `ScrollArea` thumb. The style does not animate, so reduced motion needs no exception.

Giving `::-webkit-scrollbar` a size makes Chromium draw a classic scrollbar, which keeps its gutter. Before this style, macOS overlay scrollbars appeared during the transcript's programmatic follow and faded about a second later, so the chat's scrollbar flashed. In the headless Chromium reproduction, the thumb remained visible while content overflowed, including during programmatic transcript scrolling. The change does not replace native scrolling or alter the transcript's follow logic.

- Leave `scrollbar-width` and `scrollbar-color` at `auto`. A non-`auto` value of either property overrides the `::-webkit-scrollbar` styling on that element.
- Use `scrollbar-gutter: stable` for scrollers whose content changes height while visible, so their content keeps its width when it starts or stops overflowing. The chat log reserves both gutters (`stable both-edges`), which keeps its centered column on the composer's centerline. Each composer textarea and its highlight mirror reserve the same gutter, so their text stays aligned.
- The sidebar retains its hover-triggered `ScrollArea` overlay scrollbar, with a 600ms hide delay, so the narrow, resizable column does not give up 10px to a gutter.
- xterm.js terminals draw their own scrollbar, which this style does not change.

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
| `--text-page` | 28px / 36px | 700, −0.02em | page titles: Settings, Usage & limits, Help, project screens |
| `--text-3xl` | 32px / 38px | 700, −0.02em | setup screen, dashboard numbers |
| `--text-code` | 12.5px / 18px | 400 mono | code blocks, diffs |
| `--text-terminal` | 13px / 19px | 400 mono | terminal sheet (user-adjustable ±) |

### 2.3 The wordmark and mark

`visual-omp`, lowercase, Geist Mono 600, tracking −0.02em, `--fg`, with no cursor or suffix. `Wordmark withMark` places the mark before the text with an 8px gap and a mark box about 1.3× the text size. The sm variant uses 14px text with an 18px mark in the 40px sidebar header beside the app version; md uses 16px text with a 21px mark, and lg uses 24px text with a 31px mark.

The mark is periscope C1 "Heavy" (§6). With the default `tone="accent"`, the ink shapes use `--fg` and the lens plate uses `--accent`, so the mark follows the theme. With `tone="current"`, every shape uses the surrounding text color. `src/renderer/src/ui/BrandMark.tsx` defines its geometry (exported as both `BrandMark` and `Mark`); the app icon SVGs and the README hero carry copies of the same shapes.

Streaming text uses a thin 2px accent caret (`.stream-caret`), and working states use the pulse dot and the working halo (§5.16).

### 2.4 Section labels

`.section-label` (or the `SectionLabel` component): `--font-ui`, `--text-sm` (12px), weight 500, `--fg-muted`, sentence case, no tracking, no brackets. Use it to name a group the heading does not already name, such as a settings group or a sidebar list. A label that repeats the heading under it is removed.

---

## 3. App shell layout

The window opens at 1440×920 and can shrink to 960×620 (`src/main/index.ts`). `shell/Shell.tsx` places a 40px title bar above the main area and a 28px status bar below. The sidebar and status bar use the ink chrome in both themes. A light or dark main sheet has rounded left corners against the chrome; pages use the gray canvas. The side panel is a floating rounded sheet separated from the canvas by a gap. The app always opens on Home (§4.24); open chats come back in the sidebar's Current chats.

The sidebar and side panel enter from their own edges and fade when hidden. Main-area changes use `PresenceSwap`. The chat remains mounted and inert while a page is open. The sidebar's width and visibility persist in `localStorage`; so does each open chat's side panel (§3.7).

- **Narrow windows**: when the side panel leaves less than 480px for chat, it takes the main area. Its header provides Back to chat. Returning to chat leaves the panel open for wider layouts. Opening the panel or choosing a pane focuses Back to chat. Resizing preserves usable focus where possible.
- **Home and pages** hide the side panel while open (§4.24, §5.6).

### 3.1 Title bar (40px)

The frameless title bar is a drag region with no-drag controls. It uses the main sheet surface and a bottom border. It is opaque, without backdrop blur.

- **macOS** uses `hiddenInset` traffic lights placed 16px from the window edge, with a 92px inset that leaves 16px after the green button at the current 14px button size.
- **Windows and Linux** use Electron caption buttons; renderer controls are not drawn over them.
- The sidebar toggle appears when the sidebar is hidden. The left column always ends with **Home** (a 24px `House` icon button, tooltip "Home · ⇧⌘H"), which shows Home and carries the `--selected` fill while Home is showing. View → Home and the palette's "Go to Home" do the same. The centered Search commands field opens the command palette with ⌘K or Ctrl+K.
- The sidebar header holds the wordmark and version.

### 3.2 Sidebar (264px, drag 200-320px, ⌘B hides)

The sidebar has a 40px header containing the wordmark and app version. Its remaining content is organized as follows:

```
┌────────────────────────────┐
│ ›▟ visual-omp      v0.5.0  │ 40px wordmark and version header
│ ✎ New chat                 │
│ ⌕ Search chats             │
│ Current chats              │ unopened results, then viewed chats
│ ◌ Fix checkout bug  my-shop│ status and project meta
│ ? Styles pass       landing│
│ Projects                 ＋│ project tree and add menu
│ › ▭ my-shop                │ project row
│     · Fix checkout bug     │ open marker; same chat also listed above
│     ○ Copy review          │ saved chat
│ Usage & limits             │
│ Settings                   │
│ Help                       │
└────────────────────────────┘
```

- `shell/Sidebar.tsx` is the navigation column on the ink chrome. Its resize handle accepts arrow keys in 16px steps, or 48px with Shift.
- **New chat** always starts a chat in the temporary folder: `/tmp` on macOS and Linux, and the system temp folder on Windows. It shows no shortcut hint because ⌘N/Ctrl+N keeps the focused chat's or visible project overview's folder; from Home, pages or an empty view, the shortcut uses the temporary folder. File > New Chat and the palette use that same context rule, while `/new` keeps the originating chat's folder. Project menus' New chat here, project overview actions and open side by side keep their project. Search matches chat titles and previews across projects, and matching project names. It loads unloaded chat lists and opens matching groups; Esc clears the query.
- **Current chats** lists unopened results first, separated from viewed chats by a small divider when both groups contain rows. Each group keeps the order its chats were opened. Unopened rows have a blue dot (`--info`), a stronger title and an accessible "New result" or "Waiting for your answer" label; working and waiting status marks remain visible. The blue status color distinguishes unopened results from the green dot of an open chat and the teal working notch. Group moves use layout motion through the shared motion presets and move instantly under reduced motion. The selected row has the raised pill. The section is hidden when no chats are open.
- **Projects** continues to list the same chats. Viewed open chats have a quiet open marker in the tree; unopened results share Current chats' blue dot and stronger title. Selection and numbered shortcuts belong to Current chats. Projects sort pinned first, then by last activity. Their menus include start chat, project overview, project settings, show in folder, **Folder color**, pinning and removal. Folder color is a submenu of None and the seven colors (§1.5), each with its swatch. A colored project shows a filled folder in that color on a wash of it behind the whole row, in place of the neutral fills: 16% at rest, 24% on hover or with a menu open, 30% while its overview is showing (`color-mix` with transparent; text stays 7:1 or more). Removing a project from the list forgets its color.
- **Rows remain highlighted while their menus are open**: while a row's right-click menu or its ⋯ menu is open, the row keeps its hover fill and text color, and the ⋯ button stays in place of the time or project name, although the pointer has moved into the menu.
- **Chat rows** in the project tree show title, status, pin and relative time. Open chats and saved chats share the tree; row actions include opening, splitting, closing open chats, renaming, pinning, archiving, showing in folder and deleting. The sidebar supports a 200px width and 130% text size by allowing trailing project metadata to ellipsize before the chat title.
- **Continued chats** show their newest linked file once across project lists, Home and search. Pin state comes from omp's shared pin file, so terminal and app changes appear in the same list. The pin mark and menu update after omp confirms the change.
- **Rename saved chat** opens a focused dialog from either row menu without opening the chat. The existing title is editable, Save name is disabled when empty and shows progress while omp writes, and a failure stays in the dialog beside the input. A saved file owned by a running omp is left unchanged and the error explains why.
- Opening a saved chat loads its history without starting omp. When the user moves to another chat, a saved chat that was only viewed is released: it has no unopened result, no host, no sent input, no draft or attachments and no open omp terminal. A viewed chat whose side panel is open, or was resized, is not released, so the panel is there when the user comes back. A chat also stays open when a chat that was already open appears later in Current chats, so no ⌘ number shifts. Browsing from one saved chat to the next therefore releases the chat left behind. Closing a chat records it in the reopen stack. Reopen closed chat (⌘⇧T) restores the last eligible chat, its text draft and its side panel without starting omp.
- **Shortcuts**: ⌘1-⌘9 (Ctrl elsewhere) keep the original open-chat numbers when unseen rows move; ⌘⇧[ and ⌘⇧] cycle through open chats in open order. ⌘⇧A selects the next chat waiting for an answer.
- Usage & limits, Settings and Help open pages. A page puts Back under the sidebar header, and the header and Back then share one teal card (`--page-card`) that runs to the window's top edge and both sides of the sidebar, with 12px bottom corners like the main sheet's. The card reaches 12px under the sheet at the top, so the notch beside the sheet's rounded top-left corner is teal too; the sheet is `z-0` so it paints over the rest. The fill sweeps in from the left over 360ms (`ease.outExpo`) when the page opens. When the page closes, the card keeps its height and white text while the fill sweeps back out over 240ms, and the lists below then slide up. Under reduced motion the fill crossfades. The wordmark, mark, version and Back turn white on it. Settings also puts its section navigation under the card and temporarily hides the chat lists; other pages keep the lists visible under the card. With the sidebar hidden, there is no card, and Back and any section navigation render inline.
- ⌘B (Ctrl+B) or View → Toggle Sidebar hides or shows the sidebar.

**Chat status marks** (`shell/ChatStatusMark.tsx`, status from `chatStatus` in `shell/hooks.ts`) distinguish working, waiting, open and saved chats with shapes, colors and screen-reader text. The order is: waiting for an answer (question mark, `--warn`), omp's own turn ("omp is working"), helpers at work ("omp's helpers are working"), open (filled `--ok` circle) and saved (hollow circle). The two working states share the spinning `--accent` notch, so a chat whose turn has ended keeps spinning while any helper it started still runs, by the rule the Tasks badge and the pinned helper strip use (`helpersAtWork`: a running helper, none without a running omp). A helper that finished, failed or stopped, or one omp keeps idle or parked for a follow-up, does not count. Background shell jobs do not count either, because a dev server started as a job runs until it is stopped and would keep the chat spinning; the work chip and the Tasks badge count them. The turn's end still reports the reply (notification, Dock badge), since those follow omp's turn alone (§4.22). Under reduced motion the notch stays still. The Projects tree uses a quiet dot for open chats; Current chats carries the working or waiting status.

### 3.3 Split view

`chat/ChatArea.tsx` shows one chat, or two side by side.

- ⌘ or Ctrl-click in the sidebar, "Open side by side" in a chat row's menu or the session ⋯ menu, or ⌘⏎ on a chat in the palette opens a chat in the second half. ⌘\ also opens the split, and closes it while it is on.
- The left half starts at 50%, and the resize handle ("Resize split") keeps each half at least 360px wide. A divider the user placed is pulled back in when the area shrinks.
- Each half has its own header, transcript and composer. The sidebar and status bar are shared and follow the focused half. The side panel shows the focused half's own panel (§3.7), and each header's side panel toggle reads as pressed only while its own chat's panel is on show.
- The focused half, the one keyboard commands act on, carries a 2px `--accent` line along its top edge that slides across when focus moves. Clicking anywhere in a half focuses it. The halves are groups labelled "Left chat" and "Right chat".
- The second half enters from the right and fades out when it closes.
- When the chat area is narrower than two 360px halves, only the focused chat shows; its partner stays mounted, hidden and inert, and comes back as it was once the area widens.

### 3.4 Session header

The header shows chat status, title and available actions. Its work summary chip opens Tasks and reflects effective dock visibility. Task counts follow the displayed branch; helpers and background jobs remain separate and live.

Session titles use `ui/SessionTitle.tsx` across chat headers, Current chats, saved project lists, Home, search, usage tables and confirmation lists. The shared parser follows omp's exact `<icon> <CODE>: <title>` form: one to eight non-ASCII icon codepoints, one to six ASCII capitals or digits, and the literal spaces and colon. A recognized card shows its Unicode icon, a compact neutral code chip and an ellipsized title. Private-use characters from every Unicode plane are removed only for display, including terminal-only Nerd Font icons; the code chip remains. Plain and malformed card titles stay whole apart from that removal. Stored titles are unchanged, and text-only labels and native notifications retain the card code.

Status text explains read-only access, stopped or reconnecting omp, pending questions, active work or readiness. After omp's turn ends while helpers still run, it reads "Helpers are working. omp is ready for your next message." beside the spinning notch. Read-only status is also reflected by the composer's placeholder.

### 3.5 Chat column

- **Layout**: up to 760px wide and centered, with 24px gutters and message gaps. Transcript updates use `aria-live="off"` while paced content is rendered. A single polite screen-reader announcement follows each completed assistant reply. New Markdown blocks fade in once. Hidden chats continue ingesting state but pause presentation.
- **Banners** above the transcript:
  - "omp stopped (exit N)." with [Start omp again]. A nonzero startup failure can show a recognized diagnostic below it, limited to eight lines and 1,200 characters; live terminal contents and composer drafts are excluded. A startup diagnostic naming the missing resume file replaces that action with [Start a fresh chat], which uses the same folder.
  - "Reconnecting to omp…" (warn)
  - "Showing the saved chat. omp starts when you send a message." (info)
  - For a chat open in another window, a follow row with a live dot: "Open in another window. This view updates as that window works; reply from there."
- **Transcript view**: Normal, Thinking or Verbose, selected in the header menu or Settings → General. Thinking expands thinking blocks. Verbose also shows thinking-level notices, starts tool steps expanded and includes their raw arguments.
- **User message**:
  - A right-aligned bubble up to 85% of the column: `--bg-inset`, 1px `--border`, `--radius-lg`, 12px by 16px padding, `--text-base`. There is no side rail and no speech tail.
  - Images show as 48px thumbnails above the text.
  - A line above the bubble reads "You" (or "From {name}" in shared chats), with the time on hover.
  - Hover or focus shows Rewind to here, Fork from here and Copy message under the bubble.
- **Assistant message**:
  - No card and no hover actions.
  - Each turn starts with a header row: the 18px C1 mark, then "{model} · {time}" in `--text-sm` `--fg-faint`. A later reply with a different model or provider gets its own header within the same turn, so a recovered reply never inherits the failed model's label.
  - Markdown is 14/22 `--fg`. Inline code sits on `--selected`; code blocks are on `--bg-inset` with a hairline.
  - While a reply streams, a 2px accent caret follows the last character and blinks every second.
  - A thinking block marked `narration: true` uses reply Markdown in all views, stays visible between tool groups and participates in reply pacing, file links and screen-reader announcements.
  - Interim `out://` writes use the same prose, streaming caret, playout and file links as replies. They create no file-write card or step count. Shell `details.replies` appear as prose outside the command disclosure, including replies received while the command still runs. Both transports remain visible in saved history and helper conversations. The polite announcement channel speaks each complete interim reply once without ending omp's working state. `out://` destinations never become file links.
- **Thinking**: a 28px toggle row, "Thinking" (or "Thinking (hidden by the model)"), in `--text-sm` `--fg-faint`, with a caret that turns when it opens. The text opens with `Expand`, indented 20px, in `--text-sm` `--fg-muted`, with no background and no rail. In Normal view, with "Show thinking as omp thinks" on (Settings → General, on by default), the thought omp is writing opens and reveals through the reply's playout as it streams, then folds once a tool call or reply text follows it: into the step group when it appears between two calls, otherwise collapsed. Only that thought opens on its own. A thought whose header the reader clicked keeps the reader's choice, kept by the message's time and the thought's place in it, so it survives the streamed reply turning into its saved entry and the thought moving into a step group. With the setting off, Normal view thoughts start collapsed. Thinking and Verbose open every thought either way.
- **Tool steps** (§4.7) are borderless rows, and the steps of one turn stack as one list. In Normal view, each run of steps is one ToolGroup row from its first call, in a turn still going as well as a finished one (§4.7).
- **Work visuals**: a TodoCard shows the latest actual todo board update for the turn. Helper and background-job cards use existing activity and context counts when known. ToolGroup reports tool-call count and failures, counts its time up while a call in it runs, and shows a finished group's elapsed time only when start and result timestamps are known. TurnSummary lists files from omp edit and write results, deduplicates tool results by call id, excludes failed calls and unapplied previews, and shows known additions and removals as Edit totals. These totals add up every edit, so a file edited twice counts both edits. Partial counts are labelled. A Plan checklist appears only for checkbox steps in a plan file and has no inferred overall completion.
- **Pinned helpers** (`features/panes/HelperStrip.tsx`, an `aboveComposer` chat slot; rules in `features/panes/pinnedHelpers.ts`): while any of the chat's helpers runs, it shows in a strip pinned at the bottom of the chat column, above the working row, so running work stays in view while the transcript moves on. Only running helpers pin; a finished, failed or stopped one does not (a finished one omp keeps for a follow-up message included), and a mirror without a running omp (`ompRunning`) pins nothing. The strip is one bordered `--panel` list with hairline rows, each 36px: the agent status mark (the dot's sparkle glyph, so the status does not rest on color alone), the name (`--text-md`, 500), what it is doing now (`--text-sm` `--fg-muted`, one line), then the tool-call count and the live run time in faint mono (the same `RunningTime` as the helper card), and Stop. A narrow strip drops the tool count first (under 28rem) and then the run time (under 20rem), so the name and activity keep their line. Clicking a helper with a conversation opens it, as the Tasks pane does; that button stays inside its row. At most three rows show; more helpers add "Show {n} more in Tasks", which opens the Tasks pane. When the helper whose row has keyboard focus stops running, focus moves to the Stop of the row now in its place (or the row above it), else "Show {n} more in Tasks", else the message box. The strip opens and closes with `Expand`, rows rise in and fade out (`listRowMotion`), and reduced motion keeps only the fades. The transcript appears above it in the same column, so while pinned to the bottom it follows as the strip changes height. While a helper is pinned, its card is not under its task call (§4.7).
- **Markdown**: tables include a header and horizontal scrolling frame. Ordinary cell text and headers use `overflow-wrap: break-word`, preserving normal word widths during column sizing. Headers can wrap, while numeric cells remain on one line. Links and inline code allow breaks anywhere. Long unbroken plain text can widen the table; the frame scrolls horizontally when needed. Bullet lists use disc markers, nested bullet lists use circle markers and numbered lists use decimal markers; task lists render checkboxes; callouts use their tone; code blocks have a header and Copy action.
- **omp notices** (`chat/transcript/NoticeRow.tsx`): omp records harness notices as `custom_message` entries with `display: true`, and the transcript shows them the way omp's own terminal does, in the app's tool-row and card styles. The normal presentation removes omp's wrapper tags, and Verbose offers the original text in a "Text sent to the model" disclosure.
  - **Background job results** (`async-result`): one tool-style row per job, with `TerminalWindow` and "Background job finished" plus the command's first real step (the same `commandSummary` as the Tasks pane), or `Robot` and "Helper “{name}” finished" (or failed or stopped). The row shows the duration and a check, a cross or a stop mark. It opens to the result: JSON as a formatted code block, command output as a code block and helper prose as Markdown. When omp sent only a preview, a note says so above it.
  - **Durations**: job notice rows, background job tool rows and helper cards share one duration style (`fmtDuration` in `collab/lib/format.ts`): "847ms", "4.2s", "42s", "4m 05s", "1h 13m". A helper duration that omp gives only as text in its task result ("2m41s") is parsed and shown in the same style.
  - **IRC messages** (`irc:incoming`, `irc:autoreply`, `irc:relay`): a `--panel` card titled "Message from {name}", "{from} to {to}" or "Automatic reply to {to}". The body is Markdown cut to three lines, with "Show more" when it overflows.
  - **Process exits** (`launch-completion`): a row with the exit sentence ("Process {name} exited with code {code}") and a check or a cross by exit code.
  - **Advisor notes** (`advisor`): an "Advisor" card with the note count and, per note, a severity badge (Blocker, Concern or Nit) and the note as Markdown.
  - **Skill use** (`skill-prompt`): a compact row on the user's side, "Used the {name} skill", with the user's text below it. It opens to the skill's text.
  - **Other notices**: a one-line row of the notice's text with omp's wrapper tags removed ("Note from omp" when nothing is left of the first line). It opens to the full text.
  - Normal, Thinking and Verbose all show notices. Verbose initially expands job results, skill text and other-notice details, and adds the "Text sent to the model" disclosure. IRC message bodies stay collapsed to three lines in every view until "Show more" is chosen.
  - Spacing: consecutive job, process-exit and other notice rows stack at tool-row spacing, without the 24px turn gap between them. IRC and advisor cards and the skill row keep the normal gap.
- **Transcript notices** are a centered `--text-xs` `--fg-faint` line between two hairlines:
  - "Context summarized"
  - "Continued from another branch"
  - "Switched to {model}"
  - "Thinking set to {level}" (Verbose only)
- **Model fallbacks** use a left-aligned warning row (`ModelFallbackNotice.tsx`) with `Warning`, `--warn-bg`, `--warn` and the same spacing and radius as inline errors. They appear in every transcript view, including switches before the first prompt. The text says “omp switched from {from} to {to} as a fallback.” When the source is missing it names only the destination. A related error is quoted beneath it only when omp's saved retry attribution identifies that recovery and destination. The quote is introduced as information reported at the switch, so relative retry or reset text does not become a current countdown. Provider fallback content says “The provider switched this reply from {from} to {to} as a fallback.” Tool groups break at these boundaries so later work never appears above its switch. Ordinary model changes retain the centered hairline row. These warnings add no notification channel or new unopened-result trigger.
  - The existing polite announcement channel speaks each new fallback once, including provider fallback content as it streams. Loaded history, reconnect snapshots and the saved copy of an announced stream stay silent. Ordinary model and thinking setup rows remain hidden before the first prompt in every view. Only explicit fallback entries break tool groups; ordinary switches retain their previous grouping.
- **Errors**: when a turn stops, an inline status follows it. An error shows on `--err-bg` with `XCircle`: "The reply stopped with an error", plus omp's message. A cancelled turn shows on `--warn-bg` with `Warning`: "Stopped".
- **Questions** are §4.8 and **plan review** is §4.9. The **working row** is §4.6.
- **Scrolling**: the log follows new content while pinned within 48px of the bottom, easing toward the bottom during normal motion. Gaps over 480px and reduced motion snap to the bottom. Scrolling up unpins the log and preserves its position. Programmatic follow does not unpin it, and neither does a window change (below): the transcript records the view just before the commit, puts the anchor row back afterward and reports the move to the follow (`shift`), so a move up the reader made before that commit still unpins. While unpinned, new content shows a "Show new activity" pill. The pill and the user's own sends use the same jump to the end (`jumpToEnd`): it brings the window back to the latest entries, pins the log and glides to the bottom with the follow's easing. From more than 360px away the log first moves to 360px above the bottom, so the glide never runs through hundreds of rows, and under reduced motion it moves to the bottom at once. The glide is the follow itself, so scrolling up during it (wheel, keys or scrollbar) unpins the log, which stops the glide and any following until the reader returns to the bottom. A send requests the jump when it goes to omp without waiting behind anything (`SessionController.noteSent`): Enter or the send button while omp is idle, Send now from the composer or the queue tray, a slash command omp runs, and a `!` or `$` line. While omp is still starting, the first message enters the queue like any other but requests the jump at once, because it goes out first once omp runs. The request records the intent to send: it fires before the message is typed into omp, so it can come before a failure, in which case the composer gets the draft back and the log stays at the end. The user's message therefore appears in view however far up the log was, and the reply that follows stays in view. Adding a message to the queue, automatic queue delivery and entries from other sources (another omp window, a terminal-follow view, a collab guest) do not request a jump. While scrolled up, the log keeps its position and new transcript activity shows "Show new activity". While pinned, it continues following new content. The log uses the styled scrollbar (§1.14) with both gutters reserved. In the headless Chromium reproduction, following new content, closing a question card and opening the working row left the thumb visible and the column width unchanged.
- **Long chats** (`chat/transcript/window.ts`): while following the tail, a chat with at least 120 entries renders its latest 120 to 159 entries, and "Show {n} earlier messages" above them names the rest. The first entry rendered moves on 40 entries at a time, so the first rows, that count and the scrollbar stay steady while omp works. Once the reader has scrolled away from the bottom, the window stops moving, and coming within 240px of the top loads the previous 120 entries above. The lowest row that starts inside the view keeps its place on screen through that load, because the rows at the old top can change shape once the entries before them arrive (a step group extends upward, a reply loses its header). A view at the bottom never loads earlier entries by itself. Entries loaded while the view is still at the bottom (the button in a chat that fits on screen) stay loaded while new entries arrive, until the reader leaves the end and comes back to it, chooses "Show new activity" or sends a message that goes to omp at once (above); held history can therefore grow well past 159 entries. Before this change, a window shorter than the view plus 240px was at the bottom and near the top at once, so each scroll event alternately loaded and dropped the previous window; in the headless Chromium reproduction, the top rows, the count and the scrollbar changed about 30 times a second.

### 3.6 Composer (card up to 760px)

The composer card holds the text box at its full width, with a toolbar under it: ＋ on the left, the microphone and the send or stop actions on the right. Permission, model, thinking and context controls sit in a quieter wrapping row below the card.

The model button adds a warning icon and a persistent “Fallback” label when omp identifies a fallback. Its tooltip and accessible name identify the original model when known, including across a chain of retry fallbacks. The model name may truncate, while the icon and label stay visible. It keeps the selected model from live state, or the latest saved choice when no live model is available; provider fallback content identifies the serving model for that reply. A subsequent ordinary response clears a provider-only fallback, while a manual model choice or primary restoration clears the retry marker. No provider limit percentage is used to infer a model change.

The picker checks omp's selected model separately from the serving-model label, so choosing a provider fallback explicitly still sends the model change. A different live selection invalidates an older provider fallback immediately, including within the same provider. If the original is unknown at the start of a fallback chain, it stays unknown until a non-fallback choice resets the chain. The button is capped by both 16rem and its container width, allowing long names to truncate at the smallest split width and largest text size.

- **Layout**: the card has 8px padding and two rows 8px apart. The composer uses a 14px outer radius as an exception to the 12px card radius. The text row spans the card's inner width, insets the text 4px more so it lines up with the attachment chips above it, and keeps the Shell or Python mode chip at the start of the text. The text box grows from one line to 200px, then scrolls, and fits its height again when the card's width changes. The toolbar row holds 32px buttons with 6px radii (the card's 14px less its 8px padding) and no divider. Below a 28rem card, Send now drops its label and shortcut hint and shows only its icon, while Queue message keeps its label. If the actions still do not fit on one line (the largest text size in a narrow split), they wrap within their group and ＋ stays at the bottom left.
- **Focus**: the text box draws no outline of its own. While it has keyboard focus the card's border turns `--control-border` and the card takes the 2px `--ring` outline with a 2px offset (§1.8). The toolbar buttons keep their own outlines.
- **Placeholders**: idle reads "Ask omp to change something…", while omp works "Queue a message for when omp finishes this reply", Shell mode "Type a shell command to run in the project folder…" and Python mode "Type Python code to run…". Read-only placeholders follow the session header's wording, checked in this order: "Replies are off while the chat file can't be read" when the followed chat file can't be read, "Reply from the other window" while another window owns the chat, "Choose Continue here to reply" when the chat is free to continue, and "Replies are off until the app can check the other window" when ownership could not be checked.
- **Split width**: split view keeps each chat column at least 360px wide. The card and settings row wrap their controls within that width.
- **Read-only chats**: the header explains why the chat is read-only and the placeholder gives the relevant action. The card has no repeated lock banner. Text, attachments and row controls are muted and disabled.
- **Queue path**: Enter and Queue message add the message, with its images and any slash command that omp runs, to the end of the queue while omp is busy: it is not running yet (or restarting), it works, messages wait, something is being typed into it, a message sent to it has not been acknowledged, a slash command is still being delivered or watched for its result, a hold for omp's own screen stands, omp's full-screen menu is open, or omp's message box may still hold a failed message's images (below). Send now delivers at once: ⌘↵ or its button steers the running turn, and a row's "Send message now" sends that row. Slash commands the app handles itself still open their screen at once. The queue sends its first message only when none of those conditions holds, one message at a time. A message sent to an idle omp counts as acknowledged once omp starts a turn; a message typed while a turn ran also counts once omp records it as a user message, since that turn may take it in and end without starting another; a shell (`!`) or Python (`$`) line counts once omp adds that line's own result to the chat (the same command or code) or starts a turn. There is no time limit, so a message omp never acknowledges keeps the rest queued, and a row's "Send message now" still sends them. A message that was being typed when omp stopped or moved to another room waits for nothing; the queue moves on at the next send, turn end or hold end. A queued message that fails to send goes back to its place, and a failed "Send message now" (a slash command included) shows one notification with the reason. When a message's images were pasted but its text failed to submit, the images may still be in omp's message box, and anything typed next would carry them, so nothing more is typed into omp until omp restarts or stops: sends queue, "Send message now" and commands are refused, and the tray shows "omp's message box may still hold images from a message that didn't send. Restart omp to clear it." with [Restart omp]. Removing the message does not lift this; a new room without a restart does not either, because it keeps the message box. After the restart the queue continues, and the message, if still queued, goes in its turn with its images pasted once into the new message box. A composer message that fails this way stays in the queue, first in line; one that fails before its images are pasted goes back to the composer, as does a message whose omp fails to start. The tray puts a neutral "{n} images" chip (the file names as its tooltip) before the text of a message with images, and supports editing the text, reordering and removal; clearing the text of a message with images keeps the images queued. Below a 28rem card the chip shows only the count and "Send message now" only its icon, so the message text keeps its width.
  - **Side-answer feedback**: After `/btw` is submitted, the terminal sheet opens if its chat is visible, including either half of a split, and no terminal is already open. Its inline side answer is absent from collab and produces no result row. The sheet remains open until the reader closes it. A background submission leaves the current view unchanged; the reader can return to its chat and open that chat's omp terminal to read the answer. Bare `/btw` keeps the queue held while omp's history overlay is open, then releases it when the editor returns. Other slash commands keep their existing result and overlay handling. Failed submissions keep their queued row or direct draft and show the reason.
  - File commands whose YAML frontmatter has `side: true` use that same terminal-sheet path, including commands invoked without arguments because their file supplies the prompt. The hosted omp resolves them through its public SDK at submission time, retaining enabled user/project sources, nested bare names, namespace aliases and command precedence.
- **Idle path**: the primary action sends the message and stays disabled until there is content.
- **Slash menu**: when the message starts with `/` and the caret is in the command name, a listbox above the text box lists the commands omp accepts in this project, with aliases, a description and a source label for skills, custom, extension, MCP prompt and file commands. After `/name ` it lists that command's subcommands and shows its usage hint. Focus stays in the text box; arrows move, Tab completes, Enter completes a partial name and sends a complete one, and Esc closes the menu until the next keystroke. Commands the app covers natively open their screen instead of reaching omp, and the routing table is documented in `docs/COMMANDS.md`.
- **Ghost text**: the focused message box shows omp's word-completion suffix in `--fg-faint`. Tab inserts the suffix and a trailing space; a typed matching prefix keeps the remaining suffix visible. Mention and slash menus take precedence. Completion feedback returns to omp with the source folder, text and UTF-16 cursor offset. Word completion respects `spelling.autocomplete`; its default Auto engine uses local prompt-history n-grams without provider requests or weight downloads.
- **Next-message predictions**: omp's optional prediction appears as ghost text while idle; Tab inserts it without sending. The transfer reads the exact TUI draft through the trusted extension API, preserving hard-wrapped URLs, pipes and Unicode. If the native draft, input mode or host generation changes while it returns, the app saves the captured text instead of replacing the newer draft. The Saved suggestion region offers explicit insertion or dismissal and preserves copies across app restarts. Ambiguous Tab acknowledgements or read/clear failures offer Retry recovery and Open omp terminal; composed sends remain blocked until omp's editor is confirmed clear. No Ctrl+C or screen-row reconstruction is used. The setting defaults off because omp bills an additional model request after each completed turn.
- **Dictation**: the microphone uses omp's draft-only RPC capture. A visible "Starting…" label remains until omp reports recording, including while omp prepares its speech runtime or model. The same button cancels a pending start without waiting for a transcription timeout. Stop during recording inserts the final text into this chat's draft. If the child stops unexpectedly, the microphone returns to idle with an error and preserves any available non-cancelled text. No message is submitted automatically, and enabling voice input no longer edits keybindings or restarts the chat.
- **Prompt history** (`chat/composer/history.ts`): Up recalls this chat's submitted text, newest first, when the caret is on the first visual line or the box is empty. Down works on the last visual line and returns to the exact draft and caret saved before browsing. The existing highlight mirror measures wrapped lines; if it cannot be measured, newline-delimited boundaries apply. Attachments stay in place. A selection or modified arrow keeps native editing behavior. Editing recalled text makes it the new draft. Esc first dismisses an open slash or mention menu, otherwise restores the pre-browsing draft; the existing empty-box stop action applies only outside history browsing. Menus own their arrows, and composing IME input never browses history. Recalls do not open completion menus or add live announcements.
  - Sources are the displayed branch's user-message `contentText`, successfully delivered input from this window, and up to 100 prompts from omp's `history.db`, filtered by session UUID through a read-only main-process query. Synthetic prompts and image-only messages are excluded. Matching source records are combined and consecutive repeated text is shown once. Pending queue rows remain in the tray until delivered.
  - Shell and Python modes browse their own commands; ordinary chat mode browses messages and slash commands. Excluded `!!` and `$$` prefixes are preserved. Each split composer has its own browsing cursor. Home has no chat history, and read-only composers remain disabled.
  - Unedited recalls are transient previews. Browsing leaves the persisted draft and attachments unchanged, so reloading or closing the view restores the unfinished draft. Editing or inserting text commits the preview as the draft. Send uses the preview and clears the draft as usual.
  - Saved transcript and omp database history survive app restarts. App-handled commands and other window-only records last until the chat closes or changes session. A missing database, an older saved database format or a busy writer leaves transcript and window history available. The app writes no other persistent prompt log.

### 3.7 Side panel (420px default, drag 320-640px, ⌥⌘B toggles)

- **Frame** (`shell/Dock.tsx`): the dock is a floating rounded `--panel` sheet, with an inset gap from the main sheet. It closes by default, hides while a page shows, and takes the main area at narrow widths.
- **Per chat** (`state/dockLayout.ts`): each open chat has its own side panel. Whether it is open, the pane it shows and its width belong to that chat, so opening, closing, choosing a pane or resizing in one chat leaves every other chat as it was, and a chat that never opened its panel shows it closed at 420px. Switching chats fades the previous chat's pane out and then fades the new chat's own pane in (`PresenceSwap`, one after the other, not overlapping); within a chat, choosing a pane slides. Home and project overviews share one panel of their own. A control in a chat (Review changes, the work chip, "Show N more in Tasks", a file link, a terminal it starts) acts on that chat's panel, and when that chat is the other half of a split, the half takes focus so its panel shows. A chat's side panel toggle closes the panel only while it is on screen; otherwise it brings that chat's panel into view. The panels persist with the open chats and go when a chat closes.
- **Header**: includes Back to chat when the panel occupies the main area, the pane selector and Close side panel.
- **Pane selector**: a menu button that names the pane on show with its icon, its badge and a caret. Its menu ("Panels") is a radio list of every pane with its icon and badge: Changes (`GitDiff`), Files (`TreeStructure`), Preview (`MonitorPlay`), Outputs (`Images`), Tasks (`ListChecks`), Plan (`ClipboardText`) and Terminal (`TerminalWindow`). Arrow keys, Home, End and typeahead move, and Enter or Space shows the pane. When another pane's badge has something to show, the button adds an accent dot ("Other panels have updates").
  - Panes slide in from the side of the chosen pane: one lower in the list enters from the right.
  - "Review changes" in the session header (§3.4) and the status bar's change count open Changes directly.
- **Badges**:
  - Changes: `+N −M` in the diff colors.
  - Outputs: an accent count of outputs added or made again since the pane last showed this chat. Outputs that existed when the side panel first listed the chat are not counted.
  - Tasks: an accent count pill of running helpers and jobs.
  - Plan: an accent "!" while a plan waits for a decision.
  - Terminal: a live dot while a command runs.
- **Changes** (`DiffPane.tsx`): changes since the last commit, per file, with a hideable file list. Line comments are sent to omp together. "Review code" asks omp to review the changes (`/review`), and a file's changes can be discarded after a confirmation.
- **Files**: the project tree and viewer tabs. ⌘-click or right-click mentions a file in chat; there are also Copy path and Show in folder.
  - A viewer tab can hold any absolute path, inside the project or not, so a file named in a reply or opened from Outputs shows here. Viewer tabs, expanded folders and the tree's width are kept per chat (per project on project overviews). The header shows the project-relative path inside the project, `~/...` under the home folder, and the absolute path elsewhere.
  - While tabs are open, a `SidebarSimple` button at the start of the viewer's tab row hides or shows the tree ("Hide project files" or "Show project files"), with the same slide and fade as the Changes pane's file list; the viewer then takes the pane's width. The choice is kept per chat until its last tab closes, when the tree fills the pane again. A file link in a reply opens its tab in that chat's Files pane with the tree hidden, so the file gets the whole panel, while "Open in Files" on a tool card leaves the tree as it was.
  - Text and code show with line numbers and syntax colors, images (SVG included) in the zoom view described below, and PDFs in the same built-in PDF viewer as Outputs (the same `blob:` iframe, read again on reload or when the project's files change, each Blob URL revoked once it is replaced or the tab closes). Other files show "Can't preview this file" or "This file is too big to preview" with Show in folder. An image the browser cannot draw (an SVG that is not well-formed XML, for example) shows "This image could not be displayed."
  - Both panes open a PDF with the open parameters `#navpanes=0&view=FitH`, which Chromium's viewer reads from the URL fragment: the page-thumbnail sidebar starts closed and the page fits the frame's width, while the viewer's toolbar (page, zoom, download, print) stays. Without them, a wide spread such as an 18x6 inch bifold opened at about 13% beside the thumbnails in a 535px dock.
  - A folder tab lists the folder one level deep, skipping `.git` and `node_modules` as the tree does, with the first 200 entries and then "Show all N items". Images and PDFs form the Outputs thumbnail grid ("Images and PDFs"), with the PDF glyph when the operating system makes no thumbnail; the other entries are 30px rows ("Folders and files"). Clicking an entry opens it as another tab, folders included. The header has the item count and Show folder in Finder (Show folder in its parent folder elsewhere).
  - Each tab first asks main whether its path is a file, and lists it as a folder when it is not, before it picks a renderer. The extension alone does not decide the kind, so a folder called `archive.pdf` opens as a folder and only a file ending in `.pdf` goes to the PDF viewer.
  - Raster images and PDFs get Open in default app in the header wherever they are, with the same file checks as Outputs. Files outside the project also get Show in folder; inside the project the tree's menu has it.
  - Images and PDFs also get "Expand preview" (`ArrowsOut`), which opens the same file in a `full` dialog (§5.6) over nearly the whole window, because a panel-wide view still shrinks a wide spread. The layer's header has the file name, "Zoom in" for images, Open in default app for raster images and PDFs, Show in folder and Close. A PDF uses the same frame and open parameters; an image uses the zoom view, and "Zoom in" is a pressed toggle bound to the same zoom state as clicking the image, so the header and the image never disagree. The toggle is disabled while no image is shown, such as while it loads or when it could not be drawn, in which case the layer shows "This image could not be displayed." as the pane does; new bytes for the file try again. Each opening starts fitted. Esc or Close returns focus to the Expand button.
  - **Zoom view** (`ZoomImage` in `features/panes/media.tsx`, math in `zoom.ts`), shared by the Files viewer, the Outputs larger view and the Expand layer. The image starts fitted on `--bg-inset` with a 16px margin. A raster image grows no larger than its actual size when fitted, while an SVG fills the view, which also gives an SVG without a size of its own (only a `viewBox`, or percentage width and height) a useful size; the browser's default for such an SVG is 300×150. Clicking zooms in place, keeping the clicked point of the image under the pointer: to actual size when that magnifies at least 1.5 times, otherwise to twice the fitted size. While zoomed, dragging or scrolling moves around the image, and a click without a drag returns to fit; the click that ends a drag does nothing. Ctrl+wheel, ⌘+wheel and trackpad pinches (which Chromium reports as Ctrl+wheel) zoom continuously around the pointer. Zooming in stops at eight times the fitted size or eight times actual size, whichever is larger, and the image's longer side never exceeds 20,000 pixels, a hard ceiling that wins over both; when the ceiling is at or below the fitted size, the image stays fitted. The cursor shows zoom-in while fitted, zoom-out while zoomed and grabbing while dragging. The view is focusable and named "Zoom in on {name}" (a pressed toggle) with a description of the keys. A click from assistive technology toggles the zoom at the view's center, Enter or Space toggles it, + and - change it by a factor of 1.5, 0 fits the image, and arrow keys scroll while zoomed. Esc is left to the surrounding view, so it still closes the Expand layer first and then goes back to the outputs list. The image is laid out at its zoomed size, so an SVG is drawn again at each size and stays sharp. A click, a key or the header toggle moves the image from its box on screen to the new one on `spring.snappy`. A wheel or pinch, a drag, a new image, a change of the motion setting or closing the view stops a running move first, so the image returns to its laid-out box before anything is measured. Wheel and pinch zooming follow the input directly, and under reduced motion every change is instant. Thumbnails in grids keep their click behavior and open the larger view.
- **Preview**: back, forward, reload, an address field (local addresses and `https://` pages only) and "Open page in your browser". URL and navigation history belong to the chat's dock scope, so chats in the same project remain independent; Home and project overviews share the overview scope. Links found in the chat are offered, and the empty state reads "Nothing to preview".
- **Outputs** (`OutputsPane.tsx`): the images, PDFs and files omp created, wrote, changed or viewed in the focused chat, read from the same entries as the transcript and listed newest first. A path appears once, at its newest use.
  - Sections split them by what the chat's history shows omp did (`OutputRelation` in `derive.ts`), each with a title, a one-line description and its count, and hidden when empty. In order: "Created" (images omp generated and files omp reported adding as new), "Written" (files omp wrote or a command saved, which may be new or may have replaced a file), "Changed" (files that existed before omp edited or wrote them, including files the chat had read first) and "Viewed" (images and PDFs omp only looked at, through `read` or screenshots). The first use that produces a file decides its section, so a created file stays in "Created" when omp edits or views it later, and deliverables stay at the top while review renders collect below. Each section shows its images and PDFs as tiles, then its other files as rows. "Viewed" shows the first 12 tiles and then a "Show N more" button that reveals the rest until the pane closes.
  - Images come from image blocks in tool results (a `read` image keeps its path), `generate_image` results with their saved paths, and screenshots. PDFs come from `read`. A thumbnail with a path is read from disk when the pane opens and again whenever omp uses that file, so a re-rendered file shows its current state. Without a path, or when the file is gone, it uses the data in the tool result (omp's blob store for saved chats). When neither is available the thumbnail shows a broken-image glyph, and the larger view adds "This image could not be displayed."
  - Files made by commands: `bash`, `eval` and `browser` calls often write deliverables without naming them as outputs (a Python script that saves into `$OUTDIR`). For each finished call the renderer collects the paths its arguments and printed output name (absolute, `~/`, Windows drive and UNC paths, quoted, shell variables such as `$OUTDIR` resolved, globs cut back to their folder) and the window the call ran in, from omp's recorded start (or the call) to its result, or to the delivery of a background job's result. Main checks those paths with hard limits: a named file is kept, whatever its type, when it was modified inside the window (2 seconds of slack on each end); a named folder is scanned two levels deep for PDFs, raster images and SVGs modified inside the window, skipping dot folders, `node_modules`, symlinked folders, the home and temp folders and anything directly under the root. Each folder is read entry by entry and left after 500 entries, with at most 48 folder reads and 40 files per call, and the renderer sends one batch of up to 64 calls at a time. Results are kept per call while the pane is open and checked again when it reopens, so deleted files drop out. They show as "Made 14:32".
  - This discovery is best effort. It can include unrelated files changed in the same folders while the call ran, and it cannot tell copied assets from deliverables, so a raster image copied during a command counts as made. It misses files a command never names (directly or through a folder), files deeper than two levels, and anything past the limits.
  - Images and PDFs form grids of 4:3 thumbnails with the file name below. A PDF tile shows the first page when the operating system provides a thumbnail (main's `nativeImage.createThumbnailFromPath`, at most 480px), with a small "PDF" marker; otherwise it shows a PDF glyph. The grid is a contact sheet for scanning renders side by side, which is why it is an intentional exception to the rule against identical card grids. Tiles stay flat: a hairline frame on `--bg-inset`, with no nested cards, shadows, gradients or eyebrow labels.
  - Clicking a thumbnail opens a larger view in the pane with [Back to outputs] (Esc), Show in folder and Copy path, plus Open in default app for raster images and PDFs. A PDF opens in Chromium's built-in PDF viewer inside the pane: main opens the file once, checks through that handle that it is a regular file of at most 64 MB, reads no more than that, and returns the bytes only when they start with `%PDF-`. The renderer shows them through a `blob:` URL in an iframe (the CSP allows `blob:` frames). When omp makes or views the PDF again, the view reads it again and keeps the current page on screen until the new bytes arrive; each Blob URL is revoked once it is replaced or the view closes. When the PDF can't be read the view says "This PDF could not be displayed."
  - An image's larger view is the zoom view, and it also has "Expand preview", which opens the same `full` layer as the Files viewer (images, including those that came only as data, and PDFs). Esc closes the layer first; the next Esc goes back to the list.
  - File rows are the paths `write`, `edit` and `ast_edit` touched (a staged `ast_edit` preview counts once it is applied) and the other files commands made, in 30px rows with the name, the folder and the action with its time ("Edited 14:32", "Written 14:32" and so on; the date alone for older outputs). The folder ellipsizes first and then the name; the full path is the row's tooltip. Clicking a row opens the file in the Files pane.
  - File actions (Show in folder and Copy path) need a path. Images that came only as data still offer Copy image and Save image as. The native thumbnailer accepts only checked raster images and PDFs: main resolves symlinks, requires a regular file and checks its leading bytes. Open with default app uses those checks for raster images and PDFs and asks for confirmation before opening other file types, including SVG, because their associated application may run code.
  - SVG: the panes show an SVG only through `<img>`, where scripts, event handlers and external loads do not run, from the data URL main builds in `panes:readFile` (up to the same 8 MB as other images; a 0.7 MB slide with embedded fonts renders with its fonts). Browsers refuse to draw an SVG image whose root is not in the SVG namespace, and editors and HTML-inline snippets often leave `xmlns` out, so main adds `xmlns` (and `xmlns:xlink` when the file uses `xlink:` without declaring it) to the root `<svg>` start tag of the copy it sends; nothing else in the file changes and the file on disk is untouched. Grid tiles show the SVG itself. File rows in replies (§4.6) get their thumbnail by drawing the SVG into a 96px PNG in the renderer, since main never hands SVG to the operating system's thumbnailer.
  - The empty state reads "No outputs yet" and "Images and files omp creates, writes, changes or views in this chat appear here."
- **Tasks** (`TasksPane.tsx`): the checklist, the helpers at work (helper definitions are managed in Settings → Helpers, §4.14) and background jobs:
  - The checklist has a progress bar, and a highlight slides to the step in progress.
  - Helper rows show a 28px letter avatar with a status dot, the name, the status ("Working", "Done", "Failed" or "Stopped") with the token count, and the activity line in up to two lines. The activity line is, in order of preference, the intent of the current call, the last intent, the intent of the latest finished call, the newest output line, omp's description of the task, then the first line of the assignment without omp's "Complete assignment thoroughly:" preamble. The run time is omp's latest report; omp measures it only when it reports progress, and a helper waiting on a long model reply sends none, so while a helper works its displayed duration increases each second from the moment the app received that report. Times read from a saved transcript, and those of finished helpers, stay as reported. A helper that finished its turn shows Done, here, on its card under the task call and in the task row, even while omp keeps it (`idle`, or `parked` with its session saved) so it can take a follow-up message. A message runs it again, and omp's report that the new turn started shows it as Working. Each row offers the helper's transcript when there is one, "Message {name}" while it works or while omp keeps it for a follow-up (the message box then reads "It starts working again when it reads this."), and "Stop {name}" while it works.
  - Running helpers come first, in omp's order, then finished helpers newest first, by the app's latest progress report from each or else omp's last activity time for it. Every running helper shows, then the three latest finished ones and any older failed one, because a failure is the outcome the reader most likely has to act on. The rest wait behind "Show {n} earlier helpers", which becomes "Show fewer helpers" once the list is open. Three finished cards take about 400px of a 312px pane, so the running helpers and the background jobs stay within reach. Rows that open or fold use the background jobs' row motion (`listRowMotion`), and reduced motion keeps only the fades.
  - The transcript dialog ("{name}'s conversation") opens with the assignment under an "Assignment" label, without omp's preamble. Later messages omp sent the helper show as "Message from {name}" cards (with "Interrupted its wait" when the message ended a wait), as muted one-line notices for omp's reminders, or under a "Message" label when they carry no markup. Displayed `custom_message` entries use the chat's notice rows.
  - Background jobs follow omp's `/jobs` list: running jobs first, then the five most recent finished ones, with the rest behind "Show {n} earlier jobs". The section is one bordered list with hairline rows. Each row leads with a pulsing dot while the job runs, or the chat's notice mark once it has settled (a check, a red cross or a stop mark), and its title is the intent the model gave the command, such as "Building the macOS installers". Under the title, the command's first real step appears in faint monospace: `commandSummary` splits the command only at top-level `;`, newlines, `&&` and `||` (never inside quotes, substitutions or here-documents) and skips `set -e`, `cd`, `export`, assignments, `sleep`, `echo` and comments, falling back to the first line when the quoting does not parse. A job whose call gave no intent uses that step as its title. The right side shows the time since the job started while it runs (the only job row with a timer). A settled job shows omp's reported run time, "Exit {code}" in the error color when the output ends with omp's exit line, and "Stopped" for a job that ended without a result; a value omp did not report is left out. A row opens to the full command, the last 40 lines of output and the job's id.
  - Saved and exited chats never show running work. Without omp running for the chat, a helper still marked working shows Stopped with the neutral mark, a helper omp kept for a follow-up stays Done without "Message {name}", and a job still marked running shows stopped. omp's `session_exit` entry marks where an omp process ended, so work still running at that point shows stopped even after the chat is resumed. A read-only chat counts as running while another window owns it or its ownership could not be checked; a read-only chat found free to continue does not, because no other process is writing it. The header work chip, the Tasks pane, task rows and helper cards apply the same rule.
- **Plan**: the plan file, polled every 2 seconds while visible. While omp waits for a decision, an `--accent-muted` bar offers [See all options] and [Approve plan].
- **Terminal**: the project's own shells ("Shell 1", "Shell 2"…), separate from omp's terminal screen (§4.11).

### 3.8 Status bar (28px)

The status bar (`shell/StatusBar.tsx`) uses ink chrome in both themes. Features add entries through `statusItems`. The left side shows project and Git state. The right side can show provider-plan usage, app updates and omp status. Items have accessible names and tooltips. At narrow widths, labels collapse before controls are clipped.

Plan usage (`features/extensions/usage/PlanUsageStatus.tsx`) shows one meter per provider. It lists the providers of the focused chat's model and its running helpers first, then every other provider it has shown since the renderer loaded, in the order they first appeared, across all chats. A helper that finishes therefore leaves its provider on the bar, so a Codex helper's limits stay in view after its task ends. The list exists only in renderer memory and is never saved, so quitting, reloading the window or opening a new window begins again with the focused chat's providers. A provider in use now follows its current models; one kept from earlier uses every model it was shown with. When the bar runs out of room the item drops window names, then folds the providers after the first into "+N", then drops provider names, then percents. It folds as soon as the bar row or either side's column holds more than its width, because the left column can shrink and its text would otherwise run under the right one.

---

## 4. Screen specs

Wireframes are schematic. Every screen uses the §3 shell unless noted, and the strings quoted here come from `src/renderer/src/i18n/en/`, which is authoritative when they differ.

### 4.1 Native first-run setup

Setup opens as a full-window native wizard without the sidebar or side panel. It uses the shared surfaces, spacing, controls and motion presets, with a draggable title area and an inline terminal only for omp's installer and sign-in commands.

Fresh app preferences set `setupCompleted: false`. An existing preferences file without that field is treated as completed, so upgrading does not start the full wizard. Existing users whose omp is missing, unsupported or refused see only the install step. Help and the command palette offer [Run setup again] to open the full wizard explicitly.

The full wizard presents these steps in order:

1. **Welcome** explains that setup connects a provider and chooses the app's initial settings.
2. **Install or update omp** appears only when omp is missing, unsupported or refused. It reuses the existing installer IPC and update dialog, with the states below. A supported omp skips this step.
3. **Providers** uses omp's provider discovery and `omp login` in an inline terminal. The app stores no credentials itself. [Skip] remains available until a provider is connected, then changes to [Continue].
4. **Default chat model** saves the selected model to omp's global chat default, so it applies outside the current project.
5. **Permissions** preselects [Ask me first] (`always-ask`). The selected mode is saved globally through omp's configuration path.
6. **Appearance** changes the app's appearance with a live preview. It leaves omp's terminal theme unchanged.
7. **Done** summarizes the choices. Finishing marks setup completed, opens the app and permits the existing first-run tour (§4.2).

[Exit setup] or Esc also marks setup completed and dismisses the wizard, preserving choices already saved. Setup completion belongs to the app preferences. It never writes omp's `setupVersion`, so terminal omp still offers its glyph, composer and theme setup.

The install step retains the existing recovery behavior:

- **Missing omp** shows the official install command, [Run installer], [Copy command] and [Check for omp].
- **Installing** shows output in an inline terminal with [Cancel install] and the final status or exit-code error.
- **Unsupported omp** names the installed version and the 18.14.0 minimum. [Update omp] opens the same update dialog as About, streams output and checks the detected version on completion. Managed installations name the responsible application and direct the user there instead.
- **Refused omp** on Windows shows "omp can't start", quotes Windows' reason and names Smart App Control only as a possible cause when it is on. [Check for omp] is primary and [Run installer] secondary. A failed check says "Windows still didn't start omp".
- **Still missing after a check** shows a warning suggesting that the user reopen the app.
- **Ready omp** advances the full wizard, or opens the app for an existing user who needed only installation.

[Copy command] shows "Command copied". The install step's help link opens the limited Help content without actions that need omp; [Back to setup] returns to the wizard.

### 4.2 First-run guided tour

The tour runs after setup has completed and a supported omp is available. Its automatic start waits 800ms and remains blocked while setup is open or needed. Five steps spotlight their targets: the scrim is `--backdrop` with an 8px-padded cutout (radius 12) and a `--ring` outline, and it glides between targets on the gentle spring.

- **Card**: 320px, `--bg-overlay`, `--radius-lg`, `--shadow-overlay`, placed beside the target. Title `--text-base` semibold, body `--text-md` `--fg-muted`.
- **Footer**: [Skip tour], step dots (screen readers hear "Step N of 5"), and [Show next step →], which becomes [Start chatting] on the last step. Content slides in the direction of travel.
- **Keys**: Esc finishes, → and ← step, and focus stays in the card.
- **Steps**:
  1. **Projects and chats**: "The sidebar lists your projects and chats. Each request becomes a chat you can return to."
  2. **Say what you want**: "Type what you want in plain words and press Enter to send. Commands are optional shortcuts."
  3. **How much omp does on its own**: "This setting controls how much omp does before asking you. Auto lets omp edit files and run commands without approval, so commit or back up your work before you use it."
  4. **Watch the work**: "This panel shows changes, files, previews, outputs, running helpers, the plan and a terminal. Choose one from the menu at the top of the panel." The side panel opens for this step and closes again afterwards.
  5. **Project and usage status**: "The status bar shows git information, available plan usage and omp status. Open Usage & limits for estimated API cost."
- The tour can be replayed from Help → [Take the tour]. [Run setup again] in Help or the command palette reopens setup separately.

### 4.3 Project overview

`features/projects/ProjectOverview.tsx` shows the project overview when the project view is selected. The project row's name and "Open project overview" open it, and so do the project rows on Home.

- **Layout**: a column up to 920px with 24px padding. The overview is a size container, and from 46rem wide "Instructions and settings" and Git share one row as two columns.
- **Header** (`PageHeader`):
  - The project name as the title.
  - A meta line with the folder path in mono, then "Copy folder path" and "Show in folder" icon buttons.
  - Actions: primary [Start chat here] and a "Project options" menu: Project settings…, Project instructions…, Import a chat…, Show in folder, and Remove project from list.
- **Sections** are a heading row and their content, without boxes, in this order:
  - **Recent chats**: 40px rows with a `ChatStatusMark`, the title, a "read-only" chip when another window has the chat, and the age. After five rows, "Show all {n} chats" opens the rest and "Show fewer chats" folds them again. With none: "No chats in this project yet."
  - **Instructions and settings**: a summary list. Instructions names the active instructions file and its size, or "No instructions yet", with the enabled rules count ("{n} rules loaded") as a link to the Rules tab of the Instructions page. "Model for new chats" shows the default role's model, or "Chosen by omp". "Permission mode" shows the level. A value set for this project only adds "· this project only". Below the list, [Edit instructions] or [Write instructions] and [Project settings].
  - **Git**: shows whether the folder is clean, its sync state (up to date, commits ahead or behind, no tracking branch, or no commits), and a CI checks chip when available. [Review changes] appears when there are file changes. Branch name and line counts remain in the status bar. A folder outside git reads "This folder isn't a git project yet…" with [Set up git].
  - **Start from an example**: "Each example opens a new chat with the prompt ready to edit before you send it." The starters are Fix a bug, Build a feature, Explain this, Clean up, Add tests and Fix mobile layout, each with its prompt beside it.
- The overview shows no cost figures; spend appears on the Usage & limits page (§4.18) and, for the last 7 days, on Home (§4.24).
- **Other states**:
  - With no projects, an empty state shows the 48px mark: "No projects yet. A project is a folder that omp works in." It offers [Open folder…], [Create project] and primary [Start chat in folder…].
  - A project whose folder is missing reads "Can't find “{name}”" and offers [Find folder…] or [Remove project from list].

### 4.4 New project wizard

A 560px dialog with three steps: "New project", "Details" and "First chat". Step dots sit beside "Step N of 3", and the steps slide in the direction of travel.

1. **Where?** One bordered list of three options, each with a native radio: "Empty folder" (Start fresh in a new folder), "Open existing" (Use a folder already on this computer) and "Clone from GitHub" (Download a project from a GitHub link). The selected option is filled with `--accent-muted`.
2. **Details**, depending on the kind:
  - Empty folder: project name, location and **Folder color**, a row of swatches (None and the seven colors, native radios named for screen readers, with the chosen name beside them). The color is saved before the project is listed, so the folder appears in color.
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
│ ≣ Working for 14s · 3 tool calls                 ●  │ step group (§4.7): accent icon, pulse dot
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │● Atlas  Reading src/cart/coupon.ts      43s ■   │ │ pinned helpers (§3.5): running ones only
│ │● Bolt   Searching for applyCoupon       50s ■   │ │
│ └─────────────────────────────────────────────────┘ │
│ ● Working… 14s · Working with helpers               │ working row above the composer
```

- **Working row**: while omp works it opens (with `Expand`) just above the composer.
  - It shows the accent pulse dot, "Working… {elapsed}", and the kind of work under way in plain words (`activityKey` in `chat/friendly.ts`): "Running commands", "Reading files", "Searching files", "Editing files", "Searching the web", "Reading web pages", "Running code", "Using the browser", "Working with helpers" and so on, with "Using tools" for anything else. It names the newest running call, else a call still streaming in, else "Writing a reply" while reply text streams, else "Thinking". The command or file itself shows only in the step's own row.
  - It is status only. Stopping is the composer's action slot (§3.6), so a working chat has one control for stopping the main reply, separate from the Stop button of each pinned helper.
  - It is not a live region, and the sidebar row and session header show the working mark.
- **Pinned helpers**: while helpers run, the strip of §3.5 appears between the transcript and the working row, so the reader sees them working however far the reply has moved on. A helper leaves the strip as soon as it stops running, and its card is back under its task call in normal flow, where later content pushes it off screen.
- **Streaming**: omp's collab host sends a reply in bursts (a measured run of omp 18.4.9 with claude-opus-5-5 delivered roughly 140 characters every 630ms), so showing each burst as it arrives makes the text jump. The reveal therefore runs through a playout buffer (`chat/transcript/pace.ts`): a rate controller moves the text at the rate it comes in and steers toward a target buffer that adapts to how omp delivers it (1.25 times the slow end of the gaps between bursts, kept between 0.4s and 1.5s, about 0.8s in that run), so it keeps moving between bursts. A reply starts showing about 250ms after its first text arrives, a long pause in the reply lets the reveal catch up and stop, and after omp finishes the message the controller targets showing the rest within about 0.6s while frames run, without slowing down. One timeline runs through the message's blocks in order: visible text and open thoughts take time, while collapsed thoughts and tool calls show when the reveal reaches them, so hidden thinking never delays the reply. The saved entry that replaces the stream row continues the same reveal and switches to its full-parse render once the reveal catches up. A stream first seen while the mirror synchronizes shows its current text in full and paces only what arrives after; reduced motion shows text as it arrives. Streamed Markdown renders one top-level block at a time (`MarkdownBlocks` in `transcript/render.ts`), so unchanged leading blocks keep their DOM nodes and a selection in them survives incremental updates. A later reference definition or math opener can change an earlier block and replace its nodes. A view pinned to the bottom follows growing text, while a view scrolled up holds still and shows "Show new activity". Live tool rows rise in as they start; history renders at rest.
- **Figures and charts**: SVG and Mermaid reply fences and `.svg`/`.mmd` write previews show the drawing with a keyboard-accessible View source disclosure. Invalid drawings keep the source open and explain that rendering failed. Figures use the containing theme's text, muted text, border, selection surface, accent and status tokens; series map to the accent and syntax-color tokens. Authored titles and descriptions are exposed on the image for screen readers. Diagrams retain natural-size text inside named, keyboard-focusable horizontal scrollers at narrow widths. Numeric tables retain their full accessible data and scroll frame, followed by a named SVG chart when omp 18.14's local usefulness gate qualifies them. Charts use the same theme mapping and flat fills, with a 440px minimum drawing width inside their own horizontal scroller at narrow widths. No chart or figure has an extra card frame.
- **Remote images**: Markdown images hosted elsewhere initially show their alt text, host and a Load image button. Loading one leaves every other image unchanged. Loading and failure text share the existing muted secondary style, and the button retains the normal keyboard focus outline. A Mermaid diagram that requires image resources or external styles shows its source with a short explanation.
- **File links**: file and folder names in a finished reply open in the Files pane (§3.7). The transcript collects inline code spans and words shaped like paths (absolute, `~/`, `./`, `a/b`, names ending in `/`, names abbreviated with `…`, and names with an extension that starts with a letter, so `1.2.3` and `e.g.` do not qualify), and skips links, code blocks and math. Main checks them through `fs:resolveRefs`, without reading content: an absolute or `~/` name resolves directly, and a relative one is tried in the folders named earlier in the reply (latest first), then in the chat's folder, then in the folders omp wrote or edited files in. Each occurrence resolves on its own, so the same name after two different folders can open two different files. Only references found on disk when checked become links. Cached links can become stale if files move or are deleted.
  - **Abbreviated names**: exact paths are tried first, so a filename containing a literal `…` still resolves. Otherwise, `…` (U+2026) in the final path component stands for omitted characters. Visible prefix, middle and suffix parts must match in order, with the prefix and suffix anchored to the name's ends. Three ASCII periods (`...`) stay literal because filenames and code also use them. Main lists only the same candidate parents, without recursion. Matching skips dot-prefixed entries and symbolic-link entries. A candidate folder is skipped when its own basename starts with a dot. The first eligible folder with any matches decides the result: one regular file or folder becomes a link; two or more leave the name unlinked, without trying a later folder. This preserves the reply's folder context instead of letting a less recent folder resolve an ambiguous name. Chips and rows keep the abbreviated text as written. The target, tooltip and Copy path action use the full resolved path.
  - **Chip**: a name inside a sentence, or in a code span (which becomes a chip in place of its code pill), is an inline-flex pill on the text baseline: a 14px type icon in `--accent`, then the name as written in the UI font at weight 500 in `--fg`, with 1px 6px 1px 4px padding, `--radius-sm` corners and a `--hover` background. Its height stays inside the line (20px in a 22px line at 100% text size). Hover turns the background `--selected` and the text `--accent`. There is no underline.
  - **File row**: a paragraph or list item that holds only one name, apart from whitespace and trailing punctuation, becomes a row up to 520px wide (about 47px tall at 100% text size; both scale with the text-size setting): 1px `--border`, `--radius` corners, `--panel` background and 6px 10px 6px 6px padding. A 32px tile on `--bg-inset` shows the type icon, replaced by a thumbnail (object-fit cover) for raster images and PDFs once `panes:thumbnail` returns one, and for SVG once the renderer has drawn the file (read as an image, so its scripts never run) into a 96px PNG. Thumbnails load when the row scrolls near view and stay cached by path for the session (the 120 most recent paths). Beside the tile, the file or folder name (`--text-md`, 500, `--fg`) sits over its parent folder (`--text-xs`, mono, `--fg-faint`, home shown as `~`), and both are truncated. The name keeps a line, column or range citation the reply wrote (`app.ts:42`, `app.ts:50-100`), while the folder and tooltip come from the resolved path. A trailing `ArrowUpRight` in `--fg-faint` shows on hover and focus. Hover turns the background `--hover` and the border `--border-strong`. A list whose items are all rows drops its indent and stacks the rows 4px apart.
  - Type icons: `FilePdf` for PDFs, `FileImage` for raster images and SVG, `FileCode` for code, HTML, CSS, JSON and similar, `FileText` for Markdown, text and CSV, `FileZip` for archives, `Folder` for folders and `File` otherwise. The links are built in a DOM pass over the reply's HTML, so the Phosphor icons are rendered once at module load into SVG markup that each link clones.
  - Both are `role="link"` with the full path as the tooltip. A chip's accessible name is the name as written; a row's is "{name}, in {folder}", with any citation in the name. A click, Enter or Space opens it; a drag that selects text inside it does not.
  - Limits: one request per reply checks at most the first 100 references, with at most eight bases (the chat's folder and seven folders omp wrote in), and a relative name is tried in at most the four folders named most recently before it. Abbreviation matching accepts folders with at most 512 entries, reads one extra entry to detect an oversized folder, and reads at most 4096 entries across the request. Hidden entries count toward these limits. Oversized folders are skipped, incomplete scans produce no match, and exact paths still resolve after the listing budget is exhausted.
  - A streaming reply gains its links once its reveal finishes. Results stay in memory for the session, keyed by open chat and message (the saved entry that replaces a stream row reuses them) and stored with the reply's text and bases. When a write adds a base, the reply is checked again while its previous links stay visible; up to 300 replies are kept.

### 4.7 Tool steps

Each tool call is a borderless 32px row. Consecutive rows stack with no gap.

- **Groups** (`ToolGroup.tsx`, Normal view only): a run of steps, with the thoughts between them, is one row, "Worked for {elapsed} · {n} tool calls" with "{n} failed" in `--err` and a caret that opens the rows. Text, a helper run, a question and the turn's latest checklist board end a run (`transcriptLayout` in `turns.ts`). Each step joins its group as soon as omp starts writing the call, the turn's first call and a call still running included, so a step never shows as its own row first and then folds. A group can therefore hold one call ("1 tool call"), in a finished turn as well, so nothing changes shape when the turn ends. The reply still streaming in and tools omp started before their call was saved take part in the same layout. While any of its calls runs, the group row takes the running look of a tool row (`--accent` icon, `--fg` label, the pulse dot in a 16px slot before the caret) and reads "Working for {elapsed}", counting up each second from the first call's message ("Working" when that time is unknown), and its count grows as calls arrive. Opening it shows the tool rows as they stand, a running command's output well included. A thought after the run's last call stays outside the group until another call follows it. A row the reader is using (opened, or with keyboard focus inside) also ends a run and stays a row until it is closed and focus leaves it, and a group the reader is using keeps its own first step and key, so a fold or merge never takes either away mid-read. Rows inside a group don't report this, so using them never reshapes the groups. A group keeps its open state by key, so it stays open when a streamed reply turns into its saved entry. A group that forms while the chat is open rises in like a new row; history, a window edge moving and switching views render at rest. Thinking and Verbose views show every step.
- **Row**: a tool icon (`--fg-faint`, or `--accent` while running), the friendly summary in `--text-md` (`--fg-muted`, or `--fg` on hover and while running), `+N −M` for edits, and a 16px status slot.
- **Status slot**: the pulse dot while running, a bold check in `--fg-faint` when done, and a bold cross in `--err` ("Failed") on failure. Each status has its own shape.
- **Caret**: appears on hover and opens the row.
- **Open row**: shows the model's intent line and omp's own rendering of the call. Verbose adds the raw JSON arguments and starts rows open.
- **Running output**: a running command's last output shows in a small `--bg-inset` well under its row.
- **Structured output**: eval views replace the corresponding printed text in order. Tables scroll horizontally and right-align numeric columns; JSON branches use keyboard-operable disclosures; Markdown uses the reply presentation. Trees initially open only the root and show 50 entries per branch. Tables initially show 20 rows and 12 columns. Buttons reveal further entries, rows and columns in those page sizes without discarding later data. Submit Result shows the section labels, submitted field tree and omp's rejection reason or reported error. Read cards show jq filters as separate badges, leaving the displayed file path and its context-menu target free of the query.
- **MCP progress**: a running card shows the server's message and reported count beneath its row, with the same facts in expanded details. Eval cells show their MCP progress beneath the code and output. A missing total stays an opaque counter, so the app does not infer a percentage.

| Tool | Icon | Summary while running / done / failed |
|---|---|---|
| edit | `PencilSimpleLine` | "Editing {file}…" / "Edited {file}" (or "Edited {n} files") / "Couldn't edit {file}" |
| write | `FilePlus` | "Writing {file}…" / "Wrote {file} ({lines} lines)" / "Couldn't write {file}" |
| read | `BookOpen` | "Reading {file}…" / "Read {file}" / "Couldn't read {file}" |
| grep, search | `MagnifyingGlass` | "Searching for “{pattern}”…" / "Searched for “{pattern}”" / "Search for “{pattern}” failed" |
| glob, find | `FileMagnifyingGlass` | "Looking for files…" / "Listed files matching “{pattern}”" / "Couldn't list files" |
| bash | `TerminalWindow` | "Running {command}…" / "Ran {command}" / "{command} failed with exit code {code}" |
| task (helpers) | `Robot` | "Helper “{agent}” is working…" / "Helper “{agent}” finished" / "Helper “{agent}” failed"; "Helper “{agent}” stopped" with a neutral mark. A helper omp keeps for a follow-up message counts as finished |
| todo | `ListChecks` | "Updated the checklist" / "Checklist: {done} of {total} done" |
| web search, fetch | `Globe` | "Searching the web for “{query}”…" / "Searched the web for “{query}”" / "Web search failed" |
| eval | `CodeSimple` | "Running Python…" / "Ran Python" / "Python raised an error" |
| other tools | `Wrench` | "Using {tool}…" / "Used {tool}" / "{tool} failed" |

The full set of patterns is in `i18n/en/tools.json` and `chat/friendly.ts`.

A task row's mark follows its helpers. It is running while any helper runs, an error when any failed and none runs, and a success check only when every helper finished; a helper omp keeps for a follow-up message counts as finished. Stopped helpers, with none running or failed, get a neutral dash whose accessible name is "Stopped"; such a row never shows a success check. Mixed batches name each state with its count, such as "3 helpers: 1 finished · 2 stopped". In a saved or exited chat, and for work that was still running when an earlier omp process ended, a helper still marked working counts as stopped (§3.7). While a helper runs, its card is not under its task call, because it is pinned at the bottom of the chat (§3.5); the row still counts it. Once it stops running, its card opens back under the call (with `Expand`).

**Command results**: what omp printed for a typed slash command shows as a tool-style row after the message that was last on screen when it was sent. The row has the `TerminalWindow` icon (`Warning` or `XCircle` when omp printed a warning or an error), the command in mono `--fg-muted`, and omp's lines in a mono `--bg-inset` well cut to 12 lines with "Show all N lines". A dismiss button shows on hover or focus. Rows are not saved, and a chat that only holds results does not show the empty state.

### 4.8 Question and approval card

Shown after the stream whenever omp asks a question or needs approval.

- **Card**: `--panel`, 1px `--border`, `--radius-lg`, 16px padding, `--shadow-card`. It has an 18px icon beside the title and no side rail or eyebrow. It rises in and leaves once the question is answered.
- **Choice**: `Question` icon in accent, the title and omp's help text (or "Choose any that apply").
  - Options are 48px bordered tiles in a two-column grid, each with a radio or checkbox that scales in.
  - For single choice, the `--accent-muted` highlight slides between options.
  - Arrow keys, Home and End move between options, and a double-click answers a single choice at once.
  - An "Other" field accepts a typed answer.
  - Footer: omp's optional "Chat about this", [Skip question], and [Send answer] (or [Send choices]).
- **Question series**: omp hands the app one question of an `ask` at a time and has no way to return to an earlier one, so an `ask` with more than one question is answered in the app first and sent to omp afterwards. The card reads every question from the running `ask` call and shows one at a time.
  - "Question 2 of 3" sits at the top right in `--fg-muted`, outside the sliding content, as a polite status that also describes the option group. The title keeps clear of it and wraps, as do long option labels. The options are the tiles above, and the "Other" field is offered for multiple choice as well.
  - Footer: [Previous question] (`ArrowLeft`, from question 2 on), "Chat about this", then [Skip questions] and primary [Next question] (`ArrowRight`), which becomes [Send answers] on the last question. Next stays disabled until the question has an answer: a single choice starts on omp's recommended option, and multiple choice needs a checked option or text.
  - Each answer is kept, so going back shows the picked option, the checked options and the typed text. Alt+Left and Alt+Right move between questions while focus is outside a text field, and a double-click on a single choice moves to the next question (on the last one, it sends the answers).
  - Questions slide between each other through `PresenceSwap`, and with reduced motion they fade instead. Focus follows to the new question's picked or first option.
  - [Send answers] replays the answers against omp's requests in order, by option position, since omp can add a suffix to repeated labels. Each request must match the expected question first: its title, its option labels in order as omp displays them, its sentinel rows, and for "Other" the custom answer editor of that question (a title cut at the terminal width must still fit only that question). The footer shows a spinner and "Sending your answers to omp…" until the `ask` call ends.
  - "Chat about this" and [Skip questions] apply to the whole `ask` at once, as they do in omp.
  - A series belongs to one collab room. Nothing is sent while the mirror is reconnecting, still downloading or read-only, and a new room, omp exiting or the `ask` call ending drops the series. After a reconnect to the same room, sending resumes only at the request the replay expects.
  - If a request does not match, or omp repeats a request that was already answered, the replay stops and omp's request shows in the single-question card above, under the note "omp asked in a form the app did not expect, so it stopped sending your saved answers. Answer the rest here." Another request that takes question 1's place while the questions are open (an approval, say) shows in its usual card without the note, and nothing is answered for it.
  - An `ask` with one question, approvals, extension selects and text answers keep the single-question card.
- **Approval**: `ShieldWarning` in `--warn`, "Permission needed", and the unchanged request in a mono `--bg-inset` well. A select with an `Approve` or `Approve Once` choice and a final `Deny` is an approval regardless of the other choices' order. [Deny action] and primary [Allow action] answer those exact labels. With session or file/folder grants, the primary becomes [Allow once] and keeps initial keyboard focus; broader approvals appear as secondary buttons under "Approve more than this action", with omp's exact labels and an explanation of session versus "Always" choices. A quiet note above the footer says "Sending a message now denies this request."
  - [Deny and say why] reveals an inline text area. [Deny and send message] sends that explanation through the composer's Send now path, so omp denies the pending action and steers the turn with the message. Blank explanations are disabled; a failed send keeps the text. Ordinary Deny and approval choices still answer their exact labels without sending a message.
- **Text answer**: a text area ("Type your answer…"), with [Skip question] and [Send answer].
- **omp dialog**: omp's own option lists, confirmations, one-line inputs and editors, which omp does not mirror over collab, use the same card read from omp's screen. A confirmation shows omp's Yes and No buttons, a list shows option tiles with [Cancel] and [Choose option], and an input or editor shows a text field with [Cancel] and [Send answer] (⌘⏎ sends from the editor). When omp shows only part of a long list, the card says how many options are hidden and offers [Open omp terminal]. While the card shows, the terminal sheet stays closed.

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

The title bar's Search commands field and ⌘K (Ctrl+K) open a centered 640px palette dialog, 18vh from the top, on `--bg-overlay` with `--radius-lg`, `--shadow-overlay` and the `--backdrop` veil.

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

- **Groups**: an empty query shows starter commands and recent chats. While typing, the palette groups matches as actions, chats, files and settings. The five starter commands are New chat, Compact this chat, Choose model, Show omp terminal and Settings.
- **Scope**: the palette searches registered commands, chats, project files and settings. With no match, a row offers to send the query to omp; a query that starts with `/` goes through the same routing as the composer's slash commands.
- **Danger**: danger commands show in `--err` and need ⌘⏎. The first Enter shows "Press ⌘⏎ to run this".

### 4.11 omp terminal sheet

The omp terminal appears in a bottom sheet at 80% of the window height. It can expand to fill the window and mirrors omp's own terminal screen when the app does not draw that screen natively.

- **Title**: "omp terminal" or "omp terminal: {screen}", with the description "This is omp's terminal screen. Click or type to use it."
- **States**:
  - Reconnecting: a warn strip.
  - Stopped: an error strip with [Restart omp].
  - Starting: "Starting omp…".
  - Read-only: when another window owns the chat, "You can look, but only that window can type."
- **Leaving**: leaving while an omp menu is open asks "Leave this omp screen?", with [Stay on this screen] and [Leave screen].
- **Terminal colours**: The mirror reads the active omp theme's `terminal.background`, `terminal.foreground` and 16 ANSI colours through the app-hosted extension. Bundled and custom JSON themes use omp's own loader and colour resolver. Missing fields use the active TUI colours; a theme created only in memory has no JSON terminal section to read.

### 4.11.1 Advisor sheet

Configure advisors in the work modes menu and `/advisor configure` open a 600px right sheet, capped by the viewport. The scope picker switches between the project-root and active user `WATCHDOG.yml` or existing `.yaml`. A roster picker and Add advisor precede the selected advisor's fields. Review cadence and every-Nth-update controls appear before catch-up, model, session kind, note limit, tool access and instructions. Shared instructions and the shared note limit follow the roster editor. Controls stack at narrow widths; the body scrolls while Save and Close remain in the footer.

The form preserves raw imports and an explicit empty investigative-tool selection; the advisor can still submit notes. A changed file refuses stale saves, and malformed YAML remains available through Open file. Closing or Reload with unsaved edits asks for confirmation. Save and apply invokes omp's own advisor editor callback while the chat is ready, retaining its current on or off state. A preservation transaction restores comments and unknown fields after omp's canonical write and refreshes the sheet's baseline. Pending application belongs to the chat and scope, so it survives sheet closure and scope switching. Numeric catch-up choices explain their 30-second cap, and Strict states that it has no time limit.


### 4.12 Settings

Settings opens as a full page (`features/manage/settings/SettingsPage.tsx`, §5.6) with a `NavRail` of sections. Features add sections through `settingsSections`, and each section renders its own `PageHeader` with a one-sentence description. `openSettings(section, …)` links to a section; the sidebar, the palette commands, the status bar's update notice, Help, project settings and the Tasks pane use it.

- **Rail groups**: the rail groups sections into App (General, Appearance, Sounds & alerts, Shortcuts), Agent (Models & roles, Permissions, Providers, Helpers), Context & tools (Connected tools, Skills & plugins, Memory), then an unlabelled group with Advanced and About.
- **Width**: Helpers, Connected tools, Skills & plugins and Memory manage lists and use the 920px column; the other sections are forms in the 680px column.
- **Scope**: General, Models & roles, Permissions, Connected tools and Advanced are scoped. Their header meta line holds a `ScopeSwitch` ("Where these settings apply": "All projects" or "Project: {name}"). The project is the one active when Settings opened; with no project the scope is all projects.
- **Sections**:
  - **General** ("Choose how much omp may do on its own and how your chats look."): under Safety, Permission mode; under Chats, Transcript view, Show thinking as omp thinks (on by default; in Normal view the thought omp is writing stays open while it streams, §3.5), Voice input, Summarize long chats automatically, and omp's tone. General, project settings and the composer offer Ask me first, Ask and remember, Edits OK and Auto. Unknown modes retain their raw value, show an explanation and leave known choices unselected.
  - **Appearance**: Theme (Light, Dark, System), a text size slider with a preview sentence, and Reduce motion (Match system, On, Off).
  - **Sounds & alerts**: the "Alert me in the background" switch controls notification banners and the Dock bounce or taskbar flash (§4.22). The description explains that macOS and Windows keep the unopened-result badge while alerts are off. On Windows and Linux a [Send a test] button requests a notification; on macOS a note explains that background alerts bounce the Dock icon once per newly unseen chat, and that notification banners are unavailable in the current macOS build.
  - **Shortcuts**: a searchable table of the app's shortcuts.
  - **Models & roles**: §4.13.
  - **Permissions** ("Choose, tool by tool, whether omp may use it without asking."): tool-by-tool Default, Ask, Allow or Deny, and a field to add a tool by name. Foreground computer control has its own row and asks by default, independently of permission mode. A Restricted folders section has a native [Add folder] picker and individual remove actions. Its explanation states that every access requires approval, regardless of mode or remembered grants. Inherited restrictions are identified; starting a project-specific list retains the other inherited folders. Global edits never promote a project's list. [Forget remembered approvals] confirms its all-projects scope before running omp's builtin and shows what omp printed. The confirmation explains that approvals held by an already running chat can remain until restart. Tool controls wrap below their labels at narrow widths.
  - **Providers** ("Sign in to model providers and see what omp reports about them."): provider status and discovery run outside projects with extensions disabled; the note identifies omitted project settings and extension-contributed methods. Explicit terminal sign-in retains the selected project. Transfer sign-ins offers [Export sign-ins…] and [Import sign-ins…], both global-only. Each confirms before a native file picker, explains that exports contain unencrypted secrets and warns that another computer's refresh can sign out the original. Import replaces matching accounts and keeps other sign-ins through omp's merge command.
  - **Helpers**: §4.14. **Connected tools**: §4.15. **Skills & plugins**: §4.16. **Memory**: §4.17.
  - **Advanced** ("Every omp setting, including the ones other sections don't show."): a searchable list of every omp setting, with "Changed only", per-setting reset and a reset-all action. Tern-only settings remain listed because omp 18.14's JSON metadata omits UI conditions; hiding them accurately remains blocked on an omp metadata path.
  - **About**: the 48px mark beside the large wordmark and "A desktop app for omp, the coding agent."
    - Rows for the visual-omp version (and how it updates), the omp version and channel, the omp location, and the last update check.
    - Actions: [Check for updates], [Read release notes], [Read omp docs] and [Report an issue].
    - When a newer visual-omp version exists, its row offers [Review update], which opens the in-app release-notes viewer before any update starts. [Read release notes] opens the same viewer, including when no update is available. A newer omp version still offers [Update omp].
    - When omp reports an app-managed installation, its row says "Managed by {app}" and offers no Update action.
- **Unsaved edits**: sections with drafts (Models & roles, the helper editor) use the leave guard, so switching section or scope asks first (§5.6).
- **States**:
  - A change made outside the app shows an info banner with [Reload settings].
  - A read failure reads "Couldn't read omp's settings: {reason}", with [Try again].

### 4.13 Models & roles

The Models & roles section (`features/manage/roles/ModelsSection.tsx`) describes how models are assigned to jobs and offers [Refresh models] in its header. Its description reads "Choose which model handles each job, such as everyday chat, planning and commit messages."

- **New chats**: a "Default thinking" select sets the thinking level for new chats and has a chip naming where the value comes from. Its tooltip reads "Higher thinking levels allow more reasoning and may take longer or cost more."
- **Model roles** ("Changes to roles wait until you save them."): a hairline list shows one row per role, including Job widgets (`widget`), whose unassigned model follows Fast (`smol`). Each row has the role name, its id in mono when the two differ, an accent dot while the row is unsaved, a line saying what the role is used for, a Model picker and a Thinking select. A missing model shows "This model isn't available. Pick another one." in an `Expand`. Model capability hints label free models explicitly and reserve the low-cost icon for known fixed input prices of at most $1 per million tokens.
- **Footer**: the footer remains visible at the bottom of the list and shows the pending count or save scope, [Revert changes] and primary [Save roles].
- **Presets** appear below the roles. "Save as preset" stores the whole set, and each preset can be applied or deleted. The first alphabetical preset matching every effective role assignment and its recorded default thinking level has an Active chip. Unsaved role drafts do not change that marker.
- **Compaction limits** follow Presets. A model picker selects a model-specific limit in the chosen config scope. The input accepts a base (`90k`), a percentage (`80%`) or an exact fixed trigger (`f400k`); clearing it restores the inherited limit. The preview names the trigger and its basis. Saving a limit that opens an extended window first confirms the larger window and any applicable long-context pricing threshold. When per-model limits are disabled, the preview and extended-window confirmation explicitly describe behavior after they are enabled; saving leaves the active window unchanged. Unsaved limits use the leave guard.
- Leaving with unsaved roles asks "Discard your changes?"

### 4.14 Helpers

The Helpers section (`features/manage/agents/HelpersSection.tsx`) lists reusable helper definitions, with the description "Reusable specialists omp can hand work to." The section holds helper definitions only; running helpers show in the chat (pinned at its bottom while they run, §3.5) and its Tasks pane (§3.7).

- **Header actions** include [Reload helpers], [Create helper with omp] and primary [New helper].
- **Toolbar**: the toolbar offers search and a "Show" switch between All, Built-in, All projects and This project.
- **Rows** show a 32px letter tile on `--bg-inset` in mono, the name, scope and "Customized" chips, the description, a model chip and an on/off switch. Each row's menu offers Edit helper or Customize helper, Duplicate helper, Run helper now and Delete helper.
- **Broken files**: a broken definition file shows a warn tile, "Can't be used" and [Fix file].
- **Editor**: Edit and New open a 400px right sheet (`AgentEditor.tsx`) that uses the leave guard.
- **Tool access**: the editor labels the default as "Use omp's default tools". Turning it off selects a built-in allowlist, including an empty list. Supporting tools and extension tools remain subject to omp's behavior, so the editor does not promise that the list controls every capability. The tools fieldset has a wrapper to preserve the form's standard spacing before the structured-results switch.
- **Structured results**: a standard switch, "Return structured results", keeps the helper's result tool and saved output schema when `task.structured` is off. The switch changes only the flag; reads, edits and Duplicate preserve the schema. A schema editor would add a separate editing workflow for an opaque omp-owned format, so this control stays a single switch.
- **Scope at discovery ceilings**: This project is disabled in the filter, new-helper editor and AI creation dialog when the folder is home or a shared temporary root. A short explanation identifies this as visual-omp's policy and directs the user to a subfolder or All projects.

### 4.15 Connected tools (MCP)

The Connected tools section (`features/extensions/mcp/McpSection.tsx`) manages MCP servers and offers [Add server]. Its description reads "MCP servers let omp use outside tools, such as a database or a ticket tracker."

- **Scope**: the page's scope switch, beside the config path.
- **Rows**: in a bordered list. Each row has:
  - a `StatusDot` with a glyph ("Connected", "Couldn't connect", "Connected, but slow to start", "Turned off" and others)
  - the name and transport
  - the tool count
  - an on/off switch
  - a menu: Test connection, View tools, Edit server, Remove server
  - warn chips for "No tools found. Check the command." and "Needs sign-in"
- **Project checks**: opening the section never connects project servers. [Test connection] and [View tools] require a native per-invocation confirmation naming the server, scope, folder and destination, with a warning about commands and substitutions. Background checks resolve only saved all-projects entries in main and use a neutral folder.
- **Sign in**: OAuth presets and remote-server editors offer [Sign in]. Pending changes save first, then main re-reads the chosen scope and asks for native confirmation before project settings, commands or substitutions. omp runs its browser flow with ambient MCP discovery and extensions suppressed. The editor reports progress and failure, preserving omp's selected project folder and native credential-write path.
- **Empty**: "Add a server to let omp use an outside tool, like GitHub, a database or your notes."

### 4.16 Skills & plugins

The Skills & plugins section (`features/extensions/skills/SkillsSection.tsx`) has the description "Install and manage the skills and plugins omp can use." It has Skills and Plugins tabs, search, and a "Show" switch between "Installed", "This project" and "Registry".

- **Skills**: rows with a letter tile, name, scope chip, description and switch. Clicking a row opens a 460px detail sheet (`SkillDrawer.tsx`): What it does, When omp uses it, Show file, Remove skill.
- **Skill registry**: under "From the skill share registry", rows with install counts and [Install skill].
- **Skill project scope**: project installs are disabled at home and shared temporary roots, with a short explanation beside the skill list. Projects inside those folders retain project installs.
- **Plugins**: installed plugins show their version and marketplace update chip ("v1.3 → v1.4") when the catalog reports a newer version. npm and git packages offer [Update] through `omp plugin upgrade <name>` independently of marketplace availability. Marketplace updates keep their qualified id and selected scope. "Install by name" and "From your marketplaces" list what is available.
- **Activity**: installs and updates appear in an Activity list with progress.

### 4.17 Memory

The Memory section (`features/extensions/memory/MemorySection.tsx`) shows what omp remembers, with a backend chip in the header meta line. Its description reads "Notes omp keeps between chats so it doesn't start from scratch."

- **Toolbar**: the toolbar offers a 240px scope select, search and [Forget everything]. Forget everything asks you to type "forget".
- **List**: the keyboard-navigable list is 280px wide and appears beside a reader that shows the entry's kind, dates, tags and content, with [Export memory…] and [Forget this]. The list and reader scroll on their own inside a bordered frame.
- **Backend off**: a notice links to the memory backend setting in Advanced.
- **Empty**: "omp hasn't saved any memories yet."

### 4.18 Usage & limits

Usage & limits opens as a full page (`features/extensions/usage/UsagePage.tsx`, §5.6). Dollar figures appear only here and in Home's usage glance (the last 7 days, §4.24, which the owner asked for), and are always labelled Estimated API cost.

- **Provider limits**: each provider row identifies its account, status and applicable window. It can expand to show all accounts and windows, preserving the window order omp reports. Unknown values remain unknown, and warnings remain visible when an account is collapsed. An account with routing diagnostics shows omp's priority, reserve percentage and source, state (eligible, inside reserve, exhausted or unknown), remaining percentage and reclaim threshold when present. A help tooltip explains that this is an account-wide diagnostic and routing can differ for a model or chat.
- **Saved resets**: omp reports each account's banked rate-limit resets (`resetCredits`, Codex and Claude today). A provider row with any shows a small chip beside its name, "{n} saved resets", in the neutral tone, or the warning tone when one expires within 24 hours, which is also when omp warns, since an unspent reset is lost; that account then gets a collapsed alert, "{account}: a saved reset expires in {time}". The name and chip wrap onto two lines when the name column is too narrow for both. The expanded account shows "{n} saved resets" with the soonest expiry ("The soonest expires in 1d 9h", the exact time in its tooltip), "None can be spent now" when the provider says so, and [Spend a reset].
  - **Spend a reset** opens a dialog, "Spend a saved {provider} reset?", naming the account and its organization. Main lists resets through `omp usage reset --json` (`src/main/features/usage/resets.ts`). `parseResetListing` rejects a partly malformed listing, so the dialog cannot spend from data it does not understand.
  - The dialog matches structured account ids, falling back to email when one side lacks an id, and requires compatible organization identity. Labels are display text only. Exactly one stored sign-in must match; a missing or ambiguous match offers omp's `/usage reset` picker in a chat instead.
  - A matched entry shows omp's label and the exact target ("omp lists this account as {label}, stored sign-in openai-codex/4."), omp's live counts and soonest expiry, and "A spent reset can't be returned." Which limits the reset clears is stated only when omp's last report names the next credit (`nextCreditId`) and its `clears`, attributed to that report; otherwise the dialog says the report doesn't say and the provider decides. When omp reports none usable, it shows omp's reason and [Spend reset] stays disabled.
  - [Spend reset] runs `omp usage reset <provider>/<credential id>`. The confirmed target and spending state are held by `ResetFlow` (`usage/resets.ts`), so polling cannot change or restart them. Main refuses concurrent spends for the same target. The dialog cannot be dismissed while omp spends.
  - The result, "{provider} reset result", shows omp's output verbatim. A zero exit code confirms success, including when no output was printed; a nonzero exit code is shown as failure. The app never retries a spend automatically, because interruption can occur after redemption. Main's refusal before launch reads "No reset was sent to omp." The limits then refresh; a failed refresh retains its reason and [Refresh limits]. No chat needs to be running, and no transcript or queue is involved.
- **Activity** (`ActivityGrid.tsx`), between the limits and recorded usage: omp's model requests per local day as a GitHub-style calendar on its own card, one column per week from the locale's first weekday (`Intl.Locale` week data, Sunday without it), the newest week on the right and days after today left out. The card shows a year, 53 weeks; a narrower grid shows as many whole weeks as fit. Cells are 11px with 3px gaps and corners a fifth of the edge, and once the year fits they grow up to 16px to fill the card. Month names head the first week of each month, dropped when closer than three weeks to the next, and Mon, Wed and Fri label the rows on the Usage page. A day's shade ranks its requests among the active days shown, in quarters (`activityWeeks`): no requests is `--heat-0`, and the busiest quarter is `--heat-4`. The scale is relative to the days shown, not a fixed request count, so the compact grid keeps its contrast and a day's shade can differ between Home and this page. Hovering or focusing a day shows its date, requests and estimated API cost in the chart's tooltip card; the days form one tab stop, where up and down move a day, left and right a week, and Home and End jump to the first and last day. Under the grid, "{n} requests since {date}" and a Less to More legend. It reads one `extensions:spend` summary of 371 days (`ACTIVITY_DAYS`), kept in `usageMemory` for Home, with its own failure, stale and partial-file notices, and the period switch below doesn't apply to it.
- **Recorded usage**: a 7- or 30-day period control applies only to local recorded usage, from omp session and subagent files. A segmented KPI strip shows Chats, Tokens and Estimated API cost. The daily chart uses neutral bars except for today's accent bar and includes an average line. A separate share-bar card breaks cost down by project when more than one project has cost. Selecting a project share filters the chat table.
- **Chats**: a searchable, sortable table shows per-chat usage, with project and model filter pills, paging and CSV export. Filters apply to the table and export. Partial data and failures are labelled.
- The page links to omp stats in a browser. Its provider limits and local recorded-usage period have separate sources and refresh behavior.
- **Empty**: "No recorded usage in this period" with "Chats you run with omp appear here with their token use."

### 4.19 Session tree

A 960×640 dialog: "Session tree", with the 20px mark, the description "Every branch of this chat, from the first message to the current point." and [Close].

- **Canvas**: on `--bg-inset`, 180×40 message nodes with 2px `--border-strong` connectors. The current node has an accent outline, and the selection ring glides between nodes.
- **Navigation**: drag to pan; zoom with ⌘+, ⌘− and ⌘0.
- **Side panel**: a 320px preview of the selected message, with [Rewind to here] or [Resume from here] and [Fork from here]. omp notices appear as the same one-line summaries the transcript uses, such as "Helper “X” finished" or "Message from X: …".
- **Empty**: "No branches yet. Fork or rewind to try another approach."

### 4.20 Share dialog

- **Link**: "Creates an encrypted link. Only people who have the link can read the chat." An optional secret GitHub gist is available. [Create link] returns a link with a copy button.
- **File**: "Save this chat as a web page you can open anywhere." Secrets are masked before HTML export. A separate **Export anonymized copy** action runs `omp anonymize <session> -o <dir>` after a native chooser selects a new or empty folder. Its explanation states what omp redacts, what metadata remains and that exported files need review before sharing.
- **Move**: **Move to another computer** saves a tar with `omp session pack <session> <out.tar>` through a native Save dialog. The explanation states that the original content may contain secrets, the chat's omp process must exit first, and the local copy remains unchanged. **Import from another computer** is available without an open chat: native choosers select an archive and destination project folder, then run `omp session unpack <archive.tar> --cwd <dir>`. Project files travel separately. Matching older copies may be replaced; diverged copies import as forks. Successful operations show omp's confirmed path and diagnostics; imported chats offer **Open imported chat**. Cancellation and errors remain visible without claiming an export or import succeeded.
- **Invite**: "Let someone watch or join this chat live." [Start sharing] produces two invite links, one to join and one to watch, and a list of the people present with Editor and Viewer chips. [Stop sharing] ends it.
- **While shared**: the status bar shows the "Shared" item (§3.8), which opens this dialog on the Invite tab.

### 4.21 Help

Help opens as a full page (`features/onboarding/HelpPage.tsx`, §5.6) in the 680px column, titled "Help" with the description "Short guides for common tasks and definitions of the terms visual-omp uses."

- **Header actions** include [Take the tour] and [Keyboard shortcuts]. Keyboard shortcuts opens Settings → Shortcuts.
- **Contents** begin with "Search guides and terms", followed by "Guides" and "Glossary".
- **Guides** include Your first chat, Staying safe with Auto mode, Rewinding and forking, and When omp asks questions. Each is a disclosure row with an icon, title and summary that opens to its four steps.
- **Glossary** contains 13 terms defined in `helpContent.ts`.
- **No match**: "No matches" with "omp can answer questions about itself and about your project." and primary [Ask omp: "{query}"], which opens a new chat with the question. Without a project it asks to open one first.
- **More help**: omp documentation and Report a problem.
- The setup screen shows the same content without the parts that need omp (§4.1).

### 4.22 System surfaces

**Update notice**: an info toast (§5.7) titled "visual-omp v{version} is available" with the release summary, or "The release notes list what changed." when no summary is available. Its action row holds [Dismiss notice] (quiet) and [Review update] (accent). Review update opens the release-notes viewer and dismisses the notice. Settings → About lists both versions and provides the same review action for visual-omp. The strings live in `i18n/en/onboarding.json` (`update.*`) and `manage.json`, which are authoritative over this summary.
**Release-notes viewer** (`ReleaseNotesViewer`): a 720px dialog titled "visual-omp release notes", using the shared dialog size limits, tokens and reduced-motion behavior. **This update** lists notes for published versions newer than the installed version through the offered update, newest first, including intermediate releases retrieved across GitHub pages. Each version begins with its overview and categorized highlights, followed by detailed headings. **Past versions** provides the installed version and earlier releases in the shared version selector. Published GitHub bodies take precedence; the bundled CHANGELOG supplies installed and older bodies when needed, with their source identified. Unreleased entries and future bundled versions are excluded. A failed check identifies offline notes while leaving saved and bundled notes readable. The body scrolls vertically, and wide tables scroll inside `.tr-table`. Raw HTML is escaped, images do not load, and links use the external-link handler. The fixed footer remains outside the scrolling body, with [All releases on GitHub], [Close] and, on This update, [Update to v{version}]. Only the explicit update action starts the existing installation flow.
**Update window** (`AppUpdateSheet`, opened after [Update to v{version}] starts the update): a large dialog titled "Update visual-omp to v{version}" with the release summary, the body for the install method, [Read release notes] as an accent text link back to the viewer, and [Close]. A Homebrew install shows the upgrade's output in an inline terminal and then [Restart visual-omp]. A per-user Scoop install shows one sentence ("visual-omp closes, Scoop updates it in a PowerShell window, and visual-omp opens again when Scoop finishes.") and [Update and restart] (primary), which goes through the quit-warning dialog. A Scoop install for all users has no update button: it explains that only an administrator can update it, shows `scoop update visual-omp --global` in an `--bg-inset` mono block with [Copy command] (ghost), and the person runs it after quitting. A disk-image or installer copy shows the download's progress and its next step. On an installer copy, a hairline rule separates a muted line at the end of the dialog, "Scoop can install visual-omp and update it without the installer.", followed by an inline accent link, [Show how to switch]. The link expands three numbered steps: install Scoop from scoop.sh ([Open scoop.sh], ghost), the three PowerShell commands in an `--bg-inset` mono block with [Copy commands] (ghost, toast "Commands copied"), and quitting and uninstalling the installer's copy, which keeps the profile. It starts collapsed on every update and never interrupts the download.
**Quit-warning dialog**: a modal shown when quitting while omp is working in a chat, which means omp's reply is in progress or any helper it started is working (`workInFlight` in `state/chatWork.ts`, the helper rule of the status marks in §3.2), or while a chat's state could not be checked. It has a warn glyph and the title "Quit while work is running?" ("Quit while work may be running?" when the only chats it asks about could not be checked). The body states the work recorded when the user chose to quit ("When you chose to quit, omp was replying in 2 chats. 3 helpers were working as well."), names the chats that could not be checked ("visual-omp could not check whether omp is working in 1 chat."), and ends "Quitting stops any work still running. You can reopen your saved chats next time." The dialog keeps that wording and waits for an answer even if the work ends; each listed chat shows what it is doing now on the right: "Working", "2 helpers working", "Working with 2 helpers", "No work running" or "Not checked". The actions are [Keep waiting] and [Stop and quit] (danger), with the checkbox "Always stop working chats when quitting", which skips the dialog for known work when quitting and never for chats that could not be checked. Closing a single working chat asks with its own dialog (§8.4), which has no checkbox. A request for the same operation while its dialog is open shares the answer; a different one (a quit while a close dialog is open, or closing another chat) gets its own dialog after the first is answered. Before deciding, a quit waits up to 5 seconds for init() to adopt the running omp processes and for their rooms to sync; a chat still unknown after that is listed as not checked, so a quit never hangs and never treats unknown work as idle. On macOS, closing the window leaves the app and its omp processes running; a later quit while omp runs opens the window again and asks once it has loaded. The strings live in `i18n/en/onboarding.json` (`quit.*`).
**Notifications and unopened results**: a chat becomes unseen when its main turn finishes or it starts waiting for an answer while the window is unfocused or minimized, or while the chat is absent from both visible split halves. Home, pages, project overviews and an expanded side panel covering the chat also leave results unseen. Showing the chat with window focus clears that chat alone; focusing on another chat or Home leaves the others unchanged. Closing a tab removes its unseen state. A main-turn finish counts while helpers still run, and a helper finishing later reports nothing. Each chat counts once. Validated reasons persist with restorable tabs because reopening the app on Home does not mean those results have been read.

The badge is independent of the background-alert switch: it records results still to read without interrupting work. Only background notification banners and the one-time bounce or flash follow that switch. Main stops bouncing or flashing on focus without clearing the count, and clears native attention on reload, renderer loss and window close. The renderer republishes restored counts on launch. Background events are tracked while the app window remains open, including when minimized; closing the macOS window stops tracking new events until a window reopens.

- **macOS**: the Dock badge shows the unopened-chat count while positive, including while another chat is focused. On the owner's Mac, a badge that the app had set remained hidden until Allow notifications was enabled for visual-omp (observed on 2026-10-27). Settings › Sounds & alerts advises checking Allow notifications and Badge application icon in System Settings › Notifications › visual-omp if the count is missing. With background alerts enabled, a newly unseen background chat bounces the icon once (informational). Background events also request a native banner; macOS denied banners to the tested ad-hoc signed build, so the current build shows none.
- **Windows**: the taskbar overlay shows the unopened-chat count while positive, including while another chat is focused: an accent circle with the number, "9+" above nine, described for screen readers as "N chats finished or need your answer". With background alerts enabled, each newly unseen background chat flashes the taskbar button. Background events request a native toast under the AppUserModelID `ltd.decoy.visualomp`, subject to system notification settings. Windows requires a Start menu shortcut carrying that ID. The installer sets it, and a per-user Scoop install writes it into `Scoop Apps\visual-omp.lnk` at launch because Scoop recreates the shortcut during updates. A global Scoop install needs administrator rights to change its shortcut, so it gets no toasts.
- **Toasts and banners**: the title is the chat title and the body a one-line outcome ("Finished: Edited 3 files and tests pass ✓" or "Needs your answer"), shortened with an ellipsis past 256 and 1,024 characters. Clicking one restores and focuses the window and switches to that chat.

There is no in-app notification center. Current chats separates unopened results from viewed chats (§3.2). Home's recent chats and project overviews use the same unseen marks for open chats. The strings are in `i18n/en/onboarding.json` (`notify.*`), `shell.json` (`sidebar.unseen.*`) and `manage.json` (`alerts.*`).


### 4.23 Packaging and loading

The figures in this section describe the macOS arm64 app directory as measured with `du`, in MiB. The app decreased from 303.9 MiB (0.4.2) to 242.5 MiB (0.5.0), about 61 MiB less. Retaining only `en` and `en-US` removed 48.2 MiB of Electron locale files. The ASAR archive decreased from 14.2 MiB to 3.9 MiB. Pure-JavaScript main-process dependencies are bundled; `node-pty` is the native runtime dependency. Source maps are excluded. The renderer figures are uncompressed build-output sizes of individual chunks. The initial renderer entry chunk decreased from about 4.87 MB to 1.56 MB. Xterm (about 331 KB) and KaTeX (about 262 KB) load as separate chunks, and Settings sections, Usage and other feature views are code-split.

### 4.24 Home

`features/home/HomeScreen.tsx` is where the app opens, and the title bar's Home button shows it. It is not a page, but like one it renders on the gray canvas (`data-surface="canvas"`): the sidebar keeps its lists and the side panel stands aside. Pages opened from it say "Back to Home". Closing the last open chat also returns to it.

- **Layout**: an outer page scroller, with independently scrolling Recent chats and Projects cards in the three-column layout. The content is centered, up to 1200px, with 24px gutters, a top margin of `clamp(2rem, 7vh, 5rem)` and 40px between the prompt box and the sections. Each section is a panel `Card` (`--panel`, white in light mode, 1px `--border`, `--radius-lg`, 16px padding, no shadow) on the canvas, so the three read as separate places. From 1080px wide (a size container) the three cards stand side by side at 3fr, 2fr and 2fr with 24px gaps: Recent chats, Projects, Usage. The Usage card sets the row's height. Recent chats and Projects keep their own height up to it (`CappedCard`: the wrapper holds no in-flow content and stretches to the row, and the card inside is positioned at its top with the row as its maximum height), so a short list leaves a shorter card, and a list opened with "Show more" scrolls inside its card once it reaches the Usage card's height. Narrower, the sections stack in that order, 24px apart, at their own heights. With the lists collapsed and a single-line draft, the tested maximized window showed all sections without scrolling. Expanded content and shorter windows retain vertical scrolling. Usage phrases wrap whole at the dots in its narrow column, and the Projects actions are small buttons so both fit on one line.
- **Hero**: the 40px mark, 16px, then the empty chat's question at `--text-2xl` bold ("What should we work on?", or "…next?" once there are chats), 24px, then the prompt box.
- **Prompt box** (`HomeComposer.tsx`): the composer card (§3.6): the growing text box at full width, then a toolbar with ＋ (Attach file) on the left and Send on the right; Enter sends and Shift+Enter adds a line. While the text box has keyboard focus the card shows the composer's focus ring (§3.6): the 2px `--ring` outline with a 2px offset. Pasted or dropped images become chips and other files become absolute `@path` mentions, since the draft can still move to another project. The text, images and chosen folder are kept in the composer drafts under `home`, so an unfinished draft preserves its destination when leaving Home, returning or restarting. The quiet row under the card holds the project folder picker (projects pinned first with their color dots, then Open folder… and Create project…), the permission level (`PermissionMenu`, a project setting), the model (the chat's `ModelList`) and the thinking level. The initial folder is `/tmp` on macOS and Linux, or the system temp folder on Windows. A successful send resets it, as does returning to Home with no text or attachments. A cancelled send preserves the whole draft. It appears in the picker before any chat exists there, named as the projects list names it, such as "tmp". Choosing a project or opening a folder changes only this Home draft's folder, leaving the sidebar and status bar's active project unchanged. Model and thinking start from that folder's default role and go to omp as `--model` and `--thinking` launch flags only when changed, so the new chat can still move folders before its first message. The thinking button names only a level the chat will start with: a picked level the new model can't take is dropped, and a default the model doesn't offer leaves the button unnamed for omp to decide. Sending starts the chat (`startChat`), which then shows; a `/command` goes where the composer would send it.
- **Recent chats**: the newest saved chats across every project from `sessions:recent` (one walk of the sessions folder), six rows, or eight in the three-column layout, with "Show more chats" opening the rest. A 40px row holds the status mark, the title, a read-only chip when another window has the chat, and the project's 8px color dot (a hollow ring without a color), its name and the age. Chats of missing folders are left out. With none: "No chats yet. Start one above and it appears here."
- **Projects**: pinned first, then by activity, six rows with "Show all {n} projects". A 40px row holds the folder (filled in its color, `FolderMinus` in `--warn` when missing), the name, a pin and "{n} chats · {age}"; a colored project's row carries a 10% wash of its color, 16% on hover. [Open folder…] and [Create project] follow the list.
- **Usage** (`UsageGlance.tsx`): up to three providers closest to a plan limit, each with a `Meter` and its window and reset ("16% of the 5h limit used · Resets in 2h 39m"), with "Near limit" or "Limit reached" in words when it applies, then "Estimated API cost, last 7 days" with the amount and "What this usage would cost at public API prices.", then "Activity" and the activity grid (§4.18) at the weeks the card's width fits, without weekday labels. It reads the shared limits snapshot, one 7-day spend summary and then the activity year, which it leaves for the Usage & limits page; "Open Usage & limits" links there. Figures kept from an earlier read after a failed refresh say so, as do totals with unreadable session files, each on a line with a `Warning` glyph in `--warn` and the Usage page's own wording, and "No recorded usage in this period" shows only when every read worked. Activity has its own such lines, and it shows even when the last 7 days are empty, since earlier months can hold requests.
- **Ping field** (`PingField.tsx`): a Canvas 2D dot grid behind everything, 28px pitch, `--plot-dot` at 5-12% alpha drifting on two slow sine fields, densest behind the hero and never below 25% of that lower down; the fade is in the alpha math, with no gradient or mask. Every 6-10s a sonar ping sweeps out from a random point at 260px/s to 640px: dots in the 90px band behind its edge brighten and grow up to 2px, and the 30px nearest the edge turn `--plot-accent` (the teal), fading out over the last quarter; three pings in ten send a fainter, faster echo. It renders at about 30fps and pauses while hidden, offscreen or after the window has been in the background for 10s. Under reduced motion it draws one still frame.
- **Focus**: the text box takes focus when Home mounts. The prompt box carries `data-tour="composer"` and its permission button `data-tour="permission"`, so the first-run tour, which now starts on Home, points at them.

---

## 5. Component library spec

These primitives live in `src/renderer/src/ui/` and are imported from `@/ui`. Colors always come from tokens. Every interactive component has a `:focus-visible` ring (§1.8); icon-only controls carry a tooltip and an `aria-label` that matches it; disabled controls stay visible at 45% opacity with a `not-allowed` cursor. Icons are Phosphor (`@phosphor-icons/react`). `App` mounts `IconContext` with size `1em`, regular weight and `currentColor`, so callers size icons with `size-*` classes and pass `weight` only to deviate (`bold` for heavier strokes, `fill` for solid status glyphs).

### 5.1 Buttons

| Variant | Fill | Text | Border | Use |
|---|---|---|---|---|
| Primary | `--accent`, hover `--accent-hover`, active `--accent-active`, `--shadow-primary` | `--accent-fg` | none | the main action on a surface |
| Secondary | `--panel`, hover `--bg-inset`, active `--selected`, `--shadow-card` | `--fg` | 1px `--border-strong` | default action |
| Ghost | transparent, hover `--hover`, active `--selected` | `--fg-muted`, `--fg` on hover | none | toolbars, headers |
| Danger | `--err`, hover `--err-hover`, `--shadow-primary` | `--fg-inverse` | none | destructive confirmation |
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

All menu-like surfaces share the same anatomy: a 12px `--bg-overlay` floating surface with border and `--shadow-pop`, 6px inset padding, and 32px rows with 8px horizontal padding and 6px row radii. Icons or check slots lead; shortcuts align right in faint monospace. Destructive items use `--err`; separators use a border and 6px vertical margin. Group labels use sentence case. Descriptive radio rows are 44px tall with a muted second line, and selected radio items show a leading check. Submenus use a caret. Menu content has a 200px minimum width; select lists match the trigger width. Popovers use the same floating surface with 12px padding and an optional title and description. Menu surfaces portal outside chrome and use the sheet palette.

Opening uses the Radix transform origin with a short scale and offset; closing fades and scales down. Compact controls may use half-step spacing.

Text editing and plain-text selection use a native operating-system context menu (`main/contextMenu.ts`), with Electron roles supplying localized editing labels. Custom labels come from `src/shared/i18n/en/contextMenu.json`, using the renderer locale convention for interpolation keys. Editable fields offer Undo, Redo, Cut, Copy, Paste and Select all, disabled according to Chromium's edit flags; Windows also offers Delete, and rich-text fields offer Paste and match style. A misspelled word offers spelling suggestions and Add to dictionary. Selected read-only text offers Copy, with Look up on macOS. Lookup previews are limited to 40 Unicode code points. An empty, noneditable target has no native menu. Renderer context-menu triggers must cancel the DOM event for their own targets so the native menu does not open for them; ordinary text fields and selections must leave it uncancelled.

Spellchecking is enabled for prose in the composer and disabled in its Shell and Python modes. Paths, commands, repository URLs and other code-like fields disable spellchecking explicitly; prose fields retain the browser default.

#### Context menus for transcript and pane targets

Links, resolved file and folder references, tool paths, turn-summary files, Changes rows, Files tree entries and viewer tabs, image thumbnails and open previews use the shared Radix menu. Helper conversations and Plan Markdown use the same link and image actions. Preview address suggestions also offer the link menu. Existing left-click actions remain unchanged.

Web links offer Open in browser, then Copy link. Loopback web links also offer Open in Preview pane, scoped to the chat that contains the link. Files and folders offer Open first, then Show changes when available, Open with default app for files, the platform's reveal action, path-copy actions and Mention in chat. Images offer Copy image and Save image as first, followed by default-app, reveal and absolute-path actions when a backing file is known. Separators divide navigation, copying and chat insertion.

Copy path always copies an absolute path, so its result remains usable outside the current project. Known filesystem paths retain their literal spelling, including punctuation; only raw tool references have selectors removed. Copy relative path appears only for paths inside that chat's project and uses forward slashes. Folders open in the Files pane, matching resolved folder links. Native reveal and default-app handlers reject network and device paths before filesystem or shell access, while allowing local paths outside the project.

The context-menu key and Shift+F10 open the same menu on a focused target. A right-click within selected text keeps the native selection menu, including selected link text, a selection spanning a link and selected viewer code. A selection elsewhere does not suppress the target menu. Handled target events are canceled before they reach Electron. Images are rasterized to PNG in Chromium and passed as bounded data to main for clipboard copying or a native save dialog. Main does not fetch image URLs. A remote image that refuses cross-origin canvas access reports an error instead of copying incomplete content.


### 5.6 Pages, dialogs and sheets

**Pages** are for sustained management and reading: Settings, Usage & limits, Help, Project settings and Instructions. A page takes over the main area (`useApp.openPage(id, props)`, `ui/Page.tsx`). Features register pages in `pages` and open them through `state/navigation.ts` (`openSettings`, `openUsage`, `openHelp`, `openProjectSettings`, `openProjectInstructions`). The chat it replaced stays mounted, hidden and inert, so Back finds it with the same scroll position, expanded history and split width; the side panel hides while a page shows. Pages are not restored: after a restart the window opens on Home (§4.24).

- **Layout**: `PageFrame` uses one vertical scroll region. Content widths are form, list and data variants, centered with 24px page padding. If the sidebar is shown, the page portals Back into its slot; a section navigation such as Settings also occupies the slot and replaces the chat lists. Other page Back links leave those lists visible. If the sidebar is hidden, Back and section navigation render inline. The dock is hidden while a page is open.
- **Header**: `PageHeader` shows a wrapping title, description, optional metadata and actions. Focus follows a page or section change to the page title after a lazy section mounts, unless the reader has moved focus.
- **Back**: Back returns to the chat, project overview or Home the page replaced ("Back to chat", "Back to project", "Back to Home"). When the chat it replaced has closed meanwhile, Back returns Home. ⌘B with the sidebar visible controls sidebar visibility. Page navigation preserves its return destination and guards unsaved edits.
- **Settings links** (`openSettings(section, { projectPath, scope, sectionProps })`): every field applies on each link, including while Settings is open. The project is fixed when the link is made; scope falls back to all projects when there is no project.

**Dialogs** are for bounded decisions: confirmations, sharing, short creation flows and wizards. **Sheets** remain for edge overlays that keep their context in view: the omp terminal (§4.11), the commit and pull request forms, the helper editor (§4.14) and the skill detail (§4.16). Overlays that any feature can open, dialogs such as Share included, register in the `sheets` registry and open with `useApp.openSheet`.

Dialog: centered with translate utilities, widths 400 / 480 / 560 / 720px, `--bg-overlay`, 1px `--border`, `--radius-lg`, `--shadow-overlay`, 20px padding. The scrim is `--backdrop`, a translucent dimming wash (alpha 0.42 in light, 0.62 in dark) with no blur. Click outside or Esc cancels; `destructive` dialogs show a warning glyph and ignore scrim clicks. Title 16/600, body `--text-md`, footer right-aligned with 8px gaps. Opens with a spring scale 0.95 → 1 and fade; closes with a short scale-down.

The `full` size fills the window less 16px on each side, for previews of wide content (§3.7 "Expand preview"). It uses the same surface, scrim and motion; `actions` puts icon buttons in the header before Close, and the body fills the remaining height.

Sheet: docked right (default width 480px) or bottom (default 60vh), 8px from the window edges, `--bg-overlay`, 1px `--border`, `--radius-lg`, `--shadow-overlay`. 48px header (title, actions, close), scrolling body, optional sticky footer. Slides in from its edge on the gentle spring and slides partway back while fading on close. Both trap focus and return it on close.

**Page building blocks**: `SectionHeader` provides a title, optional description and actions; `KpiStrip` presents segmented key figures; `Meter` shows a provider-reported limit with its account and window named; `Progress` represents task progress; tables use sticky headers, hairline rows, right-aligned numeric cells and sortable header buttons; `ScopeSwitch` appears in scoped Settings sections; `Notice` pairs a status glyph with a message and optional action.

### 5.7 Toasts

Bottom-right stack of up to three, 320px wide (never wider than the window minus 32px), `--bg-raised`, 1px `--border`, `--shadow-pop`, `--radius-lg`. Row one holds the tone icon, the message (13px/500) and description (12px `--fg-muted`), and the close button. Message and description wrap anywhere, so long versions and file names never push the close button out. When a toast has actions, they sit in their own right-aligned, wrapping row below: the quiet `secondaryAction` first, then `action` in accent. Both dismiss the toast. info and ok toasts dismiss after 5 seconds unless sticky, and hover or focus pauses the timer; warn and err stay until dismissed. Toasts rise in on the gentle spring, the stack reflows with layout animation, and a rightward swipe (past 80px or 500px/s) throws a toast off.

### 5.8 Tabs

Underline variant: 28px (sm) or 32px (md), 1px `--border` baseline, active text `--fg`. Pill variant: 24 or 28px pills, active fill `--selected`. The active marker (2px `--accent` underline, or the pill fill) is one element that slides between triggers; its `layoutId` comes from `useId()` in each `Tabs` instance. Triggers rendered outside `Tabs` fall back to a static marker. `Tabs` is used in the prompt library, the Instructions page and Skills & plugins. Chats have no tabs: open chats are sidebar rows (§3.2), and the side panel picks its pane from a menu (§3.7).

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
- **Streaming caret**: a 2px `--accent` bar after the last revealed character of streaming text, blinking at 1s. It stays while the playout buffer drains after the reply ends.
- **Reduced motion**: the halo holds still, the dot freezes at 60% opacity, and the caret stops blinking.

### 5.17 Context-usage ring

20px ring, 2.5px stroke: track `--border-strong`, fill `--accent`, round cap, starting at 12 o'clock. Zones: under 60% `--accent`, 60-80% `--warn`, over 80% `--err` with a slow opacity pulse. The arc eases to new values over `--dur-slow`. Screen readers get `role="meter"` and "62% of context used".

The ring appears once, in the composer's bottom row (§3.6), while the chat reports context usage. It shows "{n}%" beside it from 60% (hidden in the compact row states), and its tooltip reads "{n}% of the context window used". Clicking it opens a popover, "Context window", with the token count against the window size, a progress bar in the zone's tone and [Compact chat], which is primary from 60% and waits while omp is replying.

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
| Configure advisors | "Choose each advisor's model, tools, review cadence and catch-up policy." |
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
| Usage & limits | "Check your plan limits and the usage omp recorded on this computer." |
| Review code (Changes pane) | "Ask omp to review these changes for bugs (runs /review)." |
| Permission button | "How much omp may do before it asks you." |
| Send now (while omp works) | "Send now. omp reads it at its next step, before this reply finishes." |
| Reopen closed chat (⌘⇧T) | "Bring back the chat you closed last, with any text you hadn't sent." |
| Next waiting chat (⌘⇧A) | Select the next open chat waiting for an answer. |
| ⌘1-⌘9 (Ctrl elsewhere) | Open the corresponding Current chats row. |
| ⌘⇧[ / ⌘⇧] | Cycle through open chats in open order. |

### 8.2 Empty states

- **No projects**: "No projects yet. A project is a folder that omp works in." with [Create project].
- **No chats in a project** (sidebar): "No chats yet. New chats in this project appear here." On the project overview: "No chats in this project yet."
- **Empty chat**: "What should we work on?" (or "What should we work on next?"). The first chat adds "Describe the change in plain words, or start from an example."
- **Changes pane**: "No uncommitted changes" and "Edits made since your last commit appear here, whether omp or you made them."
- **Tasks pane**: "Nothing running" and "omp's checklist, helpers and background jobs appear here while a chat works."
- **Preview pane**: "Nothing to preview" and "Type a local address above, or start a dev server in this chat to get a link."
- **Terminal pane**: "No terminal open" and "Run your own commands in this project. These shells are separate from omp's."
- **Chat search**: "No chats match '{q}'."
- **Memory**: "omp hasn't saved any memories yet."
- **Usage**: "No recorded usage in this period" and "Chats you run with omp appear here with their token use."

### 8.3 Example prompts (empty chat)

Clicking an example fills the composer without sending it.

1. **Fix a bug**: "The checkout total on my site is wrong when a coupon is applied. Find the cause and fix it."
2. **Build a page**: "Build a contact page for this project with a form that checks the email address is valid."
3. **Explain this project**: "Explain what this project does and how its main parts fit together, in plain language."
4. **Clean up this folder**: "Find unused files and duplicated code in this folder. List them and ask me before deleting anything."

The project overview lists six shorter starters: Fix a bug, Build a feature, Explain this, Clean up, Add tests, Fix mobile layout. Each opens a new chat with its prompt in the composer, ready to edit.

### 8.4 Confirmations and guardrails

- **Quit while working**: the title is "Quit while work is running?", or "Quit while work may be running?" when only unchecked chats remain. The body states the work recorded when the user chose to quit ("When you chose to quit, {n} helpers were working.") and any chats that could not be checked, then "Quitting stops any work still running. You can reopen your saved chats next time." The actions are [Keep waiting] / [Stop and quit].
- **Close a working chat**: one message for the work recorded when the user chose to close, each ending "You can reopen the saved chat later." With omp replying, the title is "Close while omp is working?" and the body "When you chose to close this chat, omp was replying. Closing stops any work still running." With only helpers working, the title is "Close while helpers are working?" and the body "When you chose to close this chat, {n} helpers were working. Closing stops any helpers still running." With both, the title is "Close while omp and helpers are working?" and the body "When you chose to close this chat, omp was replying and {n} helpers were working. Closing stops any work still running." The action is [Stop and close].
- **Delete chat**: "Delete '{title}'?" with "This removes the saved conversation from this computer. You can't undo it." and [Keep chat] / [Delete chat].
- **First switch to Auto**: "Turn on Auto?" with "Auto lets omp edit files and run commands without asking. Use it only in projects you trust." and [Turn on Auto].
- **Discard a file's changes** (Changes pane): "The file goes back to how it was at your last commit. You can't undo this."
- **Read-only chat**: the session header explains why the chat is read-only, and the composer's placeholder matches it: "Replies are off while the chat file can't be read", "Reply from the other window", "Choose Continue here to reply" or "Replies are off until the app can check the other window".

---

*End of spec. Tokens in §1 are the single source of truth; implementation maps them 1:1 into Tailwind v4 `@theme` and never hardcodes a raw color outside `theme/`.*
