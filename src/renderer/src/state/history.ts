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

/** Entries on the branch ending at `leafId` (default: the last entry), root → leaf. Unknown leaf → all entries. */
export function activeBranch<T extends TreeNode>(entries: readonly T[], leafId?: string | null): T[] {
	if (entries.length === 0) return [];
	const byId = new Map<string, T>();
	for (const entry of entries) byId.set(entry.id, entry);
	const leaf = leafId ? byId.get(leafId) : entries.at(-1);
	if (!leaf) return [...entries];
	const path: T[] = [];
	const seen = new Set<string>();
	let cursor: T | undefined = leaf;
	while (cursor && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		path.push(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
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
