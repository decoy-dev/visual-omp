/**
 * What a typed slash command printed, as an ephemeral row in its chat (DESIGN §3.5 "Command results").
 *
 * `typed.ts` types the command and samples omp's painted screen; the rules here decide when the
 * printed lines have settled into a result, when watching stops without one, and where a result sits
 * in the transcript. Results live per chat in memory only: omp never saves them in the session file.
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { useSyncExternalStore } from "react";
import type { SessionView } from "../../state/session";
import { messageLines } from "./screen";

export type ResultTone = "info" | "warn" | "err";

/** omp's tone for one printed line: `Error…`/`Failed…` and `Warning…` (the rule `reportOutput` toasts with). */
export function outputTone(line: string): ResultTone {
	return /^(error|failed)/i.test(line) ? "err" : /^warning/i.test(line) ? "warn" : "info";
}

/** The strongest tone among the lines. */
export function linesTone(lines: readonly string[]): ResultTone {
	let tone: ResultTone = "info";
	for (const line of lines) {
		const next = outputTone(line.trim());
		if (next === "err") return "err";
		if (next === "warn") tone = "warn";
	}
	return tone;
}

// ── Reading what omp printed ────────────────────────────────────────────────

/**
 * Lines omp added above its editor between two screen reads, oldest first. A longest-common-subsequence
 * match, so a status line inserted above an inline report panel (omp keeps panels next to the editor)
 * is found as well as lines appended at the bottom; lines scrolled off the top simply drop out.
 */
export function printedLines(before: readonly string[], after: readonly string[]): string[] {
	const old = messageLines(before);
	const next = messageLines(after);
	const n = old.length;
	const m = next.length;
	// lcs[i][j]: common subsequence length of old[i..] and next[j..].
	const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = old[i] === next[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const added: string[] = [];
	let i = 0;
	let j = 0;
	while (j < m) {
		if (i < n && old[i] === next[j]) {
			i++;
			j++;
		} else if (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
		else added.push(next[j++]!);
	}
	return added;
}

/** omp's working spinner (`Loader`): a braille frame leading the line, e.g. `⠧ Compacting context... (⎋ to cancel)`. */
export function isLoaderLine(line: string): boolean {
	return /^[\u2801-\u28FF]\s/.test(line.trim());
}

/**
 * Printed lines as the result row shows them: an inline report panel loses its box frame (its title
 * stays as the first line) and its "⎋ to close" hint, the shared indent goes, and blank runs shrink
 * to one blank line. The grid inside stays aligned for a monospace well.
 */
export function presentLines(lines: readonly string[]): string[] {
	const shaped: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimEnd();
		const title = /^\s*╭─+\s*(.*?)\s*─*╮$/.exec(trimmed);
		if (title) {
			if (title[1]) shaped.push(title[1]);
			continue;
		}
		if (/^\s*╰─*╯$/.test(trimmed)) continue;
		const framed = /^\s*│ ?(.*?)\s*│$/.exec(trimmed);
		const text = framed ? (framed[1] ?? "") : trimmed;
		if (/^⎋ to close$/.test(text.trim())) continue;
		shaped.push(text);
	}
	const indent = Math.min(...shaped.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length));
	const out: string[] = [];
	for (const line of shaped) {
		const text = Number.isFinite(indent) ? line.slice(indent) : line;
		if (!text.trim() && (out.length === 0 || !out.at(-1)!.trim())) continue;
		out.push(text);
	}
	while (out.length > 0 && !out.at(-1)!.trim()) out.pop();
	return out;
}

// ── When a typed command is done ────────────────────────────────────────────

export const WATCH = {
	/** Printed lines unchanged this long are the result. */
	quietMs: 600,
	/** After a spinner (compaction, a handoff) the screen repaints more; wait longer before trusting it. */
	afterLoaderMs: 1500,
	/** Nothing printed by then (and no spinner): the command prints nothing. */
	firstOutputMs: 5000,
	/** Give up on any command after this long. */
	maxMs: 10 * 60_000,
	/** Polls without omp's editor before it counts as replaced, and with it before it counts as back (a repaint can drop it for a frame). */
	replacedPolls: 2,
} as const;

