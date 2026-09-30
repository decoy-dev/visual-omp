/**
 * Read-only transcript for a saved omp session file, shown instantly before omp resumes it.
 * Mirrors omp's load rule (docs/session.md, `buildSessionContext`): the leaf is the last entry,
 * and the displayed branch is the parentId path from the root to that leaf.
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
	const byId = new Map<string, RawEntry>();
	let last: RawEntry | null = null;
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
		if (!item.id) continue;
		byId.set(item.id, item);
		last = item;
	}
	const path: RawEntry[] = [];
	const seen = new Set<string>();
	let cursor = last;
	while (cursor?.id && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		path.push(cursor);
		cursor = cursor.parentId ? (byId.get(cursor.parentId) ?? null) : null;
	}
	path.reverse();
	// Entries on disk are omp's SessionEntry union; the transcript renderer tolerates unknown kinds.
	return { header, entries: path as unknown as SessionEntry[], title: title ?? header?.title ?? null };
}
