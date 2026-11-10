// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "@shared/tsp-host";
import { tspHostPatch, type TspHostPatch } from "@shared/tsp/patch";
import { askFormPresentation } from "@shared/tsp/roles";
import { walkNodes } from "@shared/tsp/view-state";
import { PresentationVisibility, usePresentationClaim, type PresentationTarget } from "../../state/tsp/presentation-claims";
import { usePresentedForm } from "./formPresentation";
import evidence from "../../../../main/omp/tsp/fixtures/18.18.3/ask-html-form.ask.json";

let root: Root;
let element: HTMLDivElement;
let snapshot: TspHostSnapshot;
let target: PresentationTarget;
let generation: number;
let active: boolean;
let available: boolean;
let visible: boolean;
const listeners = new Set<(patch: TspHostPatch) => void>();
const originalVomp = window.vomp;

function Consumer() {
	usePresentationClaim(target, active, available);
	return null;
}
function Observer() {
	const form = usePresentedForm(target.hostId, generation);
	return createElement("output", null, form ?? "absent");
}
async function render() {
	await act(async () => root.render(createElement(PresentationVisibility, { visible }, createElement(Consumer), createElement(Observer))));
}
async function publish(patch: Partial<TspHostSnapshot>) {
	await act(async () => {
		snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
		for (const listener of listeners) listener(tspHostPatch(null, snapshot));
	});
}
const identity = () => element.querySelector("output")!.textContent;

beforeEach(async () => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	listeners.clear(); generation = 1; active = true; available = true; visible = true;
	const hostId = `form-presentation-${crypto.randomUUID()}`;
	const surfaces = (structuredClone(evidence.stages[2]!.surfaces) as unknown as TspSurfaceSnapshot[]).map(surface => ({ ...surface, documentGeneration: 1 }));
	const surface = surfaces.find(surface => [...walkNodes(surface.document)].some(node => askFormPresentation(node)))!;
	const node = [...walkNodes(surface.document)].find(node => askFormPresentation(node))!;
	target = { hostId, epoch: 1, surfaceId: surface.open.id, nodeId: node.id };
	snapshot = { hostId, generation: 1, epoch: 1, revision: 1, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: false, reason: "Question" }, surfaces };
	Object.assign(window, { vomp: { invoke: async (channel: string) => channel === "host:tsp-snapshot" ? snapshot : undefined,
		on: (channel: string, listener: (patch: TspHostPatch) => void) => { if (channel === "host:tsp-patch") listeners.add(listener); return () => listeners.delete(listener); } } });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
	await render();
});
afterEach(async () => {
	await act(async () => root.unmount());
	element.remove(); window.vomp = originalVomp;
});

it("keeps a claimed native form identity after request and tool completion, then releases at native departure", async () => {
	const form = identity();
	expect(form).toBe(JSON.stringify([target.hostId, 1, 1, target.surfaceId, target.nodeId]));
	await publish({ questionMatches: [], availability: { available: true, reason: null } });
	expect(identity()).toBe(form);
	await publish({ surfaces: [] });
	expect(identity()).toBe("absent");
});

it("accepts an available consumer under an omp sheet and releases hidden or unmounted consumers", async () => {
	active = false; await render();
	expect(identity()).not.toBe("absent");
	visible = false; await render();
	expect(identity()).toBe("absent");
	visible = true; available = false; await render();
	expect(identity()).toBe("absent");
});

it.each(["generation", "epoch", "transitioning"] as const)("rejects stale %s presentation despite retained documents and claims", async kind => {
	if (kind === "generation") await publish({ generation: 2 });
	else if (kind === "epoch") await publish({ epoch: 2 });
	else await publish({ lifecycle: "transitioning" });
	expect(identity()).toBe("absent");
});

it("retains real displayed geometry when input closes or an unrelated surface loses its document generation", async () => {
	const before = identity();
	await publish({ closing: true, negotiated: false, documentGeneration: null });
	expect(identity()).toBe(before);
});

it.each(["closed", "suspended", "old-document", "hidden", "unsupported"] as const)("rejects a %s native form while its claim remains registered", async kind => {
	const surfaces = structuredClone(snapshot.surfaces);
	const surface = surfaces.find(surface => surface.open.id === target.surfaceId)!;
	if (kind === "closed") surface.closed = true;
	else if (kind === "suspended") surface.suspended = true;
	else if (kind === "old-document") surface.documentGeneration = 0;
	else {
		const node = [...walkNodes(surface.document)].find(node => node.id === target.nodeId)!;
		if (kind === "hidden") node.p = { ...node.p, hidden: true };
		else node.c = [];
	}
	await publish({ surfaces });
	expect(identity()).toBe("absent");
});

it("requires the observer's generation and the claim's host to match the current document", async () => {
	generation = 2; await render();
	expect(identity()).toBe("absent");
	generation = 1; await render();
	expect(identity()).not.toBe("absent");
	target = { ...target, hostId: "another-host" }; await render();
	expect(identity()).toBe("absent");
});
