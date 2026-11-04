import { tspHost } from "./tsp/hosts";
import type { GuestClient } from "../collab/lib/client";
import type { SessionController } from "./session";

/** Keeps renderer-owned collab request authority separate from omp's document lifecycle. */
export class TspQuestionSync {
	#session: SessionController;
	#hostId: string | null = null;
	#revision = 0;
	#last = "";
	#disposed = false;
	#unsubscribeSession: () => void;
	#unsubscribeTsp: (() => void) | null = null;
	#client: GuestClient | null = null;
	#connection: number | undefined;
	#connectionSerial = 0;
	#requestScopes = new WeakMap<object, { hostId: string; generation: number; epoch: number | null }>();
	constructor(session: SessionController) {
		this.#session = session;
		this.#unsubscribeSession = session.subscribe(() => this.#sync());
	}
	#sync(): void {
		if (this.#disposed) return;
		const view = this.#session.getSnapshot();
		const host = view.host;
		if (host?.transport !== "tsp") return;
		if (this.#hostId !== host.hostId) {
			this.#hostId = host.hostId;
			this.#last = "";
			this.#unsubscribeTsp?.();
			this.#unsubscribeTsp = tspHost(host.hostId).subscribe(() => this.#sync());
		}
		const snapshot = tspHost(host.hostId).getSnapshot();
		const guest = view.guest;
		const client = this.#session.guestClient();
		if (client !== this.#client || guest?.uiConnection !== this.#connection) {
			this.#client = client;
			this.#connection = guest?.uiConnection;
			this.#connectionSerial++;
			this.#requestScopes = new WeakMap();
		}
		const requests = guest?.pendingUiRequests ?? [];
		// Remember where each request was observed. A delayed TSP snapshot can only invalidate
		// matching authority; collab retains its request and its original reqId answer path.
		for (const request of requests) {
			if (!this.#requestScopes.has(request)) this.#requestScopes.set(request, {
				hostId: host.hostId, generation: host.generation,
				epoch: snapshot?.generation === host.generation ? snapshot.epoch : null,
			});
		}
		if (!snapshot || snapshot.generation !== host.generation) return;
		const currentRequests = requests.every(request => {
			const scope = this.#requestScopes.get(request)!;
			if (scope.hostId !== host.hostId || scope.generation !== host.generation) return false;
			if (scope.epoch === null) scope.epoch = snapshot.epoch;
			return scope.epoch === snapshot.epoch;
		});
		const connected = client !== null && currentRequests && guest?.phase === "live" && view.mode === "live" && snapshot.lifecycle === "live";
		const state = { hostId: host.hostId, generation: host.generation, epoch: snapshot.epoch, connection: this.#connectionSerial, connected, requests: connected ? [...requests] : [] };
		const serialized = JSON.stringify(state);
		if (serialized === this.#last) return;
		this.#last = serialized;
		void window.vomp.invoke("host:tsp-questions", host.hostId, { ...state, revision: ++this.#revision }).catch(error => console.warn("Could not mirror collab questions", error));
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribeSession();
		this.#unsubscribeTsp?.();
	}
}
