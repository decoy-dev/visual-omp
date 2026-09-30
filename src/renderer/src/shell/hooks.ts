import { type KeyboardEvent, useEffect, useState, useSyncExternalStore } from "react";
import type { SessionController, SessionView } from "../state/session";

const noSubscribe = () => () => {};
const noSnapshot = () => null;

/** Live SessionView for a controller (null when there is none). */
export function useSessionView(controller: SessionController | null): SessionView | null {
	return useSyncExternalStore(controller ? controller.subscribe : noSubscribe, controller ? controller.getSnapshot : noSnapshot);
}

export type ChatStatus = "working" | "needsInput" | "live" | "idle";

export function chatStatus(view: SessionView | null): ChatStatus {
	if (!view) return "idle";
	if (view.guest?.uiRequest) return "needsInput";
	if (view.working) return "working";
	return view.mode === "live" ? "live" : "idle";
}

/** Human title for a chat: omp's live session name, the saved title, the first message, or a fallback. */
export function chatTitle(view: SessionView | null, fallback: string | null): string | null {
	return view?.guest?.state?.sessionName || view?.guest?.header?.title || view?.history?.title || fallback;
}

/** Re-render every `ms` (relative timestamps, elapsed timers). */
export function useNow(ms = 30_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), ms);
		return () => clearInterval(timer);
	}, [ms]);
	return now;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });

/** Compact relative time: "2m", "1h", "3d", "Sep 12". */
export function shortAgo(then: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 60) return relative.format(0, "second");
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 7) return `${days}d`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Elapsed "14s" / "2m 05s" for the working row. */
export function elapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * Arrow-key focus movement for a WAI-ARIA tablist with manual activation: Left/Right move focus to the previous or
 * next tab (wrapping), Home/End to the first or last. Enter or Space on the focused tab then activates it.
 * Returns true when the key was handled.
 */
export function moveTabFocus(event: KeyboardEvent<HTMLElement>): boolean {
	const list = event.currentTarget.closest('[role="tablist"]');
	if (!list) return false;
	const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')];
	const index = tabs.indexOf(event.currentTarget);
	if (index < 0) return false;
	const target =
		event.key === "ArrowRight"
			? tabs[(index + 1) % tabs.length]
			: event.key === "ArrowLeft"
				? tabs[(index - 1 + tabs.length) % tabs.length]
				: event.key === "Home"
					? tabs[0]
					: event.key === "End"
						? tabs.at(-1)
						: undefined;
	if (!target) return false;
	event.preventDefault();
	target.focus();
	return true;
}
