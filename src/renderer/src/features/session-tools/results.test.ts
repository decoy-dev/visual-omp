import { describe, expect, it } from "vitest";
import {
	placeResults,
	presentLines,
	printedLines,
	startWatch,
	supersededResult,
	WATCH,
	type WatchSample,
	type WatchState,
	watchStep,
} from "./results";

// Screens as omp 18.11 paints them (120 columns, trailing spaces trimmed by the reader).
const EDITOR = ["╭── π ▶ ⬢ Opus 5.5 · ◕ xhigh ▶ 🗑 project ▶──3%────────╮", "╰─                                ─╯"];
const PANEL = [
	"╭─ Context Usage ─────────────────────────────╮",
	"│                                             │",
	"│ ⛁ ⛁ ⛶ ⛶   Claude Opus 5.5 (1m context)      │",
	"│ ⛶ ⛶ ⛝ ⛝   31K/1m tokens (3.1%)              │",
	"│                                             │",
	"│ ⎋ to close                                  │",
	"╰─────────────────────────────────────────────╯",
];
const screen = (...above: string[]) => ["", ...above, "", ...EDITOR, "", ""];

function sample(lines: string[], now: number, extra: Partial<WatchSample> = {}): WatchSample {
	return { now, lines, editor: true, working: false, turnProgressed: false, roomChanged: false, transcriptGrew: false, ...extra };
}

/** Feed timed samples; every non-wait decision (and when), plus the final state. */
function steps(before: string[], command: string, samples: WatchSample[], duringTurn = false) {
	let state: WatchState = startWatch(0, duringTurn);
	const decisions: { kind: string; lines?: string[]; at: number }[] = [];
	for (const next of samples) {
		const [after, decision] = watchStep(state, before, command, next);
		state = after;
		if (decision.kind !== "wait") decisions.push({ ...decision, at: next.now });
	}
	return { decisions, state };
}

/** The first non-wait decision (and when), or wait. */
function run(before: string[], command: string, samples: WatchSample[], duringTurn = false) {
	return steps(before, command, samples, duringTurn).decisions[0] ?? { kind: "wait" as const };
}

/** The same screen sampled every 120ms from `from` to `to`. */
function hold(lines: string[], from: number, to: number, extra?: Partial<WatchSample>): WatchSample[] {
	const out: WatchSample[] = [];
	for (let now = from; now <= to; now += 120) out.push(sample(lines, now, extra));
	return out;
}

describe("printedLines", () => {
	it("finds a status line omp inserts above an inline report panel", () => {
		const before = screen(" Fast mode is off.", ...PANEL);
		const after = screen(" Fast mode is off.", " Warning: Nothing to compact (no messages yet)", ...PANEL);
		expect(printedLines(before, after)).toEqual([" Warning: Nothing to compact (no messages yet)"]);
	});

	it("finds a repeated line printed again at the bottom", () => {
		expect(printedLines(screen(" Fast mode is off."), screen(" Fast mode is off.", " Fast mode is off."))).toEqual([" Fast mode is off."]);
	});
});

describe("presentLines", () => {
	it("unboxes a report panel, keeps its title and grid, drops the close hint", () => {
		expect(presentLines(PANEL)).toEqual(["Context Usage", "", "⛁ ⛁ ⛶ ⛶   Claude Opus 5.5 (1m context)", "⛶ ⛶ ⛝ ⛝   31K/1m tokens (3.1%)"]);
	});
});

