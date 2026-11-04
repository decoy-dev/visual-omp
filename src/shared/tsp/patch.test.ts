import { describe, expect, it } from "vitest";
import { TspDocument } from "../../main/omp/tsp/apply";
import type { TspNode, TspOp } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";
import { TspDocumentStore } from "./document";
import { tspHostPatch } from "./patch";

function host(document: TspNode, revision: number): TspHostSnapshot {
	return {
		hostId: "host", generation: 1, revision, epoch: 1, availability: { available: true, reason: null }, negotiated: true,
		lifecycle: "live", documentGeneration: 1, failure: null,
		surfaces: [{ open: { id: "s:1", mode: "inline" }, sequence: revision, closed: false, document, focus: null, suspended: false, settled: [], documentGeneration: 1 }],
	};
}

function byId(root: TspNode): Map<string, TspNode> {
	const nodes = new Map<string, TspNode>();
	const stack = [root];
	while (stack.length) {
		const node = stack.pop()!;
		nodes.set(node.id, node);
		stack.push(...node.c ?? []);
	}
	return nodes;
}

function random(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
}

/** Valid ops against `doc`, reusing deleted ids so a stale copy of an old node would show. */
function randomOps(doc: TspDocument, root: TspNode, next: () => number, counter: { value: number }): TspOp[] {
	const nodes = [...byId(root).values()];
	const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!;
	const containers = nodes.filter(node => node.k === "col");
	const freshId = () => next() < 0.2 ? `n${Math.floor(next() * counter.value)}` : `n${counter.value++}`;
	const roll = next();
	if (roll < 0.35) {
		const parent = pick(containers);
		const id = freshId();
		if (doc.has(id)) return [];
		const before = parent.c?.length && next() < 0.5 ? pick([...parent.c]).id : null;
		const child = `${id}-text`;
		const wire = next() < 0.5 ? { id, k: "text", p: { text: `hello ${id}` } } : { id, k: "col", ...(doc.has(child) ? {} : { c: [{ id: child, k: "text", p: { text: "child" } }] }) };
		return [["add", id, parent.id, before, wire] as TspOp];
	}
	const texts = nodes.filter(node => node.k === "text");
	if (roll < 0.6 && texts.length) return [["text", pick(texts).id, next() < 0.8 ? "append" : "replace", ` t${counter.value++}`] as TspOp];
	const movable = nodes.filter(node => node.id !== root.id);
	if (!movable.length) return [];
	const node = pick(movable);
	if (roll < 0.72) return [["set", node.id, next() < 0.5 ? { tone: pick(["muted", "accent", null]) } : { role: `r${counter.value++}` }] as TspOp];
	if (roll < 0.85) {
		const inside = byId(node);
		const targets = containers.filter(container => !inside.has(container.id));
		if (!targets.length) return [];
		return [["move", node.id, pick(targets).id, null] as TspOp];
	}
	return [["del", node.id] as TspOp];
}

