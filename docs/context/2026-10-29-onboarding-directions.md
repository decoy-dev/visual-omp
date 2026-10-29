# Onboarding redesign: design directions (2026-10-29)

The owner found the first-run setup in `d41ea16` plain: "it has no personality and isn't a great first impression to the app. I would like more animation, more fun aspects, more visual identity." The designer agent proposed the three directions below. The owner chooses one before implementation starts. Nothing here is implemented yet.

DIRECTION 1: "Periscope up"

Concept: the mark becomes a character. The periscope rises out of the prompt, looks around, and accompanies you through setup; everything else stays a calm, centered single column, so the personality comes from the mark and motion rather than a new layout.

Visual identity
- Welcome is the one full-bleed moment: the whole window goes ink (`--chrome-bg`) with the mark large (about 120px) center-left of a 640px column, lens plate in teal, wordmark in Geist Mono 600 below it, heading and body in inverse ink text. This is the only ink step; every later step returns to the gray canvas with the light sheet, so the welcome reads as a cover and the rest as the book.
- On content steps the mark shrinks to 28px in the top-left header (where it already sits) but is now alive: the periscope head turns a few degrees toward the primary button when it becomes enabled, and the lens plate pulses once in teal when you complete a step.
- Type: step headings move up from `--text-3xl` to a true display moment on Welcome only (36-40px, Geist 700, −0.02em). All other steps keep the current scale. Teal appears only on the lens, the primary button, the focused radio, and the progress fill. No new colors anywhere.

Layout per step
- Welcome: ink full-bleed, column centered vertically, mark above heading, one teal button. No rule line.
- Install, Providers, Model, Permission, Appearance: today's centered column, widened to 680px, but each gets a small stage area (120px tall) between heading and controls where the step's "fun" beat plays. The stage is a flat `--bg-inset` rounded-12 well, not a card.
- Done: returns to ink full-bleed, mirroring Welcome, summary rows in inverse text with teal checks.

Motion choreography (plain terms; maps to existing presets)
- First paint: the prompt chevron and underscore draw in (opacity plus a short rise, about 350ms, out-expo), then the periscope column rises from the underscore over about 500ms on the gentle spring, then the lens plate pops in with the snappy spring and a single teal flash (140ms). Total under 1.2s, then it idles: a slow 4s sway of plus/minus 2 degrees on the periscope head, CSS keyframes, stops after three cycles.
- Between steps: the content column exits up 8px and fades (160ms, ease-in), the new column rises in 8px and fades (240ms, out-quart). The header mark never re-enters; it persists so it reads as one continuous character, not a per-step reload.
- Step completion: when you hit Continue, the lens flashes once and the progress periscope (below) advances on the gentle spring.
- Success: on Done, the whole window crossfades to ink, the periscope rises an extra 24px, the lens does one full teal sweep, and the summary rows stagger in at 40ms intervals. Then "Start chatting" slides the ink screen left to reveal the app shell, which is already the tour's first frame.
- Reduced motion: no rise, no sway, no sweep. The mark renders statically, step changes crossfade in 140ms, Done fades to ink. Nothing is hidden or delayed; the same information appears in the same order.

Fun moments
- The periscope rising and looking around on Welcome (above).
- Providers: each provider row starts with a dim, grayed lens dot; on successful sign-in the dot flips to teal, the row lifts 1px, and the header periscope tilts toward the row briefly, as if it noticed.
- Model: when you pick a model, its name types itself, character by character with the 2px streaming caret, into a small mock composer chip in the stage well. This reuses the app's own streaming-caret visual language.
- Appearance: switching theme crossfades the entire wizard window (it already live-previews), and the periscope's ink shapes and lens swap with it, so the character "changes clothes" with you.
- Done: the periscope does one small celebratory rise-and-settle, not confetti.

