import type { TspHostSnapshot } from "@shared/tsp-host";
import type { GuestSnapshot } from "../../collab/lib/client";
import type { SessionController } from "../../state/session";
import { TspNoticeProjection } from "./notices";
import { displayedEntries } from "../../chat/branch";
import { savedParents } from "../../state/history";

/** Controller-owned subscription, active even while the transcript and omp screen are unmounted. */
export class TspNoticeStore {
	readonly #projection = new TspNoticeProjection();
	readonly #listeners = new Set<() => void>();
	readonly #offSession: () => void;
	#offTsp: (() => void) | null = null;
	#host: string | null = null;
	#identity: string | null = null;
	#generation: number | null = null;
	#revision = -1;
	#disposed = false;
	#previousRoomGuest: GuestSnapshot | null = null;
	#roomSynced = false;
	constructor(readonly session: Pick<SessionController, "subscribe" | "getSnapshot">) {
		this.#offSession = session.subscribe(() => this.#sync());
	}
	getSnapshot = () => this.#projection.getSnapshot();
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	#publish(): void { for (const listener of this.#listeners) listener(); }
	#sync(): void {
		const view = this.session.getSnapshot();
		const host = view.host?.transport === "tsp" ? view.host : null;
		if ((host?.hostId ?? null) !== this.#host) {
			this.#offTsp?.(); this.#offTsp = null; this.#projection.reset(); this.#revision = -1;
			this.#roomSynced = false;
			if (this.#host) this.#previousRoomGuest = view.guest;
			this.#host = host?.hostId ?? null; this.#generation = host?.generation ?? null; this.#identity = host?.sessionId ?? null;
			if (host) {
				const hostId = host.hostId;
				const accept = (snapshot: TspHostSnapshot) => {
					if (this.#disposed || this.#host !== hostId || snapshot.hostId !== hostId || snapshot.revision <= this.#revision) return;
					if (snapshot.generation !== this.session.getSnapshot().host?.generation) return;
					this.#revision = snapshot.revision;
					this.#projection.apply(snapshot); this.#publish();
				};
				this.#offTsp = window.vomp.on("host:tsp-update", accept);
				void window.vomp.invoke("host:tsp-snapshot", hostId).then(snapshot => { if (snapshot) accept(snapshot); }).catch(() => undefined);
			}
		}
		if (host && (this.#generation !== host.generation || (this.#identity !== null && host.sessionId !== this.#identity))) {
			this.#projection.rotate();
			this.#roomSynced = false;
			this.#previousRoomGuest = view.guest;
			this.#generation = host.generation; this.#identity = host.sessionId;
		}
		if (host) this.#identity = host.sessionId;
		if (host && view.guest && view.guest !== this.#previousRoomGuest) {
			this.#roomSynced ||= view.guest.phase === "live" && !view.guest.loading;
			if (this.#roomSynced) this.#projection.collab(view.guest.entries, view.guest.notices, displayedEntries(view), savedParents(view.history));
		}
		this.#publish();
	}
	dispose(): void {
		this.#disposed = true; this.#offSession(); this.#offTsp?.(); this.#listeners.clear(); this.#projection.reset();
	}
}
