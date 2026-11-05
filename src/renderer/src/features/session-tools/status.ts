/**
 * One status source per chat, shared by session-tools views. Classic hosts poll their painted screen
 * while subscribed and live, retaining the last status line while a dialog hides it. TSP hosts never
 * read that screen: their mode status comes from the native snapshot and change events.
 */
import { useVisualSnapshot } from "../../state/visualSnapshot";
import type { SessionModes } from "@shared/contracts/native";
import type { SessionController, SessionView } from "../../state/session";
import { readScreen } from "./drive";
import { parseStatusLine, type StatusLine } from "./screen";

export interface ScreenSnapshot {
	/** Last classic painted screen; empty for TSP and before the first classic read. */
	lines: readonly string[];
	/** Classic status retained across dialogs, or native mode facts without painted model/thinking for TSP. */
	status: StatusLine | null;
}

const EMPTY: ScreenSnapshot = { lines: [], status: null };
const IDLE_MS = 1000;
const OVERLAY_MS = 450;

export function statusWithModes(status: StatusLine | null, modes: SessionModes | null): StatusLine | null {
	if (!modes) return status;
	return {
		model: status?.model ?? null,
		thinking: status?.thinking ?? null,
		plan: modes.plan.status === "inactive" ? "off" : modes.plan.status === "active" ? "on" : "paused",
		goal: modes.goal.status === "inactive" ? "off" : modes.goal.status,
		vibe: modes.vibe.status === "active",
		loop: modes.loop.status !== "inactive",
	};
}

class ScreenPoller {
	readonly #session: SessionController;
	readonly #listeners = new Set<() => void>();
	#snapshot: ScreenSnapshot = EMPTY;
	#timer: number | null = null;
	#text = "";
	#scope = "";
	#hostKey = "";
	#lifecycle = 0;
	#nativeRevision = 0;
	#off: (() => void)[] = [];

	constructor(session: SessionController) { this.#session = session; }

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		if (this.#listeners.size === 1) {
			this.#off = [
				this.#session.subscribe(() => this.#reconcile()),
				window.vomp.on("native:changed", event => {
					const view = this.#session.getSnapshot();
					if (view.mode !== "live" || view.host?.transport !== "tsp" || view.host.hostId !== event.hostId) return;
					this.#nativeRevision++;
					this.#publish([], event.snapshot.modes, true);
				}),
			];
			this.#reconcile(true);
		}
		return () => {
			this.#listeners.delete(listener);
			if (this.#listeners.size === 0) {
				this.#lifecycle++;
				this.#cancelTimer();
				for (const off of this.#off) off();
				this.#off = [];
			}
		};
	};

	getSnapshot = (): ScreenSnapshot => this.#snapshot;

	#cancelTimer(): void { clearTimeout(this.#timer ?? undefined); this.#timer = null; }
	#identity(view: SessionView): string { return `${view.host?.hostId ?? ""}:${view.host?.generation ?? ""}:${view.host?.transport ?? "classic"}`; }
	#reconcile(force = false): void {
		const view = this.#session.getSnapshot();
		const hostKey = this.#identity(view);
		const scope = `${hostKey}:${view.mode}`;
		if (!force && scope === this.#scope) return;
		this.#scope = scope;
		this.#lifecycle++;
		this.#cancelTimer();
		if (hostKey !== this.#hostKey) {
			this.#hostKey = hostKey;
			this.#nativeRevision++;
			this.#text = "";
			if (this.#snapshot !== EMPTY) { this.#snapshot = EMPTY; for (const listener of this.#listeners) listener(); }
		}
		if (view.mode !== "live" || !this.#session.hostId) return;
		if (view.host?.transport === "tsp") void this.refresh();
		else void this.#tick();
	}
	#publish(lines: readonly string[], modes: SessionModes | null, tsp: boolean): void {
		const text = `${tsp ? "semantic" : "painted"}:${lines.join("\n")}\n${JSON.stringify(modes)}`;
		if (text === this.#text) return;
		this.#text = text;
		this.#snapshot = { lines, status: statusWithModes(tsp ? null : parseStatusLine(lines) ?? this.#snapshot.status, modes) };
		for (const listener of this.#listeners) listener();
	}

	/** Refresh native mode facts for TSP; only classic hosts have a painted screen to read. */
	async refresh(): Promise<ScreenSnapshot> {
		const view = this.#session.getSnapshot();
		const hostId = this.#session.hostId;
		if (view.mode !== "live" || !hostId) return this.#snapshot;
		const identity = this.#identity(view);
		const lifecycle = this.#lifecycle;
		const current = () => lifecycle === this.#lifecycle && this.#session.getSnapshot().mode === "live" && this.#identity(this.#session.getSnapshot()) === identity;
		const nativeRevision = this.#nativeRevision;
		if (view.host?.transport === "tsp") {
			const native = await window.vomp.invoke("native:snapshot", hostId).catch(() => null);
			if (native && current() && nativeRevision === this.#nativeRevision) this.#publish([], native.modes, true);
		} else {
			const [lines, native] = await Promise.all([
				readScreen(this.#session).catch(() => null),
				window.vomp.invoke("native:snapshot", hostId).catch(() => null),
			]);
			if (lines && current()) this.#publish(lines, native?.modes ?? null, false);
		}
		return this.#snapshot;
	}

	async #tick(): Promise<void> {
		this.#timer = null;
		const lifecycle = this.#lifecycle;
		await this.refresh();
		const view = this.#session.getSnapshot();
		if (this.#listeners.size === 0 || lifecycle !== this.#lifecycle || view.mode !== "live" || view.host?.transport === "tsp") return;
		const overlays = view.host?.tui?.overlays ?? 0;
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

/** Live omp status: painted polling for classic hosts, native mode events for TSP hosts. */
export function useOmpScreen(session: SessionController): ScreenSnapshot {
	const poller = screenPoller(session);
	return useVisualSnapshot(poller.subscribe, poller.getSnapshot);
}

/** Subscribe a React view to a chat's SessionView. */
export function useSessionView(session: SessionController): SessionView {
	return useVisualSnapshot(session.subscribe, session.getSnapshot);
}
