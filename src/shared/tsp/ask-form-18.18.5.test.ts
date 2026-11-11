import { describe, expect, it } from "vitest";
import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { hookQuestions } from "./hook-questions";
import { matchQuestions, type CollabQuestion, type CollabQuestionState } from "./question-match";
import { QuestionArbitrator } from "./question-arbitrator";
import { askFormPresentation, isClaimable, isKnownAction, isKnownRole, TSP_ACTIONS, TSP_READ_ONLY_ACTIONS, TSP_ROLES } from "./roles";
import { unclaimed, walkNodes } from "./view-state";
import tabs from "../../main/omp/tsp/fixtures/18.18.5/ask-fixture-form-tabs.ask.json";
import fourTabs from "../../main/omp/tsp/fixtures/18.18.5/ask-four-fieldsets-tabs.ask.json";
import guest from "../../main/omp/tsp/fixtures/18.18.5/ask-fixture-form-guest.ask.json";
import colors from "../../main/omp/tsp/fixtures/18.18.5/ask-fixture-colors.ask.json";
import legacy from "../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";

const scope = { hostId: "ask-18.18.5", generation: 1, epoch: 1 };
interface RecordedStage { stage: string; surfaces: unknown; request: unknown }
function capture(evidence: { stages: readonly RecordedStage[] }, name: string) {
	const stage = evidence.stages.find(stage => stage.stage === name);
	if (!stage) throw new Error(`Missing recorded stage: ${name}`);
	const surfaces = structuredClone(stage.surfaces) as TspSurfaceSnapshot[];
	const root = surfaces.flatMap(surface => [...walkNodes(surface.document)]).find(node => node.p?.role === TSP_ROLES.editorAsk || node.p?.role === TSP_ROLES.editorAskHidden)!;
	return { surfaces, root, request: stage.request as CollabQuestion | null, dialogs: hookQuestions(surfaces, scope.generation) };
}
function state(request: CollabQuestion | null, revision = 1): CollabQuestionState {
	return { ...scope, connection: 1, connected: true, revision, requests: request ? [request] : [] };
}

