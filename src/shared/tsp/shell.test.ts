import { describe, expect, it } from "vitest";
import type { TspNode } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { isClaimable, isClaimed, isKnownAction } from "./roles";
import { isShellAction, projectShell, shellPresentation, shellProps, type ShellVizPresentation } from "./shell";

function presentation(): ShellVizPresentation {
	return {
		preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
		rows: [{ id: "row:0", depth: 0, node: "opaque:node:1", state: "ok", segments: [{ text: "echo café", node: "opaque:node:1", range: [0, 9], executionNode: "opaque:execution:1", executionSeq: 2, executedAtNs: 42 }], effects: [],
			annotations: [{ name: "name", value: "café", node: "opaque:setter:1", scopeId: "scope:0", fullLength: 5, setterSeq: 1 }] }],
		original: [], output: "café\n", executing: false,
		watches: [{ name: "name", value: "café", node: "opaque:setter:1" }], timeline: { length: 10, cursor: 10, elapsedNs: 42, durationNs: 42 },
	};
}
function tool(call = "call:a", id = "a"): TspNode {
	return { id: `tool:${id}`, k: "tool", p: { role: "omp.tool.bash", key: call, name: "bash", title: "Bash", status: "done", command: "echo café" }, c: [
		{ id: `shell:${id}`, k: "shell", p: { key: "input", presentation: presentation() } },
	] };
}
function snapshot(nodes: TspNode[] = [tool()]): TspHostSnapshot {
	return { hostId: "host", generation: 3, epoch: 7, revision: 1, availability: { available: true, reason: null }, negotiated: true,
		lifecycle: "live", documentGeneration: 3, failure: null,
		surfaces: [{ open: { id: "surface", mode: "inline", role: "omp.session" }, sequence: 1, closed: false, suspended: false, settled: [], focus: null,
			documentGeneration: 3, document: { id: "surface", k: "col", c: [{ id: "main", k: "col", c: nodes }] } }] };
}

