import { TspDocumentStore } from "@shared/tsp/document";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

/** Subscribe before fetching. Revision ordering rejects a late initial read. */
export function useTsp(hostId: string | null) {
	const store = useMemo(() => new TspDocumentStore(), [hostId]);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (!hostId) return;
		let live = true;
		setFailed(false);
		const accept = (next: Parameters<TspDocumentStore["accept"]>[0] | null) => {
			if (live && next?.hostId === hostId) { store.accept(next); setFailed(false); }
		};
		const off = window.vomp.on("host:tsp-update", accept);
		void window.vomp.invoke("host:tsp-snapshot", hostId).then(accept).catch(() => { if (live && !store.getSnapshot()) setFailed(true); });
		return () => { live = false; off(); };
	}, [hostId, store]);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
	return { snapshot, failed, store };
}
