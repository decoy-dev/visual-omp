import type { SubagentLifecyclePayload } from "@oh-my-pi/pi-wire";
import type { GuestSnapshot } from "../../collab/lib/client";
import { type SessionHistory } from "../../state/history";
import { type SessionController } from "../../state/session";
import { watchSessionFile } from "../../state/sessionFiles";
import { helpersOf, ompRunning, type Helper } from "./derive";
import { i18n } from "../../i18n";

export interface HelperMessage { id: number; text: string; state: "queued" | "preparing" | "sending" | "error"; error?: string }
export interface HelperConversationSnapshot {
	helper: Helper;
	history: SessionHistory | null;
	file: string | null;
	error: string | null;
	queue: readonly HelperMessage[];
	stale: boolean;
	draft: string;
}
const conversations = new WeakMap<SessionController, Map<string, HelperConversation>>();

/** The semantic subscription remains live while the helper view is closed or the window is hidden. */
export class HelperConversation {
	#snapshot: HelperConversationSnapshot;
	#listeners = new Set<() => void>();
	#offSession: () => void;
	#offEvent: () => void;
	#offFile: (() => void) | null = null;
	#scope: string;
	#fileRequest = 0;
	#looking = false;
	#disposed = false;
	#messageId = 0;
	#sending: { id: number; phase: "preparing" | "dispatched"; lifecycle: SubagentLifecyclePayload | undefined; started: boolean; timer?: number } | null = null;
	#noticeId = 0;
	#sources: { agents: GuestSnapshot["agents"]; progress: GuestSnapshot["progress"]; lifecycle: GuestSnapshot["lifecycle"]; running: boolean } | null = null;
	constructor(readonly session: SessionController, helper: Helper) {
		this.#snapshot = { helper, history: null, file: null, error: null, queue: [], draft: "", stale: false };
		this.#scope = this.#identity();
		this.#noticeId = session.getSnapshot().guest?.notices.at(-1)?.id ?? 0;
		this.#offSession = session.subscribe(() => this.#update());
		this.#offEvent = session.onEvent(event => { if (event.kind === "disposed") this.dispose(); });
		this.#update();
	}
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		this.#update();
		return () => { this.#listeners.delete(listener); this.#releaseFile(); };
	};
	getSnapshot = (): HelperConversationSnapshot => this.#snapshot;
	setDraft(text: string): void { this.#set({ draft: text }); }
	enqueue(): void {
		const text = this.#snapshot.draft.trim();
		if (!text || this.#disposed || this.#snapshot.stale) return;
		this.#set({ draft: "", queue: [...this.#snapshot.queue, { id: ++this.#messageId, text, state: "queued" }] });
		this.#drain();
	}
	cancel(id: number): void {
		if (this.#sending?.id === id) {
			if (this.#sending.phase === "dispatched") return;
			clearTimeout(this.#sending.timer); this.#sending = null;
		}
		this.#set({ queue: this.#snapshot.queue.filter(item => item.id !== id) });
		this.#drain();
	}
	retry(id: number): void {
		if (this.#snapshot.stale) return;
		this.#set({ queue: this.#snapshot.queue.map(item => item.id === id ? { id, text: item.text, state: "queued" } : item) });
		this.#drain();
	}
	reload(): void {
		if (this.#snapshot.stale) return;
		this.#offFile?.(); this.#offFile = null;
		this.#set({ error: null, history: null, file: null });
		void this.#findFile();
	}
	dispose(): void {
		this.#disposed = true;
		this.#fileRequest++;
		clearTimeout(this.#sending?.timer);
		this.#sending = null;
		this.#offSession(); this.#offEvent(); this.#offFile?.();
		this.#listeners.clear();
	}
	#identity(): string {
		const view = this.session.getSnapshot();
		return `${view.host?.hostId ?? ""}:${view.host?.generation ?? ""}:${view.guest?.header?.id ?? this.session.sessionFile ?? ""}`;
	}
	#idle(): boolean {
		const view = this.session.getSnapshot();
		const agent = view.guest?.agents.find(agent => agent.id === this.#snapshot.helper.id && agent.kind === "sub");
		return this.#scope === this.#identity() && view.mode === "live" && !view.readOnly && view.guest?.phase === "live" && !view.guest.readOnly
			&& (agent?.status === "idle" || agent?.status === "parked") && view.guest.lifecycle.get(this.#snapshot.helper.id)?.status !== "aborted"
			&& this.#snapshot.helper.messageable && this.#snapshot.helper.status !== "running";
	}
	#update(): void {
		if (this.#disposed) return;
		const view = this.session.getSnapshot();
		if (this.#scope !== this.#identity()) {
			clearTimeout(this.#sending?.timer); this.#sending = null;
			this.#set({ stale: true, helper: { ...this.#snapshot.helper, messageable: false, status: "stopped" }, error: i18n.t("panes:tasks.focus.errors.scope"), queue: this.#snapshot.queue.map(item => ({ ...item, state: "error", error: i18n.t("panes:tasks.focus.errors.scopeMessage") })) });
			this.#offSession(); this.#offFile?.(); this.#offFile = null;
			this.#fileRequest++; this.#looking = false;
			return;
		}
		const guest = view.guest;
		const running = ompRunning(view);
		let helper = this.#snapshot.helper;
		const sources = this.#sources;
		if (guest && (!sources || sources.agents !== guest.agents || sources.progress !== guest.progress || sources.lifecycle !== guest.lifecycle || sources.running !== running)) {
			this.#sources = { agents: guest.agents, progress: guest.progress, lifecycle: guest.lifecycle, running };
			helper = helpersOf(guest, running).find(helper => helper.id === this.#snapshot.helper.id) ?? { ...helper, messageable: false };
			this.#set({ helper });
		}
		if (!guest && !running && helper.messageable) {
			helper = { ...helper, messageable: false, status: helper.status === "running" ? "stopped" : helper.status };
			this.#set({ helper });
		}
		if (!helper.messageable && this.#snapshot.queue.some(item => item.state === "queued")) {
			this.#set({ queue: this.#snapshot.queue.map(item => item.state === "queued" ? { ...item, state: "error", error: i18n.t("panes:tasks.focus.errors.unavailable") } : item) });
		}
		for (const notice of view.guest?.notices ?? []) {
			if (notice.id <= this.#noticeId) continue;
			this.#noticeId = notice.id;
			if (notice.level === "error" && notice.message.startsWith(`agent ${this.#snapshot.helper.id}:`)) {
				if (this.#sending) this.#fail(this.#sending.id, notice.message);
				else this.#set({ error: notice.message });
			}
		}
		const sending = this.#sending;
		if (sending) {
			const aborted = guest?.agents.find(agent => agent.id === helper.id)?.status === "aborted" || guest?.lifecycle.get(helper.id)?.status === "aborted";
			if (aborted || !this.#snapshot.helper.messageable || view.mode === "exited" || guest?.phase === "ended") this.#fail(sending.id, i18n.t("panes:tasks.focus.errors.unavailable"));
			else if (sending.phase === "dispatched") {
				const lifecycle = view.guest?.lifecycle.get(this.#snapshot.helper.id);
				if (helper?.status === "running") sending.started = true;
				// A completed lifecycle received since dispatch also covers a turn too short to show its running state.
				if (this.#idle() && (sending.started || lifecycle !== sending.lifecycle && lifecycle?.status !== "started")) this.#finish(sending.id);
			}
		}
		if (this.#listeners.size > 0 && !this.#snapshot.file && !this.#looking && !this.#snapshot.error) void this.#findFile();
		this.#drain();
	}
	async #findFile(): Promise<void> {
		const parent = this.session.sessionFile;
		if (!parent) { this.#set({ error: i18n.t("panes:tasks.focus.errors.noParent") }); return; }
		this.#looking = true;
		const request = ++this.#fileRequest;
		try {
			const file = await window.vomp.invoke("sessions:helperFile", parent, this.#snapshot.helper.id);
			if (this.#disposed || request !== this.#fileRequest) return;
			if (!file) { this.#set({ error: i18n.t("panes:tasks.focus.errors.noFile") }); return; }
			this.#set({ file });
			this.#offFile = watchSessionFile(file, (history, state) => {
				if (this.#disposed || request !== this.#fileRequest) return;
				this.#set({ ...(history ? { history } : {}), error: state && !state.readable ? state.error ?? i18n.t("panes:tasks.focus.errors.unreadable") : null });
			});
		} catch (error) {
			if (!this.#disposed && request === this.#fileRequest) this.#set({ error: String(error) });
		} finally { if (request === this.#fileRequest) this.#looking = false; }
	}
	#drain(): void {
		const first = this.#snapshot.queue[0];
		if (this.#disposed || this.#sending || first?.state !== "queued" || !this.#idle()) return;
		const client = this.session.guestClient();
		if (!client) return;
		const sending = {
			id: first.id, phase: "preparing" as "preparing" | "dispatched",
			lifecycle: undefined as SubagentLifecyclePayload | undefined, started: false, timer: undefined as number | undefined,
		};
		this.#sending = sending;
		this.#set({ queue: this.#snapshot.queue.map(item => item.id === first.id ? { ...item, state: "preparing" } : item) });
		void (async () => {
			let busy = false;
			try {
				await client.sendHelperPrompt(this.#snapshot.helper.id, first.text, () => {
					if (this.#disposed || this.#sending !== sending) throw new Error(i18n.t("panes:tasks.focus.errors.cancelled"));
					const current = this.session.getSnapshot();
					const aborted = current.guest?.agents.find(agent => agent.id === this.#snapshot.helper.id)?.status === "aborted" || current.guest?.lifecycle.get(this.#snapshot.helper.id)?.status === "aborted";
					if (aborted || current.mode === "exited" || current.guest?.phase === "ended") throw new Error(i18n.t("panes:tasks.focus.errors.unavailable"));
					if (!this.#idle()) { busy = true; throw new Error("The helper started working before delivery."); }
					if (this.session.guestClient() !== client) throw new Error(i18n.t("panes:tasks.focus.errors.disconnected"));
					sending.lifecycle = current.guest?.lifecycle.get(this.#snapshot.helper.id);
				}, () => {
					if (this.#disposed || this.#sending !== sending) return;
					sending.phase = "dispatched";
					this.#set({ queue: this.#snapshot.queue.map(item => item.id === first.id ? { ...item, state: "sending" } : item) });
				});
				if (this.#sending !== sending) return;
				sending.timer = window.setTimeout(() => {
					if (this.#sending !== sending) return;
					if (sending.started) return;
					this.#fail(first.id, i18n.t("panes:tasks.focus.errors.unconfirmed"));
				}, 10_000);
			} catch (error) {
				if (this.#sending !== sending) return;
				if (busy) {
					this.#sending = null;
					this.#set({ queue: this.#snapshot.queue.map(item => item.id === first.id ? { ...item, state: "queued" } : item) });
				} else this.#fail(first.id, error instanceof Error ? error.message : String(error));
			}
		})();
	}
	#finish(id: number): void {
		clearTimeout(this.#sending?.timer); this.#sending = null;
		this.#set({ queue: this.#snapshot.queue.filter(item => item.id !== id) });
		this.#releaseFile();
	}
	#fail(id: number, error: string): void {
		clearTimeout(this.#sending?.timer); this.#sending = null;
		this.#set({ queue: this.#snapshot.queue.map(item => item.id === id ? { ...item, state: "error", error } : item) });
		this.#releaseFile();
	}
	#releaseFile(): void {
		if (this.#listeners.size > 0) return;
		this.#fileRequest++; this.#looking = false;
		this.#offFile?.(); this.#offFile = null;
		this.#snapshot = { ...this.#snapshot, file: null, history: null };
	}
	#set(patch: Partial<HelperConversationSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (const listener of this.#listeners) listener();
	}
}

export function helperConversation(session: SessionController, helper: Helper): HelperConversation {
	let map = conversations.get(session);
	if (!map) { map = new Map(); conversations.set(session, map); }
	const key = `${session.sessionFile}:${session.getSnapshot().host?.generation}:${helper.id}`;
	let conversation = map.get(key);
	if (!conversation) { conversation = new HelperConversation(session, helper); map.set(key, conversation); }
	return conversation;
}
