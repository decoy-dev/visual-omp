/**
 * Live sharing ("Invite live"): publish a chat's private collab room to omp's public relay so
 * people elsewhere can watch — or type into — the running chat from omp's web client.
 *
 * Every chat already hosts a collab room on the app's loopback relay. Publishing makes that relay
 * host the same room on the public relay (`wss://my.omp.sh`, or the user's `collab.relayUrl` when
 * it names another relay) and forward sealed frames both ways; the room key never leaves the
 * link, so the relay still sees only ciphertext. Links use omp's format: the browser client at
 * `https://<relay host>/#<roomId>.<key>` (control links append the write token to the key).
 */

/**
 * - `connecting`: opening the connection to the public relay.
 * - `live`: people with a link can join.
 * - `reconnecting`: the connection dropped; the app retries and guests rejoin by themselves.
 * - `stopped`: sharing is off (see {@link LiveShareState.endedReason}).
 */
export type LiveSharePhase = "connecting" | "live" | "reconnecting" | "stopped";

export interface LiveShareState {
	hostId: string;
	roomId: string;
	phase: LiveSharePhase;
	/** Public relay origin, e.g. `wss://my.omp.sh`. */
	relayOrigin: string;
	/** Browser link that can watch and type (room key + write token). */
	controlLink: string;
	/** Browser link that can only watch (room key alone). */
	viewLink: string;
	/** People connected through the public relay right now. */
	remoteGuests: number;
	/** Latest connection problem, in plain words; null while healthy. */
	error: string | null;
	/** `stopped`: the user stopped sharing. `room-closed`: the chat restarted or ended, which closes its room. */
	endedReason: "stopped" | "room-closed" | null;
}

declare module "../ipc" {
	interface IpcInvokeMap {
		/**
		 * Publish the chat's live room. Resolves once the bridge is created (phase `connecting` or
		 * `live`); follow `collab:shareState`. Publishing an already shared chat returns its state.
		 * Rejects when the chat is not live.
		 */
		"collab:publish": { args: [hostId: string]; result: LiveShareState };
		/** Stop sharing; people connected through the public relay are disconnected. */
		"collab:unpublish": { args: [hostId: string]; result: void };
		/** Current sharing state of a chat; null when it was never shared in this app session. */
		"collab:shared": { args: [hostId: string]; result: LiveShareState | null };
	}

	interface IpcEventMap {
		"collab:shareState": LiveShareState;
	}
}
