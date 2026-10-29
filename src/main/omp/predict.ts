/** Local word completion shares one no-session omp process per project folder. */
import { z } from "zod";
import { PersistentRpc } from "./rpc";

const suffixSchema = z.object({ suffix: z.string().nullable() });
const services = new Map<string, PersistentRpc>();
const owners = new Map<string, Set<string>>();

export function retainPredictionFolder(folder: string, owner: string): void {
	const active = owners.get(folder) ?? new Set<string>();
	active.add(owner);
	owners.set(folder, active);
}

export function releasePredictionFolder(folder: string, owner: string): void {
	const active = owners.get(folder);
	if (!active) return;
	active.delete(owner);
	if (active.size > 0) return;
	owners.delete(folder);
	services.get(folder)?.close();
	services.delete(folder);
}

function service(folder: string): PersistentRpc {
	let rpc = services.get(folder);
	if (!rpc) {
		rpc = new PersistentRpc(folder, []);
		services.set(folder, rpc);
	}
	return rpc;
}

/** No provider usage: omp's auto engine is a local n-gram trained on prompt history. */
export async function predictWord(folder: string, text: string, cursor: number): Promise<string | null> {
	if (!owners.has(folder)) return null;
	return suffixSchema.parse(await service(folder).request("predict_word", { text, cursor })).suffix;
}

export async function predictFeedback(folder: string, text: string, cursor: number, suggestion: string, accepted: boolean): Promise<void> {
	const rpc = services.get(folder);
	if (rpc) await rpc.request("predict_word_feedback", { text, cursor, suggestion, accepted }, 10_000);
}

/** A config edit must reach the next request, including spelling.autocomplete: off. */
export function closePredictions(force = false): void {
	for (const rpc of services.values()) rpc.close(force);
	services.clear();
	if (force) owners.clear();
}
