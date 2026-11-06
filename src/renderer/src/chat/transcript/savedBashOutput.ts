import type { SavedToolOutput } from "@shared/session-output";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ToolResultLike } from "../../tool-render/types";

export const SavedToolOutputContext = createContext<{ file: string | null; identity: string } | null>(null);

type RecoveryStatus = "none" | "loading" | "ready" | "unavailable" | "too-large";

export interface SavedBashOutputInput {
	name: string;
	running: boolean;
	result?: ToolResultLike;
	toolCallId?: string;
}

export interface SavedBashOutput {
	result: ToolResultLike | undefined;
	needed: boolean;
	canLoad: boolean;
	loading: boolean;
	status: RecoveryStatus;
	load: () => void;
}

const TEXT_ELISION = /\n…\[\d+ chars elided for collab session\]$/;
const ARRAY_ELISION = /^…\[\d+ items elided for collab session\]$/;

/** Only collab's content markers prove that the saved output may contain more text. */
function hasElidedContent(result: ToolResultLike): boolean {
	const content: readonly unknown[] = result.content;
	if (!Array.isArray(content)) return false;
	return content.some((block, index) => {
		if (typeof block === "string") return index === content.length - 1 && ARRAY_ELISION.test(block);
		if (typeof block !== "object" || block === null) return false;
		const entry = block as { type?: unknown; text?: unknown };
		return entry.type === "text" && typeof entry.text === "string" && TEXT_ELISION.test(entry.text);
	});
}

const MAX_RETAINED_ENTRIES = 128;
const MAX_RETAINED_CONTENT_BYTES = 8 * 1024 * 1024;
type RecoverySnapshot = { status: Exclude<RecoveryStatus, "ready"> } | { status: "ready"; content: ToolResultLike["content"] };
type PendingRequest = { manual: boolean };
interface RetainedRecovery {
	snapshot: RecoverySnapshot;
	bytes: number;
	pending: PendingRequest | null;
}

// Retain content, not the source result: each consumer keeps its own current metadata.
// In-flight entries are pinned; saturation declines work instead of growing the cache.
const retained = new Map<string, RetainedRecovery>();
const listeners = new Map<string, Set<() => void>>();
let retainedContentBytes = 0;

function notify(key: string): void {
	for (const listener of listeners.get(key) ?? []) listener();
}

function evict(key: string, entry: RetainedRecovery): void {
	retained.delete(key);
	retainedContentBytes -= entry.bytes;
	notify(key);
}

function evictOldestSettled(): boolean {
	for (const [key, entry] of retained) {
		if (entry.pending) continue;
		evict(key, entry);
		return true;
	}
	return false;
}

function acquire(key: string): RetainedRecovery | null {
	const existing = retained.get(key);
	if (existing) {
		retained.delete(key);
		retained.set(key, existing);
		return existing;
	}
	if (retained.size >= MAX_RETAINED_ENTRIES && !evictOldestSettled()) return null;
	const entry: RetainedRecovery = { snapshot: { status: "none" }, bytes: 0, pending: null };
	retained.set(key, entry);
	return entry;
}

function requestOutput(key: string, file: string, toolCallId: string, manual: boolean): boolean {
	const entry = acquire(key);
	if (!entry) return false;
	// A manual request can upgrade an automatic request's smaller content limit.
	// Other consumers join the latest request, and automatic attempts never retry.
	if (entry.pending && (!manual || entry.pending.manual)) return true;
	if (!manual && entry.snapshot.status !== "none") return true;
	const pending = { manual };
	entry.pending = pending;
	retainedContentBytes -= entry.bytes;
	entry.bytes = 0;
	entry.snapshot = { status: "loading" };
	notify(key);

	const finish = (saved: SavedToolOutput) => {
		// Superseded requests must not overwrite either subscribers or retained results.
		if (retained.get(key) !== entry || entry.pending !== pending) return;
		if (saved.status === "ready" && hasElidedContent({ content: saved.content })) {
			saved = { status: "unavailable" };
		}
		if (saved.status === "ready") {
			const bytes = new TextEncoder().encode(JSON.stringify(saved.content)).byteLength;
			if (bytes > MAX_RETAINED_CONTENT_BYTES) {
				saved = { status: "too-large" };
			} else {
				while (retainedContentBytes + bytes > MAX_RETAINED_CONTENT_BYTES) evictOldestSettled();
				entry.bytes = bytes;
				retainedContentBytes += bytes;
			}
		}
		entry.snapshot = saved.status === "ready"
			? { status: "ready", content: saved.content }
			: { status: saved.status };
		entry.pending = null;
		notify(key);
	};
	// Promise.resolve also handles a missing bridge and synchronous IPC errors.
	void Promise.resolve().then(() => retained.get(key) === entry && entry.pending === pending
		? window.vomp.invoke("sessions:toolOutput", file, toolCallId, manual)
		: { status: "unavailable" as const })
		.then(finish, () => finish({ status: "unavailable" }));
	return true;
}

/** Recover settled bash content from this exact transcript file, never from a related chat. */
export function useSavedBashOutput({ name, running, result, toolCallId }: SavedBashOutputInput): SavedBashOutput {
	const context = useContext(SavedToolOutputContext);
	const file = context?.file ?? null;
	const identity = context?.identity ?? null;
	const needed = useMemo(() => name === "bash" && !running && !!result && hasElidedContent(result), [name, running, result]);
	const canLoad = needed && !!file && !!toolCallId;
	const key = canLoad ? JSON.stringify([file, identity, toolCallId]) : null;
	const scope = useMemo(() => ({}), [key, name, running, needed]);
	const active = useRef<typeof scope | null>(null);
	const [declined, setDeclined] = useState<typeof scope | null>(null);
	const subscribe = useCallback((listener: () => void) => {
		if (!key) return () => {};
		const subscribers = listeners.get(key) ?? new Set<() => void>();
		listeners.set(key, subscribers);
		subscribers.add(listener);
		return () => {
			subscribers.delete(listener);
			if (!subscribers.size) listeners.delete(key);
		};
	}, [key]);
	const getSnapshot = useCallback(() => key ? retained.get(key)?.snapshot ?? null : null, [key]);
	const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

	useLayoutEffect(() => {
		active.current = scope;
		return () => { active.current = null; };
	}, [scope]);

	const request = useCallback((manual: boolean) => {
		if (!key || !file || !toolCallId || active.current !== scope) return;
		if (!requestOutput(key, file, toolCallId, manual)) setDeclined(scope);
	}, [key, file, toolCallId, scope]);

	useEffect(() => {
		request(false);
	}, [request]);

	const load = useCallback(() => request(true), [request]);
	const recovered = useMemo(() => current?.status === "ready" && result
		? { ...result, content: current.content }
		: result, [current, result]);
	const status = !needed ? "none" : !canLoad ? "unavailable" : current?.status ?? (declined === scope ? "unavailable" : "none");
	return { result: recovered, needed, canLoad, loading: status === "loading", status, load };
}
