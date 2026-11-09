import type { TspHostSnapshot } from "@shared/tsp-host";
import { mainOutputNodes, type MainOutput } from "@shared/tsp/main-output";

/** Attribution ends at the next input or identity change, rather than an idle-editor timer. */
export class TspMainFeedback {
	#command: { before: TspHostSnapshot; observed: Map<string, { fingerprint: string; delivered: boolean }>; current: MainOutput[]; accept: (output: MainOutput, snapshot: TspHostSnapshot) => boolean } | null = null;
	begin(before: TspHostSnapshot, accept: (output: MainOutput, snapshot: TspHostSnapshot) => boolean): () => void {
		const current = mainOutputNodes(before);
		const command = { before, accept, current, observed: new Map(current.map(output => [JSON.stringify([output.surfaceId, output.nodeId]), { fingerprint: output.fingerprint, delivered: false }])) };
		this.#command = command;
		return () => { if (this.#command === command) this.#command = null; };
	}
	end(): void { this.#command = null; }
	apply(snapshot: TspHostSnapshot): MainOutput[] {
		const command = this.#command;
		if (!command) return [];
		if (command.before.hostId !== snapshot.hostId || command.before.generation !== snapshot.generation || command.before.epoch !== snapshot.epoch || snapshot.lifecycle !== "live") { this.end(); return []; }
		const accepted: MainOutput[] = [];
		const outputs = mainOutputNodes(snapshot);
		const present = new Set(outputs.map(output => JSON.stringify([output.surfaceId, output.nodeId])));
		const replaced = command.current.filter(output => !present.has(JSON.stringify([output.surfaceId, output.nodeId])));
		for (const output of outputs) {
			const key = JSON.stringify([output.surfaceId, output.nodeId]);
			const observed = command.observed.get(key);
			if (observed?.fingerprint === output.fingerprint) continue;
			const replacement = !observed ? replaced.find(previous => previous.surfaceId === output.surfaceId && previous.fingerprint === output.fingerprint) : undefined;
			if (replacement) {
				replaced.splice(replaced.indexOf(replacement), 1);
				const previousKey = JSON.stringify([replacement.surfaceId, replacement.nodeId]);
				const previous = command.observed.get(previousKey)!;
				command.observed.set(key, previous);
				if (!previous.delivered) continue;
				output.previousNodeId = replacement.nodeId;
			}
			const delivered = command.accept(output, snapshot);
			command.observed.set(key, { fingerprint: output.fingerprint, delivered });
			if (delivered) accepted.push(output);
		}
		command.current = outputs;
		// Only live identities participate in the next reconciliation, including A -> B -> A cycles.
		for (const key of command.observed.keys()) if (!present.has(key)) command.observed.delete(key);
		return accepted;
	}
}
