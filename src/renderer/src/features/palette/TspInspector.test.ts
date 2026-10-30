// @vitest-environment happy-dom
import type { TspNode } from "@shared/tsp";
import type { TspHostSnapshot } from "@shared/tsp-host";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "../../i18n";
import { TspInspector } from "./TspInspector";

const snapshot = (revision: number, generation = 1, hostId = "host"): TspHostSnapshot => ({
	hostId, generation, revision, negotiated: true, lifecycle: "live", documentGeneration: generation, failure: null,
	surfaces: [{
		documentGeneration: generation,
		open: { id: "surface", mode: "screen", title: `Revision ${revision}`, role: "test", adopt: true },
		sequence: revision, closed: false, focus: "editor", suspended: false, settled: ["root"],
		document: { id: "root", k: "col", c: [{ id: "editor", k: "editor", p: { text: "Draft", sendable: true } }] },
	}],
});

let element: HTMLDivElement;
let root: Root;
let listeners: Set<(value: TspHostSnapshot) => void>;
let requests: PromiseWithResolvers<TspHostSnapshot | null>[];
let calls: string[];
let off: Mock;
const render = async (generation = 1, hostId = "host") => {
	await act(async () => root.render(createElement(TspInspector, { hostId, generation })));
};
const update = async (value: TspHostSnapshot) => {
	await act(async () => { for (const listener of listeners) listener(value); });
};
const reply = async (value: TspHostSnapshot | null, index = 0) => {
	await act(async () => requests[index]!.resolve(value));
};

beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	listeners = new Set(); requests = []; calls = []; off = vi.fn();
	Object.assign(window, { vomp: {
		on: (channel: string, callback: (value: TspHostSnapshot) => void) => {
			calls.push(channel); listeners.add(callback);
			return () => { off(); listeners.delete(callback); };
		},
		invoke: (channel: string) => {
			calls.push(channel);
			const request = Promise.withResolvers<TspHostSnapshot | null>(); requests.push(request);
			return request.promise;
		},
	} });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); });

describe("TSP inspector attachment", () => {
	it("subscribes before requesting the snapshot and keeps a newer event when the snapshot arrives late", async () => {
		await render();
		expect(calls).toEqual(["host:tsp-update", "host:tsp-snapshot"]);
		await update(snapshot(4));
		await reply(snapshot(2));
		expect(element.querySelector("h3")?.textContent).toBe("Revision 4");
	});

	it("ignores another host, another generation, duplicate revisions and older updates", async () => {
		await render(); await reply(snapshot(4));
		await update(snapshot(9, 1, "other"));
		await update(snapshot(9, 2));
		await update({ ...snapshot(4), surfaces: [] });
		await update(snapshot(3));
		expect(element.querySelector("h3")?.textContent).toBe("Revision 4");
		await update(snapshot(5));
		expect(element.querySelector("h3")?.textContent).toBe("Revision 5");
	});

	it("reattaches on restart and ignores both the old listener and its pending snapshot", async () => {
		await render();
		const oldListener = [...listeners][0]!;
		await render(2);
		expect(off).toHaveBeenCalledOnce();
		expect(listeners.size).toBe(1);
		await update(snapshot(8, 1));
		await act(async () => oldListener(snapshot(10, 1)));
		await reply(snapshot(11, 1));
		expect(element.querySelector("h3")).toBeNull();
		await update(snapshot(3, 2));
		await reply(snapshot(1, 2), 1);
		expect(element.querySelector("h3")?.textContent).toBe("Revision 3");
	});

	it("reattaches on host replacement and keeps a new update when the snapshot is absent", async () => {
		await render(); await reply(snapshot(3));
		await render(1, "replacement");
		expect(element.querySelector("h3")).toBeNull();
		await update(snapshot(1, 1, "replacement"));
		await reply(null, 1);
		expect(element.querySelector("h3")?.textContent).toBe("Revision 1");
	});

	it("allows an update to recover a failed snapshot request", async () => {
		await render();
		await act(async () => requests[0]!.reject(new Error("disconnected")));
		expect(element.textContent).toContain("The semantic snapshot could not be loaded.");
		await update(snapshot(1));
		expect(element.querySelector("h3")?.textContent).toBe("Revision 1");
		expect(element.textContent).not.toContain("could not be loaded");
	});
});

