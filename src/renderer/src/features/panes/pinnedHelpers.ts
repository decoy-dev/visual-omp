/**
 * Helpers pinned at the bottom of the chat (DESIGN §3.5): while a helper of this chat runs, it shows in the strip
 * above the composer instead of as a card under its task call, so running work stays in view. Once it stops running
 * (done, failed or stopped) it leaves the strip, and its card is back under its call in the transcript.
 */
import { useMemo } from "react";
import type { SessionView } from "../../state/session";
import { type Helper, helpersOf, helpersMayRun } from "./derive";

export interface PinnedHelpers {
	/** Running helpers, in `helpersOf` order. */
	all: readonly Helper[];
	/** Ids of every running helper: their cards stay out of the transcript while pinned. */
	ids: ReadonlySet<string>;
}

/** Which of the chat's helpers pin: the running ones. A stale mirror (`helpersOf` without a running omp) pins none. */
export function pinnedHelpers(helpers: readonly Helper[]): PinnedHelpers {
	const all = helpers.filter(helper => helper.status === "running");
	return { all, ids: new Set(all.map(helper => helper.id)) };
}

/** The helper cards a task call shows under it: those not pinned at the bottom of the chat. */
export function unpinnedRuns(runs: readonly Helper[], pinned: ReadonlySet<string>): readonly Helper[] {
	return pinned.size === 0 ? runs : runs.filter(run => !pinned.has(run.id));
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The chat's pinned helpers from its live mirror, with `ids` kept the same object while the same helpers run, so rows
 * compare it by identity and progress reports alone re-render nothing but the strip.
 */
export function usePinnedHelpers(view: SessionView | null | undefined): PinnedHelpers {
	const agents = view?.guest?.agents;
	const progress = view?.guest?.progress;
	const lifecycle = view?.guest?.lifecycle;
	const live = helpersMayRun(view);
	const pinned = useMemo(
		() => pinnedHelpers(helpersOf(agents && progress && lifecycle ? { agents, progress, lifecycle } : null, live)),
		[agents, progress, lifecycle, live],
	);
	const key = [...pinned.ids].join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the ids' identity follows their content (`key`).
	const ids = useMemo(() => (pinned.ids.size === 0 ? NONE : pinned.ids), [key]);
	return useMemo(() => ({ ...pinned, ids }), [pinned, ids]);
}
