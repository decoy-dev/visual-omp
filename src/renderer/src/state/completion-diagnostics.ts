import type { CompactCompletionDiagnostic } from "@shared/completion-diagnostics";
import type { GuestSnapshot } from "../collab/lib/client";

let nextEdge = 0;

/** Optional diagnostic work stays outside the renderer entry and sends no transcript data. */
export function reportCompletion(chatId: string, snapshot: GuestSnapshot | null, result: number): Promise<void> {
	const evidence = snapshot?.completion;
	const origin = result === 16 ? 4 : evidence?.[1];
	if (origin === undefined) return Promise.resolve();
	let helpers = 0;
	for (const agent of snapshot?.agents ?? []) if (agent.kind === "sub" && agent.status === "running") helpers++;
	const phase = snapshot ? ["connecting", "waiting", "live", "reconnecting", "ended"].indexOf(snapshot.phase) : 4;
	const payload: CompactCompletionDiagnostic = [chatId, performance.timeOrigin, ++nextEdge, origin & 7, phase, origin >> 3, snapshot?.lastStreamingAt ?? null, helpers, result];
	return window.vomp.invoke("app:completionDiagnostic", payload);
}