describe("recorded 18.18.5 HTML form presentations", () => {
	it.each([tabs, fourTabs])("recognizes nested bodies and preserves established ownership through every native stage", evidence => {
		let now = 10;
		const arb = new QuestionArbitrator(() => now);
		const opened = capture(evidence, "opened");
		arb.update(scope, state(opened.request));
		const initial = arb.matches(scope, opened.dialogs)[0]!;
		expect(initial).toMatchObject({ status: "matched", reqId: opened.request!.reqId, nodeFirstSeenMs: 10, requestFirstSeenMs: 10 });
		expect(opened.root.c!.some(node => node.p?.role === TSP_ROLES.askForm)).toBe(false);
		expect(opened.dialogs[0]).toMatchObject({ formView: "fields", formNavigation: { active: "t0" }, formFields: [{ title: "Release channel", kind: "choice", other: true, options: ["Stable", "Beta", "Other (type your own)"] }] });
		for (const stage of evidence.stages.filter(stage => stage.request)) {
			now += 10;
			const current = capture(evidence, stage.stage);
			const presentation = askFormPresentation(current.root)!;
			expect(presentation, stage.stage).not.toBeNull();
			expect(current.dialogs, stage.stage).toHaveLength(1);
			expect(current.dialogs[0]!.nodeId).toBe(initial.nodeId);
			const match = arb.matches(scope, current.dialogs)[0]!;
			expect(match, stage.stage).toMatchObject({ status: presentation.navigation?.active === "t0" ? "matched" : "settling", reqId: opened.request!.reqId, nodeFirstSeenMs: 10, requestFirstSeenMs: 10 });
			expect(isClaimable(current.root)).toBe(true);
			const surface = current.surfaces.find(surface => surface.open.id === match.surfaceId)!;
			expect(unclaimed(surface, "dock").flatMap(node => [...walkNodes(node)]).some(node => node.id === match.nodeId)).toBe(true);
			expect(unclaimed(surface, "dock", new Set([match.nodeId])).flatMap(node => [...walkNodes(node)]).some(node => node.id === match.nodeId)).toBe(false);
			expect(() => arb.answer(scope, current.dialogs, match.surfaceId, match.nodeId)).toThrow();
		}
		const submitted = capture(evidence, "submitted");
		arb.update(scope, state(null, 2));
		expect(arb.matches(scope, submitted.dialogs)).toEqual([]);
		expect(arb.matches(scope, capture(evidence, "review").dialogs)[0]).toMatchObject({ status: "unmatched" });
	});

	it("recognizes Review and Hide without inventing fields or fresh content matches", () => {
		const opened = capture(tabs, "opened");
		for (const view of ["review", "hidden"] as const) {
			const current = capture(tabs, view);
			expect(askFormPresentation(current.root)).toMatchObject({ view, body: null });
			expect(current.dialogs[0]).toMatchObject({ kind: "form", formView: view, formFields: [] });
			expect(matchQuestions(scope, state(opened.request), current.dialogs)[0]!.status).toBe("ambiguous");
		}
	});

	it("settles later invisible guest fields on the original binding rather than matching unrelated requests", () => {
		const arb = new QuestionArbitrator();
		const first = guest.stages[0]!;
		const initial = capture(guest, first.stage);
		let revision = 0;
		for (const stage of guest.stages) {
			const current = capture(guest, stage.stage);
			arb.update(scope, state(current.request, ++revision));
			if (!current.request) { expect(arb.matches(scope, current.dialogs)).toEqual([]); continue; }
			expect(current.dialogs[0]!.formNavigation!.active).toBe("t0");
			const match = arb.matches(scope, current.dialogs)[0]!;
			expect(match, stage.stage).toMatchObject({ status: stage.stage === first.stage ? "matched" : "settling", reqId: initial.request!.reqId });
			if (stage.stage !== first.stage) {
				expect(matchQuestions(scope, state(current.request), current.dialogs)[0]!.status).toBe("ambiguous");
				const fresh = new QuestionArbitrator();
				fresh.update(scope, state(current.request));
				expect(fresh.matches(scope, current.dialogs)[0]!.status).toBe("ambiguous");
			}
		}
		for (const request of [
			{ reqId: 90, kind: "editor" as const, title: "Unrelated editor" },
			{ reqId: 91, kind: "select" as const, title: "Unrelated select", options: ["Yes", "No"] },
		]) expect(matchQuestions(scope, state(request), initial.dialogs)[0]!.status).toBe("ambiguous");
	});

	it("can match a later field only when the native tab actually exposes matching content", () => {
		const second = capture(tabs, "second-tab");
		const checkbox = capture(guest, "checkbox").request!;
		expect(second.dialogs[0]!.formFields).toEqual([{ title: "Platforms to check", kind: "choice", other: true, options: ["macOS", "Windows", "Linux", "Other (type your own)"] }]);
		expect(matchQuestions(scope, state(checkbox), second.dialogs)[0]).toMatchObject({ status: "matched", reqId: checkbox.reqId });
		const arb = new QuestionArbitrator();
		const opened = capture(tabs, "opened");
		arb.update(scope, state(opened.request)); arb.matches(scope, opened.dialogs);
		arb.update(scope, state(checkbox, 2));
		expect(arb.matches(scope, second.dialogs)[0]).toMatchObject({ status: "matched", reqId: checkbox.reqId });
	});

	it("retains single-page color forms through Hide and Show", () => {
		const arb = new QuestionArbitrator();
		const opened = capture(colors, "opened");
		arb.update(scope, state(opened.request));
		expect(arb.matches(scope, opened.dialogs)[0]!.status).toBe("matched");
		expect(askFormPresentation(opened.root)).toMatchObject({ view: "fields" });
		expect(opened.dialogs[0]!.formNavigation).toBeUndefined();
		expect(arb.matches(scope, capture(colors, "hidden").dialogs)[0]!.status).toBe("settling");
		expect(arb.matches(scope, capture(colors, "shown").dialogs)[0]!.status).toBe("matched");
	});

	it("extracts legacy fields recursively without losing labels, preceding text or section titles", () => {
		const original = capture(legacy, legacy.stages[0]!.stage);
		const wrapped = capture(legacy, legacy.stages[0]!.stage);
		for (const section of walkNodes(wrapped.root)) if (section.p?.role === TSP_ROLES.askSection) {
			section.c = [{ id: `${section.id}/layout`, k: "col", c: section.c }];
		}
		expect(askFormPresentation(original.root)).toMatchObject({ view: "fields", body: { id: "o.form" } });
		expect(hookQuestions(wrapped.surfaces, 1)[0]!.formFields).toEqual(original.dialogs[0]!.formFields);
		expect(matchQuestions(scope, state(original.request), hookQuestions(wrapped.surfaces, 1))[0]!.status).toBe("matched");
	});

	it.each(["epoch", "generation", "hostId"] as const)("releases established ownership on %s change", key => {
		const opened = capture(tabs, "opened");
		const review = capture(tabs, "review");
		const arb = new QuestionArbitrator();
		arb.update(scope, state(opened.request)); arb.matches(scope, opened.dialogs);
		const nextScope = { ...scope, [key]: key === "hostId" ? "another-host" : 2 };
		expect(arb.matches(nextScope, review.dialogs)[0]!.status).toBe("unavailable");
		arb.update(nextScope, { ...state(opened.request, 2), ...nextScope });
		expect(arb.matches(nextScope, review.dialogs)[0]!.status).toBe("ambiguous");
	});

	it("releases form continuity on genuine node loss, identity changes and unsupported presentations", () => {
		for (const loss of ["absent", "unsupported", "navigation", "other-node", "other-surface"] as const) {
			const opened = capture(tabs, "opened");
			const arb = new QuestionArbitrator();
			arb.update(scope, state(opened.request)); arb.matches(scope, opened.dialogs);
			const changed = capture(tabs, "review");
			if (loss === "unsupported") changed.root.c = [];
			if (loss === "navigation") for (const node of walkNodes(changed.root)) if (node.k === "tabs") node.p = { ...node.p!, items: [...node.p!.items, { id: "new-field", label: "Another field" }] };
			const dialogs = hookQuestions(changed.surfaces, 1).map(dialog => ({ ...dialog, ...(loss === "other-node" ? { nodeId: "another" } : {}), ...(loss === "other-surface" ? { surfaceId: "another" } : {}) }));
			const result = arb.matches(scope, loss === "absent" ? [] : dialogs);
			expect(result.every(match => match.status !== "settling"), loss).toBe(true);
			expect(arb.matches(scope, capture(tabs, "review").dialogs)[0]!.status, loss).toBe("ambiguous");
		}
	});

	it("does not use disconnected mirrors, duplicates or a hidden ancestor as form identity", () => {
		const opened = capture(tabs, "opened");
		const arb = new QuestionArbitrator();
		arb.update(scope, state(opened.request)); arb.matches(scope, opened.dialogs);
		arb.update(scope, { ...state(opened.request, 2), connected: false });
		expect(arb.matches(scope, capture(tabs, "review").dialogs)[0]!.status).toBe("unavailable");
		expect(matchQuestions(scope, state(opened.request), [...opened.dialogs, { ...opened.dialogs[0]!, nodeId: "duplicate" }]).every(match => match.status === "ambiguous")).toBe(true);
		opened.root.p = { ...opened.root.p, hidden: true };
		expect(hookQuestions(opened.surfaces, 1)).toEqual([]);
		expect(askFormPresentation(opened.root)).toBeNull();
	});

	it("rejects legacy non-HTML asks, unknown roots and malformed Review or Hide shapes", () => {
		const mutations: [string, string, (root: TspNode) => void][] = [
			["opened", "unknown root", root => { root.p = { ...root.p, role: `${TSP_ROLES.editorAsk}.future` }; }],
			["opened", "legacy list", root => { root.c = [{ id: "question", k: "md", p: { text: "Release channel" } }, { id: "options", k: "list", p: { role: TSP_ROLES.askOptions }, c: [{ id: "stable", k: "item", p: { label: "Stable" } }] }]; }],
			["opened", "empty body", root => { const body = askFormPresentation(root)!.body!; body.c = []; }],
			["opened", "duplicate body", root => { root.c = [...root.c!, { ...askFormPresentation(root)!.body!, id: "duplicate" }]; }],
			["review", "missing answers", root => { root.c = root.c!.filter(node => node.p?.role !== TSP_ROLES.askAnswers); }],
			["review", "missing submit", root => { for (const node of walkNodes(root)) node.c = node.c?.filter(child => child.p?.actions?.click !== TSP_ACTIONS.submit); }],
			["review", "invalid tab", root => { for (const node of walkNodes(root)) if (node.k === "tabs") node.p = { ...node.p!, active: "unknown" }; }],
			["review", "duplicate tab", root => { for (const node of walkNodes(root)) if (node.k === "tabs") node.p = { ...node.p!, items: [...node.p!.items, node.p!.items[0]!] }; }],
			["review", "legacy submit tab", root => { for (const node of walkNodes(root)) if (node.k === "tabs") node.p = { ...node.p!, active: "submit", items: node.p!.items.map(item => item.id === "review" ? { ...item, id: "submit" } : item) }; }],
			["hidden", "legacy Skip action", root => { for (const node of walkNodes(root)) if (node.k === "button" && node.p?.actions?.click === TSP_ACTIONS.cancel) node.p = { ...node.p, text: "Skip" }; }],
			["opened", "opaque body", root => { askFormPresentation(root)!.body!.c = [{ id: "future-body", k: "col", p: { role: `${TSP_ROLES.askForm}.future` } }]; }],
			["opened", "unknown field control", root => { for (const node of walkNodes(root)) if (node.p?.role === TSP_ROLES.askField) node.c = [{ id: "future-field", k: "text", p: { role: `${TSP_ROLES.askField}.future`, text: "Unsupported control" } }]; }],
			["hidden", "missing summary", root => { for (const node of walkNodes(root)) node.c = node.c?.filter(child => child.p?.role !== TSP_ROLES.askSummary); }],
			["hidden", "missing show", root => { for (const node of walkNodes(root)) node.c = node.c?.filter(child => child.p?.actions?.click !== TSP_ACTIONS.show); }],
			["hidden", "missing cancel", root => { for (const node of walkNodes(root)) node.c = node.c?.filter(child => child.p?.actions?.click !== TSP_ACTIONS.cancel); }],
		];
		for (const [stage, label, mutate] of mutations) {
			const current = capture(tabs, stage);
			mutate(current.root);
			expect(askFormPresentation(current.root), label).toBeNull();
			expect(isClaimable(current.root), label).toBe(false);
			expect(hookQuestions(current.surfaces, 1), label).toEqual([]);
		}
	});

	it("registers recorded form vocabulary and explicit screen controls", () => {
		for (const role of [TSP_ROLES.askHead, TSP_ROLES.askQuestions, TSP_ROLES.askAnswers, TSP_ROLES.askNotice]) expect(isKnownRole(role)).toBe(true);
		for (const action of [TSP_ACTIONS.next, TSP_ACTIONS.show, TSP_ACTIONS.hide]) {
			expect(isKnownAction(action)).toBe(true);
			expect(TSP_READ_ONLY_ACTIONS[action]).toBeUndefined();
		}
	});
});
