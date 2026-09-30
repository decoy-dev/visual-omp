/**
 * SessionController: everything one chat tab knows and can do.
 *
 * A chat starts as a read-only view of its saved file (if any). The first time the user interacts,
 * it launches a hidden omp (resuming that file) through main's SessionHost, then mirrors omp's
 * live collab stream through the vendored GuestClient. Messages sent while omp is working wait in
 * an app-side queue the user can edit; they go out one at a time when omp yields, or immediately
 * (steering the current turn) with "Send now".
 */
import type { HostState } from "@shared/ipc";
import { GuestClient, type GuestSnapshot } from "../collab/lib/client";
import { parseSessionHistory, type SessionHistory } from "./history";

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
	/** The saved session is open in another omp process; typing is disabled. */
	readOnly: boolean;
	error: string | null;
}

export type SessionEvent =
	| { kind: "finished" }
	| { kind: "needsInput" }
	| { kind: "exited"; code: number | null };

let nextQueueId = 0;

export class SessionController {
	readonly tabId: string;
	readonly projectPath: string;
	#sessionFile: string | null;
	#view: SessionView;
	#resolvingFile = false;
	/** Entry count at the last file lookup; lookups rerun only when omp appends entries. */
	#resolvedAtEntries = 0;
	#guest: GuestClient | null = null;
	#guestLink: string | null = null;
	#unsubscribeGuest: (() => void) | null = null;
	#unsubscribeHost: (() => void) | null = null;
	#starting: Promise<void> | null = null;
	#listeners = new Set<() => void>();
	#eventListeners = new Set<(event: SessionEvent) => void>();

	constructor(options: { tabId: string; projectPath: string; sessionFile: string | null; readOnly?: boolean }) {
		this.tabId = options.tabId;
		this.projectPath = options.projectPath;
		this.#sessionFile = options.sessionFile;
		this.#view = {
			mode: options.sessionFile ? "history" : "starting",
			host: null,
			guest: null,
			history: null,
			queue: [],
			working: false,
			readOnly: options.readOnly ?? false,
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

	onEvent(listener: (event: SessionEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}

	/** Load the saved transcript for instant display. */
	async loadHistory(): Promise<void> {
		if (!this.#sessionFile) return;
		try {
			const text = await window.vomp.invoke("sessions:read", this.#sessionFile);
			this.#set({ history: parseSessionHistory(text) });
		} catch (error) {
			this.#set({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** Launch (or resume) the hidden omp for this chat. Idempotent. */
	ensureLive(): Promise<void> {
		if (this.#view.readOnly) return Promise.reject(new Error("This chat is open elsewhere."));
		if (this.#view.host && this.#view.host.phase !== "exited") return this.#starting ?? Promise.resolve();
		this.#starting ??= this.#start().finally(() => {
			this.#starting = null;
		});
		return this.#starting;
	}

	async #start(): Promise<void> {
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
		});
		hostId = state.hostId;
		this.#onHostState(state);
		for (const later of pending) if (later.hostId === hostId) this.#onHostState(later);
	}

	#onHostState(host: HostState): void {
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
		this.#closeGuest();
		this.#guestLink = link;
		const guest = new GuestClient(link, "visual-omp");
		this.#guest = guest;
		this.#unsubscribeGuest = guest.subscribe(() => this.#onGuest(guest.getSnapshot()));
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
			if (file) {
				this.#sessionFile = file;
				this.#set({});
			}
		} finally {
			this.#resolvingFile = false;
		}
	}

	#onGuest(snapshot: GuestSnapshot): void {
		const wasWorking = this.#view.working;
		const hadRequest = this.#view.guest?.uiRequest?.reqId;
		const working = snapshot.working;
		this.#set({ guest: snapshot, working });
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

	/** Send a message; queued while omp works or starts, delivered when it yields. */
	async send(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
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
		await this.ensureLive();
		await this.#whenLive();
		await this.#submit(line, "steer");
	}

	/** Press keys in omp's TUI (tmux-style tokens: "escape", "down down enter"). */
	async keys(keys: string): Promise<void> {
		if (!this.hostId) return;
		await window.vomp.invoke("host:keys", this.hostId, keys);
	}

	/** Stop the current turn without restoring queued messages into omp's editor. */
	abort(): void {
		this.#guest?.sendAbort();
	}

	/** Answer a pending omp question/approval (`value` = option label or text; undefined = skip). */
	answer(reqId: number, value: string | undefined): void {
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

	/** Stop omp cleanly (session is saved) and release everything. */
	async dispose(): Promise<void> {
		this.#closeGuest();
		this.#unsubscribeHost?.();
		this.#unsubscribeHost = null;
		const hostId = this.hostId;
		if (hostId) await window.vomp.invoke("host:stop", hostId);
		this.#listeners.clear();
		this.#eventListeners.clear();
	}

	async #submit(text: string, mode: "steer" | "followUp"): Promise<void> {
		const hostId = this.hostId;
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
