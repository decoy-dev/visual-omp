import { z } from "zod";

const count = z.number().int().nonnegative().finite();

/** Explicit projection only: chat content, credentials and unknown fields are discarded. */
export const completionDiagnosticSchema = z.object({
	chatId: z.uuid(),
	edgeId: z.uuid(),
	cause: z.enum(["agent_end", "state", "welcome", "async-wait-settle", "host-exit"]),
	phase: z.enum(["connecting", "waiting", "live", "reconnecting", "ended"]).nullable(),
	isTerminal: z.boolean().nullable(),
	willContinue: z.boolean().nullable(),
	awaitingAsyncWork: z.boolean().nullable(),
	isStreaming: z.boolean().nullable(),
	sinceStreamingMs: count.nullable(),
	runningHelpers: count,
	finished: z.enum(["emitted", "suppressed"]),
	notificationRequested: z.boolean(),
	suppressedReason: z.enum(["continuing", "resumed", "queued", "host-exit"]).nullable(),
});

export type CompletionDiagnostic = z.infer<typeof completionDiagnosticSchema>;

/** Compact renderer wire format. Tuple validation rejects trailing positional/private data. */
export const compactCompletionDiagnosticSchema = z.tuple([
	z.uuid(),
	z.number().nonnegative().finite(),
	count,
	count.max(4),
	count.max(4),
	count.max(255).refine(flags => [0, 2, 4, 6].every(shift => ((flags >> shift) & 3) !== 3)),
	z.number().nonnegative().finite().nullable(),
	count,
	count.max(19),
]);

export type CompactCompletionDiagnostic = z.infer<typeof compactCompletionDiagnosticSchema>;