Progress indicator
- A vertical 2px track in the left margin of the content column, ink at 14% opacity, with a teal fill that grows per step and a 10px periscope-head glyph that rides the fill's leading edge. Current step also gets "Step 2 of 6" text top-right (kept for screen readers and clarity). Back moves the glyph down, never just jumping.

Install step on brand
- The terminal output stays in the existing InlineTerminal, but it sits inside the stage well with a proper header row: "Installer output" label left, a live teal pulse dot while running, exit code right when finished. The command pill (`curl -fsSL … | sh`) is Geist Mono on `--bg-inset` with a `--control-border` ring. While the installer runs, the periscope in the header leans toward the terminal, a 4-degree tilt, and straightens when the check passes. Success swaps the pulse dot for a teal check and the whole well gets a 200ms teal hairline flash on its border.

Copy tone per step (within VOICE)
- Welcome: heading "Welcome to visual-omp" stays; body stays one sentence. Button "Start setup" stays. No exclamation, no "Let's go".
- Install: current copy is already in voice; keep "The installer is a single command, and its output appears in this window."
- Providers: "Sign in to the providers you want to use. You can add more later in Settings." Concession-then-position pattern fits here.
- Model: "Choose the model new chats start with. You can change it per chat later."
- Permission: keep "Ask me first" preselected; body: "omp asks before it writes or runs commands. You can relax this later."
- Appearance: one sentence, "Pick a theme. The whole window previews it as you choose."
- Done: "You're all set" heading, then a summary list, button "Start chatting". No congratulations, no exclamation; the ink screen and the periscope carry the celebration so the words don't have to.

DESIGN.md rules
- Keeps everything: flat surfaces, one accent, no nested cards, no eyebrows, no gradients, proportional radii. The full-bleed ink Welcome/Done is already legal; ink chrome is a first-class surface. The one thing to ratify: using ink as a full-window background for two steps is new (today ink only appears in the sidebar band and status bar), so record it in DESIGN.md as the setup cover/back-cover exception. The idle sway is a new looped animation; §1.12 allows looped animations with the in-out ease, so it just needs documenting.

Implementation notes
- Reuse: BrandMark, Button, SearchInput, Notice, Spinner, PresenceSwap, Rise/Stagger, Expand, InlineTerminal, existing focus management (heading focus per step already exists). All durations and easings come straight from motion.tsx presets.
- New work: a `MarkParts` export from BrandMark (or a sibling `OnboardingMark`) that renders chevron/underscore/periscope/lens as separately animatable SVG groups, respecting `tone`. One small periscope-head glyph for the progress track. The stage well is a styled div. Effort: MEDIUM (2-3 focused days).
- Performance: trivial; a handful of transform/opacity animations. The idle sway must be CSS, not JS. Accessibility: the stage well and mark animations are `aria-hidden`; the tilt-toward-button must never be the only enabled-state signal; keep the "Step N of 6" text; the full-bleed ink steps need the chrome-region token re-declaration trick already used for the sidebar so text contrast is automatic.

---

DIRECTION 2: "The app builds itself"

Concept: split screen. The left column is the wizard; the right half is a live miniature of the actual app shell that starts empty and fills in as you answer, so setup is literally assembling your app, and the finale is the miniature growing into the real window.

Visual identity
- The right pane is the gray canvas holding a scale-model of the shell: an ink sidebar band, a light sheet with rounded left corners, a 28px ink status bar, a composer at the bottom. It is drawn with the app's own tokens, not screenshots, so it survives both themes and text scaling. Scale it to about 55% with `transform: scale`, capped so it never needs interaction.
- Left column: 440px, ink text, teal primary button, current step heading in `--text-3xl`. The miniature is the only "decoration"; there are no illustrations elsewhere.
- The mark appears once, in the miniature's sidebar header, exactly where it will live in the real app. That placement is the identity statement: you meet the logo in situ, not floating on a splash screen.

