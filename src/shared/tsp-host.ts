import { z } from "zod";
import type { TspNode, TspOpen } from "./tsp";
import type { QuestionMatch } from "./tsp/question-match";

/** Read-only inspection of an omp-owned surface, including retained main content after close. */
export interface TspSurfaceSnapshot {
	open: TspOpen;
	sequence: number;
	closed: boolean;
	document: TspNode;
	focus: string | null;
	suspended: boolean;
	settled: string[];
}

const Target = { sf: z.string().min(1), id: z.string().min(1) };
const Offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Edit = z.strictObject({
	ev: z.literal("edit"), ...Target, from: Offset, to: Offset, text: z.string(), cursor: Offset, len: Offset,
}).refine(event => event.from <= event.to && event.to <= event.len && event.cursor <= event.len - (event.to - event.from) + event.text.length, "Invalid UTF-16 edit range");

/** Untrusted renderer input. Main alone owns protocol lifecycle, credits and environment events. */
export const TspRendererEvent = z.discriminatedUnion("ev", [
	z.strictObject({ ev: z.literal("visible"), sf: z.string().min(1), visible: z.boolean() }),
	z.strictObject({ ev: z.literal("toggle"), ...Target, key: z.string().optional(), collapsed: z.boolean() }),
	z.strictObject({ ev: z.literal("select"), ...Target, item: z.string() }),
	z.strictObject({ ev: z.literal("activate"), ...Target, item: z.string() }),
	z.strictObject({ ev: z.literal("action"), ...Target, act: z.string().min(1), value: z.string().optional(), mods: z.array(z.string()).optional() }),
	z.strictObject({ ev: z.literal("change"), ...Target, item: z.string(), value: z.union([z.boolean(), z.number().finite(), z.string(), z.array(z.string()), z.null()]) }),
	Edit,
	z.strictObject({ ev: z.literal("undo"), ...Target }),
	z.strictObject({ ev: z.literal("send"), ...Target, text: z.string() }),
	z.strictObject({ ev: z.literal("focus"), ...Target }),
]);
export type TspRendererEvent = z.infer<typeof TspRendererEvent>;

export const TSP_PREVIEW_UNAVAILABLE = "TSP preview: This action is not available in the TSP preview yet. Relaunch without VOMP_TSP to use the classic controls.";

/** Electron prefixes remote errors, so classification survives the invoke boundary. */
export function isTspPreviewInputError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).includes("TSP preview:");
}

export interface TspAvailability {
	available: boolean;
	reason: string | null;
}

/** Complete replacement snapshot. Revision orders an IPC subscription against its initial read. */
export interface TspHostSnapshot {
	hostId: string;
	generation: number;
	revision: number;
	/** Increments for each hello, including replacement omp processes on the same PTY. */
	epoch: number;
	availability: TspAvailability;
	negotiated: boolean;
	/** Input/presentation authority, independent of protocol documents retained for adopt and credits. */
	lifecycle: "live" | "transitioning" | "failed" | "exited";
	documentGeneration: number | null;
	failure: string | null;
	/** Arbitration diagnostics only. Hook input remains disabled pending live ordering evidence. */
	questionMatches?: QuestionMatch[];
	surfaces: (TspSurfaceSnapshot & { documentGeneration: number | null })[];
}
