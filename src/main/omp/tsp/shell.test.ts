import { describe, expect, it } from "vitest";
import type { TspNode, TspOp } from "../../../shared/tsp";
import { projectShell, type ShellVizPresentation } from "../../../shared/tsp/shell";
import { diffTspDocument } from "../../../shared/tsp/patch";
import { walkNodes } from "../../../shared/tsp/view-state";
import { TspSession } from "./session";
import { TspStream } from "./stream";

function presentation(): ShellVizPresentation {
	return { preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
		rows: [{ id: "row", depth: 0, node: "opaque:node:1", segments: [{ text: "echo hello", node: "opaque:node:1" }], effects: [] }],
		original: [], output: "hello\n", executing: false, watches: [], timeline: { length: 10, cursor: 10, elapsedNs: 42, durationNs: 42 } };
}
function harness(write?: (data: string) => void | Promise<void>) {
	const bodies: Record<string, unknown>[] = [];
	const output = new TspStream({ onMessage: message => bodies.push(JSON.parse(message.body)), onData: () => {} });
	const session = new TspSession({ cols: 100, dark: false, reduceMotion: false, write: async data => { output.push(Buffer.from(data)); await write?.(data); } });
	const receive = (verb: string, body: unknown) => session.receive({ verb, body: JSON.stringify(body), params: {} });
	let sequence = 0;
	const frame = (ops: TspOp[]) => receive("f", { sf: "s", s: ++sequence, ops });
	const shell: TspNode = { id: "shell", k: "shell", p: { presentation: presentation(), key: "input" } };
	const tool: TspNode = { id: "tool", k: "tool", p: { role: "omp.tool.bash", key: "call:a", name: "bash", title: "Bash", status: "done" }, c: [shell] };
	receive("q", { q: "hello", v: [1], features: ["edit", "send", "undo"] });
	receive("o", { id: "s", mode: "inline", role: "omp.session" });
	frame([["add", "main", "s", null, { id: "main", k: "col", c: [tool] }], ["add", "layer", "s", null, { id: "layer", k: "col" }]]);
	const action = (value: string, id = "shell") => ({ ev: "action" as const, sf: "s", id, act: "shell-viz", value });
	return { session, receive, frame, bodies, action };
}