Layout per step
- Welcome: the miniature shell fades in empty (bare sidebar band, blank sheet) with one line in its composer area: a dim placeholder "Your chats will appear here." Left column is just heading, one sentence, Start setup.
- Install: left column gets the terminal card; the miniature's status bar shows a live "installing omp…" row with the pulse dot, then "omp 0.9.x" when detected, mirroring how the real status bar reports the agent.
- Providers: each connected provider adds a small labeled chip to the miniature's sidebar under "Current chats", one per provider, appearing with a rise. Skip leaves it empty, and the miniature shows the empty-state line instead.
- Model: the chosen model name appears in the miniature's composer footer and status bar, typeset in Geist Mono like the real status bar.
- Permission: the miniature's status bar gains the approval-mode chip ("Ask me first" etc.) and it changes live as you change the radio.
- Appearance: the entire miniature flips theme with the same crossfade the real window uses, while the wizard's own left column stays in the current theme until the step completes; the miniature is the preview.
- Done: left column summarizes; then the miniature animates up to full size and crossfades into the real shell as the tour begins. The wizard chrome dissolves underneath it.

Motion choreography
- Entrance: on first paint the miniature's ink band slides in from the left (gentle spring, about 400ms), the sheet fades in 100ms later, the status bar rises from the bottom another 80ms later. It reads as the app assembling.
- Between steps: left column uses the same 160/240ms exit/enter as Direction 1. The miniature never resets; each step's change is a targeted motion (chip rises in, chip label crossfades, theme crossfades at 240ms). Continuity is the whole trick: the miniature persists across steps as one accumulating object.
- Progress: no separate indicator widget; the miniature IS the progress. A row of six small ink ticks under the left column heading fills teal as you advance, for users who want the explicit count, and "Step N of 6" stays top-right.
- Success: the finale is the miniature's scale animating from 55% to 100% while its frame dissolves (500ms, gentle spring), landing pixel-aligned with the real shell so the handoff is seamless. That is the celebration: the thing you built becomes the thing you use.
- Reduced motion: miniature parts fade in place with no slide or scale; the finale is a 140ms crossfade from wizard to shell. All state changes still visible, none implied by motion alone.

Fun moments
- The accumulating miniature itself: providers lighting up as sidebar chips, the model name dropping into the composer, the permission chip, the theme flip.
- On Done, before the grow, the miniature's periscope mark rises once and the lens flashes teal, a nod to Direction 1's character, then the grow begins.
- If the user picks dark mode, the miniature flips with a satisfying 240ms crossfade while the left column stays light for one beat, then follows; a deliberate, playful lag.

Progress indicator
- Six ticks, 16px wide, 2px tall, 8px apart, ink at 14%, filling teal left to right on the gentle spring, under the step heading. Plus persistent "Step N of 6" text. Deliberately quiet, because the miniature carries the drama.

Install step on brand
- Same InlineTerminal as today, but on the left column, full column width, with the status header row (label, live dot, exit code). The miniature's status bar mirrors install state in one line, so a user watching the right side still sees progress: "Running the omp installer", then the version. Failed state turns the mirror line to the error tone with the ✕ glyph, never color alone.

Copy tone per step
- Same strings as Direction 1, plus miniature captions in dim placeholder style: "Your chats will appear here", "No providers yet", "omp 0.9.x", model selector text, "Ask me first". All fragments are UI labels, which VOICE permits for controls and status; sentences stay on the left.

DESIGN.md rules
- Keeps: one accent, flat surfaces, radii, no gradients, no eyebrows. Needs two explicit owner decisions: (a) the miniature is arguably a "card on the canvas containing cards", close to the nested-card rule; I'd rule it a single illustrative composition, but it should be written into DESIGN.md as a sanctioned exception for setup; (b) the miniature reuses shell geometry at non-1:1 scale, which the spec doesn't currently contemplate. No other rule bends.

