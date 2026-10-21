/**
 * Shared `usage:limits` snapshot for the status bar's plan usage and the Usage & limits page. It polls
 * only while something subscribes and the window is visible: on start, every minute, when a chat's
 * turn finishes, and when a reader asks (the chat's providers changed, the page opened). Passive reads
 * invoke `omp usage --json` without explicitly invalidating omp's cache; the page's "Refresh limits"
 * ({@link checkUsageLimits}) requests invalidation. A failed read keeps the last good snapshot and
 * records why in {@link UsageLimitsStatus}.
 */
import { useSyncExternalStore } from "react";
import type { UsageLimitsSnapshot } from "@shared/contracts/usage";
import { allControllers, useApp } from "@/state/app";
import type { SessionController } from "@/state/session";
import { errorText } from "../format";

const POLL_MS = 60_000;

/** Whether a read is running and how the last one to settle ended. */
export interface UsageLimitsStatus {
	checking: boolean;
	/** Why the last settled read failed; null after a success. */
	error: string | null;
}

let snapshot: UsageLimitsSnapshot | null = null;
let status: UsageLimitsStatus = { checking: false, error: null };
let reads = 0;
let inFlight: Promise<void> | null = null;
let timer: number | null = null;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/**
 * Replaces the snapshot. A snapshot omp generated before the current one is dropped, so a slow
 * passive read cannot overwrite the result of a manual refresh that finished first.
 */
export function publishUsageLimits(next: UsageLimitsSnapshot): void {
	if (snapshot && next.generatedAt < snapshot.generatedAt) return;
	snapshot = next;
	notify();
}

/** Runs a read and resolves with why it failed, or null after a success. */
async function track(read: Promise<UsageLimitsSnapshot>): Promise<string | null> {
	reads++;
	status = { checking: true, error: status.error };
	notify();
	let error: string | null = null;
	try {
		publishUsageLimits(await read);
	} catch (err) {
		error = errorText(err);
	} finally {
		reads--;
	}
	status = { checking: reads > 0, error };
	notify();
	return error;
}

/**
 * Reads omp's limits without invalidating its cache; joins a read already running and keeps the last
 * good snapshot on failure. Resolves once that read has settled (immediately when none starts).
 */
export function refreshUsageLimits(): Promise<void> {
	if (inFlight) return inFlight;
	if (listeners.size === 0 || document.visibilityState === "hidden") return Promise.resolve();
	inFlight = track(window.vomp.invoke("usage:limits"))
		.then(() => undefined)
		.finally(() => {
			inFlight = null;
		});
	return inFlight;
}

/**
 * Asks omp to fetch fresh figures from the providers instead of its cache ("Refresh limits").
 * Resolves with why the read failed, or null once the new figures are in.
 */
export function checkUsageLimits(): Promise<string | null> {
	return track(window.vomp.invoke("usage:limits", { refresh: true }));
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

/** The current read status; exported for tests. */
export function usageLimitsStatus(): UsageLimitsStatus {
	return status;
}

/** Whether limits are being read and why the last read failed; polls while mounted. */
export function useUsageLimitsStatus(): UsageLimitsStatus {
	return useSyncExternalStore(subscribeUsageLimits, usageLimitsStatus);
}
