import type { TspNode } from "../../tsp";
import type { TspHostSnapshot } from "../../tsp-host";
import { FixtureDocuments } from "../../../renderer/src/features/tsp/testing/documents";
const recordings = import.meta.glob<string>("../../../main/omp/tsp/fixtures/18.18.3-panels/*.messages.jsonl", { query: "?raw", import: "default", eager: true });

/** Fresh omp 18.18.3 wire captures, without a provider profile or recorded model context. */
export function commandPanelFrames(name: string): TspHostSnapshot[] {
	const text = Object.entries(recordings).find(([path]) => path.endsWith(`/${name}.messages.jsonl`))?.[1];
	if (!text) throw new Error(`Missing omp 18.18.3 panel recording: ${name}`);
	const documents = new FixtureDocuments();
	const snapshots: TspHostSnapshot[] = [];
	for (const line of text.trim().split("\n")) {
		const message = JSON.parse(line) as { verb: string; body: unknown };
		documents.receive({ verb: message.verb, body: JSON.stringify(message.body) });
		if (message.verb !== "f") continue;
		const snapshot = documents.snapshot();
		snapshots.push({ ...snapshot, hostId: "host", generation: 1, revision: snapshots.length + 1, lifecycle: "live", documentGeneration: 1, failure: null, availability: { available: true, reason: null }, surfaces: snapshot.surfaces.map(surface => ({ ...surface, documentGeneration: 1 })) });
	}
	return snapshots;
}

/** Fixture variants replace immutable wire children without changing the source capture. */
export function replacePanelChild(node: TspNode, index: number, child: TspNode): void {
	node.c = node.c?.map((current, position) => position === index ? child : current);
}