/** One look at the chat while a typed command runs. */
export interface WatchSample {
	now: number;
	/** Painted screen. */
	lines: readonly string[];
	/** omp's prompt editor is painted and no overlay covers it. */
	editor: boolean;
	/** omp is running a turn. */
	working: boolean;
	/** The running turn's reply or tools changed since the command was typed (only read when it was typed mid-turn). */
	turnProgressed: boolean;
	/** The chat moved to another collab room, or omp is reconnecting or stopped. */
	roomChanged: boolean;
	/** omp appended an entry the transcript draws (a message, a compaction or branch summary, a notice). */
	transcriptGrew: boolean;
}

export interface WatchState {
	startedAt: number;
	/** The command was typed while a turn ran ("Send now"): the turn's own spinner and repaints are not the command's. */
	duringTurn: boolean;
	/** Printed lines so far (spinner lines excluded). */
	output: string[];
	/** When `output` last changed or a spinner was last seen. */
	changedAt: number;
	/** A spinner of the command's showed at some point. */
	loader: boolean;
	/** The command's spinner showed in the latest sample. */
	spinning: boolean;
	/** omp replaced its editor with a screen of its own; the watch now waits for the editor to come back. */
	replaced: boolean;
	/** Consecutive polls without the editor (or, once replaced, with it). */
	streak: number;
}

export type WatchDecision =
	| { kind: "wait" }
	/** The printed lines settled. */
	| { kind: "result"; lines: string[] }
	/** Done without a row: a turn or session change shows elsewhere, nothing was printed, or omp's editor is back after its own screen. */
	| { kind: "stop" }
	/**
	 * omp replaced its editor with a screen of its own (a dialog, picker or full-screen menu). Reported once;
	 * the watch then waits until the editor is back (or the session changes), whatever the turn does meanwhile.
	 */
	| { kind: "replaced" };

export function startWatch(now: number, duringTurn = false): WatchState {
	return { startedAt: now, duringTurn, output: [], changedAt: now, loader: false, spinning: false, replaced: false, streak: 0 };
}

export function watchStep(state: WatchState, before: readonly string[], command: string, sample: WatchSample): [WatchState, WatchDecision] {
	if (sample.roomChanged) return [state, { kind: "stop" }];
	// omp's own screen is up: nothing can be typed until it goes, even if a turn ends or entries land behind it.
	if (state.replaced) {
		const streak = sample.editor ? state.streak + 1 : 0;
		return [{ ...state, streak }, streak >= WATCH.replacedPolls ? { kind: "stop" } : { kind: "wait" }];
	}
	// The editor missing outranks the turn: omp's screen is up even if the turn moved on meanwhile.
	if (!sample.editor) {
		const streak = state.streak + 1;
		if (streak < WATCH.replacedPolls) return [{ ...state, streak }, { kind: "wait" }];
		return [{ ...state, streak: 0, replaced: true, spinning: false }, { kind: "replaced" }];
	}
	// A turn starting (or, typed mid-turn, the turn moving on or ending) repaints the area above the editor and shows in the transcript.
	const turn = state.duringTurn ? !sample.working || sample.turnProgressed : sample.working;
	if (turn || sample.transcriptGrew) return [state, { kind: "stop" }];
	const printed = printedLines(before, sample.lines).filter(line => line.trim() !== command);
	const spinning = !state.duringTurn && printed.some(isLoaderLine);
	const output = printed.filter(line => !isLoaderLine(line));
	const changed = output.join("\n") !== state.output.join("\n");
	const next: WatchState = {
		...state,
		output: changed ? output : state.output,
		changedAt: changed || spinning ? sample.now : state.changedAt,
		loader: state.loader || spinning,
		spinning,
		streak: 0,
	};
	const elapsed = sample.now - state.startedAt;
	if (elapsed >= WATCH.maxMs) return [next, next.output.length > 0 ? { kind: "result", lines: next.output } : { kind: "stop" }];
	if (spinning || sample.now - next.changedAt < (next.loader ? WATCH.afterLoaderMs : WATCH.quietMs)) return [next, { kind: "wait" }];
	if (next.output.length > 0) return [next, { kind: "result", lines: next.output }];
	return [next, next.loader || elapsed >= WATCH.firstOutputMs ? { kind: "stop" } : { kind: "wait" }];
}

