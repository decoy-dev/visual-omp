import { useMemo, useSyncExternalStore } from "react";
import { tspHost, type TspHostSource } from "./hosts";

const none: TspHostSource = { hostId: "", getSnapshot: () => null, failed: () => false, subscribe: () => () => {} };

/** The host's shared omp screen documents; every component reading one host shares one copy. */
export function useTsp(hostId: string | null) {
	const store = useMemo(() => hostId ? tspHost(hostId) : none, [hostId]);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	const failed = useSyncExternalStore(store.subscribe, store.failed);
	return { snapshot, failed, store };
}
