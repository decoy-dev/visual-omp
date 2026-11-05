/**
 * Shared types of the live preview stage (docs/LIVE-PREVIEW.md). `subjects.ts` turns a chat's collab snapshot and the
 * preview watcher's changes into `LiveSubject`s; `formats/` draws them; the Outputs pane's stage arranges them.
 */
import type { ComponentType } from "react";
import type { PreviewSequencePattern } from "@shared/contracts/preview";
import type { LiveProgress } from "./progress";

/** How the app learns about the output while omp makes it. */
export type LiveSubjectKind =
	/** The file's text, streamed in a `write` call's arguments. */
	| "source"
	/** A visual file a running call saved, reported by the preview watcher. */
	| "file"
	/** A `generate_image` request while omp writes its arguments or waits for the provider. */
	| "request"
	/** Images a running call reported in its partial result (eval cells). */
	| "images"
	/** A recognized renderer, before its output is stable on disk. */
	| "render";

export type LiveFormat = "svg" | "mermaid" | "html" | "markdown" | "csv" | "image" | "pdf" | "video" | "sequence" | "generate-image" | "result-images";

export type LiveSubjectState =
	/** omp is still writing the call's arguments. */
	| "writing"
	/** The call runs, or a file is still changing. */
	| "running"
	| "saved"
	/** The turn was stopped before the call finished. */
	| "stopped"
	/** The tool reported an error. */
	| "failed"
	/** omp skipped the call, for example for a queued steer. */
	| "skipped";

export interface LiveImage {
	mimeType: string;
	/** Base64 without a `data:` prefix. */
	data: string;
}

export interface LiveRequest {
	prompt: string | null;
	model: string | null;
	size: string | null;
	aspectRatio: string | null;
	count: number | null;
}

export interface LiveSubject {
	/** Stable across revisions: `call:<toolCallId>` for tool-call subjects, `file:<absolute path>` for watcher files. */
	id: string;
	kind: LiveSubjectKind;
	format: LiveFormat;
	toolCallId: string | null;
	toolName: string | null;
	/** Absolute path when known. */
	path: string | null;
	/** Streamed source text for `source` subjects; null otherwise. */
	text: string | null;
	/** Increases whenever what the subject shows changes. Starts at 1. */
	revision: number;
	state: LiveSubjectState;
	/** The streamed text contains collab's elision marker, so only the saved file is complete. */
	elided: boolean;
	/** omp's intent line for the call, when it sent one. */
	intent: string | null;
	request: LiveRequest | null;
	images: readonly LiveImage[] | null;
	progress: LiveProgress | null;
	sequence: { pattern: PreviewSequencePattern; count: number } | null;
	/** Byte length of `text`, or the file size the watcher reported. */
	size: number | null;
	/** Epoch ms of the first sighting and of the latest change. */
	startedAt: number;
	updatedAt: number;
}

export interface LiveFrameProps {
	subject: LiveSubject;
	/** The chat's folder, used as the protocol's asset root when it is not broad. */
	projectPath: string | null;
	/** Absolute paths omp's calls in the same turn wrote or named, for grants in broad folders. */
	related: readonly string[];
}

export interface LiveAdapter {
	format: LiveFormat;
	/** The most renders per second the stage asks for; the stage coalesces updates above it. */
	maxFps: number;
	Frame: ComponentType<LiveFrameProps>;
}
