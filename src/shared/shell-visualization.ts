import type { TspShellProps } from "./tsp/shell";

export interface ShellOpenRequest {
	requestId: string;
	file: string;
	toolCallId: string;
}
/** A collab-owned observed trace, used only by the isolated presentation process. */
export interface ShellSnapshotSource {
	sourceId: string;
	cwd: string;
	/** Per-result execution folder; cwd above remains the chat's effective-setting scope. */
	executionCwd?: string;
	cdSeparator?: ";";
	json: string;
	sourceRevision: number;
}
export interface ShellSnapshotOpenRequest extends ShellSnapshotSource {
	requestId: string;
	toolCallId: string;
}
export interface ShellSnapshotUpdateRequest {
	handle: string;
	sourceId: string;
	sourceRevision: number;
	json: string;
	executionCwd?: string;
	cdSeparator?: ";";
}
export type ShellFailureReason = "unavailable" | "too-large" | "disabled" | "cancelled" | "timeout" | "memory" | "crash";
export interface ShellFrame {
	handle: string;
	revision: number;
	props: TspShellProps;
	cdSeparator?: ";";
	/** Present only for explicitly supplied classic-host trace snapshots. */
	sourceRevision?: number;
}
export type ShellResult = ({ status: "ready" } & ShellFrame) | { status: "unavailable"; reason: ShellFailureReason };
export interface ShellInvalidation {
	handles: string[];
	reason: ShellFailureReason;
}
