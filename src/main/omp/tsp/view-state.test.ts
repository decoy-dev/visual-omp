import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { TspDocument } from "./apply";
import { TspStream } from "./stream";
import type { TspHostSnapshot, TspSurfaceSnapshot } from "../../../shared/tsp-host";
import type { TspFrame, TspOpen } from "../../../shared/tsp";
import { TspDocumentStore } from "../../../shared/tsp/document";
import { composer, openOverlay, screenSurface, unclaimed } from "../../../shared/tsp/view-state";

function snap(revision = 1): TspHostSnapshot {
	return { hostId: "host", generation: 1, epoch: 1, availability: { available: true, reason: null }, revision, negotiated: true, lifecycle: "live", documentGeneration: 1, failure: null, surfaces: [{ documentGeneration: 1, open: { id: "s:1", mode: "inline", role: "omp.session" }, sequence: revision, closed: false, focus: "editor", suspended: false, settled: [], document: { id: "s:1", k: "col", c: [{ id: "dock", k: "col", p: { role: "omp.editor" }, c: [{ id: "editor", k: "editor", p: { sendable: true, text: "draft" } }] }] } }] };
}
it("reuses unchanged nodes on replacement and notifies subscriptions only for changed nodes", () => {
	const store = new TspDocumentStore(); store.accept(snap()); const original = store.getNode("s:1", "editor"); const listener = vi.fn(); store.subscribeNode("s:1", "editor", listener);
	store.accept(snap(2)); expect(store.getNode("s:1", "editor")).toBe(original); expect(listener).not.toHaveBeenCalled();
	const changed = snap(3); changed.surfaces[0]!.document.c![0]!.c![0]!.p = { text: "changed", sendable: true };
	store.accept(changed); expect(listener).toHaveBeenCalledOnce(); expect(store.accept(snap(2))).toBe(false);
	store.accept({ ...snap(4), epoch: 2 }); expect(store.getNode("s:1", "editor")).not.toBe(original);
});
it("derives focused sendable composer and screen blocking from inherited roles", () => {
	const surfaces = snap().surfaces;
	expect(composer(surfaces)?.node.id).toBe("editor"); expect(openOverlay(surfaces)).toBeNull(); expect(screenSurface(surfaces)).toBeNull();
	surfaces[0]!.document.c![0]!.p = { role: "omp.editor.shell" }; expect(composer(surfaces)).toBeNull();
});
it("reads the committed omp 18.14 byte capture and exposes its BTW overlay without duplicate composer", () => {
	const docs = new Map<string, { doc: TspDocument; open: TspOpen }>(); let sawOverlay = false; let sawComposer = false;
	const stream = new TspStream({ onData: () => {}, onMessage: message => {
		const body = JSON.parse(message.body);
		if (message.verb === "o") docs.set(body.id, { doc: new TspDocument(body.id), open: body });
		if (message.verb !== "f") return;
		const frame = body as TspFrame; const live = docs.get(frame.sf)!; live.doc.applyFrame(frame);
		const surfaces: TspSurfaceSnapshot[] = [...docs.values()].map(({ doc, open }) => ({ open, document: doc.snapshot(), focus: doc.focus, closed: false, sequence: frame.s, suspended: doc.suspended, settled: [...doc.settled] }));
		sawOverlay ||= openOverlay(surfaces)?.node.p?.role === "omp.overlay.btwHistory";
		sawComposer ||= !!composer(surfaces);
		for (const surface of surfaces) expect(unclaimed(surface, "dock").some(node => node.p?.role === "omp.editor")).toBe(false);
	} });
	stream.push(readFileSync(resolve(process.cwd(), "src/main/omp/tsp/fixtures/omp-18.14.bin"))); stream.end();
	expect(sawOverlay).toBe(true); expect(sawComposer).toBe(true);
});
