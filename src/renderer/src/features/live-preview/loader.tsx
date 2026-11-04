import { useEffect } from "react";
import { create } from "zustand";
import { lazyView, LoadFailedNotice, type LoadFailureProps } from "../../registry/lazy";
import { useApp } from "../../state/app";

// Share the background load's recovery action with Outputs without importing the tracker eagerly.
const useTrackerFailure = create<{ retry: (() => void) | null }>(() => ({ retry: null }));

function TrackerFailed({ retry }: LoadFailureProps) {
	useEffect(() => {
		useTrackerFailure.setState({ retry });
		return () => { useTrackerFailure.setState({ retry: null }); };
	}, [retry]);
	return null;
}

const LazyTracker = lazyView(() => import("./Tracker").then(module => module.Tracker), null, TrackerFailed);

export function TrackerHost() {
	const enabled = useApp(state => state.prefs?.livePreview === true);
	// Turning previews off unmounts a failed boundary; turning them on starts a fresh load.
	return enabled ? <LazyTracker /> : null;
}

export function TrackerLoadNotice() {
	const enabled = useApp(state => state.prefs?.livePreview === true);
	const retry = useTrackerFailure(state => state.retry);
	return enabled && retry ? <LoadFailedNotice retry={retry} className="m-3 shrink-0" /> : null;
}
