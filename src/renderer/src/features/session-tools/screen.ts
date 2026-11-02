/**
 * Readers for omp's painted TUI screen (`host:screen` plain-text lines). The configured thinking
 * level, Plan Review overlay and command feedback still come from the screen. Session modes come
 * from the hosted extension's `ctx.sessionModes` snapshot, never from status labels or job text.
 * The status-line format stays pinned for the model and thinking reader.
 */

export type PlanState = "off" | "on" | "paused";
export type GoalState = "off" | "active" | "paused";

/** Thinking levels in omp's Shift+Tab cycle order (`model-controls.ts cycleThinkingLevel`). */
export const THINKING_LEVELS = ["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface StatusLine {
	/** Model display name as painted (e.g. "Opus 5.5"). */
	model: string | null;
	/** Thinking level as painted (Auto may show the level it resolved for the last turn); null when the model has no thinking control. */
	thinking: ThinkingLevel | null;
	plan: PlanState;
	goal: GoalState;
	vibe: boolean;
	loop: boolean;
}

function paintedThinkingLevel(value: string): ThinkingLevel | null {
	const word = value.replace(/^\[|\]$/g, "");
	if (word === "min") return "minimal";
	if (word === "med") return "medium";
	if (word === "xhi") return "xhigh";
	return (THINKING_LEVELS as readonly string[]).includes(word) ? (word as ThinkingLevel) : null;
}

// The overlay pins Unicode symbols, but theme overrides still win. These are omp's
// shipped Unicode, Nerd Font and ASCII model/separator spellings, not arbitrary icons.
const MODEL_MARKER = /^(?:⬢|\uec19|\[M\])(?:\s+|$)/u;
const SEGMENT_SEPARATOR = /\s+[▶\ue0b0>](?:\s+|(?=[─-]))/u;

function statusSegments(line: string): string[] {
	return line
		.replace(/^\s*(?:[╭┌]─+|\+-+)\s*/, "")
		.replace(/[─-]+[╮┐+]\s*$/, "")
		.split(SEGMENT_SEPARATOR)
		.map(segment => segment.trim());
}

function isFramedTop(line: string): boolean {
	return /^\s*(?:[╭┌]─+.*[╮┐]|\+-+.*\+)\s*$/u.test(line);
}

function hasComposerContext(lines: readonly string[], index: number): boolean {
	// The band starts input immediately below its status. Boxed input merges its
	// last row into the bottom border; earlier input rows retain both side borders.
	if (!isFramedTop(lines[index] ?? "")) return /^╰─(?:\s|$)/u.test(lines[index + 1] ?? "");
	let prompt = index + 1;
	while (/^│.*[│█]\s*$/u.test(lines[prompt] ?? "")) prompt++;
	return /^╰─(?:\s|$).*╯\s*$/u.test(lines[prompt] ?? "");
}

function isEditorStatus(lines: readonly string[], index: number, diagnostic = false): boolean {
	const line = lines[index] ?? "";
	const segments = statusSegments(line);
	const hasModel = segments.some(segment => MODEL_MARKER.test(segment));
	const hasGauge = /[▶\ue0b0>][─-]/u.test(line);
	// Unknown model glyphs are diagnostic-only, and still need omp's literal
	// status prefix as well as the composer rows before their title can be logged.
	return (hasModel || hasGauge || (diagnostic && segments.includes("π"))) && hasComposerContext(lines, index);
}

function editorStatusIndex(lines: readonly string[]): number {
	return lines.findLastIndex((_, index) => isEditorStatus(lines, index));
}

/**
 * Last status row with supported composer context, including unfamiliar glyphs
 * after omp's literal prefix. Dialog and transcript borders are excluded.
 */
export function statusBorderLine(lines: readonly string[]): string | null {
	const index = lines.findLastIndex((_, candidate) => isEditorStatus(lines, candidate, true));
	return index >= 0 ? lines[index] ?? null : null;
}

/**
 * Read the classic boxed editor or the default band composer. Narrow bars can drop
 * the model segment entirely; null fields then mean it was not painted, not "off".
 * Other composer layouts and arbitrary theme symbol overrides remain unsupported.
 */
export function parseStatusLine(lines: readonly string[]): StatusLine | null {
	const index = editorStatusIndex(lines);
	if (index < 0) return null;
	const status: StatusLine = { model: null, thinking: null, plan: "off", goal: "off", vibe: false, loop: false };
	for (const segment of statusSegments(lines[index] ?? "")) {
		const marker = MODEL_MARKER.exec(segment);
		if (!marker) continue;
		const [name = "", effort = ""] = segment.slice(marker[0].length).split(/\s+·\s+|\s+-\s+/u);
		status.model = name.replace(/\s+\p{Extended_Pictographic}\uFE0F?$/u, "").trim() || null;
		status.thinking = paintedThinkingLevel(effort.trim().split(/\s+/).at(-1) ?? "");
		break;
	}
	return status;
}

/** Transcript lines above the same editor/status row recognized by the parser. */
export function messageLines(lines: readonly string[]): string[] {
	const editorTop = editorStatusIndex(lines);
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