Implementation notes
- Reuse: tokens, Button, radios/Choice, SearchInput, InlineTerminal, PresenceSwap, Stagger for chips, the theme context so the miniature can be wrapped in the opposite `data-theme` scope for preview.
- New work: a `MiniShell` component (pure presentational, about 250 lines) drawing sidebar band, sheet, status bar, composer with divs and tokens; chip and status-line subcomponents; the scale-to-fullscreen finale, which is the riskiest piece (needs the real shell mounted behind the wizard, and a shared-layout or measured transform handoff). Effort: LARGE (4-6 days, half of it the finale).
- Performance: the miniature is static DOM, cheap. Risk is the finale transform on large windows; do it with transform/opacity only and test at 960×620. Accessibility: the entire miniature is `aria-hidden="true"` and `pointer-events: none`; every state it shows must also exist as text in the left column (it mostly already does); the finale must not move focus; focus goes to the tour's first heading after the crossfade.

---

DIRECTION 3: "Setup as the first chat"

Concept: the wizard runs inside the app's own chat surface. Each step arrives in the transcript like a message from the app, and you answer with composer-style controls at the bottom, so by the time setup ends you have already used the product once. The last message hands you the real composer.

Visual identity
- The window IS the main sheet: light sheet, ink status bar at the bottom, no sidebar (it appears only at handoff). Steps render as left-aligned app messages at measure (640px column), marked with the small mark avatar, tone `accent`. Your answers render as right-aligned ink chips, so the transcript literally reads as a conversation.
- Teal is reserved for the mark's lens, the composer's send-style primary action, and selected options. Headings inside messages use `--text-xl`, not display sizes; the restraint is the point, the chat frame is the identity.
- Type does the personality work: the app "speaks" in Geist, your answers and the model selector render in Geist Mono chips, echoing the status bar.

