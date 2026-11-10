import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "ok" | "warn" | "err";

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastOptions {
	tone?: ToastTone;
	message: string;
	/** Secondary line under the message. */
	description?: string;
	/** One inline action (e.g. Undo); clicking it also dismisses the toast. */
	action?: ToastAction;
	/** A quieter second action placed before `action` (e.g. Later); clicking it also dismisses the toast. */
	secondaryAction?: ToastAction;
	/** Keep until dismissed. warn/err toasts are always sticky. */
	sticky?: boolean;
	/** Release action ownership when dismissed, expired or displaced by another toast. */
	onDismiss?: () => void;
}

export interface ToastRecord {
	id: string;
	tone: ToastTone;
	message: string;
	description?: string;
	action?: ToastAction;
	secondaryAction?: ToastAction;
	onDismiss?: () => void;
	/** Auto-dismiss delay, or null when the toast stays until dismissed. */
	durationMs: number | null;
}

/** At most this many toasts are visible; older ones drop off first. */
export const MAX_TOASTS = 3;
export const TOAST_DURATION_MS = 5000;

let toasts: readonly ToastRecord[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function commit(next: readonly ToastRecord[]): void {
	const previous = toasts;
	toasts = next;
	for (const item of previous) if (!next.some(current => current.id === item.id)) item.onDismiss?.();
	for (const listener of listeners) listener();
}

/** Shows a toast and returns its id. info/ok auto-dismiss after 5s unless `sticky`; warn/err stay until dismissed. */
export function toast({ tone = "info", message, description, action, secondaryAction, sticky = false, onDismiss }: ToastOptions): string {
	const id = `toast-${nextId++}`;
	const autoDismiss = !sticky && (tone === "info" || tone === "ok");
	const record: ToastRecord = {
		id,
		tone,
		message,
		description,
		action,
		secondaryAction,
		onDismiss,
		durationMs: autoDismiss ? TOAST_DURATION_MS : null,
	};
	commit([...toasts, record].slice(-MAX_TOASTS));
	return id;
}

/** Refresh a visible notification without replacing its identity, tone or lifetime. */
export function updateToast(id: string, patch: Partial<Pick<ToastOptions, "description" | "action" | "secondaryAction">>): void {
	const index = toasts.findIndex(item => item.id === id);
	if (index < 0) return;
	const next = toasts.slice();
	next[index] = { ...toasts[index]!, ...patch };
	commit(next);
}

export function dismissToast(id: string): void {
	if (!toasts.some((t) => t.id === id)) return;
	commit(toasts.filter((t) => t.id !== id));
}

export function clearToasts(): void {
	if (toasts.length) commit([]);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function snapshot(): readonly ToastRecord[] {
	return toasts;
}

export function useToasts(): readonly ToastRecord[] {
	return useSyncExternalStore(subscribe, snapshot, snapshot);
}
