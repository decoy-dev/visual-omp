import { describe, expect, it } from "vitest";
import type { Helper } from "../../features/panes/derive";
import { helperRunsSummary, taskRowContextEqual, taskRuns } from "./task";

function helper(id: string, status: Helper["status"], messageable = false): Helper {
	return {
		id,
		name: id,
		status,
		activity: "",
		tokens: null,
		toolCount: null,
		durationMs: null,
		durationAt: null,
		contextTokens: null,
		contextWindow: null,
		model: null,
		hasTranscript: false,
		messageable,
	};
}

const describeState = (status: string, count: number) => `${count} ${status}`;

describe("helperRunsSummary", () => {
	it("gives stopped helpers the neutral mark with their own label", () => {
		expect(helperRunsSummary([helper("Atlas", "stopped")], describeState)).toEqual({
			key: "task.one.stopped",
			values: { agent: "Atlas" },
			status: "neutral",
			statusLabel: "task.mark.stopped",
		});
		expect(helperRunsSummary([helper("A", "stopped"), helper("B", "stopped")], describeState)).toEqual({
			key: "task.many.stopped",
			values: { count: 2 },
			status: "neutral",
			statusLabel: "task.mark.stopped",
		});
	});

	it("keeps the success mark for all-finished batches only, counting helpers omp keeps for a follow-up as finished", () => {
		expect(helperRunsSummary([helper("A", "done")], describeState)).toEqual({ key: "task.one.ok", values: { agent: "A" }, status: "ok" });
		expect(helperRunsSummary([helper("A", "done", true), helper("B", "done")], describeState)).toEqual({ key: "task.many.ok", values: { count: 2 }, status: "ok" });
		expect(helperRunsSummary([helper("A", "done"), helper("B", "stopped")], describeState)).toMatchObject({ status: "neutral", statusLabel: "task.mark.stopped" });
		expect(helperRunsSummary([helper("A", "done"), helper("B", "failed"), helper("C", "done", true)], describeState)).toMatchObject({ status: "error" });
	});

	it("only calls all-done batches finished and names every state in mixed batches", () => {
		expect(helperRunsSummary([helper("A", "done"), helper("B", "done")], describeState)).toMatchObject({ key: "task.many.ok", values: { count: 2 } });
		expect(helperRunsSummary([helper("A", "done"), helper("B", "failed"), helper("C", "stopped")], describeState)).toMatchObject({
			key: "task.many.states",
			values: { count: 3, summary: "1 done · 1 failed · 1 stopped" },
			status: "error",
		});
		expect(helperRunsSummary([helper("A", "running"), helper("B", "done", true)], describeState)).toMatchObject({
			key: "task.many.states",
			values: { count: 2, summary: "1 running · 1 done" },
			status: "running",
		});
	});
});

describe("taskRuns activity", () => {
	const assignment = "# Target\nTranscript dialog only.\n\n# Change\nClassify messages.";

	it("shows each spawn's name and assignment before omp reports progress", () => {
		const runs = taskRuns({ context: "ctx", tasks: [{ name: "HelperMarkup", agent: "task", task: assignment }] }, null, true);
		expect(runs.map(run => [run.name, run.activity])).toEqual([["HelperMarkup", "Transcript dialog only."]]);
	});

	it("never shows omp's assignment preamble from progress, and switches to the helper's own activity", () => {
		const pending = { index: 0, id: "A", agent: "task", status: "pending", task: `Complete assignment thoroughly:\n\n${assignment}`, recentTools: [], recentOutput: [] };
		expect(taskRuns({}, { progress: [pending] }, true)[0]?.activity).toBe("Transcript dialog only.");
		const working = { ...pending, status: "running", recentTools: [{ tool: "read", args: "x", intent: "Reading TasksPane", endMs: 1 }] };
		expect(taskRuns({}, { progress: [working] }, true)[0]?.activity).toBe("Reading TasksPane");
	});
});

describe("taskRowContextEqual", () => {
	// A mounted background-spawn row: its call and result never change after the spawn.
	const args = { context: "Release docs", tasks: [{ name: "AdvisorContext", agent: "astra", task: "Review." }] };
	const details = {
		results: [],
		progress: [{ index: 0, id: "AdvisorContext", agent: "astra", status: "pending", task: "Complete assignment thoroughly:\n\nReview.", recentTools: [], recentOutput: [] }],
		async: { state: "running", jobId: "AdvisorContext", type: "task" },
	};
	const working = { recorded: new Map([["AdvisorContext", "running" as const]]), ompRunning: true };

	it("re-renders the row when its helper's recorded state changes (a wait result or a delivery)", () => {
		expect(taskRowContextEqual(args, details, working, { ...working, recorded: new Map([["AdvisorContext", "done" as const]]) })).toBe(false);
	});

	it("re-renders the row when omp stops running", () => {
		expect(taskRowContextEqual(args, details, working, { ...working, ompRunning: false })).toBe(false);
	});

	it("keeps the row's memo when only another helper's state changes", () => {
		expect(taskRowContextEqual(args, details, working, working)).toBe(true);
		const other = new Map<string, "running" | "done">([
			["AdvisorContext", "running"],
			["Reviewer", "done"],
		]);
		expect(taskRowContextEqual(args, details, working, { ...working, recorded: other })).toBe(true);
	});
});
