import { describe, expect, it } from "vitest";
import type { TspNode } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { commandOutcome, commandOutcomeSpec } from "./command-result";

const toast = (text: string): TspNode => ({ id: "toast", k: "toast", p: { role: "omp.toast.status", text } });
function snapshot(sequence: number, nodes: TspNode[]): TspHostSnapshot {
	return { hostId: "host", generation: 1, epoch: 1, revision: sequence, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null,
		availability: { available: true, reason: null }, surfaces: [{ open: { id: "s:1", mode: "inline" }, sequence, closed: false, suspended: false, focus: null, settled: [], documentGeneration: 1, document: { id: "s:1", k: "col", c: nodes } }] };
}
const spec = commandOutcomeSpec("/rename example")!;
describe("commandOutcome", () => {
	it("ignores unchanged feedback even when unrelated document frames advance", () => {
		const node = toast('Session renamed to "old".');
		expect(commandOutcome(snapshot(2, [node]), snapshot(3, [structuredClone(node)]), spec)).toBeNull();
	});
	it("requires a sequence after submission and accepts a reused toast with changed text", () => {
		const before = snapshot(2, [toast('Session renamed to "old".')]);
		expect(commandOutcome(before, snapshot(2, [toast('Session renamed to "example".')]), spec)).toBeNull();
		expect(commandOutcome(before, snapshot(3, [toast('Session renamed to "example".')]), spec)).toMatchObject({ status: "success", lines: ['Session renamed to "example".'] });
	});
	it.each(["hostId", "generation", "epoch", "lifecycle"] as const)("rejects an invalidated %s scope", field => {
		const after = snapshot(3, [toast('Session renamed to "example".')]);
		Object.assign(after, { [field]: field === "hostId" ? "other" : field === "lifecycle" ? "exited" : 2 });
		expect(commandOutcome(snapshot(2, []), after, spec)).toBeNull();
	});
	it("ignores another command's error and preserves the current command's multiline failure", () => {
		const error: TspNode = { id: "error", k: "row", p: { role: "omp.notice.error" }, c: [{ id: "text", k: "text", p: { spans: [{ t: "Compaction failed: provider refused\nKeep the context." }] } }] };
		expect(commandOutcome(snapshot(2, []), snapshot(3, [error]), spec)).toBeNull();
		expect(commandOutcome(snapshot(2, []), snapshot(3, [error]), commandOutcomeSpec("/compact")!)).toMatchObject({ status: "error", lines: ["Compaction failed: provider refused", "Keep the context."] });
	});
	it("requires a settled completed summary and ignores its presentation-only updates", () => {
		const section: TspNode = { id: "compact", k: "section", p: { role: "omp.compaction", head: [{ t: "Soft-compacted" }] }, c: [{ id: "summary", k: "md", p: { key: "summary", text: "The summary." } }] };
		const pending = snapshot(3, [section]);
		expect(commandOutcome(snapshot(2, []), pending, commandOutcomeSpec("/compact")!)).toBeNull();
		const done = snapshot(4, [section]); done.surfaces[0]!.settled = ["compact"];
		expect(commandOutcome(pending, done, commandOutcomeSpec("/compact")!)).toMatchObject({ status: "success", lines: [], nodes: [{ id: "compact" }] });
		const restyled = structuredClone(done); restyled.surfaces[0]!.sequence++;
		const next = restyled.surfaces[0]!.document.c![0]!;
		next.p = { ...next.p, collapsed: true, head: [{ t: "Soft-compacted", s: "dim" }] };
		next.c = [{ id: "different-child", k: "md", p: { key: "summary", text: "The summary." } }];
		expect(commandOutcome(done, restyled, commandOutcomeSpec("/compact")!)).toBeNull();
		const empty = snapshot(4, [{ ...section, c: [] }]); empty.surfaces[0]!.settled = ["compact"];
		expect(commandOutcome(snapshot(2, []), empty, commandOutcomeSpec("/compact")!)).toBeNull();
	});
	it("does not treat toast TTL or style changes as new output", () => {
		const before = snapshot(2, [toast('Session renamed to "old".')]);
		const node = toast('Session renamed to "old".'); node.p = { ...node.p, ttl: 1200, tone: "warning" };
		expect(commandOutcome(before, snapshot(3, [node]), spec)).toBeNull();
	});
	it.each([["/handoff", "Handoff cancelled"], ["/cleanse", "Cleanse cancelled"], ["/compact", "Compaction cancelled"]])("never turns %s cancellation into success", (line, message) => {
		expect(commandOutcome(snapshot(2, []), snapshot(3, [toast(message!)]), commandOutcomeSpec(line!)!)).toMatchObject({ status: "cancelled" });
	});
	it("binds jobs-kill success and failure to the requested job", () => {
		const kill = commandOutcomeSpec("/jobs kill fixture-job")!;
		expect(commandOutcome(snapshot(2, []), snapshot(3, [toast("Cancelled background job unrelated-job.")]), kill)).toBeNull();
		expect(commandOutcome(snapshot(2, []), snapshot(3, [toast('No running background job with id "unrelated-job".')]), kill)).toBeNull();
		expect(commandOutcome(snapshot(2, []), snapshot(3, [toast("Cancelled background job fixture-job.")]), kill)).toMatchObject({ status: "success" });
	});
	it("selects one matching feedback item so another message remains available to notices", () => {
		const first = toast('Session renamed to "first".');
		const second = { ...toast('Session renamed to "second".'), id: "second" };
		expect(commandOutcome(snapshot(2, []), snapshot(3, [first, second]), spec)).toMatchObject({
			lines: ['Session renamed to "first".'], nodes: [{ id: "toast" }],
		});
		expect(commandOutcome(snapshot(2, []), snapshot(3, [first, second]), spec)?.nodes).toHaveLength(1);
	});
	it("allows quiet jobs-kill success only after 1.5 seconds with an available editor", () => {
		const before = snapshot(2, []); const after = snapshot(2, []); const quiet = commandOutcomeSpec("/jobs kill job")!;
		expect(commandOutcome(before, after, { ...quiet, elapsedMs: 1499 })).toBeNull();
		expect(commandOutcome(before, after, { ...quiet, elapsedMs: 1500 })).toEqual({ status: "success", lines: [], nodes: [] });
		after.availability.available = false;
		expect(commandOutcome(before, after, { ...quiet, elapsedMs: 2000 })).toBeNull();
	});
	it("does not infer success from an unrelated toast or claim ordinary jobs output", () => {
		expect(commandOutcome(snapshot(2, []), snapshot(3, [toast("Another guest joined")]), spec)).toBeNull();
		expect(commandOutcomeSpec("/jobs")).toBeNull();
	});
});
