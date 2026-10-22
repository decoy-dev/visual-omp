/**
 * SessionController: everything one chat tab knows and can do.
 *
 * A chat starts as a read-only view of its saved file (if any). The first time the user interacts,
 * it launches a hidden omp (resuming that file) through main's SessionHost, then mirrors omp's
 * live collab stream through the vendored GuestClient. Messages sent while omp is busy (see `busy`)
 * go to an app-side queue the user can edit, images included; they go out one at a time, each after
 * omp acknowledged the one before, or immediately (steering the current turn) with "Send now".
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { FollowState, HostState, SessionOwnership } from "@shared/ipc";
import type { Attachment } from "../chat/composer/drafts";
import { imagePathsText } from "../chat/composer/send";
import { GuestClient, type GuestSnapshot } from "../collab/lib/client";
import { extendSessionHistory, parseSessionHistory, type SessionHistory } from "./history";

export interface QueuedMessage {
	id: string;
	/** Message text; empty for a message that is only images. */
	text: string;
	/** Images omp attaches with the text, in the order they were added. */
	images: readonly Attachment[];
}

/** A shell or Python line omp runs itself, without a model turn, and the result entry it appends for it. */
interface LocalRun {
	role: "bashExecution" | "pythonExecution";
	/** The entry's `command` (shell) or `code` (Python), as omp parses it from the line. */
	source: string;
}

/**
 * Recognise a line omp runs itself, following omp's input-controller.ts: `!cmd` and `!!cmd` run `cmd` in
 * the shell; `$ code` and `$$ code` (the sigil followed by whitespace) run `code` in Python. omp records the
 * result as a message entry with role `bashExecution` (`command`) or `pythonExecution` (`code`).
 */
function localRun(text: string): LocalRun | null {
	const shell = /^!!?/.exec(text);
	if (shell) {
		const source = text.slice(shell[0].length).trim();
		return source ? { role: "bashExecution", source } : null;
	}
	const python = /^\$\$?(?=\s)/.exec(text);
	if (python) {
		const source = text.slice(python[0].length).trim();
		return source ? { role: "pythonExecution", source } : null;
	}
	return null;
}

/** True when `entry` is the result omp appended for `run`. */
function isRunResult(entry: SessionEntry, run: LocalRun): boolean {
	if (entry.type !== "message") return false;
	// The wire types list only the rendered roles; omp also replicates its shell and Python result messages.
	const message = entry.message as unknown as { role: string; command?: string; code?: string };
	return message.role === run.role && (run.role === "bashExecution" ? message.command : message.code) === run.source;
}

/**
 * What a message delivered into omp waits for before the next one may go (see `#awaitAck`), all within
 * the room `room`: omp starts a turn for it (a turn start after `turns`), or, for a shell or Python line,
 * omp appends that line's result entry after the first `entries` entries. `steered`: omp was running a
 * turn when the message was typed, so the turn may take it in and end without a new one; omp's user
 * entry for it then acknowledges it too.
 */
interface Acknowledgement {
	room: number;
	turns: number;
	entries: number;
	run: LocalRun | null;
	steered: boolean;
}

/** A delivery failed; `pasted` is true when the images were pasted into omp's editor before it did. */
class DeliveryFailure extends Error {
	constructor(
		readonly reason: unknown,
		readonly pasted: boolean,
	) {
		super(reason instanceof Error ? reason.message : String(reason));
	}
}

/** Thrown while omp's editor may still hold images from a message that didn't send (see `strandedImages`). */
class StrandedImagesError extends Error {
	constructor() {
		super("omp's message box may still hold images from a message that didn't send. Restart omp to clear it.");
	}
}

export type SessionMode = "history" | "starting" | "live" | "reconnecting" | "exited";

export interface SessionView {
	mode: SessionMode;
	host: HostState | null;
	/** Live mirror; null until omp's room is joined. Kept (stale) while reconnecting. */
	guest: GuestSnapshot | null;
	history: SessionHistory | null;
	queue: readonly QueuedMessage[];
	/** omp is running a turn. */
	working: boolean;
	/**
	 * When this app saw the current turn start (epoch ms), for "Working… 14s". Null when not working, or when the turn
	 * was already under way as the chat joined omp's room, since its real start is unknown then.
	 */
	workingSince: number | null;
	/** The saved session is (or may be) open in another omp process: typing is disabled and the transcript follows its file. */
	readOnly: boolean;
	/** Health and ownership of the followed file while read-only; null otherwise. */
	follow: Omit<FollowState, "file"> | null;
	/** A saved chat on a platform without ownership detection (Windows); shows a notice until dismissed. */
	ownerUnverified: boolean;
	/** Leaf to display after a rewind/tree move until omp appends the next entry (omp sends no frame for leaf moves). */
	displayLeaf: string | null;
	/**
	 * The previous room's entries while a new room (after /restart, /new or a session switch) downloads
	 * its snapshot; null once the new room has synced. Display only: questions and running tools always
	 * come from the current room.
	 */
	carryover: readonly SessionEntry[] | null;
	/**
	 * A message's images were pasted into omp's editor but its text failed to submit, so the images may
	 * still be there. Nothing is typed into omp until omp restarts (`restart`) or stops, which empties the
	 * editor; the queue tray offers the restart.
	 */
	strandedImages: boolean;
	error: string | null;
}

