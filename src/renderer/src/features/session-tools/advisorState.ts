import type { AdvisorScope } from "@shared/contracts/advisor";
import type { SessionController } from "../../state/session";

/** Per-chat application state survives sheet unmounts and scope changes, without retaining closed controllers. */
class AdvisorApplication {
	#pending: ReadonlySet<AdvisorScope> = new Set();
	#listeners = new Set<() => void>();
	subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
	getSnapshot = (): ReadonlySet<AdvisorScope> => this.#pending;
	set(scope: AdvisorScope, pending: boolean): void {
		if (this.#pending.has(scope) === pending) return;
		const next = new Set(this.#pending);
		if (pending) next.add(scope); else next.delete(scope);
		this.#pending = next;
		for (const listener of this.#listeners) listener();
	}
}
const applications = new WeakMap<SessionController, AdvisorApplication>();
export function advisorApplication(session: SessionController): AdvisorApplication {
	let state = applications.get(session);
	if (!state) { state = new AdvisorApplication(); applications.set(session, state); }
	return state;
}
