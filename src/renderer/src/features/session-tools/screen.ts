/**
 * Readers for omp's painted TUI screen (`host:screen` plain-text lines). omp keeps some state only in
 * its own UI — plan/goal/vibe/loop status, the configured thinking level, the Plan Review overlay and
 * command feedback printed with `showStatus` — so the app reads it back from the screen. Formats were
 * taken from omp 18.4.4 (`status-line`, `plan-review-overlay`, `hook-selector`).
 */

export type PlanState = "off" | "on" | "paused";
export type GoalState = "off" | "active" | "paused";

/** Thinking levels in omp's Shift+Tab cycle order (`model-controls.ts cycleThinkingLevel`). */
export const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface StatusLine {
	/** Model display name as painted (e.g. "Opus 5.5"). */
	model: string | null;
	/** Configured thinking selector (`auto` stays `auto`); null when the model has no thinking control. */
	thinking: ThinkingLevel | null;
	plan: PlanState;
	goal: GoalState;
	vibe: boolean;
	loop: boolean;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * The editor's top border doubles as omp's status line: `╭── π ▶ ⬢ Opus 5.5 · ◕ xhigh ▶ 🗺 Plan ▶ …╮`.
 * Returns null when it is not painted (a dialog or full-screen overlay replaces the editor).
 */
export function parseStatusLine(lines: readonly string[]): StatusLine | null {
	const line = lines.findLast(candidate => /^\s*╭─/.test(candidate) && candidate.includes(" ▶ ") && candidate.includes("⬢"));
	if (!line) return null;
	const segments = line
		.replace(/^\s*╭─+\s*/, "")
		.split(" ▶ ")
		.map(segment => segment.replace(/─+.*$/, "").trim());
	const status: StatusLine = { model: null, thinking: null, plan: "off", goal: "off", vibe: false, loop: false };
	for (const segment of segments) {
		if (segment.startsWith("⬢")) {
			const [name = "", effort = ""] = segment.slice(1).split(" · ");
			status.model = name.replace(/\s+\p{Extended_Pictographic}\uFE0F?$/u, "").trim() || null;
			const level = effort.trim().split(/\s+/).at(-1) ?? "";
			status.thinking = isThinkingLevel(level) ? level : null;
			continue;
		}
		const words = segment.split(/\s+/);
		const paused = segment.includes("⏸") || /\bpaused\b/i.test(segment);
		if (words.includes("Plan")) status.plan = paused ? "paused" : "on";
		else if (words.includes("Goal")) status.goal = paused ? "paused" : "active";
		else if (words.includes("Vibe")) status.vibe = true;
		else if (/(^|\s)Loop\b/.test(segment)) status.loop = true;
	}
	return status;
}

/** Transcript lines above the editor (where omp prints command feedback). */
function messageLines(lines: readonly string[]): string[] {
	const editorTop = lines.findLastIndex(line => /^\s*╭─/.test(line) && line.includes("⬢"));
	return (editorTop >= 0 ? lines.slice(0, editorTop) : [...lines]).map(line => line.trimEnd()).filter(line => line.trim() !== "");
}

/**
 * Lines omp printed between two screen reads: everything in `after` below the last line that was
 * already at the bottom of `before`. Falls back to the last few lines when the screen scrolled so far
 * that no anchor survives.
 */
export function newOutput(before: readonly string[], after: readonly string[]): string[] {
	const old = messageLines(before);
	const next = messageLines(after);
	for (let take = Math.min(old.length, 6); take > 0; take--) {
		const tail = old.slice(-take);
		for (let end = next.length; end >= take; end--) {
			if (tail.every((line, index) => next[end - take + index] === line)) return next.slice(end).map(line => line.trim());
		}
	}
	return next.slice(-3).map(line => line.trim());
}

export interface PlanReviewOption {
	label: string;
	selected: boolean;
}

export interface PlanReviewSlider {
	/** Role names in order (`smol`, `default`, `slow`, …). */
	roles: string[];
	selected: number;
	/** Model name under the slider (`↳ Claude Opus 5.5`). */
	model: string | null;
}

export interface PlanReviewScreen {
	options: PlanReviewOption[];
	slider: PlanReviewSlider | null;
}

const PLAN_REVIEW_HEADING = "Plan mode - next step";

/** Strips the overlay's box-drawing frame from a painted row. */
function unframe(line: string): string {
	return line.replace(/^\s*[│┃]\s?/, "").replace(/\s*[│┃]\s*$/, "");
}

/** Recognises omp's Plan Review overlay (`interactive-mode.ts handlePlanApproval`). */
export function isPlanReview(lines: readonly string[]): boolean {
	return lines.some(line => line.includes(PLAN_REVIEW_HEADING)) && lines.some(line => line.includes("Approve and execute"));
}

export function parsePlanReview(lines: readonly string[]): PlanReviewScreen | null {
	if (!isPlanReview(lines)) return null;
	const start = lines.findIndex(line => line.includes(PLAN_REVIEW_HEADING));
	const options: PlanReviewOption[] = [];
	let slider: PlanReviewSlider | null = null;
	for (let index = start + 1; index < lines.length; index++) {
		const row = unframe(lines[index] ?? "");
		if (/^[├╰]/.test((lines[index] ?? "").trim())) break;
		if (row.includes("continue with")) {
			const selectedMatch = /◀\s*(\S+)\s*▶/.exec(row);
			const roles = row
				.slice(row.indexOf("continue with") + "continue with".length)
				.replace(/[◂▸◀▶┆]/g, " ")
				.split(/\s+/)
				.filter(Boolean);
			const next = unframe(lines[index + 1] ?? "").trim();
			slider = {
				roles,
				selected: selectedMatch?.[1] ? roles.indexOf(selectedMatch[1]) : -1,
				model: next.startsWith("↳") ? next.slice(1).trim() || null : null,
			};
			continue;
		}
		const option = /^\s*(❯)?\s*(Approve and execute|Approve and compact context|Approve and keep context.*|Refine plan|Save and quit)\s*$/.exec(row);
		if (option?.[2]) options.push({ label: option[2].trim(), selected: option[1] === "❯" });
	}
	return options.length > 0 ? { options, slider } : null;
}