/**
 * The live mirror once it can stand in for what is on screen: its snapshot arrived (possibly empty,
 * after /new) or it holds entries. A newly joined room holds none until omp's snapshot finishes
 * downloading (a large chat takes seconds), so until then the previous room's entries or the saved
 * history stay visible. A mirror that reconnects keeps its entries.
 */
export function liveGuest(view: SessionView | null | undefined): GuestSnapshot | null {
	const guest = view?.guest;
	return guest && guest.phase !== "connecting" && (guest.phase === "live" || guest.entries.length > 0) ? guest : null;
}

/** Live entries to show (all branches): the synced mirror's, else the previous room's. Null: show the saved history. */
export function liveEntries(view: SessionView | null | undefined): readonly SessionEntry[] | null {
	return liveGuest(view)?.entries ?? view?.carryover ?? null;
}

export type SessionEvent =
	| { kind: "finished" }
	| { kind: "needsInput" }
	| { kind: "exited"; code: number | null }
	/** The user sent something from this window that goes to omp without waiting in the queue (`noteSent`). */
	| { kind: "sent" };

let nextQueueId = 0;

/**
 * Delivers a queued slash command when the queue drains or the user sends it now
 * (`features/session-tools/typed.ts` registers it): the app's routing first, so guarded commands never
 * reach omp and native ones open their screen, else typed into omp with its printed result captured.
 * Resolves once omp is done with it; the queue then continues. Rejects when the line could not be typed
 * (it goes back to its place in the queue); one that found omp's own screen up holds the queue
 * (`holdQueue`) until the screen goes. `report`: show other failures itself; false for Send now, whose
 * caller shows the failure.
 */
type SlashDelivery = (session: SessionController, line: string, options: { report: boolean }) => Promise<void>;
let slashDelivery: SlashDelivery | null = null;

export function setSlashDelivery(deliver: SlashDelivery): void {
	slashDelivery = deliver;
}

/** Session files the read-only tabs follow; main watches exactly this set (and drops it on reload). */
const followed = new Set<string>();

function syncFollowed(): void {
	void window.vomp.invoke("sessions:follow", [...followed]);
}

export class SessionController {
	readonly tabId: string;
	readonly projectPath: string;
	#sessionFile: string | null;
	#view: SessionView;
	/** Queued slash commands handed to `slashDelivery` and not yet done (see `#deliverSlash`). */
	#slashDeliveries = 0;
	/** Reasons the queue must not drain yet (omp shows a screen of its own, a typed command runs); see `holdQueue`. */
	#queueHolds = 0;
	/** A hold for omp's full-screen menu is in place. */
	#overlayHold = false;
	/** Messages and commands being written into omp's editor right now (`#deliverMessage`, `command`). */
	#writing = 0;
	/** The latest write into omp's editor; the next one starts after it, so two messages never interleave. */
	#lastWrite: Promise<void> = Promise.resolve();
	/** A message went to an idle omp and omp has not acknowledged it yet; nothing else drains meanwhile. */
	#awaiting: Acknowledgement | null = null;
	/** Turns seen starting (working edges), so an acknowledgement that arrived mid-write is not missed. */
	#turnStarts = 0;
	/**
	 * Counts omp rooms (a new collab room, or omp stopping): a write that finishes in a later room than it
	 * started in can't be acknowledged by the room's counters, so it waits for nothing.
	 */
	#room = 0;
	/**
	 * While `strandedImages` holds: `restartFrom` is the host generation when `restart` began typing /restart
	 * (null until then, or after that attempt failed). Only a later generation clears the hold, because omp
	 * also opens new rooms without restarting (a new session), and those keep the editor.
	 */
	#strandedSince: { restartFrom: number | null } | null = null;
	#resolvingFile = false;
	/** omp launch flags for the first start only (Claude Code / Codex import opens omp's picker). */
	#extraArgs: string[];
	/** Entry count at the last file lookup; lookups rerun only when omp appends entries. */
	#resolvedAtEntries = 0;
	#guest: GuestClient | null = null;
	#guestLink: string | null = null;
	#unsubscribeGuest: (() => void) | null = null;
	#unsubscribeHost: (() => void) | null = null;
	#starting: Promise<void> | null = null;
	#listeners = new Set<() => void>();
	#eventListeners = new Set<(event: SessionEvent) => void>();
	#unfollow: (() => void) | null = null;
	/** The followed file's full text arrived; later history comes only from its tail. */
	#tailSynced = false;
	/**
	 * Something was sent (or is on its way) to omp: a message, command, key press or answer. Set
	 * synchronously before any delivery await, so the chat is never moved to another folder mid-send.
	 */
	#inputSent = false;
	/** Terminal: after dispose() nothing starts, follows, connects or updates again. */
	#disposed = false;
	/** The ownership check a start must wait for, so omp never resumes a file before it is known to be free. */
	#ownershipCheck: Promise<void> | null = null;

