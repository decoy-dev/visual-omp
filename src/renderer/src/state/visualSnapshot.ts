import { useMemo, useSyncExternalStore } from "react";

type Subscribe = (listener: () => void) => () => void;

/** Pause only React's view of a store. Semantic subscribers and the source remain live. */
export function useVisualSnapshot<T>(subscribe: Subscribe, getSnapshot: () => T): T {
	const visual = useMemo(() => {
		let snapshot = getSnapshot();
		return {
			getSnapshot: () => {
				// Retain identity while hidden, including renders caused by an unrelated parent.
				if (typeof document === "undefined" || document.visibilityState !== "hidden") snapshot = getSnapshot();
				return snapshot;
			},
			subscribe: (listener: () => void) => {
				const notify = () => { if (document.visibilityState !== "hidden") listener(); };
				const off = subscribe(notify);
				document.addEventListener("visibilitychange", notify);
				return () => {
					off();
					document.removeEventListener("visibilitychange", notify);
				};
			},
		};
	}, [subscribe, getSnapshot]);
	return useSyncExternalStore(visual.subscribe, visual.getSnapshot, getSnapshot);
}
