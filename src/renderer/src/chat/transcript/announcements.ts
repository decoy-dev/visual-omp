import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { modelFallbacks, providerFallback, type ModelFallback } from "../../collab/lib/modelFallback";

export type TranscriptAnnouncement =
	| { id: string; fallback: ModelFallback }
	| { id: string; message: AssistantMessage };

/** One live channel, with provider blocks deduplicated across their streaming and saved forms. */
export class AnnouncementTracker {
	#session: string | null = null;
	#armed = false;
	#entries = new Set<string>();
	#providerBlocks = new Set<string>();
	#snapshot: readonly SessionEntry[] | null = null;

	update(entries: readonly SessionEntry[], stream: AssistantMessage | null, ready: boolean, session: string): TranscriptAnnouncement[] {
		if (session !== this.#session) {
			this.#session = session;
			this.#armed = false;
			this.#entries.clear();
			this.#providerBlocks.clear();
			this.#snapshot = null;
		}
		if (!ready) {
			this.#armed = false;
			return [];
		}
		const announce = this.#armed;
		const fallbacks = modelFallbacks(entries);
		const result: TranscriptAnnouncement[] = [];
		let latest: Extract<TranscriptAnnouncement, { message: AssistantMessage }> | null = null;
		const provider = (message: AssistantMessage) => {
			message.content.forEach((block, index) => {
				if (block.type !== "fallback") return;
				const fallback = providerFallback(block);
				if (!fallback) return;
				const id = JSON.stringify(["provider", message.timestamp, index, fallback.from, fallback.to]);
				if (this.#providerBlocks.has(id)) return;
				this.#providerBlocks.add(id);
				if (announce) result.push({ id, fallback });
			});
		};
		for (const entry of entries === this.#snapshot ? [] : entries) {
			if (this.#entries.has(entry.id)) continue;
			this.#entries.add(entry.id);
			const fallback = fallbacks.get(entry.id);
			if (announce && fallback) result.push({ id: entry.id, fallback });
			if (entry.type === "message" && entry.message.role === "assistant") {
				provider(entry.message);
				if (announce) latest = { id: entry.id, message: entry.message };
			}
		}
		this.#snapshot = entries;
		if (stream) provider(stream);
		this.#armed = true;
		if (latest) result.push(latest);
		return result;
	}
}
