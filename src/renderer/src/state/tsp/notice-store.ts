import type { TspHostSnapshot } from "@shared/tsp-host";
import type { CommandOutcomeSpec } from "@shared/tsp/command-result";
import type { GuestSnapshot } from "../../collab/lib/client";
import { liveEntries, type SessionController } from "../../state/session";
import { TspNoticeProjection, type TspCommandNoticeReservation } from "./notices";
import { displayedEntries } from "../../chat/branch";
import { savedParents, type SessionHistory } from "../../state/history";
import { tspHost } from "./hosts";
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import { TspMainFeedback } from "./main-feedback";
import type { MainOutput } from "@shared/tsp/main-output";
import { clearCommandResults } from "../../features/session-tools/results";

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
	#collabInputs: { entries: GuestSnapshot["entries"]; notices: GuestSnapshot["notices"]; source: readonly SessionEntry[] | null; leaf: string | null; history: SessionHistory | null } | null = null;
	readonly #mainFeedback = new TspMainFeedback();
	#feedbackInput: { line: string; history: unknown; users: Set<string> } | null = null;
	beginMainFeedback(before: TspHostSnapshot, line: string, accept: (output: MainOutput, snapshot: TspHostSnapshot) => boolean): () => void {
		const view = this.session.getSnapshot();
		const input = { line, history: view.inputHistory, users: new Set(view.guest?.entries.filter(entry => entry.type === "message" && entry.message.role === "user" || entry.type === "custom_message" && entry.customType === "collab-prompt").map(entry => entry.id)) };
		this.#feedbackInput = input;
		const end = this.#mainFeedback.begin(before, accept);
		return () => { end(); if (this.#feedbackInput === input) this.#feedbackInput = null; };
	}
	endMainFeedback(): void { this.#mainFeedback.end(); this.#feedbackInput = null; }
	constructor(readonly session: Pick<SessionController, "subscribe" | "getSnapshot">) {
		this.#offSession = session.subscribe(() => this.#sync());
	}
	getSnapshot = () => this.#projection.getSnapshot();
	beginCommand(before: TspHostSnapshot, spec: CommandOutcomeSpec): TspCommandNoticeReservation {
		const reservation = this.#projection.beginCommand(before, spec);
		return {
			commit: outcome => { reservation.commit(outcome); this.#publish(); },
			cancel: () => { reservation.cancel(); this.#publish(); },
		};
	}
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	#publish(): void { for (const listener of this.#listeners) listener(); }
	#sync(): void {
		const view = this.session.getSnapshot();
		const input = this.#feedbackInput;
		if (input) {
			const newerUser = view.guest?.entries.some(entry => !input.users.has(entry.id) && (entry.type === "message" && entry.message.role === "user" || entry.type === "custom_message" && entry.customType === "collab-prompt"));
			if (newerUser || input.history !== view.inputHistory && view.inputHistory.at(-1)?.text !== input.line) {
				this.#mainFeedback.end(); this.#feedbackInput = null;
			}
		}
		const host = view.host?.transport === "tsp" ? view.host : null;
		if ((host?.hostId ?? null) !== this.#host) {
			this.#offTsp?.(); this.#offTsp = null; this.#projection.reset(); this.#revision = -1;
			this.#mainFeedback.end(); this.#feedbackInput = null;
			clearCommandResults(this.session);
			this.#roomSynced = false;
			this.#collabInputs = null;
			if (this.#host) this.#previousRoomGuest = view.guest;
			this.#host = host?.hostId ?? null; this.#generation = host?.generation ?? null; this.#identity = host?.sessionId ?? null;
			if (host) {
				const source = tspHost(host.hostId);
				const accept = () => {
					const snapshot = source.getSnapshot();
					if (this.#disposed || this.#host !== source.hostId || !snapshot || snapshot.revision <= this.#revision) return;
					if (snapshot.generation !== this.session.getSnapshot().host?.generation) return;
					this.#revision = snapshot.revision;
					this.#projection.apply(snapshot);
					for (const output of this.#mainFeedback.apply(snapshot)) this.#projection.consumeMainOutput(snapshot, output);
					this.#publish();
				};
				this.#offTsp = source.subscribe(accept);
				// Apply an already-shared document after this sync's rotation, as a fresh read would.
				queueMicrotask(accept);
			}
		}
		if (host && (this.#generation !== host.generation || (this.#identity !== null && host.sessionId !== this.#identity))) {
			this.#projection.rotate();
			this.#mainFeedback.end(); this.#feedbackInput = null;
			clearCommandResults(this.session);
			this.#roomSynced = false;
			this.#collabInputs = null;
			this.#previousRoomGuest = view.guest;
			this.#generation = host.generation; this.#identity = host.sessionId;
		}
		if (host) this.#identity = host.sessionId;
		if (host && view.guest && view.guest !== this.#previousRoomGuest) {
			this.#roomSynced ||= view.guest.phase === "live" && !view.guest.loading;
			if (this.#roomSynced) {
				const source = liveEntries(view);
				const previous = this.#collabInputs;
				if (!previous || previous.entries !== view.guest.entries || previous.notices !== view.guest.notices || previous.source !== source || previous.leaf !== view.displayLeaf || previous.history !== view.history) {
					this.#projection.collab(view.guest.entries, view.guest.notices, displayedEntries(view), savedParents(view.history));
					this.#collabInputs = { entries: view.guest.entries, notices: view.guest.notices, source, leaf: view.displayLeaf, history: view.history };
				}
			}
		}
		this.#publish();
	}
	dispose(): void {
		this.#disposed = true; this.#offSession(); this.#offTsp?.(); this.#listeners.clear(); this.#projection.reset();
		this.#mainFeedback.end(); this.#feedbackInput = null;
		clearCommandResults(this.session);
		this.#collabInputs = null;
	}
}
