import { randomUUID } from "node:crypto";
import { compactCompletionDiagnosticSchema, type CompletionDiagnostic } from "@shared/completion-diagnostics";

const MINUTE_MS = 60_000;
const MAX_PER_MINUTE = 30;
const MAX_RETAINED_EDGES = 4096;

/** Global rolling quota, with bounded per-renderer dedup retained across reloads of its WebContents. */
export class CompletionDiagnosticIngestor {
	#edges = new WeakMap<object, Set<string>>();
	#acceptedAt: number[] = [];

	/** `now` is monotonic milliseconds. Rejected input never consumes quota or reaches the writer. */
	accept(renderer: object, payload: unknown, now: number, wallNow: number): CompletionDiagnostic | null {
		const result = compactCompletionDiagnosticSchema.safeParse(payload);
		if (!result.success) return null;
		const [chatId, rendererEpoch, edge, cause, phase, flags, lastStreamingAt, runningHelpers, decision] = result.data;
		const key = `${rendererEpoch}:${edge}`;
		let edges = this.#edges.get(renderer);
		if (edges?.has(key)) return null;
		while (this.#acceptedAt.length && now - this.#acceptedAt[0]! >= MINUTE_MS) this.#acceptedAt.shift();
		if (this.#acceptedAt.length >= MAX_PER_MINUTE) return null;
		if (!edges) {
			edges = new Set();
			this.#edges.set(renderer, edges);
		}
		edges.add(key);
		if (edges.size > MAX_RETAINED_EDGES) edges.delete(edges.values().next().value!);
		this.#acceptedAt.push(now);
		const observations = [null, false, true] as const;
		return {
			chatId, edgeId: randomUUID(),
			cause: (["agent_end", "state", "welcome", "async-wait-settle", "host-exit"] as const)[cause]!,
			phase: (["connecting", "waiting", "live", "reconnecting", "ended"] as const)[phase]!,
			isTerminal: observations[flags & 3]!,
			willContinue: observations[(flags >> 2) & 3]!,
			awaitingAsyncWork: observations[(flags >> 4) & 3]!,
			isStreaming: observations[(flags >> 6) & 3]!,
			sinceStreamingMs: lastStreamingAt === null ? null : Math.max(0, Math.floor(wallNow - lastStreamingAt)),
			runningHelpers,
			finished: decision & 1 ? "emitted" : "suppressed",
			notificationRequested: Boolean(decision & 2),
			suppressedReason: ([null, "continuing", "resumed", "queued", "host-exit"] as const)[decision >> 2]!,
		};
	}
}
