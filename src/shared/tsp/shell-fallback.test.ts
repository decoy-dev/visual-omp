import { expect, it } from "vitest";
import type { TspNode } from "../tsp";
import type { TspSurfaceSnapshot } from "../tsp-host";
import type { TspShellProps } from "./shell";
import { mainOutputFingerprint } from "./main-output";
import { isClaimable } from "./roles";
import { unclaimed, walkNodes } from "./view-state";

const props: TspShellProps = { presentation: {
	preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
	rows: [], original: [], output: "", executing: false, watches: [], timeline: { length: 0, cursor: 0, elapsedNs: 0, durationNs: 0 },
} };
function surface(hidden = false): TspSurfaceSnapshot {
	return { open: { id: "surface", mode: "inline" }, sequence: 1, closed: false, suspended: false, focus: null, settled: [], document: {
		id: "surface", k: "col", c: [{ id: "main", k: "col", c: [{ id: "assistant", k: "col", p: { role: "omp.assistant", hidden }, c: [
			{ id: "prose", k: "text", p: { text: "Already in collab" } },
			{ id: "tool", k: "tool", p: { role: "omp.tool.bash", name: "bash", key: "call", title: "Bash", status: "done" }, c: [{ id: "shell", k: "shell", p: props }, { id: "output", k: "code", p: { text: "Already in collab output" } }] },
		] }] }],
	} };
}

it("keeps only an unmatched shell descendant available inside replicated transcript nodes", () => {
	const nodes = unclaimed(surface(), "main");
	expect(nodes.map(node => node.id)).toEqual(["shell"]);
	expect(nodes.some(node => node.k === "code" || node.k === "text")).toBe(false);
});
it("releases exact shell fallback while the native command pane owns it", () => {
	expect(unclaimed(surface(), "main", new Set(["shell"]))).toEqual([]);
});
it("does not hide a different shell node with an unrelated claim", () => {
	expect(unclaimed(surface(), "main", new Set(["other-shell"])).map(node => node.id)).toEqual(["shell"]);
});
it("keeps hidden ancestor shell content out of fallback", () => {
	expect(unclaimed(surface(true), "main")).toEqual([]);
});
it("keeps ordinary replicated command content suppressed on engines without shell nodes", () => {
	const original = surface();
	const document: TspNode = { id: "surface", k: "col", c: [{ id: "main", k: "col", c: [{ id: "old-tool", k: "tool", p: { role: "omp.tool.bash", name: "bash", title: "Bash", status: "done" }, c: [{ id: "old-code", k: "code", p: { text: "printf old-engine" } }] }] }] };
	expect(unclaimed({ ...original, document }, "main")).toEqual([]);
});

it("suppresses owned feedback without hiding an unmatched replicated shell", () => {
	const state = surface();
	const feedback: TspNode = { id: "feedback", k: "text", p: { text: "Command finished" } };
	state.document.c![0]!.c = [feedback, ...state.document.c![0]!.c!];
	const owned = new Map([[feedback.id, mainOutputFingerprint(feedback)!]]);
	expect(unclaimed(state, "main", undefined, owned).map(node => node.id)).toEqual(["shell"]);
	expect(unclaimed(state, "main", new Set(["shell"]), owned)).toEqual([]);
});

it.each(["direct", "replicated"])("retains a newly added %s shell despite a prior feedback fingerprint", kind => {
	const state = surface();
	const group: TspNode = { id: "feedback", k: "col", c: [{ id: "body", k: "text", p: { text: "Command finished" } }] };
	const owned = new Map([[group.id, mainOutputFingerprint(group)!]]);
	const shell: TspNode = { id: "new-shell", k: "shell", p: props };
	group.c = [...group.c!, kind === "direct" ? shell : {
		id: "new-tool", k: "tool", p: { role: "omp.tool.bash", name: "bash", title: "Bash", status: "done" },
		c: [{ id: "replicated-output", k: "text", p: { text: "Already in collab" } }, shell],
	}];
	state.document.c![0]!.c = [group];
	expect(mainOutputFingerprint(group)).toBeNull();
	const projected = unclaimed(state, "main", undefined, owned);
	expect(projected[0]!.c!.map(node => node.id)).toEqual(["body", "new-shell"]);
	expect(unclaimed(state, "main", new Set(["new-shell"]), owned)[0]!.c!.map(node => node.id)).toEqual(["body"]);
});

it("keeps malformed shell data inspectable despite a stale native claim", () => {
	const state = surface();
	const shell = [...walkNodes(state.document)].find(node => node.k === "shell")!;
	Reflect.set(shell, "p", { presentation: {} });
	expect(isClaimable(shell)).toBe(false);
	expect(unclaimed(state, "main", new Set([shell.id])).map(node => node.id)).toEqual([shell.id]);
});

it("never claims or retains a hidden shell", () => {
	const state = surface();
	const shell = [...walkNodes(state.document)].find(node => node.k === "shell")!;
	Reflect.set(shell, "p", { ...props, hidden: true });
	expect(isClaimable(shell)).toBe(false);
	expect(unclaimed(state, "main")).toEqual([]);
});
