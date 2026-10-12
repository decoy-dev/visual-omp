/**
 * Per-chat state of a multi-question `ask` answered as one series (DESIGN §4.8, rules in
 * `askSeries.ts`). It outlives the question card, which remounts as omp's requests change, and
 * replays the saved answers on its own so a chat in a background tab still finishes sending.
 *
 * A series belongs to one collab room: the omp host, its room generation and the guest client
 * connected to it. Nothing is sent unless the mirror is that room's fully synchronized, writable,
 * live snapshot, and a series ends when the room changes, omp exits or the `ask` call ends.
 */
import type { CollabUiRequest } from "@oh-my-pi/pi-wire";
import { useSyncExternalStore } from "react";
import type { GuestSnapshot } from "../../collab/lib/client";
import type { SessionController } from "../../state/session";
import {
	ASK_CHAT,
	type AskAnswer,
	type AskQuestion,
	defaultAnswer,
	findSeriesAsk,
	isAskRunning,
	isComplete,
	isSeriesStart,
	REPLAY_START,
	type ReplayCursor,
	replayStep,
} from "./askSeries";

/** `editing`: the user walks the questions. `sending`: answers are being replayed. `sent`: all replayed, omp is finishing. `fallback`: the rest is answered by hand. */
export type AskSeriesPhase = "editing" | "sending" | "sent" | "fallback";

/** The collab room a series belongs to. */
export interface AskRoom {
	hostId: string;
	generation: number;
	/** The guest client joined to the room; a new room (or a new connection to it) gets a new one. */
	client: object;
}

export interface AskSeriesState {
	toolCallId: string;
	room: AskRoom;
	/** omp's request for question 1, which the series holds open while the user answers. */
	heldReqId: number;
	questions: readonly AskQuestion[];
	answers: readonly AskAnswer[];
	/** The question on screen. */
	index: number;
	phase: AskSeriesPhase;
	cursor: ReplayCursor;
	/** In `fallback`: why the series stopped (logged for developers), and whether it had started sending. */
	fallbackReason: string | null;
	fallbackWhileSending: boolean;
}

export type AskSeriesSession = Pick<SessionController, "subscribe" | "getSnapshot" | "answer" | "guestClient">;

export class AskSeriesDriver {
	#session: AskSeriesSession;
	#state: AskSeriesState | null = null;
	#listeners = new Set<() => void>();
	/** Ask calls that already ran as a series (or were skipped, or sent to chat) and must not start again while they run. */
	#done = new Set<string>();
	/** Requests this series answered; it resets with the series, which is bound to one room. */
	#answered = new Set<number>();
	#flushQueued = false;
	/** Inputs of the last detection, which only reruns when one of them changes. */
	#detected: readonly unknown[] = [];

	constructor(session: AskSeriesSession) {
		this.#session = session;
		session.subscribe(() => this.#sync());
		this.#sync();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): AskSeriesState | null => this.#state;

	setAnswer(index: number, answer: AskAnswer): void {
		const state = this.#state;
		if (state?.phase !== "editing" || index < 0 || index >= state.questions.length) return;
		this.#set({ ...state, answers: state.answers.map((current, at) => (at === index ? answer : current)) });
	}

	show(index: number): void {
		const state = this.#state;
		if (state?.phase !== "editing" || index < 0 || index >= state.questions.length) return;
		this.#set({ ...state, index });
	}

	/** Starts replaying once every question has an answer. */
	submit(): void {
		const state = this.#state;
		if (state?.phase !== "editing" || !state.questions.every((question, index) => isComplete(question, state.answers[index]))) return;
		this.#set({ ...state, phase: "sending", cursor: REPLAY_START });
		this.#queueFlush();
	}

	/** The held request for question 1, while omp can take an answer to it. */
	pendingRequest(): CollabUiRequest | null {
		const state = this.#state;
		const request = state?.phase === "editing" ? this.#readyGuest(state.room)?.uiRequest : null;
		return state && request?.reqId === state.heldReqId && isSeriesStart(state.questions, request) ? request : null;
	}

	/** "Chat about this" ends the whole ask at once, as it does in omp. */
	chat(): void {
		this.#finish(ASK_CHAT);
	}

	/** Cancelling any question cancels the whole ask in omp. */
	skip(): void {
		this.#finish(undefined);
	}

	#finish(value: string | undefined): void {
		const state = this.#state;
		const request = this.pendingRequest();
		if (!state || !request) return;
		this.#done.add(state.toolCallId);
		this.#clear();
		this.#session.answer(request.reqId, value);
	}

	#set(state: AskSeriesState): void {
		this.#state = state;
		this.#emit();
	}

	#clear(): void {
		this.#answered.clear();
		if (this.#state === null) return;
		this.#state = null;
		this.#emit();
	}

	#emit(): void {
		for (const listener of this.#listeners) listener();
	}

