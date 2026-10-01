/**
 * SessionController: everything one chat tab knows and can do.
 *
 * A chat starts as a read-only view of its saved file (if any). The first time the user interacts,
 * it launches a hidden omp (resuming that file) through main's SessionHost, then mirrors omp's
 * live collab stream through the vendored GuestClient. Messages sent while omp is working wait in
 * an app-side queue the user can edit; they go out one at a time when omp yields, or immediately
 * (steering the current turn) with "Send now".
 */
import type { SessionEntry } from "@oh-my-pi/pi-wire";
import type { FollowState, HostState, SessionOwnership } from "@shared/ipc";
import { GuestClient, type GuestSnapshot } from "../collab/lib/client";
import { extendSessionHistory, parseSessionHistory, type SessionHistory } from "./history";

export interface QueuedMessage {
	id: string;
	text: string;
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
	| { kind: "exited"; code: number | null };

let nextQueueId = 0;

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
			readOnly: false,
			follow: null,
			ownerUnverified: false,
			displayLeaf: null,
			carryover: null,
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
		const state = await window.vomp.invoke("host:start", {
			cwd: this.projectPath,
			resumeFile: this.#sessionFile ?? undefined,
			extraArgs: this.#extraArgs.length > 0 ? this.#extraArgs : undefined,
		});
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
			this.#closeGuest();
			this.#set({ host, mode: "exited", working: false, error: host.error });
			this.#emit({ kind: "exited", code: host.exitCode });
			return;
		}
		if (host.link && host.link !== this.#guestLink) this.#openGuest(host.link);
		const mode: SessionMode =
			host.phase === "live" ? "live" : host.phase === "restarting" ? "reconnecting" : this.#guest ? "reconnecting" : "starting";
		this.#set({ host, mode, error: host.error });
	}

	#openGuest(link: string): void {
		if (this.#disposed) return;
		// The new room shows nothing until its snapshot arrives; keep the current entries on screen meanwhile.
		const carryover = liveEntries(this.#view);
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
		// The new room has synced, even to an empty chat after /new: stop showing the previous room's entries.
		if (this.#view.carryover && liveGuest({ ...this.#view, ...patch })) patch.carryover = null;
		this.#set(patch);
		if (!this.#sessionFile && !this.#resolvingFile && snapshot.entries.length !== this.#resolvedAtEntries) {
			this.#resolvedAtEntries = snapshot.entries.length;
			void this.#resolveSessionFile();
		}
		if (snapshot.uiRequest && snapshot.uiRequest.reqId !== hadRequest) this.#emit({ kind: "needsInput" });
		if (wasWorking && !working) {
			if (this.#view.queue.length > 0) this.#drainOne();
			else this.#emit({ kind: "finished" });
		}
	}

	/** True once anything was sent or started sending to this chat's omp (see `markInput`). */
	get inputSent(): boolean {
		return this.#inputSent;
	}

	/**
	 * Record that input is about to go to omp. Every delivery path calls this before its first
	 * await; paths outside the controller (image paste, the terminal sheet) call it themselves.
	 */
	markInput(): void {
		if (this.#inputSent) return;
		this.#inputSent = true;
		this.#set({});
	}

	/** Send a message; queued while omp works or starts, delivered when it yields. */
	async send(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		this.markInput();
		if (this.#view.working || this.#view.mode !== "live" || this.#view.queue.length > 0) {
			this.#set({ queue: [...this.#view.queue, { id: `q${nextQueueId++}`, text: trimmed }] });
			await this.ensureLive();
			await this.#whenLive();
			if (!this.#view.working) this.#drainOne();
			return;
		}
		await this.#submit(trimmed, "steer");
	}

	/** Deliver a queued message right away, steering the current turn. */
	async sendNow(id: string): Promise<void> {
		const item = this.#view.queue.find(entry => entry.id === id);
		if (!item) return;
		this.#set({ queue: this.#view.queue.filter(entry => entry.id !== id) });
		await this.#submit(item.text, "steer");
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

	/** Type an omp slash command (e.g. `/restart`, `/compact focus on tests`) into the real TUI. */
	async command(line: string): Promise<void> {
		this.markInput();
		await this.ensureLive();
		await this.#whenLive();
		await this.#submit(line, "steer");
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
		await this.command("/restart");
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

	#drainOne(): void {
		const [next, ...rest] = this.#view.queue;
		if (!next) return;
		this.#set({ queue: rest });
		void this.#submit(next.text, "steer");
	}

	#whenLive(): Promise<void> {
		if (this.#view.mode === "live" && this.#view.guest?.phase === "live") return Promise.resolve();
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

	#set(patch: Partial<SessionView>): void {
		this.#view = { ...this.#view, ...patch };
		for (const listener of this.#listeners) listener();
	}

	#emit(event: SessionEvent): void {
		for (const listener of this.#eventListeners) listener(event);
	}
}