describe("shell visualization dispatch", () => {
	it("dispatches canonical actions to their exact current shell target", async () => {
		const h = harness(); await h.session.drain();
		for (const value of ["view:raw", "view:pseudo", "layer:color", "layer:inline", "layer:idioms", "layer:effects", "layer:unwrap", "split", "inspect", "play", "pause", "step", "reset", "live", "seek:0", "seek:10", "speed:0.5", "speed:1", "speed:2", "speed:4", "select:opaque:node:1", "expand:opaque:node:1"]) {
			await h.session.send(h.action(value));
			expect(h.bodies.at(-1)).toEqual(h.action(value));
		}
	});

	it.each(["view:other", "layer:unknown", "seek:-1", "seek:11", "seek:1.5", "seek:1e1", "seek:9007199254740992", "speed:3", "speed:NaN", "select:unknown", "expand:unknown", "select:row", "select:", "run", ""])("rejects unsupported action %s without writing", async value => {
		const h = harness(); await h.session.drain();
		const before = h.bodies.length;
		await expect(h.session.send(h.action(value))).rejects.toThrow("shell visualization action");
		expect(h.bodies).toHaveLength(before);
	});

	it("guards alternate change and select routes using omp's canonical mapping", async () => {
		const h = harness(); await h.session.drain();
		for (const event of [
			{ ev: "select", sf: "s", id: "shell", item: "opaque:node:1" },
			{ ev: "select", sf: "s", id: "shell", item: "select:opaque:node:1" },
			{ ev: "change", sf: "s", id: "shell", item: "select", value: "opaque:node:1" },
			{ ev: "change", sf: "s", id: "shell", item: "expand", value: "opaque:node:1" },
			{ ev: "change", sf: "s", id: "shell", item: "view", value: "raw" },
			{ ev: "change", sf: "s", id: "shell", item: "view:raw", value: true },
			{ ev: "change", sf: "s", id: "shell", item: "split", value: true },
			{ ev: "change", sf: "s", id: "shell", item: "split", value: false },
			{ ev: "change", sf: "s", id: "shell", item: "layer:color", value: false },
			{ ev: "change", sf: "s", id: "shell", item: "effects", value: true },
			{ ev: "change", sf: "s", id: "shell", item: "cursor", value: 2 },
			{ ev: "change", sf: "s", id: "shell", item: "seek", value: 0 },
			{ ev: "change", sf: "s", id: "shell", item: "speed", value: 0.5 },
			{ ev: "change", sf: "s", id: "shell", item: "shell-viz", value: "play" },
		]) {
			await h.session.send(event);
			expect(h.bodies.at(-1)).toEqual(event);
		}
		const before = h.bodies.length;
		for (const event of [
			{ ev: "select", sf: "s", id: "shell", item: "unknown" },
			{ ev: "change", sf: "s", id: "shell", item: "select", value: "unknown" },
			{ ev: "change", sf: "s", id: "shell", item: "expand", value: "unknown" },
			{ ev: "change", sf: "s", id: "shell", item: "cursor", value: -1 },
			{ ev: "change", sf: "s", id: "shell", item: "seek", value: 11 },
			{ ev: "change", sf: "s", id: "shell", item: "speed", value: 3 },
			{ ev: "change", sf: "s", id: "shell", item: "shell-viz", value: "select:missing" },
			{ ev: "change", sf: "s", id: "shell", item: "anything", value: "seek:999" },
			{ ev: "change", sf: "s", id: "shell", item: "view:other", value: true },
		]) await expect(h.session.send(event)).rejects.toThrow("shell visualization action");
		expect(h.bodies).toHaveLength(before);
	});

	it("rejects wrong targets, missing values and unavailable presentations", async () => {
		const h = harness(); await h.session.drain();
		await expect(h.session.send(h.action("play", "tool"))).rejects.toThrow("shell visualization is no longer available");
		await expect(h.session.send(h.action("play", "missing"))).rejects.toThrow("target node");
		await expect(h.session.send({ ev: "action", sf: "s", id: "shell", act: "shell-viz" })).rejects.toThrow("shell visualization action");
		h.frame([["set", "shell", { presentation: {} }]]); await h.session.drain();
		const before = h.bodies.length;
		await expect(h.session.send(h.action("play"))).rejects.toThrow("shell visualization is no longer available");
		await expect(h.session.send({ ev: "select", sf: "s", id: "shell", item: "opaque:node:1" })).rejects.toThrow("shell visualization is no longer available");
		expect(h.bodies).toHaveLength(before);
	});

	it("refuses oversized presentations before any live action", async () => {
		const h = harness();
		const oversized = presentation(); oversized.rows[0]!.segments[0]!.text = "é".repeat(32 * 1024 + 1);
		h.frame([["set", "shell", { presentation: oversized }]]); await h.session.drain();
		const before = h.bodies.length;
		await expect(h.session.send(h.action("view:raw"))).rejects.toThrow("shell visualization is no longer available");
		expect(h.bodies).toHaveLength(before);
	});

	it.each(["shell", "tool", "main"])("rejects hidden %s at dispatch time", async id => {
		const h = harness(); h.frame([["set", id, { hidden: true }]]); await h.session.drain();
		const before = h.bodies.length;
		await expect(h.session.send(h.action("play"))).rejects.toThrow("shell visualization is no longer available");
		await expect(h.session.send({ ev: "change", sf: "s", id: "shell", item: "speed", value: 1 })).rejects.toThrow("shell visualization is no longer available");
		expect(h.bodies).toHaveLength(before);
	});

	it("requires a bash tool/card ancestor or an explicit inspector on its own overlay", async () => {
		const h = harness();
		h.frame([["move", "shell", "main", null]]); await h.session.drain();
		await expect(h.session.send(h.action("play"))).rejects.toThrow("shell visualization is no longer available");
		h.frame([["set", "shell", { inspector: true }]]); await h.session.drain();
		await expect(h.session.send(h.action("play"))).rejects.toThrow("shell visualization is no longer available");
		h.frame([["move", "shell", "layer", null]]); await h.session.drain();
		await h.session.send(h.action("seek:5"));
		expect(h.bodies.at(-1)).toEqual(h.action("seek:5"));
	});

	it.each(["role", "key", "kind"])("rejects a changed ancestor %s", async field => {
		const h = harness();
		if (field === "role") h.frame([["set", "tool", { role: "omp.tool.python" }]]);
		if (field === "key") h.frame([["set", "tool", { key: "" }]]);
		if (field === "kind") h.frame([["move", "shell", "main", null], ["del", "tool"], ["add", "tool", "main", null, { id: "tool", k: "col", p: { role: "omp.tool.bash", key: "call:a" } }], ["move", "shell", "tool", null]]);
		await h.session.drain();
		await expect(h.session.send(h.action("play"))).rejects.toThrow("shell visualization is no longer available");
	});

	it("rechecks the queued target against the current document", async () => {
		const gate = Promise.withResolvers<void>(); let blocked = false;
		const h = harness(async () => { if (blocked) { blocked = false; await gate.promise; } });
		await h.session.drain(); blocked = true;
		const earlier = h.session.send({ ev: "visible", sf: "s", visible: true });
		const stale = h.session.send(h.action("select:opaque:node:1"));
		const replacement = presentation(); replacement.rows[0]!.node = "opaque:node:2"; replacement.rows[0]!.segments[0]!.node = "opaque:node:2";
		h.frame([["set", "shell", { presentation: replacement }]]);
		gate.resolve(); await earlier;
		await expect(stale).rejects.toThrow("shell visualization action");
	});

	it("preserves host generation, lifecycle and read-only guards supplied at dispatch", async () => {
		const h = harness(); await h.session.drain();
		for (const reason of ["generation changed", "host is transitioning", "read-only host"]) {
			await expect(h.session.send(h.action("play"), () => { throw new Error(reason); })).rejects.toThrow(reason);
		}
		h.frame([["suspend"]]); await h.session.drain();
		await expect(h.session.send(h.action("play"))).rejects.toThrow("target surface");
		h.frame([["resume"]]); await h.session.drain();
		h.receive("x", { id: "s", keep: true });
		await expect(h.session.send(h.action("play"))).rejects.toThrow("target surface");
	});
	it.each(["node", "surface"])("rejects queued actions after replacing the %s with reused ids", async replacement => {
		const h = harness(); await h.session.drain();
		const stale = h.session.send(h.action("play"));
		if (replacement === "surface") {
			h.receive("o", { id: "s", mode: "inline", role: "omp.session" });
			h.frame([["add", "main", "s", null, { id: "main", k: "col", c: [
				{ id: "tool", k: "card", p: { role: "omp.tool.bash", key: "call:a" }, c: [
					{ id: "shell", k: "shell", p: { presentation: presentation() } },
				] },
			] }]]);
		} else h.frame([["del", "shell"], ["add", "shell", "tool", null, { id: "shell", k: "shell", p: { presentation: presentation() } }]]);
		await expect(stale).rejects.toThrow("original shell visualization changed");
	});


	it("rejects queued actions from a previous protocol epoch", async () => {
		const h = harness(); await h.session.drain();
		const stale = h.session.send(h.action("play"));
		h.receive("q", { q: "hello", v: [1] });
		await expect(stale).rejects.toThrow("semantic screen restarted");
	});

	it("keeps old-engine code fallback and unrelated input behavior unchanged", async () => {
		const h = harness();
		h.frame([["del", "shell"], ["add", "input", "tool", null, { id: "input", k: "code", p: { text: "echo hello", lang: "bash" } }],
			["add", "choices", "main", null, { id: "choices", k: "list", c: [{ id: "choice", k: "item", p: { label: "Choice" } }] }]]);
		await h.session.drain();
		await h.session.send({ ev: "select", sf: "s", id: "choices", item: "choice" });
		expect(h.bodies.at(-1)).toEqual({ ev: "select", sf: "s", id: "choices", item: "choice" });
		await expect(h.session.send(h.action("play", "input"))).rejects.toThrow("shell visualization is no longer available");
	});
});

