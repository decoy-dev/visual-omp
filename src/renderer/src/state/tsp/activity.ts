import type { TspHostSnapshot } from "@shared/tsp-host";
import { type ActivityHost, type ActivityRun, activityRun, type OmpActivity, ompActivity } from "@shared/tsp/activity";
import { useCallback, useMemo } from "react";
import { useSessionSelection } from "../../shell/hooks";
import type { SessionController } from "../session";
import { useVisualSelection } from "../visualSnapshot";
import { tspHost } from "./hosts";

export interface ShownActivity {
	label: string;
	/** When the app first saw this run, so switching chats or remounting keeps its elapsed time. */
	since: number;
	/** Escape cancels omp's loader and its compaction run, the key omp itself names for them. */
	stop(): void;
}

const runs = new WeakMap<SessionController, ActivityRun>();
const noSubscribe = () => () => {};
const noSnapshot = (): TspHostSnapshot | null => null;
const sameActivity = (a: OmpActivity | null, b: OmpActivity | null) => a?.key === b?.key && a?.label === b?.label;

/** The chat's current TSP host, read when Stop is chosen. */
function hostScope(session: SessionController): ActivityHost | null {
	const host = session.getSnapshot().host;
	return host?.transport === "tsp" ? { hostId: host.hostId, generation: host.generation, tspEpoch: host.tspEpoch } : null;
}

/**
 * omp's progress for its own work outside a model turn, such as /handoff writing its document or /compact
 * summarizing, read from the current TSP documents of this host process and protocol epoch
 * (`@shared/tsp/activity`). Readers re-render only when the label or run changes, never for each frame. Classic
 * chats show it in omp's terminal screen instead, and a model turn uses the collab working state.
 */
export function useOmpActivity(session: SessionController): ShownActivity | null {
	const scope = useSessionSelection(session, view => view?.mode === "live" && !view.readOnly && view.host?.transport === "tsp"
		? JSON.stringify([view.host.hostId, view.host.generation, view.host.tspEpoch ?? null]) : null);
	const host = useMemo((): ActivityHost | null => {
		if (!scope) return null;
		const [hostId, generation, tspEpoch] = JSON.parse(scope) as [string, number, number | null];
		return { hostId, generation, tspEpoch: tspEpoch ?? undefined };
	}, [scope]);
	const store = useMemo(() => host ? tspHost(host.hostId) : null, [host]);
	const select = useCallback((snapshot: TspHostSnapshot | null) => ompActivity(snapshot, host), [host]);
	const activity = useVisualSelection(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? noSnapshot, select, sameActivity);
	if (!activity || !store) {
		// A gap with no activity ends the run, so reused surface and node ids later start a new one.
		runs.delete(session);
		return null;
	}
	const run = activityRun(runs.get(session), activity, Date.now());
	runs.set(session, run);
	return {
		label: activity.label,
		since: run.since,
		// Only the displayed run is stopped: a click after it ended, after omp restarted, or after a later run reused
		// the same ids sends nothing.
		stop: () => {
			if (runs.get(session) === run && ompActivity(store.getSnapshot(), hostScope(session))?.key === activity.key) void session.keys("escape");
		},
	};
}
