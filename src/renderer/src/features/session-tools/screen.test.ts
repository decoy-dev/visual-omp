import { describe, expect, it } from "vitest";
import { isPlanReview, messageLines, newOutput, parsePlanReview, parseStatusLine, statusBorderLine } from "./screen";

describe("omp screen readers", () => {
	it("reads thinking without inferring modes from status labels or job headlines", () => {
		expect(parseStatusLine(["╭── π ▶ ⬢ Opus 5.5 · ◕ xhigh ▶ 🗺 Plan ⏸ ▶ Goal Loop Vibe ──╮", "╰─                          ─╯"]))
			.toMatchObject({ model: "Opus 5.5", thinking: "xhigh", plan: "off", goal: "off", vibe: false, loop: false });
	});

	// Captured with the standalone omp 18.15.0 darwin-arm64 release in node-pty,
	// scratch HOME/PI_CODING_AGENT_DIR, --model anthropic/claude-sonnet-4-6
	// --thinking high --no-session and the app's Unicode/default/powerline overlay.
	// Each pair is a literal debug `text` response, which strips ANSI from the
	// last painted frame. The cwd basename was a long C:\Users\...\session-tools path.
	// The boxed rows additionally set composer.shape: box. Theme variants override
	// only shipped model/separator/thinking spellings while keeping symbolPreset unicode.
	const paintedEditors = [
		{
			label: "120-column default band",
			lines: [
				" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ 🗑 …windows-project-directory\\session-tools ▶─0.3%───────────────────────────────╎┃──────1M─",
				"╰─                                                                                          ⇧⇥ to change thinking effort",
			],
		},
		{
			label: "80-column default band",
			lines: [
				" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ 🗑 …dows-project-directory\\session-tools ▶─0.3%─┃1M─",
				"╰─                                                  ⇧⇥ to change thinking effort",
			],
		},
		{
			label: "60-column default band",
			lines: [
				" π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ 🗑 …ry\\session-tools ▶─0.3%─┃1M─",
				"╰─                              ⇧⇥ to change thinking effort",
			],
		},
		{
			label: "80-column boxed composer",
			lines: [
				"╭── π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ 🗑 …roject-directory\\session-tools ▶─0.3%─┃1M───╮",
				"╰─                                               ⇧⇥ to change thinking effort ─╯",
			],
		},
		{
			label: "60-column boxed composer",
			lines: [
				"╭── π ▶ ⬢ Sonnet 4.6 · ◒ high ▶ 🗑 …sion-tools ▶─0.3%─┃1M───╮",
				"╰─                           ⇧⇥ to change thinking effort ─╯",
			],
		},
		{
			label: "ASCII theme overrides",
			lines: [
				" π > [M] Sonnet 4.6 - [high] > 🗑 …ws-project-directory\\session-tools >-0.3%-┃1M-",
				"╰─                                                  ⇧⇥ to change thinking effort",
			],
		},
		{
			label: "Nerd Font theme overrides",
			lines: [
				" π \ue0b0 \uec19 Sonnet 4.6 · ◒ high \ue0b0 🗑 …dows-project-directory\\session-tools \ue0b0─0.3%─┃1M─",
				"╰─                                                  ⇧⇥ to change thinking effort",
			],
		},
	];

	it.each(paintedEditors)("reads the painted $label and excludes its editor from feedback", ({ lines }) => {
		const screen = ["Command feedback", "", ...lines];
		expect(parseStatusLine(screen)).toMatchObject({ model: "Sonnet 4.6", thinking: "high" });
		expect(statusBorderLine(screen)).toBe(lines[0]);
		expect(messageLines(screen)).toEqual(["Command feedback"]);
		expect(newOutput(["Earlier feedback", ...lines], ["Earlier feedback", "New feedback", ...lines])).toEqual(["New feedback"]);
	});

	// box.ts merges the last input row into the bottom border. Earlier rows keep
	// side borders, including a scrollbar thumb in place of the right border.
	it("reads a boxed composer with multiple input rows", () => {
		const status = paintedEditors[3]!.lines[0]!;
		const lines = ["Feedback", status, "│  First input line               │", "│  Another input line             █", "╰─ Last input line              ─╯"];
		expect(parseStatusLine(lines)).toMatchObject({ model: "Sonnet 4.6", thinking: "high" });
		expect(statusBorderLine(lines)).toBe(status);
		expect(messageLines(lines)).toEqual(["Feedback"]);
	});

	// The production overflow policy preserves the path after dropping the model.
	// These are painted 40-, 30- and 20-column bands and a 40-column boxed editor.
	it.each([
		[" π ▶ 🗑 …tools ▶─0.3%─────────────╎┃──1M─", "╰─          ⇧⇥ to change thinking effort"],
		[" π ▶ 🗑 …tools ▶─0.3%─────┃─1M─", "╰─                            "],
		[" 🗑 …tools ▶───────╎┃", "╰─                  "],
		["╭── π ▶ 🗑 …tools ▶─0.3%────────╎┃─1M───╮", "╰─       ⇧⇥ to change thinking effort ─╯"],
	])("recognizes a narrow editor without inventing its missing model (%s)", (status, prompt) => {
		const lines = ["Feedback", status, prompt];
		expect(parseStatusLine(lines)).toMatchObject({ model: null, thinking: null });
		expect(messageLines(lines)).toEqual(["Feedback"]);
		expect(statusBorderLine(lines)).toBe(status);
	});

	// These exact model segments were painted with --thinking medium/auto/off.
	it.each([
		["◑ med", "medium"],
		["⟳ auto", "auto"],
		["⦸ off", "off"],
	])("normalizes the painted thinking display %s", (display, level) => {
		expect(parseStatusLine([
			` π ▶ ⬢ Sonnet 4.6 · ${display} ▶ 🗑 …ndows-project-directory\\session-tools ▶─0.3%─┃1M─`,
			"╰─                                                  ⇧⇥ to change thinking effort",
		])).toMatchObject({ thinking: level });
	});

	// Source-backed spellings from omp's theme/symbols.ts, including levels that
	// Sonnet normalizes before rendering. These are not runtime capture fixtures.
	it.each([
		["○ min", "minimal"],
		["[min]", "minimal"],
		["[med]", "medium"],
		["[xhi]", "xhigh"],
	])("normalizes shipped thinking aliases %s", (display, level) => {
		expect(parseStatusLine([`╭── π ▶ ⬢ Model · ${display} ▶ ──╮`, "╰─                          ─╯"])).toMatchObject({ thinking: level });
	});

	it("requires the adjacent prompt for an unframed model name", () => {
		const quoted = paintedEditors[1]!.lines[0]!;
		expect(parseStatusLine(["Output mentions a status line:", quoted, "ordinary output"])).toBeNull();
		expect(statusBorderLine([quoted])).toBeNull();
		expect(messageLines([quoted])).toEqual([quoted]);
	});

	it.each([
		["╭─ Plan Review ─╮", "│ ⬢ Sonnet 4.6 · ◒ high │", "╰───────────────╯"],
		["╭─ ⬢ Sonnet 4.6 · ◒ high ─╮"],
		["╭─ ⬢ Sonnet 4.6 · ◒ high ─╮", "│ ordinary dialog output │", "╰────────────────────────╯"],
		["╭── π ▶ ⬢ Sonnet 4.6 · ◒ high ──╮", "ordinary output", "╰─ unrelated quoted prompt ─╯"],
		["Output quotes a status row:", "╭── π ▶ ⬢ Sonnet 4.6 · ◒ high ──╮", "ordinary transcript output"],
		["╭─ ⬢ Sonnet 4.6 · ◒ high ─╮", "ordinary output", paintedEditors[1]!.lines[0]!, "More transcript output"],
		["╭─ A custom title ─╮"],
	])("keeps dialog titles and quoted status rows outside editor parsing (%j)", (...lines) => {
		expect(parseStatusLine(lines)).toBeNull();
		expect(messageLines(lines)).toEqual(lines);
		expect(statusBorderLine(lines)).toBeNull();
	});

	it("requires the boxed composer's merged input row instead of a dialog bottom", () => {
		const lines = [paintedEditors[3]!.lines[0]!, "│  ordinary dialog output │", "╰─────────────────────────╯"];
		expect(parseStatusLine(lines)).toBeNull();
		expect(statusBorderLine(lines)).toBeNull();
	});

	it("keeps unfamiliar status glyphs diagnostic-only when composer context and prefix are present", () => {
		const unknown = "┌── π ▶ [custom-model] Unknown / high ──┐";
		const prompt = "╰─                                  ─╯";
		expect(statusBorderLine([unknown])).toBeNull();
		expect(statusBorderLine([unknown, "│ ordinary dialog output │", "╰─────────────────────────╯"])).toBeNull();
		expect(statusBorderLine([unknown, prompt])).toBe(unknown);
		expect(parseStatusLine([unknown, prompt])).toBeNull();
		const band = " π ▶ [custom-model] Unknown / high";
		expect(statusBorderLine([band, "╰─ draft input"])).toBe(band);
		expect(parseStatusLine([band, "╰─ draft input"])).toBeNull();
		const withoutPrefix = unknown.replace("π", "A dialog title");
		expect(statusBorderLine([withoutPrefix, prompt])).toBeNull();
	});

	it("selects the last supported composer after earlier feedback", () => {
		const lines = [...paintedEditors[0]!.lines, "Feedback", ...paintedEditors[1]!.lines];
		expect(parseStatusLine(lines)).toMatchObject({ model: "Sonnet 4.6", thinking: "high" });
		expect(statusBorderLine(lines)).toBe(paintedEditors[1]!.lines[0]);
	});

	it("reads Plan Review options, selection, and the optional execution slider", () => {
		const lines = [
			"╭─ Plan Review ─╮",
			"│ Plan mode - next step │",
			"│ continue with  ◂  smol  ◀ default ▶  slow  ▸ │",
			"│   ↳ GPT-6-Astra │",
			"│ ❯ Approve and execute │",
			"│   Approve and compact context │",
			"│   Approve and keep context (~30k / 1m) │",
			"│   Refine plan │",
			"│   Save and quit │",
			"╰───────────────╯",
		];
		expect(isPlanReview(lines)).toBe(true);
		expect(parsePlanReview(lines)).toEqual({
			options: [
				{ label: "Approve and execute", selected: true },
				{ label: "Approve and compact context", selected: false },
				{ label: "Approve and keep context (~30k / 1m)", selected: false },
				{ label: "Refine plan", selected: false },
				{ label: "Save and quit", selected: false },
			],
			slider: { roles: ["smol", "default", "slow"], selected: 1, model: "GPT-6-Astra" },
		});
	});
});
