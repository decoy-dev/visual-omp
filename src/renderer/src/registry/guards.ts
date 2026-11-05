/**
 * Confirmation hook for closing a chat while omp is working. The onboarding feature installs the
 * quit-warning dialog here; without one, closing proceeds.
 */
export type TabCloseGuard = (tabId: string) => Promise<boolean>;

let guard: TabCloseGuard | null = null;

export function setTabCloseGuard(next: TabCloseGuard): void {
	guard = next;
}

export function confirmTabClose(tabId: string): Promise<boolean> {
	return guard ? guard(tabId) : Promise.resolve(true);
}

/** Bulk close always asks once, including when no chat is working. */
let allTabsGuard: ((tabIds: readonly string[]) => Promise<boolean>) | null = null;

export function setAllTabsCloseGuard(next: (tabIds: readonly string[]) => Promise<boolean>): void {
	allTabsGuard = next;
}

export function confirmAllTabsClose(tabIds: readonly string[]): Promise<boolean> {
	return allTabsGuard ? allTabsGuard(tabIds) : Promise.resolve(false);
}

/** A pane can finish its omp-owned interaction before the panel releases its presentation. */
type PaneLeaveGuard = () => Promise<boolean>;
const paneLeaveGuards = new Map<string, PaneLeaveGuard>();

export function setPaneLeaveGuard(scope: string, guard: PaneLeaveGuard): () => void {
	paneLeaveGuards.set(scope, guard);
	return () => { if (paneLeaveGuards.get(scope) === guard) paneLeaveGuards.delete(scope); };
}

export function preparePaneLeave(scope: string): Promise<boolean> | undefined {
	return paneLeaveGuards.get(scope)?.();
}

/**
 * Saved chats this large get a warning before omp resumes them. It is a precautionary heuristic, not an omp limit,
 * and smaller files are not promised to be safe: a 70.5 MB chat stopped answering Stop after it resumed.
 */
export const LARGE_RESUME_BYTES = 32 * 1024 * 1024;

export interface ResumeRequest {
	tabId: string;
	projectPath: string;
	file: string;
	bytes: number;
	/** Aborted when the chat closes while the question is open; the guard then answers no. */
	signal: AbortSignal;
}

/** Resolves true when omp may resume the file. The session-tools feature installs the warning dialog. */
export type ResumeGuard = (request: ResumeRequest) => Promise<boolean>;

let resumeGuard: ResumeGuard | null = null;

export function setResumeGuard(next: ResumeGuard): void {
	resumeGuard = next;
}

export function confirmLargeResume(request: ResumeRequest): Promise<boolean> {
	return resumeGuard ? resumeGuard(request) : Promise.resolve(true);
}

/** The user chose not to resume a large saved chat. Callers drop it without reporting an error. */
export class ResumeDeclinedError extends Error {
	constructor() {
		super("The chat was not resumed.");
		this.name = "ResumeDeclinedError";
	}
}

export function isResumeDeclined(error: unknown): error is ResumeDeclinedError {
	return error instanceof ResumeDeclinedError;
}
