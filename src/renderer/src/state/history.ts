/**
 * Session branches. omp sessions are append-only trees (id/parentId); what a chat shows is the
 * active branch — the parentId path from the root to the leaf, which is the last entry unless a
 * rewind moved it (docs/session.md, `buildSessionContext`).
 */
import type { SessionEntry, SessionHeader } from "@oh-my-pi/pi-wire";
import { parseJsonl } from "../collab/lib/jsonl";

export interface SessionHistory {
	header: SessionHeader | null;
	/** Entries on the active branch, root → leaf. */
	entries: SessionEntry[];
	/** Title from the physical title slot (newest), falling back to the header title. */
	title: string | null;
	/** Every tree entry in file order (all branches); the base for {@link extendSessionHistory}. */
	all: readonly TreeEntry[];
}

interface TreeNode {
	id: string;
	parentId?: string | null;
}

/** Parent ids from a saved session file (id → parent id), for crossing entries the live stream leaves out. */
export type SavedParents = ReadonlyMap<string, string | null>;

const savedParentsCache = new WeakMap<readonly TreeEntry[], SavedParents>();

/** Every saved entry's parent id, cached per loaded history. */
export function savedParents(history: SessionHistory | null | undefined): SavedParents | undefined {
	if (!history) return undefined;
	let parents = savedParentsCache.get(history.all);
	if (!parents) {
		parents = new Map(history.all.map(entry => [entry.id, entry.parentId ?? null]));
		savedParentsCache.set(history.all, parents);
	}
	return parents;
}

/**
 * Entries on the branch ending at `leafId` (default: the last entry), root → leaf. Unknown leaf → all entries.
 *
 * omp's live stream replicates only some entry types, so a parent can be missing: omp's `custom`
 * bookkeeping (`tool_execution_start` between a tool call and its result, title changes) never
 * reaches the app. A missing parent is bridged to its nearest ancestor the stream does carry:
 * - through `saved` (the session file's parent ids) when the missing entry was already saved;
 * - otherwise by inference. omp appends every entry as a child of the current leaf, so the entry
 *   that arrived just before the missing entry's first child is that nearest ancestor. This holds
 *   for a linear chat and for a branch resumed at a missing entry that already had a child. It can
 *   still pick the wrong branch, for example when omp moved the leaf to a missing entry that was not
 *   saved yet and had no carried child.
 */
export function activeBranch<T extends TreeNode>(entries: readonly T[], leafId?: string | null, saved?: SavedParents): T[] {
	if (entries.length === 0) return [];
	const indexById = new Map<string, number>();
	entries.forEach((entry, index) => indexById.set(entry.id, index));
	const firstChild = new Map<string, number>();
	entries.forEach((entry, index) => {
		const parent = entry.parentId;
		if (parent && !indexById.has(parent) && !firstChild.has(parent)) firstChild.set(parent, index);
	});
	/** Index of the nearest carried ancestor of the missing entry `id`, reached from `from`; -1 at the root. */
	const bridge = (id: string, from: number): number => {
		let cursor: string | null = id;
		const visited = new Set<string>();
		while (cursor && saved?.has(cursor) && !visited.has(cursor)) {
			visited.add(cursor);
			cursor = saved.get(cursor) ?? null;
			const carried = cursor ? indexById.get(cursor) : undefined;
			if (carried !== undefined) return carried;
		}
		if (!cursor) return -1;
		return (firstChild.get(cursor) ?? from) - 1;
	};
	let index = leafId ? indexById.get(leafId) : entries.length - 1;
	if (index === undefined) return [...entries];
	const path: T[] = [];
	const seen = new Set<number>();
	for (let entry = entries[index]; entry && !seen.has(index); entry = entries[index]) {
		seen.add(index);
		path.push(entry);
		if (!entry.parentId) break;
		index = indexById.get(entry.parentId) ?? bridge(entry.parentId, index);
	}
	return path.reverse();
}

interface RawEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	title?: string;
}

type TreeEntry = RawEntry & { id: string };

function isRawEntry(value: unknown): value is RawEntry {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

const EMPTY: SessionHistory = { header: null, entries: [], title: null, all: [] };

export function parseSessionHistory(text: string): SessionHistory {
	return extendSessionHistory(EMPTY, text);
}

/**
 * `history` plus the JSONL lines in `text` (what omp appended since). Earlier entries keep their
 * object identity so rendered rows stay memoized. Returns `history` itself when nothing changed.
 */
export function extendSessionHistory(history: SessionHistory, text: string): SessionHistory {
	// A trailing newline flushes the last line out of the parser's carry.
	const { items } = parseJsonl(`${text}\n`, "");
	let header = history.header;
	let slotTitle: string | null = null;
	const added: TreeEntry[] = [];
	for (const item of items) {
		if (!isRawEntry(item)) continue;
		if (item.type === "title") {
			slotTitle = item.title ?? slotTitle;
			continue;
		}
		if (item.type === "session") {
			// omp writes exactly one SessionHeader line; only its `type` discriminant is checked here.
			header = item as unknown as SessionHeader;
			continue;
		}
		if (item.id) added.push({ ...item, id: item.id });
	}
	const title = slotTitle ?? history.title ?? header?.title ?? null;
	if (added.length === 0 && header === history.header && title === history.title) return history;
	const all = added.length > 0 ? [...history.all, ...added] : history.all;
	// Entries on disk are omp's SessionEntry union; the transcript renderer tolerates unknown kinds.
	const entries = added.length > 0 ? (activeBranch(all) as unknown as SessionEntry[]) : history.entries;
	return { header, entries, title, all };
}