describe("TSP host patches", () => {
	it("keeps the renderer's copy identical to main's document and reuses unchanged nodes", () => {
		const doc = new TspDocument("s:1");
		const next = random(7);
		const counter = { value: 0 };
		const store = new TspDocumentStore();
		let published = host(doc.snapshot(), 1);
		let sequence = 0;
		store.accept(published);
		for (let revision = 2; revision < 1500; revision++) {
			const before = published.surfaces[0]!.document;
			const frozen = structuredClone(before);
			// Several frames often land in one publish.
			for (let frame = Math.floor(next() * 3); frame >= 0; frame--) {
				expect(doc.applyFrame({ sf: "s:1", s: ++sequence, ops: randomOps(doc, doc.snapshot(), next, counter) })).toEqual([]);
			}
			const snapshot = host(doc.snapshot(), revision);
			const copyBefore = byId(store.getSnapshot()!.surfaces[0]!.document);
			expect(store.apply(tspHostPatch(published, snapshot))).toBe("applied");
			published = snapshot;
			const copy = store.getSnapshot()!.surfaces[0]!.document;
			expect(copy).toEqual(snapshot.surfaces[0]!.document);
			// Earlier snapshots stay as they were published, and untouched subtrees keep their objects.
			expect(before).toEqual(frozen);
			const mainBefore = byId(before);
			const copyAfter = byId(copy);
			for (const [id, node] of byId(snapshot.surfaces[0]!.document)) {
				if (mainBefore.get(id) === node) expect(copyAfter.get(id)).toBe(copyBefore.get(id));
			}
		}
	});

	it("sends one node for a streamed token in a long transcript", () => {
		const doc = new TspDocument("s:1");
		const rows = Array.from({ length: 500 }, (_, index) => ({ id: `m${index}`, k: "col", c: [{ id: `m${index}-text`, k: "text", p: { text: `message ${index}` } }] }));
		doc.applyFrame({ sf: "s:1", s: 1, ops: [["add", "main", "s:1", null, { id: "main", k: "col", c: rows }]] as TspOp[] });
		const previous = host(doc.snapshot(), 1);
		doc.applyFrame({ sf: "s:1", s: 2, ops: [["text", "m499-text", "append", " more"]] });
		const patch = tspHostPatch(previous, host(doc.snapshot(), 2));
		expect(patch.base).toBe(1);
		expect(patch.surfaces[0]!.nodes).toEqual([{ id: "m499-text", k: "text", p: { text: "message 499 more" } }]);
	});

	it("asks for a complete read when it has not seen the patch's base", () => {
		const doc = new TspDocument("s:1");
		doc.applyFrame({ sf: "s:1", s: 1, ops: [["add", "a", "s:1", null, { id: "a", k: "text", p: { text: "one" } }]] });
		const first = host(doc.snapshot(), 1);
		doc.applyFrame({ sf: "s:1", s: 2, ops: [["text", "a", "append", " two"]] });
		const second = host(doc.snapshot(), 2);
		doc.applyFrame({ sf: "s:1", s: 3, ops: [["text", "a", "append", " three"]] });
		const third = host(doc.snapshot(), 3);
		const store = new TspDocumentStore();
		expect(store.apply(tspHostPatch(first, second))).toBe("gap");
		store.accept(first);
		expect(store.apply(tspHostPatch(second, third))).toBe("gap");
		expect(store.apply(tspHostPatch(first, second))).toBe("applied");
		expect(store.apply(tspHostPatch(first, second))).toBe("stale");
		expect(store.apply(tspHostPatch(second, third))).toBe("applied");
		expect(store.getSnapshot()!.surfaces[0]!.document).toEqual(third.surfaces[0]!.document);
		// A patch naming a node the copy lacks leaves the store waiting for a complete read.
		const broken = tspHostPatch(third, host(doc.snapshot(), 4));
		broken.surfaces[0]!.nodes = [{ id: "s:1", k: "col", c: ["missing"] }];
		expect(store.apply(broken)).toBe("gap");
		expect(store.apply(tspHostPatch(third, host(doc.snapshot(), 5)))).toBe("gap");
		expect(store.accept(host(doc.snapshot(), 4))).toBe(true);
		expect(store.getSnapshot()!.surfaces[0]!.document).toEqual(third.surfaces[0]!.document);
	});

	it("follows surfaces through close, adoption, removal, reopening with the same id and an omp restart", () => {
		const surfaces = new Map<string, { doc: TspDocument; closed: boolean }>();
		const open = (id: string, ops: TspOp[]) => {
			const doc = new TspDocument(id);
			doc.applyFrame({ sf: id, s: 1, ops });
			surfaces.set(id, { doc, closed: false });
		};
		let revision = 0;
		let epoch = 1;
		const publish = (): TspHostSnapshot => ({
			...host(new TspDocument("unused").snapshot(), ++revision),
			epoch,
			surfaces: [...surfaces].map(([id, { doc, closed }]) => ({ open: { id, mode: "inline" as const }, sequence: revision, closed, document: doc.snapshot(), focus: doc.focus, suspended: false, settled: [], documentGeneration: 1 })),
		});
		const store = new TspDocumentStore();
		const main = (text: string): TspOp => ["add", "main", "s:1", null, { id: "main", k: "col", c: [{ id: "reply", k: "text", p: { text } }] }];
		const layer = (sf: string, head: string): TspOp => ["add", "layer", sf, null, { id: "layer", k: "col", c: [{ id: "menu", k: "overlay", p: { head } }] }];
		open("s:1", [main("first")]);
		open("s:2", [layer("s:2", "Menu")]);
		let published = publish();
		store.accept(published);
		const step = (change: () => void) => {
			change();
			const next = publish();
			expect(store.apply(tspHostPatch(published, next))).toBe("applied");
			expect(store.getSnapshot()!.surfaces).toEqual(next.surfaces);
			published = next;
		};
		step(() => surfaces.get("s:2")!.doc.applyFrame({ sf: "s:2", s: 2, ops: [["set", "menu", { head: "Changed" }]] }));
		step(() => { surfaces.get("s:2")!.doc.close(); surfaces.get("s:2")!.closed = true; });
		// Adoption reopens the kept document, which then receives frames again.
		step(() => { const kept = surfaces.get("s:2")!; kept.closed = false; kept.doc.applyFrame({ sf: "s:2", s: 3, ops: [layer("s:2", "Adopted")] }); });
		step(() => surfaces.delete("s:2"));
		step(() => open("s:2", [layer("s:2", "Reopened")]));
		// A restart clears every surface; the new process reuses the same surface and node ids.
		step(() => { surfaces.clear(); epoch++; });
		step(() => { open("s:1", [main("second process")]); open("s:2", [layer("s:2", "Again")]); });
		// A replacement with no base also repairs a store that could not apply a patch.
		const broken = tspHostPatch(published, publish());
		broken.surfaces[0]!.nodes = [{ id: "s:1", k: "col", c: ["missing"] }];
		expect(store.apply(broken)).toBe("gap");
		const replacement = publish();
		expect(store.apply(tspHostPatch(null, replacement))).toBe("applied");
		expect(store.getSnapshot()!.surfaces).toEqual(replacement.surfaces);
	});
});
