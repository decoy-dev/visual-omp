import { runningHelpers } from "../features/panes/derive";
import type { SessionView } from "./session";

/** What closing a chat or quitting the app would stop in it: omp's reply in progress and its helpers at work. */
export interface ChatWork {
	/** omp's own turn is running (`SessionView.working`). */
	replying: boolean;
	/** Helpers working now, by the Tasks badge's rule (`runningHelpers`): none without a running omp. */
	helpers: number;
}

/** The work in flight in a chat, or null when closing it stops nothing that runs. */
export function workInFlight(view: SessionView | null): ChatWork | null {
	if (!view) return null;
	const work = { replying: view.working, helpers: runningHelpers(view) };
	return work.replying || work.helpers > 0 ? work : null;
}