describe("shell presentation validation", () => {
	it("returns canonical data unchanged and reuses validation of immutable presentations", () => {
		const value = presentation();
		expect(shellPresentation(value)).toBe(value);
		expect(shellPresentation(value)).toBe(value);
		expect(shellProps({ presentation: value, inspector: true, liveOrigin: false, replayEpoch: 0, cwd: "/tmp", lang: "bash", preview: { lines: 4 } })).toMatchObject({ presentation: value });
	});

	it.each([
		["preferences.view", ["raw"]], ["preferences.layers.color", "true"], ["preferences.split", 1], ["preferences.playing", null],
		["preferences.speed", 3], ["preferences.cursor", 11], ["preferences.selectedNode", ""], ["preferences.expandedNodes", ["x", "x"]],
		["timeline.length", -1], ["timeline.cursor", 11], ["timeline.elapsedNs", Infinity], ["timeline.durationNs", -1], ["timeline.trimmed", 1],
		["running", "true"], ["executing", null], ["message", []], ["output", {}],
		["rows.0.id", ""], ["rows.0.depth", 0.5], ["rows.0.node", "\n"], ["rows.0.range", [4, 2]], ["rows.0.active", 1],
		["rows.0.role", "unknown"], ["rows.0.state", "done"], ["rows.0.executionSeq", -1], ["rows.0.executedAtNs", NaN],
		["rows.0.meta", false], ["rows.0.detail", []], ["rows.0.effects", [{ kind: ["network"], glyph: "!", label: "Network", why: "Reported" }]],
		["rows.0.annotations.0.fullLength", -1], ["rows.0.annotations.0.scope", 3], ["rows.0.annotations.0.scopeId", ""],
		["rows.0.annotations.0.setterSeq", 1.5], ["rows.0.annotations.0.value", null], ["rows.0.annotations.0.range", [0, Infinity]],
		["rows.0.segments.0.active", "yes"], ["rows.0.segments.0.state", "done"], ["rows.0.segments.0.executionNode", ""],
		["rows.0.segments.0.style", []], ["rows.0.segments.0.tip", {}], ["rows.0.segments.0.expanded", 1], ["rows.0.segments.0.language", true],
	] as const)("rejects malformed %s", (path, value) => {
		const input = presentation();
		const parts = path.split(".");
		let parent: Record<string, unknown> = input as unknown as Record<string, unknown>;
		for (const part of parts.slice(0, -1)) parent = parent[part] as Record<string, unknown>;
		parent[parts.at(-1)!] = value;
		expect(shellPresentation(input)).toBeNull();
	});

	it.each([
		{ inspector: 1 }, { liveOrigin: "yes" }, { replayEpoch: -1 }, { replayEpoch: Infinity }, { cwd: [] }, { lang: "sh" }, { preview: { lines: 0 } }, { preview: { lines: 1.5 } },
	])("rejects malformed shell props %j", invalid => {
		expect(shellProps({ presentation: presentation(), ...invalid })).toBeNull();
	});

	it("bounds UTF-8 row text across segments and annotation values", () => {
		const exact = presentation(); exact.rows[0]!.segments = [{ text: "é".repeat(32 * 1024) }];
		expect(shellPresentation(exact)).toBe(exact);
		const oversized = structuredClone(exact); oversized.rows[0]!.segments.push({ text: "a" });
		expect(shellPresentation(oversized)).toBeNull();
		const value = presentation(); value.rows[0]!.annotations![0]!.value = "é".repeat(8 * 1024);
		expect(shellPresentation(value)).toBe(value);
		const longValue = structuredClone(value); longValue.rows[0]!.annotations![0]!.value += "a";
		expect(shellPresentation(longValue)).toBeNull();
		const detail = presentation(); detail.rows[0]!.detail = "x".repeat(16 * 1024 + 1);
		expect(shellPresentation(detail)).toBeNull();
	});

	it("bounds row and total segment counts across both panes", () => {
		const exact = presentation(); exact.rows[0]!.segments = Array.from({ length: 1024 }, () => ({ text: "" }));
		expect(shellPresentation(exact)).toBe(exact);
		const tooMany = structuredClone(exact); tooMany.rows[0]!.segments.push({ text: "" });
		expect(shellPresentation(tooMany)).toBeNull();
		const total = presentation(); total.rows = Array.from({ length: 48 }, (_, id) => ({ id: String(id), depth: 0, segments: exact.rows[0]!.segments, effects: [] }));
		total.original = [{ id: "original", depth: 0, segments: Array.from({ length: 848 }, () => ({ text: "" })), effects: [] }];
		expect(shellPresentation(total)).toBe(total);
		const overflow = structuredClone(total); overflow.original[0]!.segments.push({ text: "" });
		expect(shellPresentation(overflow)).toBeNull();
	});

	it("counts the entire serialized response with UTF-8 and JSON escaping", () => {
		const exact = presentation();
		const budget = 2 * 1024 * 1024 - new TextEncoder().encode(JSON.stringify(exact)).length;
		exact.output += "x".repeat(budget);
		expect(shellPresentation(exact)).toBe(exact);
		const overflow = structuredClone(exact); overflow.output += "é";
		expect(shellPresentation(overflow)).toBeNull();
		const escaped = presentation(); escaped.output = "\u0000".repeat(350_000);
		expect(shellPresentation(escaped)).toBeNull();
		const future = { ...presentation(), future: "x".repeat(2 * 1024 * 1024) };
		expect(shellPresentation(future)).toBeNull();
	});

	it("rejects duplicate row identities, malformed panes and cyclic future fields", () => {
		const duplicate = presentation(); duplicate.rows.push(structuredClone(duplicate.rows[0]!));
		expect(shellPresentation(duplicate)).toBeNull();
		expect(shellPresentation({ ...presentation(), original: null })).toBeNull();
		const cyclic = { ...presentation(), future: {} as unknown }; cyclic.future = cyclic;
		expect(shellPresentation(cyclic)).toBeNull();
	});
});

