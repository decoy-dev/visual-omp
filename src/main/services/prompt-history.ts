import { DatabaseSync } from "node:sqlite";
import type { PromptHistoryItem } from "@shared/ipc";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional upstream data: never create, migrate or write omp's database. */
export function readPromptHistory(file: string, sessionId: unknown): PromptHistoryItem[] {
	if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return [];
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
		const table = db.prepare("SELECT type FROM sqlite_master WHERE name = 'history'").get();
		if (table?.type !== "table") return [];
		const columns = db.prepare("PRAGMA table_info(history)").all();
		for (const [name, type] of [["id", "INTEGER"], ["prompt", "TEXT"], ["created_at", "INTEGER"], ["session_id", "TEXT"]]) {
			if (!columns.some(column => column.name === name && column.type === type)) return [];
		}
		const rows = db.prepare("SELECT prompt, created_at FROM history WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 100").all(sessionId);
		return rows.flatMap(row => typeof row.prompt === "string" && typeof row.created_at === "number" && Number.isFinite(row.created_at)
			? [{ text: row.prompt, timestamp: row.created_at * 1000 }]
			: []).reverse();
	} catch {
		// Missing or unavailable databases and a busy writer must leave transcript history usable.
		return [];
	} finally {
		db?.close();
	}
}
