import { describe, expect, it } from "vitest";
import { type Helper, type HelperStatus, helpersOf } from "./derive";
import { pinnedHelpers, unpinnedRuns } from "./pinnedHelpers";

const helper = (id: string, status: HelperStatus, messageable = status === "running"): Helper => ({
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
});

describe("pinnedHelpers", () => {
	it("pins only running helpers; done (also one omp keeps for a follow-up), failed and stopped ones stay in the transcript", () => {
		const pinned = pinnedHelpers([helper("a", "running"), helper("b", "done", true), helper("c", "done"), helper("d", "failed"), helper("e", "stopped")]);
		expect(pinned.all.map(run => run.id)).toEqual(["a"]);
		expect([...pinned.ids]).toEqual(["a"]);
	});

	it("retains every running helper in order so the strip can fit cards to its width", () => {
		const pinned = pinnedHelpers(["a", "b", "c", "d", "e"].map(id => helper(id, "running")));
		expect(pinned.all.map(run => run.id)).toEqual(["a", "b", "c", "d", "e"]);
		// Overflow helpers remain pinned too.
		expect(pinned.ids.size).toBe(5);
	});

	it("pins nothing from a stale mirror once omp no longer runs", () => {
		const guest = {
			agents: [],
			progress: new Map(),
			lifecycle: new Map([
				["a", { id: "a", agent: "task", status: "started" as const, index: 0, description: "Scan" }],
				["b", { id: "b", agent: "task", status: "completed" as const, index: 1, description: "Read" }],
			]),
		};
		expect([...pinnedHelpers(helpersOf(guest, true)).ids]).toEqual(["a"]);
		expect(pinnedHelpers(helpersOf(guest, false)).all).toEqual([]);
	});
});

describe("unpinnedRuns", () => {
	it("keeps a task call's cards for its helpers that are not pinned, and all of them once none is", () => {
		const runs = [helper("a", "running"), helper("b", "done"), helper("c", "running")];
		expect(unpinnedRuns(runs, new Set(["a", "c"])).map(run => run.id)).toEqual(["b"]);
		// "a" finished: it leaves the strip and its card is back under the call.
		expect(unpinnedRuns(runs, new Set(["c"])).map(run => run.id)).toEqual(["a", "b"]);
		expect(unpinnedRuns(runs, new Set())).toBe(runs);
	});
});
