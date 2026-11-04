import { TspDocumentStore } from "@shared/tsp/document";
import type { TspHostPatch } from "@shared/tsp/patch";
import type { TspHostSnapshot } from "@shared/tsp-host";

/** A read-only view of one host's omp screen documents. */
export interface TspHostSource {
	readonly hostId: string;
	/** Null until a document arrives, and while `failed()` reports a copy that could not be brought current. */
	getSnapshot(): TspHostSnapshot | null;
	/** A read failed while this copy was missing or behind main. A later patch or subscriber retries. */
	failed(): boolean;
	subscribe(listener: () => void): () => void;
}

/** Delays before the timed retries of a failed read. */
const RETRY_MS = [1000, 4000];

interface Entry {
	store: TspDocumentStore;
	listeners: Set<() => void>;
	/** Main published a revision this copy could not apply; a read must bring it current. */
	behind: boolean;
	failed: boolean;
	/** Patches received while a read is outstanding, applied together with its result. */
	pending: TspHostPatch[] | null;
	attempts: number;
	retry: ReturnType<typeof setTimeout> | undefined;
	disposed: boolean;
}

const entries = new Map<string, Entry>();
let offPatches: (() => void) | null = null;

function visible(entry: Entry): TspHostSnapshot | null {
	return entry.failed ? null : entry.store.getSnapshot();
}

/** Run `change`, then tell subscribers once if what they can see changed. */
function update(entry: Entry, change: () => void): void {
	const before = visible(entry);
	const failed = entry.failed;
	change();
	if (visible(entry) !== before || entry.failed !== failed) for (const listener of entry.listeners) listener();
}

function applyPatch(entry: Entry, patch: TspHostPatch): void {
	const result = entry.store.apply(patch);
	if (result === "gap") entry.behind = true;
	// A patch applies only on top of the revision before it, or replaces everything.
	else if (result === "applied") entry.behind = false;
}

function read(hostId: string, entry: Entry): void {
	if (entry.pending || entry.disposed) return;
	clearTimeout(entry.retry);
	entry.retry = undefined;
	entry.pending = [];
	void window.vomp.invoke("host:tsp-snapshot", hostId).then(
		snapshot => settle(hostId, entry, snapshot),
		() => settle(hostId, entry, undefined),
	);
}

/** A read's snapshot (undefined when it failed) and the patches received meanwhile reach subscribers together. */
function settle(hostId: string, entry: Entry, snapshot: TspHostSnapshot | null | undefined): void {
	if (entry.disposed) return;
	const queued = entry.pending ?? [];
	entry.pending = null;
	update(entry, () => {
		if (snapshot && entry.store.accept(snapshot)) entry.behind = false;
		for (const patch of queued) applyPatch(entry, patch);
		// A copy that is still behind, or a failed read with nothing to show, is reported rather than shown.
		entry.failed = entry.behind || (snapshot === undefined && !entry.store.getSnapshot());
		if (!entry.failed) entry.attempts = 0;
	});
	if (entry.failed && entry.attempts < RETRY_MS.length) entry.retry = setTimeout(() => read(hostId, entry), RETRY_MS[entry.attempts++]);
}

function receive(patch: TspHostPatch): void {
	const entry = entries.get(patch.hostId);
	if (!entry) return;
	if (entry.pending) { entry.pending.push(patch); return; }
	update(entry, () => {
		applyPatch(entry, patch);
		if (!entry.behind) {
			entry.failed = false;
			entry.attempts = 0;
			// A patch that brought the copy current makes a scheduled retry unnecessary.
			clearTimeout(entry.retry);
			entry.retry = undefined;
		}
	});
	if (entry.behind) read(patch.hostId, entry);
}

function release(hostId: string, entry: Entry): void {
	// Same-commit remounts and StrictMode resubscribe before the microtask, keeping the document.
	queueMicrotask(() => {
		if (entry.listeners.size || entries.get(hostId) !== entry) return;
		entry.disposed = true;
		clearTimeout(entry.retry);
		entries.delete(hostId);
		if (!entries.size) { offPatches?.(); offPatches = null; }
	});
}

function subscribe(hostId: string, listener: () => void): () => void {
	let entry = entries.get(hostId);
	if (!entry) {
		entry = { store: new TspDocumentStore(), listeners: new Set(), behind: false, failed: false, pending: null, attempts: 0, retry: undefined, disposed: false };
		entries.set(hostId, entry);
		// One IPC listener for every host, attached before the first read so no patch is missed.
		offPatches ??= window.vomp.on("host:tsp-patch", receive);
		read(hostId, entry);
	} else if (entry.failed) read(hostId, entry);
	const current = entry;
	current.listeners.add(listener);
	return () => {
		if (!current.listeners.delete(listener)) return;
		if (!current.listeners.size) release(hostId, current);
	};
}

/**
 * The shared document for `hostId`. It is read when first subscribed, kept current by main's
 * patches while anything subscribes, and dropped after the last subscriber leaves. The view holds
 * no state, so callers that need a stable subscribe function memoize it per host.
 */
export function tspHost(hostId: string): TspHostSource {
	return {
		hostId,
		getSnapshot: () => {
			const entry = entries.get(hostId);
			return entry ? visible(entry) : null;
		},
		failed: () => entries.get(hostId)?.failed ?? false,
		subscribe: listener => subscribe(hostId, listener),
	};
}
