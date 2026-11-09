import { describe, expect, it } from "vitest";
import { hookQuestions, matchQuestions, type CollabQuestion } from "./question-match";
import { QuestionArbitrator } from "./question-arbitrator";
import { isClaimable } from "./roles";
import { unclaimed, walkNodes } from "./view-state";
import type { TspSurfaceSnapshot } from "../tsp-host";
import evidence from "../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";
import { TSP_ROLES } from "./roles";

const scope = { hostId: "ask-form", generation: 1, epoch: 1 };
describe("recorded 18.18.3 form arbitration", () => {
	it("keeps every sequential guest request on one form and suppresses it only with a claim", () => {
		const arbitrator = new QuestionArbitrator();
		let revision = 0;
		for (const stage of evidence.stages) {
			const surfaces = stage.surfaces as unknown as TspSurfaceSnapshot[];
			const dialogs = hookQuestions(surfaces, 1);
			const requests = stage.request ? [stage.request as CollabQuestion] : [];
			arbitrator.update(scope, { ...scope, connection: 1, revision: ++revision, connected: true, requests });
			if (!stage.request) { expect(dialogs).toEqual([]); continue; }
			expect(dialogs, stage.stage).toHaveLength(1);
			expect(arbitrator.matches(scope, dialogs), stage.stage).toMatchObject([{ status: "matched", reqId: stage.request.reqId }]);
			const dialog = dialogs[0]!;
			const surface = surfaces.find(surface => surface.open.id === dialog.surfaceId)!;
			const root = [...walkNodes(surface.document)].find(node => node.id === dialog.nodeId)!;
			expect(isClaimable(root, surface)).toBe(true);
			expect(unclaimed(surface, "dock").flatMap(node => [...walkNodes(node)]).some(node => node.id === dialog.nodeId)).toBe(true);
			expect(unclaimed(surface, "dock", new Set([dialog.nodeId])).flatMap(node => [...walkNodes(node)]).some(node => node.id === dialog.nodeId)).toBe(false);
			expect(() => arbitrator.answer(scope, dialogs, dialog.surfaceId, dialog.nodeId)).toThrow();
		}
	});
	it("does not claim a same-title editor for a choice field without Other", () => {
		const surfaces = structuredClone(evidence.stages[0]!.surfaces) as unknown as TspSurfaceSnapshot[];
		for (const surface of surfaces) for (const node of walkNodes(surface.document)) {
			if (node.p?.role === TSP_ROLES.askSection) {
				let choices = 0;
				node.c = node.c?.filter(child => child.p?.role !== TSP_ROLES.askField || choices++ === 0);
			}
			if (node.k === "list") node.c = node.c?.filter(child => !child.id.endsWith("/other"));
		}
		const dialogs = hookQuestions(surfaces, 1);
		expect(dialogs[0]?.formFields).toEqual([{ title: "Choose the release settings.", kind: "choice", other: false, options: ["Stable", "Preview"] }]);
		const state = { ...scope, connection: 1, revision: 1, connected: true, requests: [{ reqId: 42, kind: "editor" as const, title: "Choose the release settings." }] };
		expect(matchQuestions(scope, state, dialogs)[0]?.status).toBe("ambiguous");
		expect(matchQuestions(scope, { ...state, requests: [{ reqId: 43, kind: "select", title: "Choose the release settings.", options: ["Stable", "Preview"] }] }, dialogs)[0]?.status).toBe("matched");
	});
	it("does not invent ownership for another request, duplicate forms or disconnected mirrors", () => {
		const stage = evidence.stages[0]!;
		const dialogs = hookQuestions(stage.surfaces as unknown as TspSurfaceSnapshot[], 1);
		const state = { ...scope, connection: 1, revision: 1, connected: true, requests: [stage.request as CollabQuestion] };
		expect(matchQuestions(scope, { ...state, requests: [{ reqId: 42, kind: "editor", title: "Unrelated" }] }, dialogs)[0]?.status).toBe("ambiguous");
		expect(matchQuestions(scope, state, [...dialogs, { ...dialogs[0]!, nodeId: "duplicate" }]).every(match => match.status === "ambiguous")).toBe(true);
		expect(matchQuestions(scope, { ...state, connected: false }, dialogs)[0]?.status).toBe("unavailable");
	});
});