describe("shell publication limits", () => {
	it("preserves refused shell identity so a duplicate never becomes an unambiguous match", async () => {
		const h = harness();
		h.frame([["add", "duplicate", "tool", null, { id: "duplicate", k: "shell" }]]);
		await h.session.drain();
		const state = h.session.snapshot();
		expect(projectShell({ ...state, hostId: "host", generation: 1, revision: 1, lifecycle: "live", documentGeneration: 1,
			failure: null, availability: { available: true, reason: null }, surfaces: state.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) },
		"host", 1, "call:a")).toBeNull();
	});

	it.each(["response", "segments", "row segments", "row bytes", "annotation", "props"])("refuses oversized %s before snapshot and patch publication, then recovers", async limit => {
		const h = harness();
		h.frame([["add", "output", "tool", null, { id: "output", k: "code", p: { text: "Complete ordinary output", lang: "text" } }]]);
		await h.session.drain();
		const before = h.session.snapshot().surfaces[0]!.document;
		const ordinary = [...walkNodes(before)].find(node => node.id === "output");
		const invalid = presentation();
		if (limit === "response") invalid.output = "x".repeat(2 * 1024 * 1024);
		if (limit === "segments") invalid.rows = Array.from({ length: 49 }, (_, id) => ({ id: String(id), depth: 0, segments: Array.from({ length: 1024 }, () => ({ text: "" })), effects: [] }));
		if (limit === "row segments") invalid.rows[0]!.segments = Array.from({ length: 1025 }, () => ({ text: "" }));
		if (limit === "row bytes") invalid.rows[0]!.segments = [{ text: "é".repeat(32 * 1024 + 1) }];
		if (limit === "annotation") invalid.rows[0]!.annotations = [{ name: "value", value: "x".repeat(16 * 1024 + 1) }];
		h.frame([["set", "shell", { presentation: invalid, ...(limit === "props" ? { cwd: "x".repeat(16 * 1024 + 1) } : {}) }]]);
		await h.session.drain();
		const refused = h.session.snapshot().surfaces[0]!.document;
		expect([...walkNodes(refused)].find(node => node.id === "shell")).toEqual({ id: "shell", k: "shell" });
		expect([...walkNodes(refused)].find(node => node.id === "output")).toBe(ordinary);
		const patch = diffTspDocument(before, refused);
		expect(patch).toContainEqual({ id: "shell", k: "shell" });
		expect(JSON.stringify(patch).length).toBeLessThan(256);
		await expect(h.session.send(h.action("play"))).rejects.toThrow("shell visualization is no longer available");
		h.frame([["set", "shell", { presentation: presentation(), cwd: "/tmp" }]]); await h.session.drain();
		const recovered = h.session.snapshot().surfaces[0]!.document;
		expect([...walkNodes(recovered)].find(node => node.id === "shell")?.k).toBe("shell");
		expect([...walkNodes(recovered)].find(node => node.id === "output")).toBe(ordinary);
		expect(diffTspDocument(refused, recovered).find(node => node.id === "shell")?.k).toBe("shell");
		await h.session.send(h.action("play"));
	});
});
