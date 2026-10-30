import { describe, expect, it } from "vitest";
import type { TspOp } from "../../../shared/tsp";
import { TspDocument } from "./apply";

function apply(doc: TspDocument, ops: readonly TspOp[], s = 1) {
	return doc.applyFrame({ sf: doc.surface, s, ops });
}

function document() {
	const doc = new TspDocument("s:1");
	expect(apply(doc, [["add", "main", "s:1", null, { id: "main", k: "col", c: [
		{ id: "a", k: "text", p: { text: "hello", tone: "muted" } },
		{ id: "b", k: "col" },
	] }]])).toEqual([]);
	return doc;
}

describe("upstream TSP document semantics", () => {
	it("applies property deletion, append, replace and UTF-16 splice", () => {
		const doc = document();
		expect(apply(doc, [["set", "a", { tone: null, role: "example", unused: undefined }], ["text", "a", "append", "🐢"], ["splice", "a", 5, 2, "!"], ["text", "a", "replace", "done"]])).toEqual([]);
		expect(doc.get("a")).toEqual({ id: "a", k: "text", p: { text: "done", role: "example" } });
	});

	it("rejects an invalid op individually and continues the frame", () => {
		const doc = document();
		const errors = apply(doc, [["move", "b", "a", "missing"], ["text", "a", "append", "!"], ["splice", "a", 100, 0, "bad"]], 7);
		expect(errors).toEqual([
			{ s: 7, op: 0, msg: "missing is not a child of a" },
			{ s: 7, op: 2, msg: "splice range 100+0 outside text of length 6" },
		]);
		expect(doc.get("main")?.c?.map(node => node.id)).toEqual(["a", "b"]);
		expect(doc.get("a")?.p).toMatchObject({ text: "hello!" });
	});

	it("moves and deletes subtrees, rejecting cycles and duplicate ids atomically", () => {
		const doc = document();
		expect(apply(doc, [["move", "a", "b", null]])).toEqual([]);
		expect(doc.get("b")?.c?.[0]?.id).toBe("a");
		expect(apply(doc, [["move", "b", "a", null], ["add", "x", "main", null, { id: "x", k: "col", c: [{ id: "a", k: "text" }] }]])).toHaveLength(2);
		expect(doc.has("x")).toBe(false);
		expect(apply(doc, [["del", "b"]])).toEqual([]);
		expect(doc.has("a")).toBe(false);
		expect(doc.size).toBe(2);
	});

	it("tracks settle hints, focus, suspension and validates reveal/scroll targets", () => {
		const doc = document();
		expect(apply(doc, [["settle", "main"], ["settle", "a"], ["focus", "a"], ["suspend"], ["reveal", "a", "nearest"], ["scroll", "a", "end"]])).toEqual([]);
		expect([...doc.settled]).toEqual(["main", "a"]);
		expect(doc.focus).toBe("a");
		expect(doc.suspended).toBe(true);
		expect(apply(doc, [["set", "a", { text: "changed" }], ["resume"]])).toEqual([]);
		expect([...doc.settled]).toEqual([]);
		expect(doc.suspended).toBe(false);
		apply(doc, [["del", "a"]]);
		expect(doc.focus).toBeNull();
		expect(apply(doc, [["reveal", "missing", "end"], ["del", "s:1"]])).toHaveLength(2);
	});

	it("retains main on keep-close and drops live dock, layer and focus", () => {
		const doc = document();
		apply(doc, [["add", "dock", "s:1", null, { id: "dock", k: "col" }], ["add", "layer", "s:1", null, { id: "layer", k: "col", c: [{ id: "overlay", k: "overlay" }] }], ["focus", "overlay"]]);
		doc.close();
		expect(doc.snapshot().c?.map(node => node.id)).toEqual(["main"]);
		expect(doc.has("overlay")).toBe(false);
		expect(doc.focus).toBeNull();
		const snapshot = doc.snapshot();
		const text = snapshot.c?.[0]?.c?.[0];
		if (text?.k === "text" && text.p) text.p.text = "external mutation";
		expect(doc.get("a")?.p).toMatchObject({ text: "hello" });
	});
});