/**
 * The row a watch leaves when the next command is typed before it finished: what it printed so far,
 * unless its spinner still shows (the output is partial) or omp's own screen took over. Null: no row.
 */
export function supersededResult(state: WatchState): string[] | null {
	return state.replaced || state.spinning || state.output.length === 0 ? null : state.output;
}

/** Entries the transcript draws a row for, so a command that adds one is already visible there. */
export function drawsRow(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return entry.message.role === "user" || entry.message.role === "assistant";
		case "custom_message":
			return entry.display || entry.customType === "collab-prompt";
		case "compaction":
		case "branch_summary":
			return true;
		default:
			return false;
	}
}

/** The omp session a chat shows; results recorded under another session are not shown. */
export function roomKey(view: SessionView | null | undefined): string | null {
	return view?.host?.sessionId ?? view?.guest?.header?.id ?? null;
}

// ── The per-chat store ──────────────────────────────────────────────────────

export interface CommandResultRecord {
	id: string;
	/** The line as typed, e.g. `/fast status`. */
	command: string;
	/** What omp printed, shaped by `presentLines`. */
	lines: string[];
	tone: ResultTone;
	/** Last displayed entry when the command was sent; null when the chat showed none. */
	anchor: string | null;
	/** `roomKey` when the command was sent. */
	room: string | null;
	createdAt: number;
}

interface ChatResults {
	items: readonly CommandResultRecord[];
	listeners: Set<() => void>;
}

const EMPTY: readonly CommandResultRecord[] = [];
const chats = new WeakMap<object, ChatResults>();
let nextResultId = 0;

function chatResults(chat: object): ChatResults {
	let results = chats.get(chat);
	if (!results) {
		results = { items: EMPTY, listeners: new Set() };
		chats.set(chat, results);
	}
	return results;
}

function update(chat: object, items: readonly CommandResultRecord[]): void {
	const results = chatResults(chat);
	results.items = items;
	for (const listener of results.listeners) listener();
}

/** Record a result for `chat` (its SessionController). */
export function addCommandResult(chat: object, result: Omit<CommandResultRecord, "id" | "createdAt">): void {
	update(chat, [...chatResults(chat).items, { ...result, id: `r${nextResultId++}`, createdAt: Date.now() }]);
}

export function dismissCommandResult(chat: object, id: string): void {
	update(
		chat,
		chatResults(chat).items.filter(item => item.id !== id),
	);
}

export function commandResults(chat: object): readonly CommandResultRecord[] {
	return chats.get(chat)?.items ?? EMPTY;
}

export function useCommandResults(chat: object): readonly CommandResultRecord[] {
	return useSyncExternalStore(
		listener => {
			const results = chatResults(chat);
			results.listeners.add(listener);
			return () => results.listeners.delete(listener);
		},
		() => commandResults(chat),
	);
}

export interface PlacedResults<T> {
	/** Before the first row (the chat showed nothing when they were sent). */
	top: T[];
	/** After the row of the entry with this id. */
	after: Map<string, T[]>;
	/** After the last row: their entry is no longer on the displayed branch. */
	end: T[];
}

/**
 * Where results sit among the displayed entries (`ids`, of which rows from `start` are rendered).
 * Results of another omp session are left out, and so are results anchored above the rendered window.
 */
export function placeResults<T extends Pick<CommandResultRecord, "anchor" | "room">>(
	ids: readonly string[],
	start: number,
	results: readonly T[],
	room: string | null,
): PlacedResults<T> {
	const placed: PlacedResults<T> = { top: [], after: new Map(), end: [] };
	if (results.length === 0) return placed;
	const index = new Map(ids.map((id, position) => [id, position]));
	for (const result of results) {
		if (result.room !== null && room !== null && result.room !== room) continue;
		if (result.anchor === null) {
			if (start === 0) placed.top.push(result);
			continue;
		}
		const position = index.get(result.anchor);
		if (position === undefined) placed.end.push(result);
		else if (position >= start) {
			const list = placed.after.get(result.anchor);
			if (list) list.push(result);
			else placed.after.set(result.anchor, [result]);
		}
	}
	return placed;
}
