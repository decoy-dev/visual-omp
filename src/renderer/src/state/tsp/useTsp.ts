import { useMemo } from "react";
import { useVisualSnapshot } from "../visualSnapshot";
import { tspHost, type TspHostSource } from "./hosts";

const none: TspHostSource = { hostId: "", getSnapshot: () => null, failed: () => false, subscribe: () => () => {} };

/** The host's shared omp screen documents; every component reading one host shares one copy. */
export function useTsp(hostId: string | null) {
	const store = useMemo(() => hostId ? tspHost(hostId) : none, [hostId]);
	const snapshot = useVisualSnapshot(store.subscribe, store.getSnapshot);
	const failed = useVisualSnapshot(store.subscribe, store.failed);
	return { snapshot, failed, store };
}
