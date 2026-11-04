import type { TspKind, TspNode } from "../tsp";
import type { TspHostSnapshot } from "../tsp-host";

/** One node without its subtree. Children are named by id and sent only when they changed too. */
export interface TspPatchNode {
	id: string;
	k: TspKind;
	p?: Record<string, unknown>;
	c?: string[];
}

export type TspSurfacePatch = Omit<TspHostSnapshot["surfaces"][number], "document"> & {
	/** The receiver keeps nothing from an earlier copy of this surface: `nodes` holds the whole document. */
	reset: boolean;
	/** New nodes and nodes whose kind, props or child order changed, parents before children. */
	nodes: TspPatchNode[];
};

/**
 * Main's IPC update for one host. Every snapshot field is complete except the documents, which
 * carry only what changed since revision `base`. A null base replaces every document.
 */
export type TspHostPatch = Omit<TspHostSnapshot, "surfaces"> & {
	base: number | null;
	surfaces: TspSurfacePatch[];
};

function patchNode(node: TspNode): TspPatchNode {
	const out: TspPatchNode = { id: node.id, k: node.k };
	if (node.p) out.p = node.p as Record<string, unknown>;
	if (node.c?.length) out.c = node.c.map(child => child.id);
	return out;
}

function sameProps(a: object | undefined, b: object | undefined): boolean {
	if (a === b) return true;
	const left = (a ?? {}) as Record<string, unknown>;
	const right = (b ?? {}) as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	for (const key of keys) if (!Object.hasOwn(right, key) || left[key] !== right[key]) return false;
	return true;
}

function sameChildIds(a: readonly TspNode[] | undefined, b: readonly TspNode[] | undefined): boolean {
	const left = a ?? [];
	const right = b ?? [];
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (left[index]!.id !== right[index]!.id) return false;
	return true;
}

/**
 * Nodes of `next` that differ from `previous`. Unchanged subtrees are skipped by identity, so the
 * cost follows the change when both trees share structure. Children are paired by id under the
 * same parent; a node that moved to another parent is sent again with its subtree.
 */
export function diffTspDocument(previous: TspNode | undefined, next: TspNode, out: TspPatchNode[] = []): TspPatchNode[] {
	if (previous === next) return out;
	if (!previous || previous.k !== next.k || !sameProps(previous.p, next.p) || !sameChildIds(previous.c, next.c)) out.push(patchNode(next));
	if (!next.c?.length) return out;
	const before = previous?.c?.length ? new Map(previous.c.map(child => [child.id, child])) : undefined;
	for (const child of next.c) diffTspDocument(before?.get(child.id), child, out);
	return out;
}

/** The update that turns the receiver's copy of `previous` into `next`. */
export function tspHostPatch(previous: TspHostSnapshot | null, next: TspHostSnapshot): TspHostPatch {
	const { surfaces, ...fields } = next;
	const before = previous && previous.hostId === next.hostId ? new Map(previous.surfaces.map(surface => [surface.open.id, surface])) : null;
	return {
		...fields,
		base: before ? previous!.revision : null,
		surfaces: surfaces.map(({ document, ...surface }) => {
			const old = before?.get(surface.open.id);
			return { ...surface, reset: !old, nodes: diffTspDocument(old?.document, document) };
		}),
	};
}

interface IndexEntry {
	node: TspNode;
	parent: string | null;
}

/** One surface's current tree plus an id index, updated in place by patches. */
export class TspDocumentIndex {
	#root: TspNode | null = null;
	#nodes = new Map<string, IndexEntry>();

	get root(): TspNode | null {
		return this.#root;
	}

	/** Replace the tree with one received whole, such as the initial read. */
	replace(root: TspNode): void {
		this.#nodes.clear();
		const stack: [TspNode, string | null][] = [[root, null]];
		while (stack.length) {
			const [node, parent] = stack.pop()!;
			this.#nodes.set(node.id, { node, parent });
			for (const child of node.c ?? []) stack.push([child, node.id]);
		}
		this.#root = root;
	}

	/**
	 * Apply changed nodes and rebuild only their ancestors, keeping every other node's identity.
	 * Returns false when the patch names a node this copy does not have; the copy is then unusable
	 * until `replace`.
	 */
	apply(nodes: readonly TspPatchNode[], reset: boolean): boolean {
		if (reset) this.#nodes.clear();
		if (!nodes.length) return reset ? false : this.#root !== null;
		const staged = new Map(nodes.map(node => [node.id, node]));
		const dirty = new Set<string>();
		for (const id of staged.keys()) {
			for (let at: string | null | undefined = id; at != null && !dirty.has(at); at = this.#nodes.get(at)?.parent) dirty.add(at);
		}
		const dropped: [string, string][] = [];
		let missing = false;
		const build = (id: string, parent: string | null): TspNode | null => {
			const entry = this.#nodes.get(id);
			if (!dirty.has(id)) {
				if (!entry) { missing = true; return null; }
				if (entry.parent !== parent) entry.parent = parent;
				return entry.node;
			}
			const source = staged.get(id) ?? (entry ? patchNode(entry.node) : null);
			if (!source) { missing = true; return null; }
			const childIds = source.c ?? [];
			const children: TspNode[] = [];
			for (const child of childIds) {
				const built = build(child, id);
				if (built) children.push(built);
			}
			if (entry?.node.c) {
				const kept = new Set(childIds);
				for (const old of entry.node.c) if (!kept.has(old.id)) dropped.push([old.id, id]);
			}
			// A node resent unchanged (moved, or above a change that cancelled out) keeps its object.
			const old = entry?.node;
			const same = old && old.k === source.k && sameProps(old.p, source.p) && (old.c?.length ?? 0) === children.length
				&& children.every((child, index) => child === old.c![index]);
			const node = same ? old : { id, k: source.k, ...(source.p ? { p: source.p } : {}), ...(children.length ? { c: children } : {}) } as TspNode;
			this.#nodes.set(id, { node, parent });
			return node;
		};
		// A reset lists the root first; otherwise the root keeps its id.
		const rootId = reset ? nodes[0]!.id : this.#root?.id;
		const root = rootId === undefined ? null : build(rootId, null);
		if (missing || !root) return false;
		this.#root = root;
		// A dropped child that was not re-parented while building left the tree with its subtree.
		for (const [id, parent] of dropped) this.#forget(id, parent);
		return true;
	}

	#forget(id: string, parent: string): void {
		const stack: [string, string][] = [[id, parent]];
		while (stack.length) {
			const [at, expected] = stack.pop()!;
			const entry = this.#nodes.get(at);
			if (!entry || entry.parent !== expected) continue;
			this.#nodes.delete(at);
			for (const child of entry.node.c ?? []) stack.push([child.id, at]);
		}
	}
}
