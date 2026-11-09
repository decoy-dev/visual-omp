import { describe, expect, it } from "vitest";
import type { TspHostSnapshot } from "@shared/tsp-host";
import type { TspNode } from "@shared/tsp";
import { mainOutputFingerprint, mainOutputNodes } from "@shared/tsp/main-output";
import { unclaimed } from "@shared/tsp/view-state";
import { commandResults, mainCommandFeedback } from "../../features/session-tools/results";
import { TspMainFeedback } from "./main-feedback";

const text = (id: string, value = "Public output"): TspNode => ({ id, k: "text", p: { text: value } });
function snapshot(nodes: TspNode[], revision = 1): TspHostSnapshot {
	return { hostId: "host", epoch: 1, generation: 1, revision, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: true, reason: null }, surfaces: [
		{ open: { id: "surface", mode: "inline", role: "omp.session" }, sequence: revision, documentGeneration: 1, closed: false, suspended: false, focus: null, settled: [], document: { id: "surface", k: "col", c: [{ id: "main", k: "col", c: nodes }] } },
	] };
}

describe("command feedback ownership", () => {
	it.each([
		"collab: visual-omp joined the collab session",
		"collab: visual-omp left the collab session",
		"collab: visual-omp interrupted the session",
		"collab: Collab ended: host disconnected",
	])("does not attribute an asynchronous session toast to the in-flight command: %s", content => {
		const projection = new TspMainFeedback();
		const chat = {};
		const notice: TspNode = { id: "collab-status", k: "toast", p: { role: "omp.toast.status", text: content, ttl: 2400 } };
		projection.begin(snapshot([]), mainCommandFeedback(chat, "/tools", () => null, "room"));
		projection.apply(snapshot([notice], 2));
		expect(commandResults(chat)).toEqual([]);
		projection.apply(snapshot([{ id: "output-group", k: "col", c: [notice, text("command-output", "Command-owned output")] }], 3));
		expect(commandResults(chat).map(result => ({ command: result.command, lines: result.lines }))).toEqual([
			{ command: "/tools", lines: ["Command-owned output"] },
		]);
	});
	it("retains command status toasts and extension warnings outside the collab status source", () => {
		const projection = new TspMainFeedback();
		const chat = {};
		projection.begin(snapshot([]), mainCommandFeedback(chat, "/extension", () => null, "room"));
		projection.apply(snapshot([
			{ id: "summary", k: "toast", p: { role: "omp.toast.status", text: "Session compacted 2 times" } },
			{ id: "extension-status", k: "toast", p: { role: "omp.toast.status", text: "Warning: extension fixture needs attention", tone: "warning" } },
			{ id: "extension-warning", k: "toast", p: { role: "omp.notice.warning", text: "collab: extension-owned warning", tone: "warning" } },
		], 2));
		expect(commandResults(chat).map(result => ({ lines: result.lines, tone: result.tone }))).toEqual([
			{ lines: ["Session compacted 2 times"], tone: "info" },
			{ lines: ["Warning: extension fixture needs attention"], tone: "warn" },
			{ lines: ["collab: extension-owned warning"], tone: "warn" },
		]);
	});
	it("does not present unchanged baseline content recreated under a new root id", () => {
		const projection = new TspMainFeedback();
		const chat = {};
		projection.begin(snapshot([text("old")]), mainCommandFeedback(chat, "/extension", () => null, "room"));
		projection.apply(snapshot([text("replacement")], 2));
		expect(commandResults(chat)).toEqual([]);
	});
	it("rebinds a delivered root replacement to the same row and preserves genuinely appended repetitions", () => {
		const projection = new TspMainFeedback();
		const chat = {};
		projection.begin(snapshot([]), mainCommandFeedback(chat, "/extension", () => "arrival", "room"));
		projection.apply(snapshot([text("first")], 2));
		const id = commandResults(chat)[0]!.id;
		projection.apply(snapshot([text("replacement")], 3));
		expect(commandResults(chat)).toHaveLength(1);
		expect(commandResults(chat)[0]).toMatchObject({ id, anchor: "arrival", provenance: [{ nodeId: "replacement" }] });
		projection.apply(snapshot([text("replacement"), text("new-print")], 4));
		expect(commandResults(chat)).toHaveLength(2);
	});
	it("transfers ownership back across an A to B to A root identity cycle", () => {
		const projection = new TspMainFeedback();
		const chat = {};
		projection.begin(snapshot([]), mainCommandFeedback(chat, "/extension", () => null, "room"));
		projection.apply(snapshot([text("A")], 2));
		const id = commandResults(chat)[0]!.id;
		projection.apply(snapshot([text("B")], 3));
		const after = snapshot([text("A")], 4);
		projection.apply(after);
		expect(commandResults(chat)).toHaveLength(1);
		expect(commandResults(chat)[0]).toMatchObject({ id, provenance: [{ nodeId: "A" }] });
		const claims = new Map(commandResults(chat)[0]!.provenance!.map(node => [node.nodeId, node.text]));
		expect(unclaimed(after.surfaces[0]!, "main", undefined, claims)).toEqual([]);
	});
	it("preserves a new print after an intervening removal frame", () => {
		const projection = new TspMainFeedback();
		const chat = {};
		projection.begin(snapshot([]), mainCommandFeedback(chat, "/extension", () => null, "room"));
		projection.apply(snapshot([text("first")], 2));
		projection.apply(snapshot([], 3));
		projection.apply(snapshot([text("new-print")], 4));
		expect(commandResults(chat)).toHaveLength(2);
	});
	it.each(["form", "action"] as const)("returns changed %s content to fallback even when visible text is unchanged", change => {
		const original: TspNode = { id: "feedback", k: "col", c: [text("body")] };
		const fingerprint = mainOutputFingerprint(original)!;
		const changed: TspNode = change === "form"
			? { ...original, c: [...original.c!, { id: "secret", k: "input", p: { text: "private-do-not-capture" } }] }
			: { ...original, p: { actions: { click: "delete" } } };
		const after = snapshot([changed], 2);
		expect(mainOutputNodes(after)).toEqual([]);
		expect(unclaimed(after.surfaces[0]!, "main", undefined, new Map([["feedback", fingerprint]]))).toEqual([changed]);
	});
	it("preserves source titles and updates them as semantic output changes", () => {
		const projection = new TspMainFeedback();
		const chat = {};
		projection.begin(snapshot([]), mainCommandFeedback(chat, "/extension", () => null, "room"));
		const output: TspNode = { id: "feedback", k: "text", p: { text: "Public output", title: "Connection report" } };
		projection.apply(snapshot([output], 2));
		expect(commandResults(chat)[0]?.title).toBe("Connection report");
		projection.apply(snapshot([{ ...output, p: { ...output.p, title: "Connection details" } }], 3));
		expect(commandResults(chat)).toHaveLength(1);
		expect(commandResults(chat)[0]?.title).toBe("Connection details");
	});
});
