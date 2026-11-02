import { describe, expect, it } from "vitest";
import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import { isClaimable, isClaimed, TSP_PLAN_OPTIONS, TSP_ROLES } from "./roles";
import { planChoice, planReview, projectPlanReview } from "./plan-review";
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
		expect(review.slider).toEqual({ id: "tabs", items: [{ id: "t0", label: "smol" }, { id: "t1", label: "default" }], selected: 1 });
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
});
