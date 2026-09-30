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