	#fallback(state: AskSeriesState, reason: string): void {
		console.warn(`[visual-omp] ask series for ${state.toolCallId} stopped: ${reason}`);
		this.#set({ ...state, phase: "fallback", fallbackReason: reason, fallbackWhileSending: state.phase !== "editing" });
	}

	/** The room the chat is joined to now, or null between rooms. */
	#room(): AskRoom | null {
		const host = this.#session.getSnapshot().host;
		const client = this.#session.guestClient();
		return host && client ? { hostId: host.hostId, generation: host.generation, client } : null;
	}

	/**
	 * The mirror when it can take an answer for `room`: the current client's own snapshot, fully
	 * downloaded and live, on a live host, and writable. A reconnecting or ended mirror is not.
	 */
	#readyGuest(room: AskRoom | null): GuestSnapshot | null {
		const view = this.#session.getSnapshot();
		const client = this.#session.guestClient();
		const guest = view.guest;
		const current = this.#room();
		if (!room || !current || !client || !guest || guest !== client.getSnapshot()) return null;
		if (current.hostId !== room.hostId || current.generation !== room.generation || current.client !== room.client) return null;
		if (view.mode !== "live" || view.host?.phase !== "live" || view.readOnly) return null;
		if (guest.phase !== "live" || guest.readOnly || guest.loading !== null) return null;
		return guest;
	}

	#sync(): void {
		const view = this.#session.getSnapshot();
		if (view.mode === "exited" || view.host?.phase === "exited") {
			this.#done.clear();
			this.#clear();
			return;
		}
		const state = this.#state;
		const room = this.#room();
		if (state) {
			// A new room (restart, /new, resume) or a new connection restarts omp's request ids: the series cannot continue there.
			const host = view.host;
			const moved = host ? host.hostId !== state.room.hostId || host.generation !== state.room.generation : false;
			if (moved || (room && room.client !== state.room.client)) {
				this.#clear();
				return;
			}
		}
		const guest = this.#readyGuest(room);
		if (!guest) return;
		for (const id of this.#done) if (!isAskRunning(guest, id)) this.#done.delete(id);
		if (state) {
			if (!isAskRunning(guest, state.toolCallId)) {
				this.#clear();
				return;
			}
			const request = guest.uiRequest;
			// Anything other than the held question 1 while the user answers (an approval, say) goes to the usual card unanswered.
			if (state.phase === "editing" && request && (request.reqId !== state.heldReqId || !isSeriesStart(state.questions, request))) {
				this.#fallback(state, `omp sent another request (${request.kind} "${request.title}") while the questions were open`);
			} else if (state.phase === "sending") this.#queueFlush();
			return;
		}
		const request = guest.uiRequest;
		if (!room || request?.kind !== "select") return;
		const inputs = [request, guest.activeTools, guest.entries, guest.stream, guest.working];
		if (inputs.every((input, index) => input === this.#detected[index])) return;
		this.#detected = inputs;
		const ask = findSeriesAsk(guest, request.title);
		if (!ask || this.#done.has(ask.toolCallId) || !isSeriesStart(ask.questions, request)) return;
		this.#answered.clear();
		this.#set({
			toolCallId: ask.toolCallId,
			room,
			heldReqId: request.reqId,
			questions: ask.questions,
			answers: ask.questions.map(defaultAnswer),
			index: 0,
			phase: "editing",
			cursor: REPLAY_START,
			fallbackReason: null,
			fallbackWhileSending: false,
		});
	}

	/** Replies run after the current update finishes, so answering never re-enters the session's listeners. */
	#queueFlush(): void {
		if (this.#flushQueued) return;
		this.#flushQueued = true;
		queueMicrotask(() => {
			this.#flushQueued = false;
			this.#flush();
		});
	}

	#flush(): void {
		const state = this.#state;
		if (state?.phase !== "sending") return;
		// A mirror that went away since the flush was queued is checked again on its next update.
		const guest = this.#readyGuest(state.room);
		const request = guest?.uiRequest;
		if (!guest || !request) return;
		if (!isAskRunning(guest, state.toolCallId)) return;
		// omp asking again for a request that was answered means the reply may not have arrived: answering again could toggle twice.
		if (this.#answered.has(request.reqId)) {
			this.#fallback(state, `omp repeated request ${request.reqId}, which was already answered`);
			return;
		}
		const step = replayStep(state.questions, state.answers, state.cursor, request);
		if (step.kind === "mismatch") {
			this.#fallback(state, `question ${state.cursor.question + 1}: ${step.reason}`);
			return;
		}
		this.#answered.add(request.reqId);
		this.#set({ ...state, cursor: step.cursor, phase: step.done ? "sent" : "sending" });
		this.#session.answer(request.reqId, step.value);
	}
}

const drivers = new WeakMap<AskSeriesSession, AskSeriesDriver>();

/** The chat's series driver, created on first use; it follows the chat from then on. */
export function askSeriesFor(session: AskSeriesSession): AskSeriesDriver {
	let driver = drivers.get(session);
	if (!driver) {
		driver = new AskSeriesDriver(session);
		drivers.set(session, driver);
	}
	return driver;
}

export function useAskSeries(session: AskSeriesSession): AskSeriesState | null {
	const driver = askSeriesFor(session);
	return useSyncExternalStore(driver.subscribe, driver.getSnapshot, driver.getSnapshot);
}
