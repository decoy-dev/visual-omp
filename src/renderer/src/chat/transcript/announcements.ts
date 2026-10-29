import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { modelFallbacks, providerFallback, type ModelFallback } from "../../collab/lib/modelFallback";
import type { ActiveTool } from "../../collab/lib/client";
import { isReplyWrite, toolResultReplies } from "../friendly";

export type TranscriptAnnouncement =
	| { id: string; fallback: ModelFallback }
	| { id: string; message: AssistantMessage }
	| { id: string; text: string };

/** One live channel, with provider blocks deduplicated across their streaming and saved forms. */
export class AnnouncementTracker {
	#session: string | null = null;
	#armed = false;
	#entries = new Set<string>();
	#providerBlocks = new Set<string>();
	#snapshot: readonly SessionEntry[] | null = null;
	#toolReplies = new Set<string>();

	update(entries: readonly SessionEntry[], stream: AssistantMessage | null, ready: boolean, session: string, active?: ReadonlyMap<string, ActiveTool>): TranscriptAnnouncement[] {
		if (session !== this.#session) {
			this.#session = session;
			this.#armed = false;
			this.#entries.clear();
			this.#providerBlocks.clear();
			this.#toolReplies.clear();
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
		const replies = (callId: string, details: unknown) => {
			for (const [index, text] of toolResultReplies(details).entries()) {
				const id = `tool-reply:${callId}:${index}`;
				if (this.#toolReplies.has(id)) continue;
				this.#toolReplies.add(id);
				if (announce) result.push({ id, text });
			}
		};
		for (const entry of entries === this.#snapshot ? [] : entries) {
			if (this.#entries.has(entry.id)) continue;
			this.#entries.add(entry.id);
			const fallback = fallbacks.get(entry.id);
			if (announce && fallback) result.push({ id: entry.id, fallback });
			if (entry.type === "message" && entry.message.role === "assistant") {
				provider(entry.message);
				for (const block of entry.message.content) {
					if (block.type !== "toolCall" || !isReplyWrite(block.name, block.arguments)) continue;
					const text = block.arguments.content;
					if (announce && typeof text === "string" && text.trim()) result.push({ id: `write-reply:${block.id}`, text });
				}
				if (announce) latest = { id: entry.id, message: { ...entry.message, content: entry.message.content.filter(block => block.type !== "toolCall" || !isReplyWrite(block.name, block.arguments)) } };
			}
			if (entry.type === "message" && entry.message.role === "toolResult") replies(entry.message.toolCallId, entry.message.details);
		}
		this.#snapshot = entries;
		if (stream) provider(stream);
		for (const tool of active?.values() ?? []) {
			const partial = tool.partialResult;
			if (partial && typeof partial === "object" && "details" in partial) replies(tool.toolCallId, partial.details);
		}
		this.#armed = true;
		if (latest) result.push(latest);
		return result;
	}
}
