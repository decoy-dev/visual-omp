import { describe, expect, it } from "vitest";
import { hookQuestions, matchQuestions, QuestionArbitrator, type CollabQuestionState, type HookQuestion } from "./question-match";

const scope = { hostId: "host", generation: 1, epoch: 1 };
const dialog: HookQuestion = { surfaceId: "s", nodeId: "hook", title: "Choose", kind: "select", options: [{ label: "Yes", description: "Continue" }, { label: "No" }] };
const state: CollabQuestionState = { ...scope, revision: 1, connection: 1, connected: true, requests: [{ reqId: 4, kind: "select", title: "Choose", options: [{ label: "Yes", description: "Continue" }, "No"] }] };

describe("hook-collab question arbitration", () => {
	it("matches only mutual unique title, field and option data", () => {
		expect(matchQuestions(scope, state, [dialog])).toMatchObject([{ status: "matched", reqId: 4 }]);
		for (const changed of [{ ...dialog, title: "Other" }, { ...dialog, options: [{ label: "Yes" }] }, { ...dialog, options: [{ label: "Yes", description: "Different" }, { label: "No" }] }]) expect(matchQuestions(scope, state, [changed])[0]?.status).toBe("ambiguous");
		const editor: HookQuestion = { ...dialog, kind: "editor", field: "draft" };
		const request = { reqId: 7, kind: "editor" as const, title: "Choose", prefill: "draft" };
		expect(matchQuestions(scope, { ...state, requests: [request] }, [editor])[0]?.status).toBe("matched");
		expect(matchQuestions(scope, { ...state, requests: [request] }, [{ ...editor, field: "changed" }])[0]?.status).toBe("ambiguous");
	});
	it("handles collab first and TSP first without treating absence as identity", () => {
		for (const first of ["collab", "tsp"]) {
			const arb = new QuestionArbitrator();
			if (first === "collab") { arb.update(scope, state); expect(arb.matches(scope, [])).toEqual([]); }
			else expect(arb.matches(scope, [dialog])[0]?.status).toBe("unavailable");
			arb.update(scope, state);
			expect(arb.matches(scope, [dialog])[0]?.status).toBe("matched");
		}
	});
	it("disables local answers for duplicate requests or duplicate live dialogs", () => {
		expect(matchQuestions(scope, { ...state, requests: [...state.requests, { ...state.requests[0]!, reqId: 5 }] }, [dialog])[0]?.status).toBe("ambiguous");
		expect(matchQuestions(scope, state, [dialog, { ...dialog, nodeId: "other" }]).map(match => match.status)).toEqual(["ambiguous", "ambiguous"]);
	});
	it("marks local questions unmatched only with an authoritative empty collab mirror", () => {
		expect(matchQuestions(scope, { ...state, requests: [] }, [dialog])[0]?.status).toBe("unmatched");
		expect(matchQuestions(scope, null, [dialog])[0]?.status).toBe("unavailable");
		expect(matchQuestions(scope, { ...state, connected: false }, [dialog])[0]?.status).toBe("unavailable");
	});
	it("rejects stale host, generation, epoch and revision updates", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, state);
		for (const stale of [{ ...state, hostId: "other" }, { ...state, generation: 0 }, { ...state, epoch: 0 }, { ...state, requests: [] }]) expect(arb.update(scope, stale)).toBe(false);
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("matched");
		for (const changed of [{ ...scope, epoch: 2 }, { ...scope, generation: 2 }]) expect(arb.matches(changed, [dialog])[0]?.status).toBe("unavailable");
	});
	it("invalidates match authority on disconnect while preserving a bound dialog's completion guard", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, state); arb.matches(scope, [dialog]);
		arb.update(scope, { ...state, revision: 2, connected: false, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("unavailable");
		arb.update(scope, { ...state, revision: 3, connection: 2, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("settling");
		expect(() => arb.answer(scope, [dialog], "s", "hook")).toThrow("settling");
		expect(arb.matches(scope, [])).toEqual([]);
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("unmatched");
	});
	it("waits for remote settlement AND node departure in either order", () => {
		for (const first of ["node", "request"]) {
			const arb = new QuestionArbitrator(); arb.update(scope, state); arb.matches(scope, [dialog]);
			if (first === "node") expect(arb.matches(scope, [])).toEqual([]);
			arb.update(scope, { ...state, revision: 2, requests: [] });
			if (first === "request") expect(arb.matches(scope, [dialog])[0]?.status).toBe("settling");
			expect(arb.matches(scope, [])).toEqual([]);
			expect(arb.matches(scope, [dialog])[0]?.status).toBe("unmatched");
		}
	});
	it("extracts only live current-generation hook data", () => {
		const surface = { open: { id: "s", mode: "inline" as const }, sequence: 1, closed: false, suspended: false, focus: null, settled: [], documentGeneration: 1, document: { id: "hook", k: "overlay" as const, p: { role: "omp.overlay.hook-select", head: "Choose" }, c: [{ id: "picker", k: "picker" as const, p: { items: [{ id: "yes", label: "Yes", detail: "Continue" }, { id: "no", label: "No" }] } }] } };
		expect(hookQuestions([surface], 1)).toEqual([{ ...dialog, field: undefined }]);
		for (const changed of [{ ...surface, closed: true }, { ...surface, suspended: true }, { ...surface, documentGeneration: 0 }]) expect(hookQuestions([changed], 1)).toEqual([]);
	});
	it("keeps a local answer blocked until its node departs, including reconnects", () => {
		const arb = new QuestionArbitrator();
		arb.update(scope, { ...state, requests: [] });
		arb.answer(scope, [dialog], "s", "hook");
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("answering");
		expect(() => arb.answer(scope, [dialog], "s", "hook")).toThrow("answering");
		arb.update(scope, { ...state, revision: 2, connected: false, requests: [] });
		arb.update(scope, { ...state, revision: 3, connection: 2, requests: [] });
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("answering");
		expect(arb.matches(scope, [])).toEqual([]);
		expect(arb.matches(scope, [dialog])[0]?.status).toBe("unmatched");
		expect(arb.matches({ ...scope, epoch: 2 }, [dialog])[0]?.status).toBe("unavailable");
	});
	it.each(["node", "request"])("records stable monotonic observation times when %s arrives first", first => {
		let now = 10;
		const arb = new QuestionArbitrator(() => now);
		if (first === "node") expect(arb.matches(scope, [dialog])[0]).toMatchObject({ nodeFirstSeenMs: 10, status: "unavailable" });
		else arb.update(scope, state);
		now = 25;
		if (first === "node") arb.update(scope, state);
		const match = arb.matches(scope, [dialog])[0]!;
		expect(match).toMatchObject({ status: "matched", nodeFirstSeenMs: first === "node" ? 10 : 25, requestFirstSeenMs: first === "node" ? 25 : 10 });
		now = 40; arb.update(scope, { ...state, revision: 2 });
		expect(arb.matches(scope, [dialog])[0]).toEqual(match);
		arb.update(scope, { ...state, revision: 3, requests: [] });
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "settling", nodeFirstSeenMs: match.nodeFirstSeenMs, requestFirstSeenMs: match.requestFirstSeenMs });
		arb.matches(scope, []);
		now = 60;
		expect(arb.matches(scope, [dialog])[0]).toMatchObject({ status: "unmatched", nodeFirstSeenMs: 60 });
		expect(arb.matches(scope, [dialog])[0]?.requestFirstSeenMs).toBeUndefined();
	});
});
