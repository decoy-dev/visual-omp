# visual-omp logo concepts

The selected logo is periscope variation C1 "Heavy" ([`2-periscope/variants/c-prompt/variations/c1-heavy/`](2-periscope/variants/c-prompt/variations/c1-heavy/)), and it is now applied across the app, the app icons and the README hero; [DESIGN.md §6](../DESIGN.md#6-app-icon) describes it. The rest of this folder is the historical exploration that led there. It began as five candidate directions to replace the Circuit V icon, each a different type of logo, so the choice was between approaches before it was between details. [`board.png`](board.png) shows all five side by side; each folder has its own `board.png` with the icon at 512, 128, 64, 32 and 16px, the mark on light and dark, the title bar lockup, and the rationale.

All five are flat vector with no gradients, glows or filters. The teal is the app's accent from `src/renderer/src/theme/tokens.css` (`--accent`, light and dark), converted from OKLCH to sRGB hex. Neutrals are the ink, paper and icon tile values the app already uses. omp's plug orange appears only in concept 5, where it stands for omp.

| # | Type | Name | Colors |
|---|---|---|---|
| 1 | Lettermark | [Typed v](1-typed-v/) | Ink, teal |
| 2 | Pictorial symbol | [Periscope](2-periscope/) | Teal, paper |
| 3 | Abstract geometric mark | [Twin](3-twin/) | Teal |
| 4 | Wordmark-led logotype | [Window o](4-window-o/) | Ink, teal |
| 5 | Emblem | [Plug seal](5-plug-seal/) | Teal, omp orange |

## Files in each folder

- `mark.svg`: the symbol on a transparent background in its primary colors.
- `mark-mono.svg`: the same symbol in one color. Every fill uses `currentColor`, so it takes the text color of whatever contains it (menu bar template, favicon, single-color print).
- `app-icon.svg`: the 1024×1024 macOS icon. The tile is the 824×824 rounded rectangle at (100, 100) with a 185 corner radius, the same safe area the current icon uses; macOS applies its own squircle mask.
- `lockup.svg`: the mark beside the `visual-omp` wordmark at the title bar's 14px text size, set in Geist Mono 600 as outlines. Its fills read `--vo-ink`, `--vo-accent` and `--vo-orange` when those CSS variables are set and fall back to the light-theme hex values otherwise.
- `board.png`: the presentation board for that concept, 1600×1000.

## 1. Typed v (lettermark)

visual-omp works by typing into omp's terminal session on your behalf, so the lettermark shows the moment after a keystroke: a lowercase v, drawn heavy with flat terminals like a monospace glyph, followed by the block cursor. The v supplies the initial and the cursor places it in a terminal. Both shapes are straight-edged blocks, which is why the mark stays legible at 16px in the menu bar, where it reads as a letter and a bar.

| Role | Light | Dark |
|---|---|---|
| v | Ink `#141c1c` | `#e9eeee` |
| Cursor | Teal `#10726f` | `#5fccc8` |
| Icon tile | `#141919` | |

## 2. Periscope (pictorial symbol)

omp keeps running as a terminal program inside visual-omp, out of view, and the app shows you what that hidden session is doing. A periscope is the ordinary object built for that job: it lets you see something you have no direct line of sight to. The mark is a periscope head above a two-wave waterline, with the 45° mirror cut at the top of the tube. It is the only concept that depicts an object, so it asks the least of someone seeing it for the first time. The catch is scale: below 32px the waves merge into a line, and what remains is the head and the tube.

| Role | Light | Dark |
|---|---|---|
| Mark | Teal `#10726f` | `#5fccc8` |
| Icon tile | Teal `#10726f` | |
| Mark on the icon | Paper `#f5f7f7` | |

### Periscope variants

Concept 2 was chosen for further work. [`2-periscope/variants/`](2-periscope/variants/) holds six executions of it, each with the same five files as a concept folder, and [`2-periscope/variants/board.png`](2-periscope/variants/board.png) shows all six at 256, 64, 32 and 16px on light and dark with their lockups. Every variant keeps the periscope rising above a surface and changes one or more of weight, surface, head, color and crop. The original read as a Γ over a line at 16px, so each variant also adds one feature that survives at that size: a lens plate, a colored lens, the π outline, a prompt chevron, or the tile edge.

| | Name | Weight | Surface | Head | Colors |
|---|---|---|---|---|---|
| A | [Swell](2-periscope/variants/a-swell/) | Solid | Waves | Mirror cut, lens plate | Teal `#5fccc8` on dark tile `#141919` |
| B | [Monoline](2-periscope/variants/b-monoline/) | Line, one weight | Waves | Mirror cut | Teal `#10726f` on paper `#f5f7f7` |
| C | [Prompt](2-periscope/variants/c-prompt/) | Solid | `>_` prompt line | Mirror cut, teal lens plate | Ink `#141c1c` on paper, lens teal `#10726f` |
| D | [Pi](2-periscope/variants/d-pi/) | Solid | Flat line | π crossbar with a 45° cut | Paper `#f5f7f7` on teal tile `#10726f` |
| E | [Lens](2-periscope/variants/e-lens/) | Solid | Waves | Round lens facing the viewer | Paper on dark tile `#141919`, lens omp orange `#f97316` |
| F | [Rising](2-periscope/variants/f-rising/) | Solid | The tile's bottom edge | Mirror cut, lens plate | Teal `#10726f` on pale teal `#dff4f2` (`--accent-muted`) |

On a light background the marks use the light teal `#10726f` and ink `#141c1c`; on dark they use `#5fccc8` and `#e9eeee`.

**A. Swell.** This is the original drawing tightened for small sizes. The tube is narrower and the head taller, so at 32px the head is visibly larger than the tube it sits on, and a separate plate at the front marks the lens glass. The waterline keeps its waves, which remain the clearest way to show that the tube continues below the surface. Teal on the dark tile matches the app's dark theme.

**B. Monoline.** The same periscope drawn as a line at a single weight with round joins, the way the app's interface icons are drawn. The tube walls stop short of the wave line, so the tube passes behind the water, and the 45° mirror forms the back of the head. It is the variant that would look most at home inside the interface. The trade-off is at 16px, where the stroke rasterizes at about one pixel and the drawing keeps its outline but loses its interior.

**C. Prompt.** Here the surface is omp's own prompt. A chevron and an underscore make the `>_` that begins a terminal line, and the periscope rises out of the underscore, so the place it looks up from is a terminal. The body is ink and only the lens plate at the front of the head is teal. That plate is the detail that survives at 16px, as a single colored point at the top right of the icon.

**D. Pi.** The head and tube are built from a π. The crossbar is the head, with its left overhang cut at 45° for the mirror; the long leg is the tube that goes below the surface; the shorter right leg hangs free, as it does in omp's π. It acknowledges where the app comes from and leaves omp's plug and proportions alone. At 16px it keeps a π outline over a line, which no other variant has.

**E. Lens.** The periscope head ends in a round lens turned toward the viewer, so you look straight into the optics that the app uses to watch omp's session. The center of the lens is omp's plug orange, the only warm color in the set, and that orange point is what identifies the icon at 16px. A gap separates the lens from its housing, so the one-color version still shows a lens.

**F. Rising.** No surface is drawn. The periscope rises out of the bottom edge of the icon, so the tile stands in for the water and everything below the edge stays out of sight. Dropping the waterline leaves room for a larger head and tube than any other variant has, so its shapes are the largest of the six at 16px. The tile uses the pale teal of the app's accent-muted token.

#### Variant C: prompt variations

Variant C was chosen for further work. [`2-periscope/variants/c-prompt/variations/`](2-periscope/variants/c-prompt/variations/) holds six variations of it, C1 to C6, each with the same five files, and [`variations/board.png`](2-periscope/variants/c-prompt/variations/board.png) shows all six at 256, 64, 32 and 16px on light and dark with their lockups. All six keep the periscope rising out of the underscore of a prompt, so the terminal is where it surfaces, and each keeps at least one feature that survives at 16px.

| | Name | Prompt | Composition | Weight | Head | Colors |
|---|---|---|---|---|---|---|
| C1 | [Heavy](2-periscope/variants/c-prompt/variations/c1-heavy/) | Heavy `>` | Chevron left of the base | Heavy | Mirror cut, lens plate | Ink `#141c1c` on paper `#f5f7f7`, lens teal `#10726f` |
| C2 | [Thin](2-periscope/variants/c-prompt/variations/c2-thin/) | Small thin `>` | Tube passes through a split underscore | Lighter | Round lens | Teal `#5fccc8` on dark tile `#141919`, lens paper |
| C3 | [Cursor](2-periscope/variants/c-prompt/variations/c3-cursor/) | `>` with a static block cursor for the underscore | Chevron left of the block | Heavy | Mirror cut, lens plate | Paper on teal tile `#10726f`, chevron and lens ink |
| C4 | [Typed](2-periscope/variants/c-prompt/variations/c4-typed/) | Teal `>` | One line of text; the periscope is the typed character | Lighter | Mirror cut, lens plate | Ink on paper, chevron teal `#10726f` |
| C5 | [Angle](2-periscope/variants/c-prompt/variations/c5-angle/) | Heavy angle quote `❯` | Chevron left of the base | Heavy | Squared, window slot | Paper on dark tile `#141919`, chevron teal `#5fccc8` |
| C6 | [Dollar](2-periscope/variants/c-prompt/variations/c6-dollar/) | `$` in Geist Mono 600 | Glyph left of the base | Lighter | Round lens | Ink on paper, lens teal `#10726f` |

On a light background the marks use the light teal `#10726f` and ink `#141c1c`; on dark they use `#5fccc8` and `#e9eeee`. C4 is the one variation whose lockup reads as a prompt line: Geist Mono's `>` in teal, the periscope in the next character cell, then `visual-omp` after a space.

**C1. Heavy.** This keeps variant C as it was and gives the chevron more weight, so the prompt and the periscope carry equal mass on the tile. The chevron has longer arms than before, which keeps the heavier stroke from closing up into an arrowhead. Only the lens plate is teal, and at 16px it remains a single colored point at the top right.

**C2. Thin.** The chevron shrinks to a thin mark at the height of lowercase text, and the periscope takes the rest of the tile. The underscore is split where the tube passes through it, so the tube visibly continues below the prompt line into the session underneath. The head ends in a round lens, and the lighter tube and underscore sit closer to the weight of Geist Mono 600 in the lockup. On the dark tile the paper lens is the brightest point, which is what carries the icon at 16px.

**C3. Cursor.** The underscore becomes a solid block, the static cursor a terminal draws where the next character will go, and the periscope rises out of it. If this variation is chosen, it is the only block cursor in the brand, and it does not blink. The chevron and the lens plate are ink on the teal tile, which ties the prompt to the optics. At 16px the paper block and tube read as one heavy shape with a dark point beside it.

**C4. Typed.** The mark is set like one line of terminal output: a teal chevron, then the periscope in the next character cell, standing on the baseline with its underscore below it. Teal marks the prompt and everything typed after it is ink. The lockup follows the same rule and reads as a prompt line, with Geist Mono's own `>` in teal, the periscope as the first character after it, and visual-omp after a space.

**C5. Angle.** The prompt is a heavy angle quote with flat ends, the `❯` that many shell themes print. The head is a squared box with a window slot near its front face, the plainest periscope head of the six. Paper on the dark tile with a teal prompt makes it the dark-theme counterpart of C4. The squared head is also the weakest periscope read here: at 16px the shape is closer to a letter F than to optics.

**C6. Dollar.** The prompt is a `$` set in Geist Mono 600, the prompt most shells print for a regular user, so the lockup's typeface appears in the mark itself. The periscope is drawn lighter to match the glyph's stroke, and its head ends in a round teal lens. At 16px the `$` and the teal point remain legible side by side. The catch is that the pair can read as the characters `$f`, since the lens sits where the hook of an f would be.

## 3. Twin (abstract geometric mark)

Everything visual-omp shows is state it reads from omp and draws again as native interface. The mark is a square cut along its diagonal: the solid half stands for omp's live session and the outlined half for the app's copy of it, the same shape drawn a second time. It has no letter and no object in it, so it takes repetition before people associate it with the app. That being said, it is the plainest of the five to reproduce: one color, three straight edges per half, and no detail that disappears at 16px.

| Role | Light | Dark |
|---|---|---|
| Mark | Teal `#10726f` | `#5fccc8` |
| Icon tile | Paper `#f5f7f7` | |

## 4. Window o (wordmark-led logotype)

The name already describes the product: a visual layer over omp. This direction lets the name carry the identity and changes one letter. The o in omp is redrawn with a heavy top rail over a screen-shaped counter, so the word contains a window at the exact point where omp begins. The rest of the name is Geist at weight 600, the typeface the app's interface already uses, so the logo and the interface share one typeface. Below 64px a full name is illegible, so the app icon uses the window o on its own.

| Role | Light | Dark |
|---|---|---|
| Letters | Ink `#141c1c` | `#e9eeee` |
| Window o | Teal `#10726f` | `#5fccc8` |
| Icon tile | `#141919` | |

For this concept `lockup.svg` is the logo itself; `mark.svg` is the window o alone.

## 5. Plug seal (emblem)

omp's own icon attaches an orange plug connector to its π. visual-omp connects to omp from the outside, so the emblem shows that connection: omp's orange plug meeting a teal socket, inside a seal that carries the name and the publisher. It is the only concept that uses two hues, and the split is deliberate: orange belongs to omp and teal to this app. The ring lettering is legible from 128px up. At 32px and 16px the text becomes texture, and the orange plug is what identifies the icon.

| Role | Light | Dark |
|---|---|---|
| Rings, lettering, socket | Teal `#10726f` | `#5fccc8` |
| Plug | omp orange `#f97316` | `#f97316` |
| Icon tile | `#141919` | |

## How the boards were made

The mark geometry is authored as exact coordinates on the 1024 icon grid, with no traced or embedded artwork. The wordmark and the seal lettering are Geist and Geist Mono outlines at weight 600, taken from the fonts in `node_modules/@fontsource-variable`. The boards are HTML pages rendered by headless Chrome at a device scale of 1, so every icon size on a board is the SVG rasterized at that pixel size.