	constructor(options: { tabId: string; projectPath: string; sessionFile: string | null; extraArgs?: string[] }) {
		this.tabId = options.tabId;
		this.projectPath = options.projectPath;
		this.#sessionFile = options.sessionFile;
		this.#extraArgs = options.extraArgs ?? [];
		this.#view = {
			mode: options.sessionFile ? "history" : "starting",
			host: null,
			guest: null,
			history: null,
			queue: [],
			working: false,
			workingSince: null,
			readOnly: false,
			follow: null,
			ownerUnverified: false,
			displayLeaf: null,
			carryover: null,
			strandedImages: false,
			error: null,
		};
	}

	get sessionFile(): string | null {
		return this.#view.host?.sessionFile ?? this.#sessionFile;
	}

	get hostId(): string | null {
		return this.#view.host?.hostId ?? null;
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	getSnapshot = (): SessionView => this.#view;

	/**
	 * Ask main whether another omp has this chat's file open. If so, or if that cannot be told
	 * (fail closed), the tab turns read-only and follows the file. Starting omp waits for this.
	 * On Windows (`unsupported`) nothing can be detected: the tab stays writable, as in v0.1, and
	 * `ownerUnverified` asks the user to close any terminal omp on the chat first.
	 */
	checkOwnership(): Promise<void> {
		const file = this.#sessionFile;
		if (!file || this.#disposed) return Promise.resolve();
		this.#ownershipCheck ??= (async () => {
			const ownership = await window.vomp.invoke("sessions:ownership", file).catch((): SessionOwnership => "unknown");
			if (this.#disposed) return;
			if (ownership === "unsupported") {
				this.#set({ ownerUnverified: true });
				return;
			}
			// A host adopted meanwhile (renderer reload) means this app is the writer.
			if (this.#view.host) return;
			if (ownership === "elsewhere" || ownership === "unknown") this.#follow(file, ownership);
		})().finally(() => {
			this.#ownershipCheck = null;
		});
		return this.#ownershipCheck;
	}

	/** Hide the Windows ownership notice for this chat. */
	dismissOwnerNotice(): void {
		if (this.#view.ownerUnverified) this.#set({ ownerUnverified: false });
	}

	/**
	 * Continue a followed chat here after main reported its file free. Ownership is checked again
	 * right before omp starts, and anything but `free` keeps the tab read-only (returns false).
	 *
	 * Remaining race: omp has no session ownership lock (only a per-write publish lock), so an omp
	 * started in a terminal between this check and our omp's first append could write the same file.
	 * Only an ownership lock in omp itself can close that gap.
	 */
	async continueHere(): Promise<boolean> {
		const file = this.#sessionFile;
		if (!file || this.#disposed || !this.#view.readOnly || this.#view.follow?.ownership !== "free") return false;
		const ownership = await window.vomp.invoke("sessions:ownership", file).catch((): SessionOwnership => "unknown");
		if (ownership !== "free" || this.#disposed || !this.#view.readOnly) return false;
		this.#stopFollowing();
		this.#set({ readOnly: false, follow: null });
		await this.ensureLive();
		return true;
	}

	/** Mirror what the other omp appends to the session file; stays read-only until continueHere(). */
	#follow(file: string, ownership: SessionOwnership): void {
		if (this.#disposed || this.#unfollow) return;
		this.#set({ readOnly: true, follow: { readable: true, error: null, ownership } });
		// Main's first tail for a file is the whole file (`reset`); appends before it would be out of order.
		this.#tailSynced = false;
		const offTail = window.vomp.on("sessions:tail", tail => {
			if (tail.file !== file || this.#unfollow !== stop) return;
			if (tail.reset) {
				this.#tailSynced = true;
				this.#set({ history: parseSessionHistory(tail.text) });
			} else if (this.#tailSynced && this.#view.history) {
				const history = extendSessionHistory(this.#view.history, tail.text);
				if (history !== this.#view.history) this.#set({ history });
			}
		});
		const offState = window.vomp.on("sessions:followState", state => {
			if (state.file !== file || this.#unfollow !== stop) return;
			this.#set({ follow: { readable: state.readable, error: state.error, ownership: state.ownership } });
		});
		const stop = () => {
			offTail();
			offState();
			followed.delete(file);
			syncFollowed();
		};
		this.#unfollow = stop;
		followed.add(file);
		syncFollowed();
	}

	#stopFollowing(): void {
		this.#unfollow?.();
		this.#unfollow = null;
		this.#tailSynced = false;
	}

	onEvent(listener: (event: SessionEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	/** Load the saved transcript for instant display. */
	async loadHistory(): Promise<void> {
		if (!this.#sessionFile) return;
		try {
			const text = await window.vomp.invoke("sessions:read", this.#sessionFile);
			// A followed tab may already hold newer text from the file's tail.
			if (!this.#disposed && !this.#tailSynced) this.#set({ history: parseSessionHistory(text) });
		} catch (error) {
			if (!this.#disposed) this.#set({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Launch (or resume) the hidden omp for this chat. Idempotent. */
	ensureLive(): Promise<void> {
		if (this.#disposed) return Promise.reject(new Error("This chat was closed."));
		if (this.#view.readOnly) return Promise.reject(new Error("This chat is open elsewhere."));
		if (this.#view.host && this.#view.host.phase !== "exited") return this.#starting ?? Promise.resolve();
		this.#starting ??= this.#start().finally(() => {
			this.#starting = null;
		});
		return this.#starting;
	}

	/** Start omp if needed and resolve once it runs and its live mirror is joined; rejects if omp exits first. */
	async whenLive(): Promise<void> {
		await this.ensureLive();
		if (this.#view.mode === "live" && this.#view.guest?.phase === "live") return;
		// omp can exit while it starts, before anything below subscribes.
		if (this.#view.mode === "exited") throw new Error(this.#view.error ?? "omp stopped");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const unsubscribe = this.subscribe(() => {
			const view = this.#view;
			if (view.mode === "live" && view.guest?.phase === "live") {
				unsubscribe();
				resolve();
			} else if (view.mode === "exited") {
				unsubscribe();
				reject(new Error(view.error ?? "omp stopped"));
			}
		});
		return promise;
	}

	/** Adopt an omp that is already running for this chat (renderer reload, window reopened). */
	attach(host: HostState): void {
		if (this.#disposed) return;
		this.#unsubscribeHost?.();
		this.#unsubscribeHost = window.vomp.on("host:state", state => {
			if (state.hostId === host.hostId) this.#onHostState(state);
		});
		this.#onHostState(host);
	}

	async #start(): Promise<void> {
		await this.#ownershipCheck;
		if (this.#disposed) throw new Error("This chat was closed.");
		if (this.#view.readOnly) throw new Error("This chat is open elsewhere.");
		this.#set({ mode: "starting", error: null });
		this.#unsubscribeHost?.();
		const pending: HostState[] = [];
		let hostId: string | null = null;
		// Subscribe before starting so no state transition is missed.
		this.#unsubscribeHost = window.vomp.on("host:state", state => {
			if (hostId === null) pending.push(state);
			else if (state.hostId === hostId) this.#onHostState(state);
		});
		let state: HostState;
		try {
			state = await window.vomp.invoke("host:start", {
				cwd: this.projectPath,
				resumeFile: this.#sessionFile ?? undefined,
				extraArgs: this.#extraArgs.length > 0 ? this.#extraArgs : undefined,
			});
		} catch (error) {
			// Main refused to start omp (e.g. the new-install permission check couldn't read omp's settings):
			// show its message where a failed start shows, with "Start omp again" to retry.
			const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, "");
			this.#unsubscribeHost?.();
			this.#unsubscribeHost = null;
			if (!this.#disposed) this.#set({ mode: "exited", working: false, error: message });
			throw new Error(message);
		}
		// Closed while omp was starting: this host has no tab, so stop it instead of adopting it.
		if (this.#disposed) {
			await this.#stopHost(state.hostId);
			throw new Error("This chat was closed.");
		}
		// Launch flags (e.g. --from-claude) apply to the first start only; later starts resume the file.
		this.#extraArgs = [];
		hostId = state.hostId;
		this.#onHostState(state);
		for (const later of pending) if (later.hostId === hostId) this.#onHostState(later);
	}

	#onHostState(host: HostState): void {
		if (this.#disposed) return;
		if (host.sessionFile) this.#sessionFile = host.sessionFile;
		if (host.phase === "exited") {
			// Nothing typed into the omp that stopped is coming back to acknowledge itself, and its editor is gone:
			// the next omp starts with an empty one.
			this.#room++;
			this.#awaiting = null;
			this.#strandedSince = null;
			this.#closeGuest();
			this.#set({ host, mode: "exited", working: false, strandedImages: false, error: host.error });
			this.#emit({ kind: "exited", code: host.exitCode });
			return;
		}
		if (host.link && host.link !== this.#guestLink) this.#openGuest(host.link);
		const mode: SessionMode =
			host.phase === "live" ? "live" : host.phase === "restarting" ? "reconnecting" : this.#guest ? "reconnecting" : "starting";
		this.#set({ host, mode, error: host.error });
		const restartFrom = this.#strandedSince?.restartFrom;
		if (restartFrom != null && host.generation > restartFrom) {
			// omp restarted as `restart` asked: its editor starts empty. The queue continues once the new room has synced.
			this.#strandedSince = null;
			this.#set({ strandedImages: false });
			this.whenLive().then(
				() => this.#resumeQueue(),
				() => undefined,
			);
		}
	}

	#openGuest(link: string): void {
		if (this.#disposed) return;
		// The new room shows nothing until its snapshot arrives; keep the current entries on screen meanwhile.
		const carryover = liveEntries(this.#view);
		// The new room counts entries and turns afresh, so a wait begun in the old one can't be acknowledged.
		this.#room++;
		this.#awaiting = null;
		this.#closeGuest();
		this.#guestLink = link;
		const guest = new GuestClient(link, "visual-omp");
		this.#guest = guest;
		this.#unsubscribeGuest = guest.subscribe(() => this.#onGuest(guest.getSnapshot()));
		if (carryover !== this.#view.carryover) this.#set({ carryover });
		guest.connect();
	}

	#closeGuest(): void {
		this.#unsubscribeGuest?.();
		this.#unsubscribeGuest = null;
		this.#guest?.close();
		this.#guest = null;
		this.#guestLink = null;
	}

	/** omp creates a new chat's file lazily with its first entry; look it up once entries exist. */
	async #resolveSessionFile(): Promise<void> {
		const sessionId = this.#view.host?.sessionId ?? this.#view.guest?.header?.id;
		if (!sessionId) return;
		this.#resolvingFile = true;
		try {
			const file = await window.vomp.invoke("sessions:find", sessionId);
			if (file && !this.#disposed) {
				this.#sessionFile = file;
				this.#set({});
			}
		} finally {
			this.#resolvingFile = false;
		}
	}

	/** Show the branch ending at `entryId` (after omp's /branch or /tree moved the leaf). Cleared by the next entry. */
	setDisplayLeaf(entryId: string | null): void {
		this.#set({ displayLeaf: entryId });
	}

	#onGuest(snapshot: GuestSnapshot): void {
		if (this.#disposed) return;
		const wasWorking = this.#view.working;
		const hadRequest = this.#view.guest?.uiRequest?.reqId;
		const working = snapshot.working;
		const appended = snapshot.entries.length > (this.#view.guest?.entries.length ?? 0);
		const patch: Partial<SessionView> = { guest: snapshot, working, ...(appended ? { displayLeaf: null } : {}) };
		// A turn seen starting on a synced mirror gets a start time; one already under way when the mirror joined or
		// reconnected keeps none.
		if (working && !wasWorking) {
			patch.workingSince = this.#view.guest?.phase === "live" ? Date.now() : null;
			this.#turnStarts++;
		}
		// The new room has synced, even to an empty chat after /new: stop showing the previous room's entries.
		if (this.#view.carryover && liveGuest({ ...this.#view, ...patch })) patch.carryover = null;
		this.#set(patch);
		if (!this.#sessionFile && !this.#resolvingFile && snapshot.entries.length !== this.#resolvedAtEntries) {
			this.#resolvedAtEntries = snapshot.entries.length;
			void this.#resolveSessionFile();
		}
		if (snapshot.uiRequest && snapshot.uiRequest.reqId !== hadRequest) this.#emit({ kind: "needsInput" });
		if (this.#awaiting && this.#acknowledged(this.#awaiting)) {
			this.#awaiting = null;
			// A shell or Python line finished without a turn: no turn end will move the queue on.
			if (!working) this.#resumeQueue();
		}
		if (wasWorking && !working) {
			if (this.#view.queue.length > 0) this.#resumeQueue();
			else this.#emit({ kind: "finished" });
		}
	}

	/** True once anything was sent or started sending to this chat's omp (see `markInput`). */
	get inputSent(): boolean {
		return this.#inputSent;
	}

	/**
	 * Record that input is about to go to omp. Every delivery path calls this before its first
	 * await; paths outside the controller (the terminal sheet) call it themselves.
	 */
	markInput(): void {
		if (this.#inputSent) return;
		this.#inputSent = true;
		this.#set({});
	}

	/**
	 * A message sent now must wait its turn in the queue: omp is not running yet or runs a turn, messages
	 * wait, something is being typed into omp, a message sent to omp has not been acknowledged, a slash
	 * command is being delivered or still runs (a hold), omp's own full-screen menu is open, or omp's editor
	 * may still hold a failed message's images (`strandedImages`).
	 */
	get busy(): boolean {
		return this.#view.mode !== "live" || this.#lineAhead;
	}

	/**
	 * `busy` without the start: something goes to omp before a message sent now, or omp must finish something first.
	 * A message sent while only omp's start is awaited goes out first once omp runs.
	 */
	get #lineAhead(): boolean {
		const view = this.#view;
		return (
			view.working ||
			view.queue.length > 0 ||
			view.strandedImages ||
			this.#writing > 0 ||
			this.#awaiting !== null ||
			this.#slashDeliveries > 0 ||
			this.#queueHolds > 0 ||
			(view.host?.tui?.overlays ?? 0) > 0
		);
	}

	/**
	 * Tell this window's views that the user sent something that goes to omp without waiting behind anything, so the
	 * transcript goes to its end to show it (`SessionEvent` "sent"). `send`, `steer` and `sendNow` call it; a slash
	 * command typed at once calls it from `features/session-tools/typed.ts`. Queued messages that go out later don't.
	 * It records the intent to send: callers fire it before anything is typed, so a send that then fails has still
	 * moved the view.
	 */
	noteSent(): void {
		this.#emit({ kind: "sent" });
	}

	/**
	 * Send a message and its images. It joins the end of the queue while omp is busy (see `busy`) and goes
	 * out in order through `#resumeQueue`; otherwise omp gets it at once. A message nothing waits ahead of
	 * (omp idle, or only starting) counts as sent now (`noteSent`).
	 */
	async send(text: string, images: readonly Attachment[] = []): Promise<void> {
		const message = { text: text.trim(), images: [...images] };
		if (!message.text && message.images.length === 0) return;
		this.markInput();
		if (!this.#lineAhead) this.noteSent();
		if (this.busy) {
			const item: QueuedMessage = { id: `q${nextQueueId++}`, ...message };
			this.#set({ queue: [...this.#view.queue, item] });
			try {
				await this.whenLive();
			} catch (error) {
				// omp did not start: the caller gets the message back (the composer restores its draft), so it leaves the queue.
				if (!this.#disposed) this.#set({ queue: this.#view.queue.filter(entry => entry.id !== item.id) });
				throw error;
			}
			this.#resumeQueue();
			return;
		}
		await this.#deliverDirect(message);
	}

	/**
	 * Deliver a message and its images right away, steering the turn omp is running ("Send now"). While
	 * omp's editor may still hold another message's images it queues instead, so it can't carry them.
	 */
	async steer(text: string, images: readonly Attachment[] = []): Promise<void> {
		if (this.#view.strandedImages) return this.send(text, images);
		const message = { text: text.trim(), images: [...images] };
		if (!message.text && message.images.length === 0) return;
		this.markInput();
		this.noteSent();
		await this.whenLive();
		await this.#deliverDirect(message);
	}

	/**
	 * Deliver a queued message right away, steering the current turn. When it can't be delivered it goes
	 * back to its place in the queue and the promise rejects with the reason. Refused while omp's editor
	 * may still hold a failed message's images.
	 */
	async sendNow(id: string): Promise<void> {
		const index = this.#view.queue.findIndex(entry => entry.id === id);
		const item = this.#view.queue[index];
		if (!item) return;
		if (this.#view.strandedImages) throw new StrandedImagesError();
		this.#set({ queue: this.#view.queue.filter(entry => entry.id !== id) });
		this.noteSent();
		if (this.#isSlash(item)) {
			await this.#deliverSlash(item, index, false);
			return;
		}
		try {
			await this.#deliverMessage(item);
		} catch (error) {
			const failure = error instanceof DeliveryFailure ? error : new DeliveryFailure(error, false);
			this.#requeue(item, index);
			throw failure.reason;
		}
	}

	editQueued(id: string, text: string): void {
		this.#set({ queue: this.#view.queue.map(entry => (entry.id === id ? { ...entry, text } : entry)) });
	}

	removeQueued(id: string): void {
		this.#set({ queue: this.#view.queue.filter(entry => entry.id !== id) });
	}

	moveQueued(id: string, toIndex: number): void {
		const queue = [...this.#view.queue];
		const from = queue.findIndex(entry => entry.id === id);
		if (from < 0) return;
		const [item] = queue.splice(from, 1);
		if (item) queue.splice(Math.max(0, Math.min(queue.length, toIndex)), 0, item);
		this.#set({ queue });
	}

	/**
	 * Type an omp slash command (e.g. `/restart`, `/compact focus on tests`) into the real TUI. While it is
	 * typed, sends queue and the queue stays put; the caller holds the queue for longer when the command
	 * keeps running (see `holdQueue`). A command does not move the queue on when it is done, because it may
	 * have started a turn the app can't foresee: that turn's end, the caller's hold, the next send or a hold's
	 * end does. Refused while omp's editor may still hold a failed message's images.
	 */
	async command(line: string): Promise<void> {
		await this.#command(line, false);
	}

	/** `beforeSubmit` runs inside the serialized write, right before the line is typed. */
	async #command(line: string, overStrandedImages: boolean, beforeSubmit?: () => void): Promise<void> {
		this.markInput();
		await this.#write(async () => {
			if (this.#view.strandedImages && !overStrandedImages) throw new StrandedImagesError();
			await this.whenLive();
			beforeSubmit?.();
			await this.#submit(line, "steer");
		});
	}

	/** Press keys in omp's TUI (tmux-style tokens: "escape", "down down enter"). */
	async keys(keys: string): Promise<void> {
		if (!this.hostId) return;
		this.markInput();
		await window.vomp.invoke("host:keys", this.hostId, keys);
	}

	/** Stop the current turn without restoring queued messages into omp's editor. */
	abort(): void {
		this.#guest?.sendAbort();
	}

	/** Answer a pending omp question/approval (`value` = option label or text; undefined = skip). */
	answer(reqId: number, value: string | undefined): void {
		this.markInput();
		this.#guest?.sendUiResponse(reqId, value);
	}

	/** Steer/kill/revive a running subagent. */
	agentCommand(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#guest?.sendAgentCmd(cmd, agentId, text);
	}

	guestClient(): GuestClient | null {
		return this.#guest;
	}

	async restart(): Promise<void> {
		if (this.#view.mode === "exited" || !this.#view.host) {
			await this.ensureLive();
			return;
		}
		// The restart empties omp's editor, so it is the one thing typed while a message's images may be stranded
		// there. The hold ends only on a generation newer than the one omp had when /restart was typed (see
		// `#onHostState`); updates in that generation, and a restart that failed to type, keep it.
		const markRestart = () => {
			if (this.#strandedSince) this.#strandedSince.restartFrom = this.#view.host?.generation ?? 0;
		};
		try {
			await this.#command("/restart", true, markRestart);
		} catch (error) {
			if (this.#strandedSince) this.#strandedSince.restartFrom = null;
			throw error;
		}
	}

	/**
	 * Stop omp cleanly (session is saved) and release everything. Terminal: a start still in flight
	 * stops its own host when it resolves (see #start), and nothing follows or connects afterwards.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stopFollowing();
		this.#closeGuest();
		this.#unsubscribeHost?.();
		this.#unsubscribeHost = null;
		this.#listeners.clear();
		this.#eventListeners.clear();
		await this.#starting?.catch(() => undefined);
		const host = this.#view.host;
		if (host && host.phase !== "exited") await this.#stopHost(host.hostId);
	}

	/**
	 * Stop a host this controller owns. A failure is logged, not thrown: the tab is gone either way,
	 * and main stops every host at quit (the renderer also stops unowned hosts after a reload).
	 */
	async #stopHost(hostId: string): Promise<void> {
		try {
			await window.vomp.invoke("host:stop", hostId);
		} catch (error) {
			console.error(`Could not stop omp host ${hostId}`, error);
		}
	}

	async #submit(text: string, mode: "steer" | "followUp"): Promise<void> {
		const hostId = this.hostId;
		this.markInput();
		if (!hostId) throw new Error("omp is not running");
		await window.vomp.invoke("host:submit", hostId, text, mode);
	}

	/**
	 * Run one write into omp's editor after the writes before it have finished, so two messages never
	 * interleave (one's images pasted into the other). Sends queue and the queue stays put meanwhile.
	 */
	async #write<T>(work: () => Promise<T>): Promise<T> {
		this.#writing++;
		const previous = this.#lastWrite;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#lastWrite = promise;
		try {
			await previous;
			return await work();
		} finally {
			this.#writing--;
			resolve();
		}
	}

	/**
	 * Type one message into omp's editor and submit it. Images travel the way a terminal delivers a file
	 * drag: a bracketed paste of their escaped paths makes omp attach them, and omp holds the keys that
	 * follow until the images are loaded. Refused (before anything is typed) while omp's editor may still
	 * hold a failed message's images. Once the write is done, `#settle` decides what the queue waits for.
	 * Rejects with a `DeliveryFailure` that says whether the images were pasted before it failed.
	 */
	async #deliverMessage(item: { text: string; images: readonly Attachment[] }): Promise<void> {
		this.markInput();
		let pasted = false;
		let ack: Acknowledgement;
		try {
			ack = await this.#write(async () => {
				if (this.#view.strandedImages) throw new StrandedImagesError();
				const hostId = this.hostId;
				if (!hostId) throw new Error("omp is not running");
				const before: Acknowledgement = {
					room: this.#room,
					turns: this.#turnStarts,
					entries: this.#view.guest?.entries.length ?? 0,
					run: localRun(item.text),
					steered: this.#view.working,
				};
				if (item.images.length > 0) {
					await window.vomp.invoke("composer:paste", hostId, imagePathsText(item.images.map(image => image.path)));
					pasted = true;
				}
				// Without text, Enter alone submits the images: an empty paste would make omp attach the clipboard.
				if (item.text) await this.#submit(item.text, "steer");
				else await window.vomp.invoke("host:write", hostId, "\r");
				return before;
			});
		} catch (error) {
			// The paste got through but the submit did not: the images may sit in omp's editor, and anything typed
			// next would carry them. Hold everything until omp restarts or stops (see `strandedImages`).
			if (pasted) this.#strandImages();
			throw new DeliveryFailure(error, pasted);
		}
		this.#settle(ack);
	}

	#strandImages(): void {
		if (this.#disposed || this.#view.strandedImages) return;
		this.#strandedSince = { restartFrom: null };
		this.#set({ strandedImages: true });
	}

	/**
	 * Deliver a message from the composer at once. When it fails after its images were pasted, sending it
	 * again from the composer could attach them twice, so it waits first in the queue instead (going out
	 * with a fresh paste after omp restarts), and the promise resolves. Any other failure rejects with the
	 * reason, and the caller gets the message back.
	 */
	async #deliverDirect(message: { text: string; images: readonly Attachment[] }): Promise<void> {
		try {
			await this.#deliverMessage(message);
		} catch (error) {
			if (!(error instanceof DeliveryFailure)) throw error;
			if (!error.pasted) throw error.reason;
			console.error("Could not submit a message after pasting its images", error.reason);
			this.#requeue({ id: `q${nextQueueId++}`, ...message }, 0);
		}
	}

	/**
	 * A write into omp finished: decide what the queue waits for. A write that began in an earlier room
	 * (omp stopped or moved meanwhile) waits for nothing: that room's counters can't acknowledge it, and
	 * the next send, turn end or hold end moves the queue. A message that steered the turn still running
	 * waits for that turn's end. Otherwise (omp idle, including when the turn ended while it was typed)
	 * it waits for omp to acknowledge it, or the queue moves on at once when omp already did.
	 */
	#settle(ack: Acknowledgement): void {
		if (ack.room !== this.#room) return;
		if (this.#view.working && !this.#acknowledged(ack)) return;
		this.#awaitAck(ack);
	}

	/**
	 * Nothing else drains until omp acknowledges the message (`#acknowledged`). There is no time limit, so a
	 * message omp never acknowledges keeps the queue waiting rather than sending the next one into it; Send
	 * now still delivers a queued message.
	 */
	#awaitAck(ack: Acknowledgement): void {
		if (!this.#acknowledged(ack)) {
			this.#awaiting = ack;
			return;
		}
		if (!this.#view.working) this.#resumeQueue();
	}

	/**
	 * omp acknowledged the message: a turn started after it was typed, or for a shell or Python line omp
	 * appended that line's result. A message that steered a running turn also counts once omp records it
	 * as a user message, since the turn may take it in and end without starting another; a message sent to
	 * an idle omp waits for its own turn.
	 */
	#acknowledged(ack: Acknowledgement): boolean {
		if (ack.room !== this.#room) return false;
		if (this.#turnStarts > ack.turns) return true;
		const added = this.#view.guest?.entries.slice(ack.entries) ?? [];
		const run = ack.run;
		if (run) return added.some(entry => isRunResult(entry, run));
		return ack.steered && added.some(entry => entry.type === "message" && entry.message.role === "user" && !entry.message.synthetic);
	}

	/** Put `item` back at `index` (clamped) after a failed delivery. */
	#requeue(item: QueuedMessage, index: number): void {
		if (this.#disposed) return;
		const queue = [...this.#view.queue];
		queue.splice(Math.min(index, queue.length), 0, item);
		this.#set({ queue });
	}

	/** A queued slash command goes through `slashDelivery`; with images it is a message like any other. */
	#isSlash(item: QueuedMessage): boolean {
		return slashDelivery !== null && item.images.length === 0 && item.text.startsWith("/");
	}

	#drainOne(): void {
		const [next, ...rest] = this.#view.queue;
		if (!next) return;
		this.#set({ queue: rest });
		if (this.#isSlash(next)) {
			// Not typed: it goes back first in line. A hold (omp's screen), the next send or a turn end brings it back.
			this.#deliverSlash(next, 0, true).catch(() => undefined);
			return;
		}
		this.#deliverMessage(next).catch((error: unknown) => {
			const failure = error instanceof DeliveryFailure ? error : new DeliveryFailure(error, false);
			console.error("Could not deliver a queued message", failure.reason);
			// It goes back first in line; the next send, turn end or hold end tries again (after omp restarts, when
			// its images were pasted).
			this.#requeue(next, 0);
		});
	}

	/**
	 * Hand a queued slash line to `slashDelivery`. When it was not typed, the line goes back to `index` in
	 * the queue and the promise rejects. A command that starts no turn never brings a working→idle edge, so
	 * the queue continues when the delivery is done.
	 */
	async #deliverSlash(item: QueuedMessage, index: number, report: boolean): Promise<void> {
		if (!slashDelivery) return;
		this.#slashDeliveries++;
		try {
			await slashDelivery(this, item.text, { report });
		} catch (error) {
			this.#slashDeliveries--;
			this.#requeue(item, index);
			throw error;
		}
		this.#slashDeliveries--;
		this.#resumeQueue();
	}

	/**
	 * Keep the queue from draining until `until` settles, because omp shows a screen of its own (a typed
	 * command opened it, or a queued one found it open) and anything typed now would land in it. The
	 * queue continues once the last hold ends and the chat is idle.
	 */
	holdQueue(until: Promise<unknown>): void {
		this.#queueHolds++;
		void until
			.catch(() => undefined)
			.then(() => {
				this.#queueHolds--;
				this.#resumeQueue();
			});
	}

	/**
	 * The one place the queue moves on its own: after a turn ends, a send, a message's write, a slash
	 * delivery, a hold, the acknowledgement of a shell or Python line, or omp's restart clearing stranded
	 * images. Nothing drains while omp works, something is being typed into omp, a message sent to omp has
	 * not been acknowledged, a slash delivery is in flight, a hold stands or omp's editor may hold a failed
	 * message's images, so no item is sent twice and items go one at a time; with omp's full-screen menu
	 * open it holds until the menu closes instead.
	 */
	#resumeQueue(): void {
		const view = this.#view;
		if (this.#disposed || view.queue.length === 0 || view.mode !== "live" || view.working || view.strandedImages) return;
		if (this.#writing > 0 || this.#awaiting !== null || this.#slashDeliveries > 0 || this.#queueHolds > 0) return;
		if ((view.host?.tui?.overlays ?? 0) === 0) {
			this.#drainOne();
			return;
		}
		if (this.#overlayHold) return;
		this.#overlayHold = true;
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = this.subscribe(() => {
			const next = this.#view;
			if ((next.host?.tui?.overlays ?? 0) > 0 && next.mode !== "exited") return;
			unsubscribe();
			this.#overlayHold = false;
			resolve();
		});
		this.holdQueue(promise);
	}

	#set(patch: Partial<SessionView>): void {
		this.#view = { ...this.#view, ...patch, ...(patch.working === false ? { workingSince: null } : {}) };
		for (const listener of this.#listeners) listener();
	}

	#emit(event: SessionEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}
}
