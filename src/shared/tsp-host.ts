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

/** Input type follows main's validator without evaluating its schema in the renderer. */
export type { TspRendererEvent } from "./tsp-host.schema";

export const TSP_CLASSIC_ACTION_UNAVAILABLE = "omp screen: This action is not available for an omp screen chat. Open the omp screen to use its controls.";

/** Electron prefixes remote errors, so classification survives the invoke boundary. */
export function isTspInputError(error: unknown): boolean {
	return (error instanceof Error ? error.message : String(error)).includes("omp screen:");
}

export interface TspAvailability {
	available: boolean;
	reason: string | null;
	reasonCode?: "matched-question" | "ask-editor" | "btw";
	/** The blocking hook's matched request, so another pending question cannot authorize its bypass. */
	questionReqId?: number;
}

/** Main publishes these only after lifecycle and unrelated-UI guards; an ask prompt uses collab. */
export function tspAllowsAskPrompt(availability: TspAvailability | undefined, reqId: number): boolean {
	return availability?.available === true || availability?.reasonCode === "ask-editor"
		|| (availability?.reasonCode === "matched-question" && availability.questionReqId === reqId);
}

export interface TspComposerFacts {
	sendable: boolean;
	text: string;
	cursor: number;
	ghost: string;
	editorId: string | null;
	surfaceId: string | null;
	queued: string[];
	blockedBy: "ask" | "approval" | "panel" | null;
}

export interface TspEditorRestore {
	id: string;
	hostId: string;
	text: string;
	cleared: boolean;
	error: string | null;
}

/** Complete replacement snapshot. Revision orders an IPC subscription against its initial read. */
export interface TspHostSnapshot {
	hostId: string;
	generation: number;
	revision: number;
	/** Increments for each hello, including replacement omp processes on the same PTY. */
	epoch: number;
	/** Main sets this synchronously when application-driven shutdown starts. */
	closing?: boolean;
	availability: TspAvailability;
	composer?: TspComposerFacts;
	editorRestore?: TspEditorRestore | null;
	negotiated: boolean;
	/** Input/presentation authority, independent of protocol documents retained for adopt and credits. */
	lifecycle: "live" | "transitioning" | "failed" | "exited";
	documentGeneration: number | null;
	failure: string | null;
	/** Main-owned question authority and completion state for the current epoch and generation. */
	questionMatches?: QuestionMatch[];
	surfaces: (TspSurfaceSnapshot & { documentGeneration: number | null })[];
}
