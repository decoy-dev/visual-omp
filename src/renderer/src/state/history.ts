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

function isRawEntry(value: unknown): value is RawEntry {
	return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export function parseSessionHistory(text: string): SessionHistory {
	// A trailing newline flushes the last line out of the parser's carry.
	const { items } = parseJsonl(`${text}\n`, "");
	let header: SessionHeader | null = null;
	let title: string | null = null;
	const entries: (RawEntry & { id: string })[] = [];
	for (const item of items) {
		if (!isRawEntry(item)) continue;
		if (item.type === "title") {
			title = item.title ?? title;
			continue;
		}
		if (item.type === "session") {
			// omp writes exactly one SessionHeader line; only its `type` discriminant is checked here.
			header = item as unknown as SessionHeader;
			continue;
		}
		if (item.id) entries.push({ ...item, id: item.id });
	}
	// Entries on disk are omp's SessionEntry union; the transcript renderer tolerates unknown kinds.
	return { header, entries: activeBranch(entries) as unknown as SessionEntry[], title: title ?? header?.title ?? null };
}
