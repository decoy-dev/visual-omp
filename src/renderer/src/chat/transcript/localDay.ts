import { useSyncExternalStore } from "react";

function midnight(): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

let day = midnight();
let timer: number | undefined;
const listeners = new Set<() => void>();

function refresh(): void {
	const next = midnight();
	if (day !== next) {
		day = next;
		for (const listener of listeners) listener();
	}
	clearTimeout(timer);
	const now = new Date();
	const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
	timer = window.setTimeout(refresh, Math.max(1, nextMidnight - now.getTime()));
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		refresh();
		window.addEventListener("focus", refresh);
		document.addEventListener("visibilitychange", refresh);
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) {
			clearTimeout(timer);
			timer = undefined;
			window.removeEventListener("focus", refresh);
			document.removeEventListener("visibilitychange", refresh);
		}
	};
}

/** One local-midnight timer serves every timestamp, including memoized transcript rows. */
export function useLocalDay(): number {
	return useSyncExternalStore(subscribe, () => day, midnight);
}
