import { describe, expect, it } from "vitest";
import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { isClaimable, isClaimed, TSP_PLAN_OPTIONS, TSP_ROLES } from "./roles";
import { planChoice, planReview, planSavePrompt, planSliderEvent, projectPlanReview } from "./plan-review";
import { openOverlay, unclaimed } from "./view-state";

/** Synthetic document follows v18.15.0 PlanReviewOverlay.describe, including keyed item ids. */
function syntheticPlanReview(): Extract<TspNode, { k: "overlay" }> {
	return { id: "review", k: "overlay", p: { role: TSP_ROLES.planReview, head: "A precise implementation plan" }, c: [
		{ id: "tools", k: "row", p: { role: TSP_ROLES.planTools }, c: [{ id: "cancel", k: "button", p: { text: "Cancel", actions: { click: "cancel" } } }] },
		{ id: "body", k: "col", p: { role: TSP_ROLES.planBody }, c: [{ id: "s0", k: "md", p: { text: "Implement the requested behavior." } }, { id: "s1", k: "md", p: { text: "## Validation\n\n- [ ] Cover the visible result." } }] },
		{ id: "tabs", k: "tabs", p: { role: TSP_ROLES.planStrategy, active: "t1", items: [{ id: "t0", label: "smol" }, { id: "t1", label: "default" }], actions: { click: "select" } } },
		{ id: "options", k: "list", p: { role: TSP_ROLES.planOptions, selected: "o0" }, c: Object.values(TSP_PLAN_OPTIONS).map((label, i) => ({ id: `review/options/o${i}`, k: "item", p: { key: `o${i}`, label, ...(i === 2 ? { disabled: true } : {}) } })) },
	] };
}
function planSurface(node: TspNode = syntheticPlanReview()): TspSurfaceSnapshot {
	return { open: { id: "s:1", mode: "inline", role: TSP_ROLES.session }, sequence: 1, closed: false, suspended: false, settled: [], focus: "options", document: { id: "root", k: "col", c: [{ id: "layer", k: "col", c: [node] }] } };
}
describe("TSP plan review projection", () => {
	it("preserves full Markdown, title, disabled choices and execution tier ids", () => {
		const review = planReview([planSurface()])!;
		expect(review.title).toBe("A precise implementation plan");
		expect(review.body).toBe("Implement the requested behavior.\n\n## Validation\n\n- [ ] Cover the visible result.");
		expect(review.options[0]).toMatchObject({ id: "o0", selected: true, action: "execute" });
		expect(review.slider).toEqual({ id: "tabs", kind: "tabs", items: [{ id: "t0", label: "smol" }, { id: "t1", label: "default" }], selected: 1 });
		expect(planSliderEvent(review, 0)).toEqual({ ev: "select", sf: "s:1", id: "tabs", item: "t0" });
		expect(review.cancelId).toBe("cancel");
		expect(() => planChoice(review, "keep")).toThrow("did not offer");
	});
	it.each(["execute", "compact", "refine", "save"] as const)("activates %s by its upstream option key, without cursor movement", action => {
		const review = planReview([planSurface()])!;
		expect(planChoice(review, action)).toEqual({ ev: "activate", sf: "s:1", id: "options", item: review.options.find(option => option.action === action)!.id });
	});
	it("requires an exact mounted presentation claim and retains physical input ownership", () => {
		const surface = planSurface();
		expect(isClaimable(syntheticPlanReview())).toBe(true);
		expect(isClaimed(syntheticPlanReview())).toBe(false);
		const claimed = new Set(["review"]);
		const claims = new Map([["s:1", claimed]]);
		expect(openOverlay([surface])?.node.id).toBe("review");
		expect(openOverlay([surface], false, claims)).toBeNull();
		expect(openOverlay([surface], true, claims)?.node.id).toBe("review");
		expect(unclaimed(surface, "layer")).toHaveLength(1);
		expect(unclaimed(surface, "layer", claimed)).toEqual([]);
	});
	it("keeps committed compaction visible without offering another decision", () => {
		const node = syntheticPlanReview();
		node.c = node.c!.filter(child => child.id !== "options");
		node.c = [...node.c, { id: "spinner", k: "spinner", p: { label: "Submitting" } }];
		const review = projectPlanReview(node, "s:1")!;
		expect(review.committed).toBe(true);
		expect(isClaimable(node)).toBe(true);
		expect(() => planChoice(review, "execute")).toThrow();
	});
	it("leaves unknown choices unclaimed and ignores retained, hidden and covered overlays", () => {
		const node = syntheticPlanReview();
		const options = node.c!.find(child => child.id === "options")!;
		options.c = [...options.c!, { id: "unknown", k: "item", p: { label: "A new upstream action" } }];
		expect(isClaimed(node)).toBe(false);
		expect(planReview([planSurface(node)])).toBeNull();
		expect(planReview([{ ...planSurface(), closed: true }])).toBeNull();
		expect(planReview([planSurface({ ...syntheticPlanReview(), p: { role: TSP_ROLES.planReview, hidden: true } })])).toBeNull();
		const covered = planSurface(); covered.document.c![0]!.c = [...covered.document.c![0]!.c!, { id: "other", k: "overlay" }];
		expect(planReview([covered])).toBeNull();
	});
	it("leaves upstream's annotation chooser and unfamiliar interactive descendants in the omp screen", () => {
		const node = syntheticPlanReview();
		node.c = [...node.c!, { id: "q.chooserHead", k: "text", p: { spans: [{ t: "Edit annotation", s: "accent strong" }] } },
			{ id: "q.chooser", k: "list", p: { selected: "q.chooser/c0" }, c: [{ id: "q.chooser/c0", k: "item", p: { label: "Add recovery detail", detail: "Implementation · section" } }] }];
		expect(projectPlanReview(node, "s:1")).toBeNull();
		expect(isClaimable(node)).toBe(false);
		expect(unclaimed(planSurface(node), "layer", new Set(["review"]))).toHaveLength(1);
		const other = syntheticPlanReview();
		other.c = [...other.c!, { id: "new-action", k: "button", p: { text: "New action", actions: { click: "save" } } }];
		expect(projectPlanReview(other, "s:1")).toBeNull();
	});
	it("projects omp 19.2 doc and dock layouts with approve menu, tier menu, refine, save and cancel", () => {
		const dockOverlay = (options?: { refine?: boolean; save?: boolean; disabledKeep?: boolean; extraItem?: boolean; feedback?: boolean; chooser?: boolean }): Extract<TspNode, { k: "overlay" }> => ({
			id: "review",
			k: "overlay",
			p: { role: TSP_ROLES.planReview, head: "Plan title from doc" },
			c: [
				{ id: "body", k: "col", p: { role: TSP_ROLES.planBody }, c: [{ id: "doc", k: "doc", p: { role: TSP_ROLES.planDoc, text: "Step one.\n\nStep two." } }] },
				{
					id: "dock",
					k: "row",
					p: { role: TSP_ROLES.planDock },
					c: [
						{
							id: "approve",
							k: "buttons",
							p: { role: TSP_ROLES.planApprove, variant: "split" },
							c: [
								{ id: "main", k: "button", p: { text: options?.refine ? "Refine" : "Approve", actions: { click: options?.refine ? "refine" : "approve" } } },
								{
									id: "more",
									k: "menu",
									p: {
										items: [
											{ id: "execute", label: TSP_PLAN_OPTIONS.execute, detail: "Start fresh with just the plan" },
											{ id: "compact", label: TSP_PLAN_OPTIONS.compact },
											{ id: "keep", label: `${TSP_PLAN_OPTIONS.keep} (~4k / 128k)`, ...(options?.disabledKeep ? { disabled: "Context nearly full" } : {}) },
											...(options?.extraItem ? [{ id: "unknown", label: "Unknown" }] : []),
										],
									},
								},
							],
						},
						{
							id: "model",
							k: "menu",
							p: {
								role: TSP_ROLES.planModel,
								items: [
									{ id: "tier:0", label: "smol", detail: "Claude Haiku", radio: "tier", checked: false },
									{ id: "tier:1", label: "default", detail: "Claude Opus", radio: "tier", checked: true },
								],
							},
						},
						...(options?.save ? [{ id: "save", k: "button" as const, p: { role: "omp.btn", text: "Save", actions: { click: "save" } } }] : []),
						{ id: "cancel", k: "button", p: { role: "omp.btn", text: "Cancel", actions: { click: "cancel" } } },
					],
				},
				...(options?.feedback ? [{ id: "fb", k: "col" as const, p: { role: TSP_ROLES.planFeedback }, c: [{ id: "note", k: "editor" as const, p: { text: "" } }] }] : []),
				...(options?.chooser ? [{ id: "chooser", k: "list" as const, p: { selected: "c0" }, c: [{ id: "c0", k: "item" as const, p: { label: "Edit note" } }] }] : []),
			],
		});

		const base = planReview([planSurface(dockOverlay({ disabledKeep: true, save: true }))])!;
		expect(base.title).toBe("Plan title from doc");
		expect(base.body).toBe("Step one.\n\nStep two.");
		expect(base.optionsId).toBeNull();
		expect(base.cancelId).toBe("cancel");
		expect(base.options.map(option => ({ action: option.action, selected: option.selected, disabled: option.disabled }))).toEqual([
			{ action: "execute", selected: true, disabled: false },
			{ action: "compact", selected: false, disabled: false },
			{ action: "keep", selected: false, disabled: true },
			{ action: "saveCopy", selected: false, disabled: false },
		]);
		expect(base.slider).toEqual({
			id: "model",
			kind: "menu",
			items: [
				{ id: "tier:0", label: "smol", detail: "Claude Haiku" },
				{ id: "tier:1", label: "default", detail: "Claude Opus" },
			],
			selected: 1,
		});
		expect(planChoice(base, "execute")).toEqual({ ev: "action", sf: "s:1", id: "more", act: "execute" });
		expect(planChoice(base, "compact")).toEqual({ ev: "action", sf: "s:1", id: "more", act: "compact" });
		expect(() => planChoice(base, "keep")).toThrow("did not offer");
		expect(planChoice(base, "saveCopy")).toEqual({ ev: "action", sf: "s:1", id: "save", act: "save" });
		expect(planSliderEvent(base, 0)).toEqual({ ev: "action", sf: "s:1", id: "model", act: "tier:0", checked: true });
		expect(isClaimable(dockOverlay({ save: true }))).toBe(true);

		const withRefine = projectPlanReview(dockOverlay({ refine: true }), "s:1")!;
		expect(planChoice(withRefine, "refine")).toEqual({ ev: "action", sf: "s:1", id: "main", act: "refine" });

		const committedNode: Extract<TspNode, { k: "overlay" }> = {
			id: "review",
			k: "overlay",
			p: { role: TSP_ROLES.planReview, head: "Committed plan" },
			c: [
				{ id: "body", k: "col", p: { role: TSP_ROLES.planBody }, c: [{ id: "doc", k: "doc", p: { role: TSP_ROLES.planDoc, text: "Step one." } }] },
				{ id: "spin", k: "spinner", p: { label: "Submitting" } },
			],
		};
		const committed = projectPlanReview(committedNode, "s:1")!;
		expect(committed.committed).toBe(true);
		expect(() => planSliderEvent(committed, 0)).toThrow();

		expect(projectPlanReview(dockOverlay({ extraItem: true }), "s:1")).toBeNull();
		expect(projectPlanReview(dockOverlay({ feedback: true }), "s:1")).toBeNull();
		expect(projectPlanReview(dockOverlay({ chooser: true }), "s:1")).toBeNull();
		const disabledMenu = dockOverlay();
		(disabledMenu.c![1]!.c![1] as Extract<TspNode, { k: "menu" }>).p!.disabled = true;
		expect(projectPlanReview(disabledMenu, "s:1")).toBeNull();
	});
});