describe("live shell projection", () => {
	it("matches only the ancestor call key and keeps identical parallel commands distinct after reorder", () => {
		const first = tool("call:a", "a"), second = tool("call:b", "b");
		const state = snapshot([first, second]);
		expect(projectShell(state, "host", 3, "call:a")).toMatchObject({ hostId: "host", generation: 3, epoch: 7, surfaceId: "surface", nodeId: "shell:a", toolCallId: "call:a" });
		expect(projectShell(state, "host", 3, "call:b")?.nodeId).toBe("shell:b");
		expect(projectShell(state, "host", 3, "input")).toBeNull();
		expect(projectShell(state, "host", 3, "echo café")).toBeNull();
		expect(projectShell(state, "host", 3, "call:a")).toBe(projectShell(state, "host", 3, "call:a"));
		const reordered = snapshot([second, first]);
		expect(projectShell(reordered, "host", 3, "call:a")?.nodeId).toBe("shell:a");
	});

	it("supports card ancestors, nested shell children and TSP arriving before its consumer", () => {
		const source = tool();
		const card: TspNode = { id: "card", k: "card", p: { role: "omp.tool.bash", key: "call:a" }, c: [{ id: "body", k: "col", c: source.c }] };
		const state = snapshot([card]);
		expect(projectShell(state, "host", 3, "missing")).toBeNull();
		expect(projectShell(state, "host", 3, "call:a")?.nodeId).toBe("shell:a");
		expect(projectShell(null, "host", 3, "call:a")).toBeNull();
	});

	it("refuses ambiguity across surfaces and malformed duplicate children", () => {
		const state = snapshot([tool(), tool("call:a", "duplicate")]);
		expect(projectShell(state, "host", 3, "call:a")).toBeNull();
		const crossSurface = snapshot(); crossSurface.surfaces.push({ ...structuredClone(crossSurface.surfaces[0]!), open: { id: "second", mode: "inline" } });
		expect(projectShell(crossSurface, "host", 3, "call:a")).toBeNull();
		const malformed = tool("call:a", "bad"); Reflect.set(malformed.c![0]!, "p", { presentation: {} });
		expect(projectShell(snapshot([malformed, tool()]), "host", 3, "call:a")).toBeNull();
	});

	it.each(["host", "generation", "documentGeneration", "epoch", "lifecycle", "closing", "negotiated", "surfaceGeneration", "closed", "suspended", "hidden"])("rejects unavailable %s", field => {
		const state = snapshot();
		switch (field) {
			case "host": state.hostId = "other"; break;
			case "generation": state.generation = 4; break;
			case "documentGeneration": state.documentGeneration = 2; break;
			case "epoch": state.epoch = 0; break;
			case "lifecycle": state.lifecycle = "transitioning"; break;
			case "closing": state.closing = true; break;
			case "negotiated": state.negotiated = false; break;
			case "surfaceGeneration": state.surfaces[0]!.documentGeneration = 2; break;
			case "closed": state.surfaces[0]!.closed = true; break;
			case "suspended": state.surfaces[0]!.suspended = true; break;
			case "hidden": state.surfaces[0]!.document.p = { hidden: true }; break;
		}
		expect(projectShell(state, "host", 3, "call:a")).toBeNull();
	});

	it("keeps inspector-only, wrong-ancestor and older-engine code nodes outside transcript projection", () => {
		const inspector: TspNode = { id: "inspector", k: "shell", p: { inspector: true, presentation: presentation() } };
		expect(projectShell(snapshot([inspector]), "host", 3, "call:a")).toBeNull();
		const wrong = tool(); wrong.p = { ...wrong.p, role: "omp.tool.python" };
		expect(projectShell(snapshot([wrong]), "host", 3, "call:a")).toBeNull();
		const old = tool(); old.c = [{ id: "input", k: "code", p: { text: "echo café", lang: "bash" } }];
		expect(projectShell(snapshot([old]), "host", 3, "call:a")).toBeNull();
		expect(isClaimable(old)).toBe(false);
		expect(isClaimable(inspector)).toBe(true);
		expect(isClaimed(inspector)).toBe(false);
		expect(isKnownAction("shell-viz")).toBe(true);
	});
});

describe("canonical shell action vocabulary", () => {
	it.each(["view:raw", "view:pseudo", "layer:color", "layer:inline", "layer:idioms", "layer:effects", "layer:unwrap", "split", "inspect", "play", "pause", "step", "reset", "live", "seek:0", "seek:10", "speed:0.5", "speed:1", "speed:2", "speed:4", "select:opaque:node:1", "expand:opaque:execution:1", "select:opaque:setter:1"])("accepts %s", action => {
		expect(isShellAction(presentation(), action)).toBe(true);
	});
	it.each([undefined, "", "view:python", "layer:syntax", "seek:-1", "seek:11", "seek:1.5", "seek:01", "seek:1e1", "seek:Infinity", "seek:9007199254740992", "speed:3", "speed:1.0", "select:row:0", "expand:unknown", "select:", "play:now"])("rejects %s", action => {
		expect(isShellAction(presentation(), action)).toBe(false);
	});
});
