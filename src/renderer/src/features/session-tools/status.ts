/**
 * One screen poller per chat, shared by every session-tools view (header chips, pickers, Plan Review
 * card). It reads omp's painted screen while something is subscribed and the chat is live, and keeps
 * the last status line it saw (the line disappears while omp shows a dialog in the editor slot).
 */
import { useSyncExternalStore } from "react";
import type { SessionController, SessionView } from "../../state/session";
import { readScreen } from "./drive";
import { parseStatusLine, type StatusLine } from "./screen";

export interface ScreenSnapshot {
	/** Last painted screen; empty until the first read. */
	lines: readonly string[];
	/** Last status line seen (kept while a dialog hides it); null before omp painted one. */
	status: StatusLine | null;
}

const EMPTY: ScreenSnapshot = { lines: [], status: null };
const IDLE_MS = 1000;
const OVERLAY_MS = 450;

class ScreenPoller {
	readonly #session: SessionController;
	readonly #listeners = new Set<() => void>();
	#snapshot: ScreenSnapshot = EMPTY;
	#timer: number | null = null;
	#text = "";

	constructor(session: SessionController) {
		this.#session = session;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		if (this.#listeners.size === 1) void this.#tick();
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0 && this.#timer) {
				clearTimeout(this.#timer);
				this.#timer = null;
			}
		};
	};

	getSnapshot = (): ScreenSnapshot => this.#snapshot;

	/** Read now (after an action) instead of waiting for the next tick. */
	async refresh(): Promise<ScreenSnapshot> {
		const view = this.#session.getSnapshot();
		if (view.mode !== "live" || !this.#session.hostId) return this.#snapshot;
		const lines = await readScreen(this.#session).catch(() => null);
		if (!lines) return this.#snapshot;
		const text = lines.join("\n");
		if (text !== this.#text) {
			this.#text = text;
			this.#snapshot = { lines, status: parseStatusLine(lines) ?? this.#snapshot.status };
			for (const listener of this.#listeners) listener();
		}
		return this.#snapshot;
	}

	async #tick(): Promise<void> {
		this.#timer = null;
		await this.refresh();
		if (this.#listeners.size === 0) return;
		const overlays = this.#session.getSnapshot().host?.tui?.overlays ?? 0;
		this.#timer = window.setTimeout(() => void this.#tick(), overlays > 0 ? OVERLAY_MS : IDLE_MS);
	}
}

const pollers = new WeakMap<SessionController, ScreenPoller>();

export function screenPoller(session: SessionController): ScreenPoller {
	let poller = pollers.get(session);
	if (!poller) {
		poller = new ScreenPoller(session);
		pollers.set(session, poller);
	}
	return poller;
}

/** Live omp screen facts for a chat (polled while mounted). */
export function useOmpScreen(session: SessionController): ScreenSnapshot {
	const poller = screenPoller(session);
	return useSyncExternalStore(poller.subscribe, poller.getSnapshot);
}

/** Subscribe a React view to a chat's SessionView. */
export function useSessionView(session: SessionController): SessionView {
	return useSyncExternalStore(session.subscribe, session.getSnapshot);
}
