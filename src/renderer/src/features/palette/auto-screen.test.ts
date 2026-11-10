import { describe, expect, it } from "vitest";
import type { TspNode } from "@shared/tsp";
import type { TspSurfaceSnapshot } from "@shared/tsp-host";
import { unclaimedDockPanels } from "@shared/tsp/dock-panels";
import { TSP_ROLES } from "@shared/tsp/roles";
import { ScreenSettle, unpresentedScreenKey } from "./auto-screen";

function dock(node: TspNode): TspSurfaceSnapshot {
	return { open: { id: "s:1", mode: "inline", role: TSP_ROLES.session }, sequence: 1, closed: false, suspended: false, settled: [], focus: null,
		document: { id: "s:1", k: "col", c: [{ id: "dock", k: "col", c: [{ id: "permanent-slot", k: "col", c: [node] }] }] } };
}
const picker: TspNode = { id: "models", k: "picker", p: { title: "Models", items: [{ id: "a", label: "First" }, { id: "b", label: "Second" }], selected: "a" } };

describe("automatic screen continuity", () => {
	it("settles the same candidate without restarting on observations", () => {
		const settle = new ScreenSettle();
		settle.observe("picker", 100);
		expect(settle.remaining("picker", 299)).toBe(101);
		settle.observe("picker", 399); expect(settle.remaining("picker", 400)).toBe(0);
	});
	it("restarts for a replacement and a disappearance skipped by visual batching", () => {
		const settle = new ScreenSettle(); settle.observe("first", 0);
		expect(settle.remaining("second", 200)).toBe(300);
		settle.observe(null, 250); settle.observe("second", 270);
		expect(settle.remaining("second", 500)).toBe(70);
	});
	it("identifies the actual dock picker instead of its permanent slot", () => {
		const surface = dock(structuredClone(picker));
		expect(unclaimedDockPanels([surface], new Map()).map(target => target.node.id)).toEqual(["models"]);
		const before = unpresentedScreenKey([surface], new Map());
		surface.document.c![0]!.c![0]!.c![0]!.id = "replacement";
		expect(unpresentedScreenKey([surface], new Map())).not.toBe(before);
	});
	it("ignores selection, labels, repaint sequences and unrelated progress", () => {
		const surface = dock(structuredClone(picker)); const before = unpresentedScreenKey([surface], new Map());
		surface.sequence++;
		const current = surface.document.c![0]!.c![0]!.c![0]!;
		if (current.k !== "picker") throw new Error("Expected picker");
		current.p = { ...current.p, selected: "b", title: "Models updated" };
		surface.document.c![0]!.c = [...surface.document.c![0]!.c!, { id: "progress", k: "col", p: { role: TSP_ROLES.activity }, c: [{ id: "spinner", k: "spinner" }] }];
		expect(unpresentedScreenKey([surface], new Map())).toBe(before);
	});
	it("never treats an unsupported form as an automatic dock screen", () => {
		const surface = dock({ id: "ask", k: "col", p: { role: TSP_ROLES.editorAsk }, c: [{ id: "unknown-field", k: "button", p: { text: "Unsupported" } }] });
		expect(unpresentedScreenKey([surface], new Map())).toBeNull();
	});
});
