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
