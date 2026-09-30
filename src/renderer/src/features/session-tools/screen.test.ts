import { describe, expect, it } from "vitest";
import { isPlanReview, parsePlanReview, parseStatusLine } from "./screen";

describe("omp screen readers", () => {
	it("retains plan pause and distinguishes configured thinking from model name", () => {
		expect(parseStatusLine(["╭── π ▶ ⬢ Opus 5.5 · ◕ xhigh ▶ 🗺 Plan ⏸ ▶ 🗑 project ──╮"]))
			.toMatchObject({ model: "Opus 5.5", thinking: "xhigh", plan: "paused", goal: "off", vibe: false, loop: false });
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