describe("watchStep", () => {
	it("turns a printed status line into a result once it stays quiet", () => {
		const before = screen();
		const after = screen(" Fast mode is off.");
		const decision = run(before, "/fast status", [...hold(before, 120, 360), ...hold(after, 480, 3000)]);
		expect(decision).toMatchObject({ kind: "result", lines: [" Fast mode is off."] });
		expect("at" in decision && decision.at).toBeGreaterThanOrEqual(480 + WATCH.quietMs);
	});

	it("captures an inline report panel as printed output", () => {
		const before = screen(" Fast mode is off.");
		const decision = run(before, "/context", hold(screen(" Fast mode is off.", ...PANEL), 120, 2000));
		expect(decision).toMatchObject({ kind: "result", lines: PANEL });
	});

	it("waits through a spinner and stops without a row when the compaction lands in the transcript", () => {
		const before = screen(" Reply with just the word hi.", " hi");
		const spinning = ["⠧", "⠦", "⠇"].map(frame => screen(" Reply with just the word hi.", " hi", ` ${frame} Compacting context... (⎋ to cancel)`));
		const compacted = screen(" hi", "──── 📷 remote-compacted · 32K→31K · ⌃O ────");
		const samples = [
			...Array.from({ length: 60 }, (_, index) => sample(spinning[index % 3]!, 120 * (index + 1))),
			sample(compacted, 7400),
			sample(compacted, 7520, { transcriptGrew: true }),
		];
		expect(run(before, "/compact", samples)).toEqual({ kind: "stop", at: 7520 });
	});

	it("stops without a row when a turn starts", () => {
		const before = screen();
		expect(run(before, "/review", [sample(screen(" /review"), 120), sample(screen(" /review"), 240, { working: true })])).toMatchObject({ kind: "stop" });
	});

	it("reports the editor replaced only after it stays gone, then never a row", () => {
		const before = screen();
		const dialog = ["╭─ Goal objective ─╮", "│ >                │", "╰──────────────────╯"];
		expect(run(before, "/goal", [sample(dialog, 120, { editor: false }), sample(screen(), 240)])).toEqual({ kind: "wait" });
		expect(run(before, "/goal", [sample(dialog, 120, { editor: false }), sample(dialog, 240, { editor: false })])).toEqual({ kind: "replaced", at: 240 });
	});

	it("after omp's own screen, waits however long it stays, then ends once the editor is back for good", () => {
		const before = screen();
		const dialog = ["╭─ Goal objective ─╮", "│ >                │", "╰──────────────────╯"];
		const back = screen(" Goal set: ship it");
		const { decisions } = steps(before, "/goal", [
			...hold(dialog, 120, 240, { editor: false }),
			// Open longer than any command timeout; a one-frame repaint of the editor does not count as back.
			...hold(dialog, 360, WATCH.maxMs + 1000, { editor: false }),
			sample(back, WATCH.maxMs + 1120),
			sample(dialog, WATCH.maxMs + 1240, { editor: false }),
			sample(back, WATCH.maxMs + 1360),
			sample(back, WATCH.maxMs + 1480),
		]);
		expect(decisions).toEqual([
			{ kind: "replaced", at: 240 },
			{ kind: "stop", at: WATCH.maxMs + 1480 },
		]);
	});

	it("behind omp's screen, ends only on a session change, not when the turn ends or entries land behind it", () => {
		const dialog = ["╭─ Pick ─╮", "╰────────╯"];
		const opened = hold(dialog, 120, 240, { editor: false });
		const behind = [sample(dialog, 360, { editor: false, working: true }), sample(dialog, 480, { editor: false, transcriptGrew: true })];
		expect(steps(screen(), "/x", [...opened, ...behind], true).decisions).toEqual([{ kind: "replaced", at: 240 }]);
		expect(steps(screen(), "/x", [...opened, ...behind, sample(dialog, 600, { editor: false, roomChanged: true })]).decisions.at(-1)).toEqual({ kind: "stop", at: 600 });
	});

	it("typed mid-turn (Send now): ignores the turn's spinner and keeps what the command printed", () => {
		const before = screen(" Reply so far", " ⠋ Working… (⎋ to interrupt)");
		const frames = ["⠙", "⠹", "⠸"].map(frame => screen(" Reply so far", " Fast mode is on.", ` ${frame} Working… (⎋ to interrupt)`));
		const samples = Array.from({ length: 12 }, (_, index) => sample(frames[index % 3]!, 120 * (index + 1), { working: true }));
		expect(run(before, "/fast on", samples, true)).toMatchObject({ kind: "result", lines: [" Fast mode is on."] });
	});

	it("typed mid-turn: stops without a row once the reply moves on or the turn ends", () => {
		const before = screen(" Reply so far");
		expect(run(before, "/fast on", [sample(screen(" Reply so far", " more"), 120, { working: true, turnProgressed: true })], true)).toMatchObject({ kind: "stop" });
		expect(run(before, "/fast on", [sample(screen(" Reply so far"), 120)], true)).toMatchObject({ kind: "stop" });
	});

	it("gives up quietly when nothing is printed", () => {
		const before = screen(" earlier");
		expect(run(before, "/fast on", hold(before, 120, WATCH.firstOutputMs + 240))).toMatchObject({ kind: "stop" });
	});
});

describe("supersededResult", () => {
	const before = screen();
	it("keeps what an unfinished watch printed when the next command is typed", () => {
		const { state } = steps(before, "/fast status", [sample(screen(" Fast mode is off."), 120)]);
		expect(supersededResult(state)).toEqual([" Fast mode is off."]);
	});

	it("drops a watch with nothing printed, a spinner still running, or omp's own screen up", () => {
		expect(supersededResult(steps(before, "/fast on", [sample(before, 120)]).state)).toBeNull();
		const spinning = screen(" Partial line", " ⠧ Compacting context... (⎋ to cancel)");
		expect(supersededResult(steps(before, "/compact", [sample(spinning, 120)]).state)).toBeNull();
		const dialog = ["╭─ Pick ─╮", "╰────────╯"];
		expect(supersededResult(steps(before, "/x", [sample(screen(" Note"), 120), ...hold(dialog, 240, 360, { editor: false })]).state)).toBeNull();
	});
});

describe("placeResults", () => {
	const result = (anchor: string | null, room: string | null = "s1") => ({ anchor, room });

	it("anchors after the entry, at the top for an empty chat, at the end when the entry left the branch", () => {
		const placed = placeResults(["a", "b", "c"], 0, [result("b"), result(null), result("gone")], "s1");
		expect(placed.after.get("b")).toEqual([result("b")]);
		expect(placed.top).toEqual([result(null)]);
		expect(placed.end).toEqual([result("gone")]);
	});

	it("hides results above the rendered window and from another omp session", () => {
		const placed = placeResults(["a", "b", "c"], 2, [result("a"), result(null), result("c", "s0")], "s1");
		expect(placed.after.size + placed.top.length + placed.end.length).toBe(0);
	});
});
