import type { TspHostSnapshot } from "../tsp-host";
import { TspDocumentIndex, type TspHostPatch } from "./patch";

export type TspPatchResult = "applied" | "stale" | "gap";

/**
 * One host's documents as main published them. A full snapshot seeds the store; patches then
 * rebuild only changed nodes and their ancestors, so unchanged nodes keep their identity.
 */
export class TspDocumentStore {
	#snapshot: TspHostSnapshot | null = null;
	#documents = new Map<string, TspDocumentIndex>();
	#broken = false;
	getSnapshot = (): TspHostSnapshot | null => this.#snapshot;

	/** Replace everything with a complete snapshot. Returns false for a revision this store already has. */
	accept(next: TspHostSnapshot): boolean {
		const previous = this.#snapshot;
		if (!this.#broken && previous && previous.hostId === next.hostId && next.revision <= previous.revision) return false;
		this.#documents = new Map(next.surfaces.map(surface => {
			const index = new TspDocumentIndex();
			index.replace(surface.document);
			return [surface.open.id, index];
		}));
		this.#broken = false;
		this.#snapshot = next;
		return true;
	}

	/**
	 * Apply main's patch. "gap" means this store cannot build the patched documents (it has not
	 * seen the base revision, or the patch names nodes it lacks) and needs a complete snapshot.
	 */
	apply(patch: TspHostPatch): TspPatchResult {
		const previous = this.#snapshot;
		const sameHost = previous?.hostId === patch.hostId;
		if (!this.#broken && sameHost && patch.revision <= previous!.revision) return "stale";
		if (patch.base !== null && (this.#broken || !sameHost || patch.base !== previous!.revision)) return "gap";
		const documents = new Map<string, TspDocumentIndex>();
		for (const surface of patch.surfaces) {
			const reset = patch.base === null || surface.reset;
			const index = reset ? new TspDocumentIndex() : this.#documents.get(surface.open.id);
			if (!index || !index.apply(surface.nodes, reset)) {
				this.#broken = true;
				return "gap";
			}
			documents.set(surface.open.id, index);
		}
		const { base: _base, surfaces, ...fields } = patch;
		this.#documents = documents;
		this.#broken = false;
		this.#snapshot = {
			...fields,
			surfaces: surfaces.map(({ reset: _reset, nodes: _nodes, ...surface }) => ({ ...surface, document: documents.get(surface.open.id)!.root! })),
		};
		return "applied";
	}
}