Layout per step
- Welcome: one app message: mark avatar, "Welcome to visual-omp. I'll walk you through setup. It takes about a minute." Composer shows a single teal "Start setup" action where the send button will later sit.
- Install: an app message explains, then a tool-card-styled message (reusing the transcript's tool card visual language: hairline border, 12px radius, mono command line, live output region) runs the installer inline, with the pulse dot and exit code, exactly like a real tool run will look later.
- Providers: app message lists providers as rows inside the message; signing in flips the row's status glyph and posts your answer chip: "Signed in to Anthropic".
- Model: the message carries the search input and list inline; choosing posts a chip with the selector in mono.
- Permission: four radio options inside the message, "Ask me first" preselected; choosing posts the chip.
- Appearance: three options; choosing flips the whole sheet live (the transcript you're reading is the preview, the most honest preview possible).
- Done: final app message summarizes your chips, then the composer morphs from setup actions into the real composer, the sidebar slides in with the ink band, and the status bar fills. The tour's first step points at the composer you just watched transform.

Motion choreography
- Each new step message rises in 8px with a fade on the gentle spring (about 400ms) and, on first run only, types its first sentence with the existing streaming caret at the transcript's playout pace, then drops the rest instantly. Your answer chip rises from the composer (snappy spring, 220ms) and the scroll follow glides the transcript down, reusing `useScrollFollow` verbatim.
- Between steps there is no transition at all in the wizard sense: it is just new messages arriving, which is what makes this direction feel completely different from a wizard.
- Progress: the ink status bar carries "Setup, step 2 of 6" left and a thin 2px teal fill across the top edge of the status bar that advances per step. Quiet, structural, on-brand.
- Success: the Done message's check draws itself in (the Checkbox primitive's draw animation, reused at 20px), the composer placeholder crossfades from "Start setup" to "Message omp…", and the sidebar band slides in from the left over 400ms. The celebration is the app arriving, not confetti.
- Reduced motion: messages fade in without rise, no typing effect (text appears whole, same as the reduced-motion streaming rule already in §1.12), sidebar fades in. Scroll jumps instead of gliding.

Fun moments
- The typing first sentence per step, in the app's real streaming voice.
- Your answers stacking up as chips, so Done can quote them back: the summary is the conversation you just had, not a new table.
- The composer morph at the end: the input you used to answer setup questions becomes the input you use to talk to omp. That is the single best first-impression beat available to this product, because it teaches the core UI by use.
- Provider rows lighting up with the ok glyph and a teal status line when connected, posted back as your own message, which feels like progress you caused.

Progress indicator
- The status-bar fill plus the "step N of 6" label. Nothing else; dots or tracks would fight the transcript.

Install step on brand
- The installer is a tool card in the transcript: header row with a terminal Phosphor icon, "Install omp", live pulse dot; body is the mono command and the InlineTerminal output; footer is the exit code and, on failure, the retry and copy-command buttons. This is pixel-consistent with how omp's tool runs render in chat, so the user learns that visual language too. "Having trouble? Open the help guide" becomes a quiet inline link under the card.

Copy tone per step
- Messages must obey VOICE strictly because they read as speech: formal, complete sentences, no exclamation, no "Let's go", no dashes. The register risk is the messages sounding chummy; keep them plain: "This step installs omp, the agent visual-omp drives. The installer is one command, and its output appears above." Chips (user answers) are labels, not sentences. The dry aside budget (one per VOICE) is best spent on the Permission step: "Ask me first is the safe default. You can relax it later, though most people don't." (Owner judgment call; cut if it reads too cute.)

DESIGN.md rules
- Keeps one accent, flat surfaces, radii. Needs owner sign-off on two things: (a) messages-inside-setup blur the line between setup and chat, and DESIGN.md currently scopes the transcript to chats; the setup transcript would be a documented second use of the message components; (b) the typing effect for UI copy is new (today only omp's output streams), though §1.12's playout machinery covers the mechanics. No gradients, glass, or grids involved; nothing else bends.

Implementation notes
- Reuse: the transcript message components, tool card, composer shell, `useScrollFollow`, streaming caret CSS, PresenceSwap for the composer morph, Checkbox draw animation, Stagger for provider rows, InlineTerminal, OmpLoginDialog unchanged.
- New work: a `SetupTranscript` driver that renders step state as message data, chip components for answers, the composer action morph, and the sidebar-reveal finale. No new illustration or SVG beyond what exists. Effort: MEDIUM-LARGE (3-5 days); less artwork than Direction 2, more state choreography, and the step machine in setup.ts maps cleanly onto a message queue.
- Performance: negligible; it's the app's own list rendering. Accessibility: the strongest of the three for screen readers if done right (the transcript is a natural `aria-live` log and focus moves message to message), but the typing effect must expose full text to AT immediately (visually typed, announced whole, same rule as streaming chat); the composer morph must move focus deliberately, not yank it.

---

RECOMMENDATION

Direction 2, "The app builds itself", with Direction 1's mark animation grafted onto the miniature's sidebar logo.

Direction 1 is the best value per day of work and the safest, and if the owner wants this shipped in a week it is the right pick. But 2 is the only direction that is an argument rather than a decoration: it shows the product's actual surface hierarchy (ink chrome, light sheet, status bar) before the user owns it, every choice has a visible consequence, and the grow-into-the-real-app finale is a first impression people remember and screenshot. It also ages best: six months from now, when the shell evolves, the miniature evolves with it because it is built from tokens, while mascot animation ages the moment it feels repetitive. Direction 3 is the most original but the riskiest: it commits setup copy to a conversational register that VOICE's formal tone will fi…

Questions for the owner
1. Is the full-window ink cover (Directions 1 and the Welcome of 2) acceptable as a documented exception to ink being chrome-only, or should the wizard stay on the gray canvas everywhere?
2. For Direction 2's finale, is the wizard allowed to mount the real shell behind itself (needed for the seamless grow), which slightly restructures App's first-run routing?
3. How much personality budget does the mark get after setup: does the periscope's rise-and-look animation stay a first-run-only moment, or should a smaller version of it (lens flash on connect, idle sway) live on in the app's Home and empty states?

[Some lines truncated to 768 chars. Use agent://OnboardingDirections:raw:161-161 to read line 161 whole]
