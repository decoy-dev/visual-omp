/**
 * Shared `usage:limits` snapshot for passive readouts (the status bar's plan usage). It polls only
 * while something subscribes and the window is visible: on start, every minute, when a chat's turn
 * finishes, and when a reader asks (the chat's providers changed). Passive reads invoke
 * `omp usage --json` without explicitly invalidating omp's cache. The Usage & limits refresh button
 * requests invalidation and publishes the resulting snapshot here.
 */
import { useSyncExternalStore } from "react";
import type { UsageLimitsSnapshot } from "@shared/contracts/usage";
import { allControllers, useApp } from "@/state/app";
import type { SessionController } from "@/state/session";

const POLL_MS = 60_000;

let snapshot: UsageLimitsSnapshot | null = null;
let inFlight: Promise<void> | null = null;
let timer: number | null = null;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

/**
 * Replaces the snapshot (a successful read here or in the Usage & limits sheet). A snapshot omp
 * generated before the current one is dropped, so a slow passive read cannot overwrite the result of
 * a manual refresh that finished first.
 */
export function publishUsageLimits(next: UsageLimitsSnapshot): void {
	if (snapshot && next.generatedAt < snapshot.generatedAt) return;
	snapshot = next;
	for (const listener of listeners) listener();
}

/**
 * Reads omp's limits without invalidating its cache; joins a read already running and keeps the last
 * good snapshot on failure. Resolves once that read has settled (immediately when none starts).
 */
export function refreshUsageLimits(): Promise<void> {
	if (inFlight) return inFlight;
	if (listeners.size === 0 || document.visibilityState === "hidden") return Promise.resolve();
	inFlight = window.vomp
		.invoke("usage:limits")
		.then(publishUsageLimits, () => undefined)
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

function syncPolling(): void {
	const active = listeners.size > 0 && document.visibilityState === "visible";
	if (active && !timer) {
		void refreshUsageLimits();
		timer = window.setInterval(refreshUsageLimits, POLL_MS);
	} else if (!active && timer) {
		clearInterval(timer);
		timer = null;
	}
}

/** Refreshes after any chat finishes a turn, attaching to chats as their tabs open and letting closed ones go. */
function watchTurns(): () => void {
	const detach = new Map<SessionController, () => void>();
	const attach = () => {
		const live = allControllers();
		for (const [controller, off] of detach) {
			if (live.includes(controller)) continue;
			off();
			detach.delete(controller);
		}
		for (const controller of live) {
			if (detach.has(controller)) continue;
			detach.set(
				controller,
				controller.onEvent(event => {
					if (event.kind === "finished") void refreshUsageLimits();
				}),
			);
		}
	};
	attach();
	const unsubscribe = useApp.subscribe(attach);
	return () => {
		unsubscribe();
		for (const off of detach.values()) off();
	};
}

/** Starts polling with the first listener and stops after the last; exported for tests. */
export function subscribeUsageLimits(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		document.addEventListener("visibilitychange", syncPolling);
		stopWatching = watchTurns();
	}
	syncPolling();
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		document.removeEventListener("visibilitychange", syncPolling);
		stopWatching?.();
		stopWatching = null;
		syncPolling();
	};
}

const idle = () => () => {};

/** The current snapshot; exported for tests. */
export function usageLimitsSnapshot(): UsageLimitsSnapshot | null {
	return snapshot;
}

/** The latest limits snapshot (null until the first read succeeds); polls only while `active`. */
export function useUsageLimits(active: boolean): UsageLimitsSnapshot | null {
	return useSyncExternalStore(active ? subscribeUsageLimits : idle, usageLimitsSnapshot);
}