/** Synthetic document follows the omp 18.22.0 Save plan prompt recorded in fixtures/18.22.0/plan-review-save. */
function syntheticSavePrompt(): Extract<TspNode, { k: "overlay" }> {
	return { id: "save", k: "overlay", p: { role: TSP_ROLES.planSave, head: "Save plan", modal: true }, c: [
		{ id: "path", k: "input", p: { text: "", prompt: "Path: ", sendable: false } },
		{ id: "hint", k: "text", p: { spans: [{ t: "Empty saves to " }, { t: "PLAN.md", s: "path" }] } },
		{ id: "save/cancel", k: "button", p: { text: "Cancel", actions: { click: "cancel" } } },
		{ id: "save/save", k: "button", p: { text: "Save", actions: { click: "save" } } },
	] };
}
function saveSurface(...nodes: TspNode[]): TspSurfaceSnapshot {
	const surface = planSurface();
	return { ...surface, document: { id: "root", k: "col", c: [{ id: "layer", k: "col", c: nodes }] } };
}
describe("TSP plan save prompt projection", () => {
	it("pairs omp's Save plan prompt with the review directly below it and claims it", () => {
		const prompt = planSavePrompt([saveSurface(syntheticPlanReview(), syntheticSavePrompt())])!;
		expect(prompt.review.title).toBe("A precise implementation plan");
		expect(prompt.save).toEqual({ sf: "s:1", id: "save", inputId: "path", text: "", defaultPath: "PLAN.md", saveId: "save/save", cancelId: "save/cancel" });
		expect(planReview([saveSurface(syntheticPlanReview(), syntheticSavePrompt())])).toBeNull();
		expect(isClaimable(syntheticSavePrompt())).toBe(true);
	});
	it("leaves other prompt shapes and prompts without a review below to the omp screen", () => {
		expect(planSavePrompt([saveSurface(syntheticSavePrompt())])).toBeNull();
		const extra = syntheticSavePrompt();
		extra.c = [...extra.c!, { id: "save/browse", k: "button", p: { text: "Browse", actions: { click: "browse" } } }];
		expect(planSavePrompt([saveSurface(syntheticPlanReview(), extra)])).toBeNull();
		expect(isClaimable(extra)).toBe(false);
	});
});
