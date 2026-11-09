import type { TspHostSnapshot } from "@shared/tsp-host";
import { ompActivity } from "@shared/tsp/activity";
import { describe, expect, it } from "vitest";
import { FixtureDocuments, loadFixtureRecording } from "../../features/tsp/testing/documents";

/** Each label omp showed during a recorded run, in order, with consecutive repeats removed. */
function labels(name: string): string[] {
	const documents = new FixtureDocuments();
	const seen: string[] = [];
	for (const message of loadFixtureRecording(name).messages) {
		documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		const { epoch, negotiated, surfaces } = documents.snapshot();
		const snapshot: TspHostSnapshot = { hostId: "host", generation: 1, epoch, revision: 0, negotiated, lifecycle: "live", documentGeneration: 1, failure: null,
			availability: { available: true, reason: null }, surfaces: surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) };
		const label = ompActivity(snapshot, { hostId: "host", generation: 1, tspEpoch: epoch })?.label ?? null;
		if (label !== null && seen.at(-1) !== label) seen.push(label);
	}
	return seen;
}

describe("ompActivity", () => {
	it("reads omp's handoff loader without its keyboard hint", () => {
		expect(labels("handoff")).toEqual(["Generating handoff…"]);
	});
	it("reads the compaction progress row", () => {
		expect(labels("compact-ok")).toEqual(["Compacting context…"]);
	});
	it("leaves a model turn's working row to collab", () => {
		expect(labels("ask-replaces-editor")).toEqual([]);
		expect(labels("follow-up-queue")).toEqual([]);
	});
});