describe("TSP inspector lifecycle", () => {
	it.each(["transitioning", "failed", "exited"] as const)("hides retained documents while %s and never labels them current", async lifecycle => {
		await render(); await reply(snapshot(1));
		await update({ ...snapshot(2), lifecycle, failure: lifecycle === "failed" ? "Negotiation rejected by omp" : null });
		expect(element.querySelector("h3")).toBeNull();
		expect(element.textContent).toContain("Retained documents are not current and are hidden.");
		expect(element.textContent).not.toContain("Current semantic documents");
		if (lifecycle !== "transitioning") expect(element.textContent).toContain("relaunch visual-omp without VOMP_TSP");
		if (lifecycle === "failed") expect(element.textContent).toContain("Negotiation rejected by omp");
	});

	it("offers classic relaunch recovery after failed negotiation, then accepts fresh negotiated documents", async () => {
		await render();
		await reply({ ...snapshot(1), negotiated: false, lifecycle: "failed", documentGeneration: null, failure: "Unsupported TSP version" });
		expect(element.textContent).toContain("The semantic preview is unavailable.");
		expect(element.textContent).toContain("Quit and relaunch visual-omp without VOMP_TSP");
		expect(element.querySelector("section")).toBeNull();
		await update(snapshot(2));
		expect(element.querySelector("h3")?.textContent).toBe("Revision 2");
		expect(element.textContent).toContain("Current semantic documents");
		expect(element.textContent).not.toContain("Unsupported TSP version");
	});

	it("does not show documents before negotiation or from a previous document generation", async () => {
		await render();
		await reply({ ...snapshot(1), negotiated: false });
		expect(element.textContent).toContain("Negotiating the semantic preview");
		expect(element.querySelector("section")).toBeNull();
		await update({ ...snapshot(2), documentGeneration: 0 });
		expect(element.querySelector("section")).toBeNull();
		expect(element.textContent).toContain("Retained documents are not current");
	});

	it("does not relabel an old surface when another surface becomes current", async () => {
		const value = snapshot(2);
		value.surfaces.push({ ...value.surfaces[0]!, open: { id: "old-dock", mode: "inline", title: "Old dock" }, documentGeneration: 0 });
		await render(); await reply(value);
		expect(element.querySelectorAll("section")).toHaveLength(1);
		expect(element.textContent).not.toContain("Old dock");
		expect(element.textContent).toContain("Retained documents are not current");
	});
});

it("shows every surface, lifecycle field, node and serialized property as safe read-only text", async () => {
	const value = snapshot(1);
	const props = { html: '<script>alert("test")</script>', nested: { unknown: [1, false, null] }, url: "https://example.com", text: "Original\ntext", disabled: false };
	value.surfaces[0]!.document.c = [{ id: "future-node", k: "future-kind", p: props, c: [{ id: "leaf", k: "text", p: { text: "Leaf text" } }] } as unknown as TspNode];
	value.surfaces.push({ ...value.surfaces[0]!, open: { id: "closed-surface", mode: "inline" }, closed: true, suspended: true, focus: null, settled: [] });
	await render(); await reply(value);
	expect(element.querySelectorAll("section")).toHaveLength(2);
	expect(element.querySelector('[role="region"]')?.getAttribute("tabindex")).toBe("0");
	expect(element.querySelectorAll("ul ul ul").length).toBeGreaterThan(0);
	expect(element.textContent).toContain("future-kind #future-node");
	expect(element.textContent).toContain("text #leaf");
	for (const surface of value.surfaces) {
		expect(element.textContent).toContain(JSON.stringify(surface.open, null, 2));
		expect(element.textContent).toContain(JSON.stringify({ sequence: surface.sequence, focus: surface.focus, suspended: surface.suspended, closed: surface.closed, settled: surface.settled }, null, 2));
	}
	expect(element.textContent).toContain(JSON.stringify(props, null, 2));
	expect(element.querySelector("script, a, input, textarea, button, [contenteditable], .xterm")).toBeNull();
	expect(calls).toEqual(["host:tsp-update", "host:tsp-snapshot"]);
});
