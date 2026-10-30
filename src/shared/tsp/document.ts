import type { TspNode } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";

/** IPC carries replacements. Reconcile them so unchanged node subscribers keep their identity. */
export class TspDocumentStore {
	#snapshot: TspHostSnapshot | null = null;
	#nodes = new Map<string, TspNode>();
	#listeners = new Set<() => void>();
	#nodeListeners = new Map<string, Set<() => void>>();
	getSnapshot = (): TspHostSnapshot | null => this.#snapshot;
	getNode = (surface: string, id: string): TspNode | undefined => this.#nodes.get(this.#key(surface, id));
	subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
	subscribeNode(surface: string, id: string, listener: () => void): () => void {
		const key = this.#key(surface, id);
		let listeners = this.#nodeListeners.get(key);
		if (!listeners) this.#nodeListeners.set(key, listeners = new Set());
		listeners.add(listener);
		return () => { listeners.delete(listener); if (!listeners.size) this.#nodeListeners.delete(key); };
	}
	accept(next: TspHostSnapshot): boolean {
		const previous = this.#snapshot;
		if (previous && previous.hostId === next.hostId && next.revision <= previous.revision) return false;
		const oldNodes = previous?.hostId === next.hostId && previous.epoch === next.epoch ? this.#nodes : new Map<string, TspNode>();
		const nodes = new Map<string, TspNode>();
		const reconcile = (sf: string, incoming: TspNode): TspNode => {
			const key = this.#key(sf, incoming.id);
			const old = oldNodes.get(key);
			const children = incoming.c?.map(child => reconcile(sf, child));
			const sameChildren = old?.c?.length === children?.length && (children?.every((child, i) => child === old?.c?.[i]) ?? true);
			const node = old && old.k === incoming.k && JSON.stringify(old.p) === JSON.stringify(incoming.p) && sameChildren ? old : { ...incoming, ...(children ? { c: children } : {}) } as TspNode;
			nodes.set(key, node);
			return node;
		};
		this.#snapshot = { ...next, surfaces: next.surfaces.map(surface => ({ ...surface, document: reconcile(surface.open.id, surface.document) })) };
		this.#nodes = nodes;
		for (const [key, listeners] of this.#nodeListeners) if (oldNodes.get(key) !== nodes.get(key)) for (const listener of listeners) listener();
		for (const listener of this.#listeners) listener();
		return true;
	}
	#key(surface: string, id: string): string { return `${surface.length}:${surface}${id}`; }
}
