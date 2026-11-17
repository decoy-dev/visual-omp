import { readFile } from "node:fs/promises";
import { compactAtValue } from "@shared/compaction";
import { writeText } from "../files";

/**
 * Per-chat compaction points, keyed by omp session id, in one JSON file of the app's profile. A chat's host
 * passes its value to omp through the chat's config overlay; chats without an entry use omp's own settings.
 */
export interface ChatCompactionStore {
	get(sessionId: string): Promise<number | null>;
	/** Saves `tokens` for the session; null removes its entry. */
	set(sessionId: string, tokens: number | null): Promise<void>;
}

export function createChatCompactionStore(file: string): ChatCompactionStore {
	let entries: ReadonlyMap<string, number> | null = null;
	let writes: Promise<void> = Promise.resolve();
	// A missing file holds no points. An unreadable or malformed one is reported, never overwritten.
	const load = async (): Promise<ReadonlyMap<string, number>> => {
		if (entries) return entries;
		let text: string;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			entries ??= new Map();
			return entries;
		}
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} does not hold saved compaction points.`);
		const next = new Map<string, number>();
		for (const [sessionId, value] of Object.entries(parsed)) {
			const tokens = compactAtValue(value);
			if (tokens !== null) next.set(sessionId, tokens);
		}
		entries ??= next;
		return entries;
	};
	return {
		async get(sessionId) {
			return (await load()).get(sessionId) ?? null;
		},
		set(sessionId, tokens) {
			// The whole read, change and write runs in order, and the change is kept only once it is on disk.
			const write = writes.then(async () => {
				const next = new Map(await load());
				if (tokens === null) next.delete(sessionId);
				else next.set(sessionId, tokens);
				await writeText(file, JSON.stringify(Object.fromEntries(next), null, 2) + "\n");
				entries = next;
			});
			// Keep the queue alive after a failed write; this caller still sees the error.
			writes = write.catch(() => {});
			return write;
		},
	};
}
