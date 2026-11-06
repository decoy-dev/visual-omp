/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * publish, so React change detection is reference equality all the way.
 *
 * Frames that only bring newer visual state (helper progress, streamed text,
 * partial tool output, session state, helper activity) publish together: once
 * per display frame while the chat is on screen, about once a second
 * otherwise. A later frame of the same kind supersedes them, so nothing is
 * lost. Every other frame, and any frame that changes a turn, a question, a
 * helper's status, the thinking level or the connection, publishes as it is
 * applied.
 */

import type {
	AgentEvent,
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	GuestFrame,
	HostFrame,
	ImageContent,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-wire";
import { importRoomKey } from "./codec";
import { COLLAB_PROTO, encodeBase64Url, parseCollabLink } from "./link";
import { CollabSocket } from "./socket";

type Timer = ReturnType<typeof setTimeout>;

export type ConnectionPhase = "connecting" | "waiting" | "live" | "reconnecting" | "ended";

/** Packed origin: low three bits are the cause; following bit pairs are nullable wire flags. */
export type CompletionEvidence = readonly [revision: number, origin: number, suppression: number];

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

/**
 * A helper's progress report as it arrived. omp computes `progress.durationMs` only when it sends a report, and a
 * helper waiting on a long model reply sends none, so the run time since then is measured from `receivedAt`.
 */
export interface GuestProgress extends SubagentProgressPayload {
	/** `Date.now()` when this guest received the report. */
	receivedAt: number;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, GuestProgress>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** Updates from calls that already ended, keyed by call id. These never imply foreground activity. */
	backgroundTools: ReadonlyMap<string, ActiveTool>;
	/** Foreground run, including continuations and the idle-confirmation interval. */
	working: boolean;
	/** A non-terminal settle whose next turn depends on background jobs. */
	awaitingAsyncWork?: boolean;
	/** Distinguishes waits when a native SDK check completes after a continuation. */
	asyncWaitRevision?: number;
	/** State-only idle awaiting a fresh owner-scoped SDK observation. */
	idleCheckRevision?: number;
	/** Privacy-safe provenance for the latest completion or suppressed completion candidate. */
	completion?: CompletionEvidence | null;
	lastStreamingAt?: number | null;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** Includes locally submitted answers until omp sends ui-request-end. */
	pendingUiRequests?: readonly CollabUiRequest[];
	uiConnection?: number;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
	/** Configured selector from omp's latest thinking event; null before any or after a reconnect. */
	thinkingSelector: string | null;
	/** Complete latest thinking event, including omp's explicit Auto classifier result. */
	thinkingEvent?: Extract<AgentEvent, { type: "thinking_level_changed" }> | null;
	/** Snapshot download progress between `welcome` and its final chunk, else null. */
	loading: { received: number; total: number } | null;
}

const MAX_NOTICES = 50;
const IDLE_CONFIRMATION_MS = 1_500;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;
/** Off screen, frames that only refresh what the chat shows publish together about this often. */
const BACKGROUND_PUBLISH_MS = 1_000;
/** On screen, a display frame publishes them; this bounds the wait where no frame is drawn. */
const FOREGROUND_PUBLISH_MS = 250;

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

/** The name this app joins omp's collab session with; omp announces it in join and leave notices. */
export const APP_GUEST_NAME = "visual-omp";

export class GuestClient {
	readonly #socket: CollabSocket;
	readonly #name: string;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	#reqSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	/**
	 * Snapshot in flight since `welcome`: chunk entries, plus live `entry`
	 * frames that arrived meanwhile (published after the snapshot, at the tail).
	 */
	#pendingSnapshot: { entries: SessionEntry[]; live: SessionEntry[]; total: number } | null = null;
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, GuestProgress> = new Map();
	/** Helper progress received since the last publish; only the newest report per helper is kept. */
	#progressDraft: Map<string, GuestProgress> | null = null;
	/** `id:status` of every helper, so a roster change publishes at once while activity updates wait. */
	#agentRoster = "";
	/** Counts progress reports that introduce a helper or change its status; close and quit guards read that status. */
	#progressStatusRevision = 0;
	/** The chat is on screen: superseded visual updates publish once per display frame, not about once a second. */
	#foreground = false;
	#scheduledPublish: { cancel(): void } | null = null;
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#backgroundTools: ReadonlyMap<string, ActiveTool> = new Map();
	/** Retained across idle frames and reconnects: a backgrounded call can keep producing output. */
	readonly #endedTools = new Set<string>();
	readonly #resumedToolCallIds = new Set<string>();
	#working = false;
	#idleTimer: Timer | null = null;
	#idleCandidate: { revision: number; terminal: boolean; confirmed: boolean; ready: boolean; origin: number } | null = null;
	#idleRevision = 0;
	#continuing = false;
	#awaitingAsyncWork = false;
	#asyncWaitRevision = 0;
	#completion: CompletionEvidence | null = null;
	#completionRevision = 0;
	#lastStreamingAt: number | null = null;
	#readOnly = false;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestQueue: CollabUiRequest[] = [];
	#pendingUiRequests = new Map<number, CollabUiRequest>();
	#uiConnection = 0;
	#notices: readonly Notice[] = [];
	#thinkingSelector: string | null = null;
	#thinkingEvent: Extract<AgentEvent, { type: "thinking_level_changed" }> | null = null;
	#snapshot: GuestSnapshot;
	/**
	 * Published entries array, cached across commits: rebuilt only when
	 * `#entries` is mutated (welcome/snapshot-chunk/entry frames). Every
	 * other frame (streaming message_update, state, bus, agents) reuses the
	 * same reference, so entry-identity consumers (Transcript memo,
	 * useSyncExternalStore) skip their O(n) scans per token.
	 */
	#publishedEntries: readonly SessionEntry[] = [];

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key: importRoomKey(parsed.key) });
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end("timed out waiting for the host's welcome");
			}, WELCOME_TIMEOUT_MS);
		}
	}

	close(): void {
		this.#clearIdle();
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#cancelScheduledPublish();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per publish. */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/** Whether the chat is on screen, which sets how often superseded visual updates publish. */
	setForeground(foreground: boolean): void {
		if (foreground === this.#foreground) return;
		this.#foreground = foreground;
		if (!this.#scheduledPublish) return;
		if (foreground) this.#commit();
		else {
			this.#cancelScheduledPublish();
			this.#schedulePublish();
		}
	}

	sendPrompt(text: string, images: ImageContent[] = [], beforeSend?: () => void): Promise<void> {
		return this.#sendWritable({ t: "prompt", text, ...(images.length ? { images } : {}) }, beforeSend);
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		this.#socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			this.#showNextUiRequest();
			this.#commit();
		}
	}

	sendAbort(): void {
		this.#socket.send({ t: "abort" });
		this.#continuing = false;
		this.#scheduleIdle();
		if (this.#awaitingAsyncWork) {
			this.#awaitingAsyncWork = false;
			this.#recordCompletion(3, 0);
			this.#commit();
		}
	}

	/** A fresh, owner-scoped SDK sample found neither jobs nor pending deliveries. */
	settleAsyncWait(revision: number): void {
		if (!this.#awaitingAsyncWork || revision !== this.#asyncWaitRevision) return;
		this.#awaitingAsyncWork = false;
		this.#recordCompletion(3, 0);
		this.#commit();
	}

	/** Confirm only the state-only idle interval for which this fresh SDK sample was requested. */
	settleIdle(revision: number): void {
		const candidate = this.#idleCandidate;
		if (!candidate?.ready || candidate.revision !== revision || this.#continuing) return;
		candidate.confirmed = true;
		this.#scheduleIdle();
		this.#commit();
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/** Helper messages are held by the app until idle and never buffered across a collab reconnect. */
	sendHelperPrompt(agentId: string, text: string, beforeSend: () => void, dispatched?: () => void): Promise<void> {
		return this.#sendWritable({ t: "agent-cmd", cmd: "chat", agentId, text }, beforeSend, dispatched);
	}

	/** Connection authority is shared by main-chat prompts and queued helper messages. */
	#sendWritable(frame: GuestFrame, beforeSend?: () => void, dispatched?: () => void): Promise<void> {
		if (this.#phase !== "live" || this.#readOnly) throw new Error("The chat is not ready to receive a message.");
		const connection = this.#uiConnection;
		return this.#socket.sendConnected(frame, () => {
			if (this.#phase !== "live" || this.#readOnly || this.#uiConnection !== connection) throw new Error("The chat changed before the message was sent. Send it again.");
			beforeSend?.();
		}, dispatched);
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: HostFrame): void {
		this.#applyFrameSafe(frame);
	}

	#handleOpen(): void {
		this.#socket.send({ t: "hello", proto: COLLAB_PROTO, name: this.#name, writeToken: this.#writeToken });
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		if (this.#idleCandidate) this.#recordCompletion(this.#idleCandidate.origin, 2);
		this.#clearIdle();
		this.#clearSnapshotProgressTimer();
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			this.#invalidateQuestionAuthority();
			// The next welcome restarts the snapshot; drop the partial one.
			this.#pendingSnapshot = null;
			this.#commit();
			return;
		}
		this.#end(reason);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#clearIdle();
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#pendingSnapshot = null;
		this.#awaitingAsyncWork = false;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end("timed out waiting for the host's session snapshot");
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(`failed to apply session snapshot: ${err instanceof Error ? err.message : String(err)}`);
				return;
			}
			this.#pushNotice("error", `failed to apply ${frame.t} frame`);
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		const before = deferrable(frame) ? this.#semanticMark() : null;
		switch (frame.t) {
			case "welcome":
				// A fresh welcome (first join or reconnect) restarts the snapshot.
				// Entries already on screen stay until the new snapshot replaces
				// them once complete, so a resync never blanks the transcript.
				this.#header = frame.header;
				if (frame.entryCount === 0) {
					this.#entries = [];
					this.#publishedEntries = [];
					this.#pendingSnapshot = null;
				} else {
					this.#pendingSnapshot = { entries: [], live: [], total: frame.entryCount };
				}
				this.#state = frame.state;
				this.#setAgents(frame.agents);
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#resumedToolCallIds.clear();
				this.#progress = new Map();
				this.#progressDraft = null;
				this.#lifecycle = new Map();
				this.#clearIdle();
				this.#continuing = false;
				this.#working ||= this.#awaitingAsyncWork;
				this.#awaitingAsyncWork = false;
				if (frame.state.isStreaming) {
					this.#lastStreamingAt = Date.now();
					this.#markWorking();
				} else this.#observeIdle(514);
				this.#readOnly = frame.readOnly === true;
				// The welcome's snapshot is authoritative again; later events set the selector anew.
				this.#thinkingSelector = null;
				this.#thinkingEvent = null;
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				this.#scheduleIdle();
				break;
			case "snapshot-chunk": {
				// Buffer fragments and publish the transcript once, when the
				// snapshot completes (as the TUI guest does). Intermediate chunks
				// only advance `loading`: publishing entries per chunk re-renders
				// the transcript per chunk, and a 50 MB session is ~100 chunks.
				const pending = this.#pendingSnapshot;
				if (pending === null) return;
				pending.entries.push(...frame.entries);
				for (const entry of frame.entries) {
					if (entry.type === "message" && entry.message.role === "toolResult") this.#finishTool(entry.message.toolCallId);
				}
				// Complete on `final` or once every promised entry arrived, so a
				// lost final chunk doesn't strand a fully received transcript.
				if (!frame.final && pending.entries.length < pending.total) {
					this.#armSnapshotProgressTimer();
					break;
				}
				this.#entries = pending.entries;
				this.#entries.push(...pending.live);
				this.#publishedEntries = [...this.#entries];
				this.#pendingSnapshot = null;
				this.#clearSnapshotProgressTimer();
				this.#phase = "live";
				this.#seedResumedTools();
				this.#scheduleIdle();
				break;
			}
			case "entry":
				if (frame.entry.type === "message" && frame.entry.message.role === "toolResult") this.#finishTool(frame.entry.message.toolCallId);
				// The committed row supersedes the finished stream ghost, even when
				// the row is buffered behind an in-flight snapshot.
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				if (this.#pendingSnapshot !== null) {
					this.#pendingSnapshot.live.push(frame.entry);
					break;
				}
				this.#entries.push(frame.entry);
				this.#publishedEntries = [...this.#entries];
				this.#seedResumedTools();
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				// omp reapplies Auto on a model change and can clear its resolved effort
				// without another thinking event when the provisional level stays the same.
				if (this.#thinkingSelector === "auto" && (
					this.#state?.model?.provider !== frame.state.model?.provider
					|| this.#state?.model?.id !== frame.state.model?.id
				)) this.#thinkingEvent = null;
				this.#state = frame.state;
				// Streaming recovers a missed agent_start. An idle sample alone
				// remains a candidate until a fresh host observation confirms it.
				if (frame.state.isStreaming) {
					this.#lastStreamingAt = Date.now();
					this.#markWorking();
				} else this.#observeIdle(513);
				break;
			case "agents":
				this.#setAgents(frame.agents);
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					const previous = (this.#progressDraft ?? this.#progress).get(payload.progress.id);
					if (!previous || previous.progress.status !== payload.progress.status) this.#progressStatusRevision++;
					// A helper reports up to 20 times a second; publish only the newest report per helper.
					this.#progressDraft ??= new Map(this.#progress);
					this.#progressDraft.set(payload.progress.id, { ...payload, receivedAt: Date.now() });
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				this.#pendingUiRequests.set(frame.request.reqId, frame.request);
				if (this.#uiRequest) this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				else this.#uiRequest = frame.request;
				break;
			case "ui-request-end":
				this.#pendingUiRequests.delete(frame.reqId);
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout.
					this.#end(frame.message);
					return; // #end already committed
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		const after = before && this.#semanticMark();
		if (before && after && before.every((value, index) => Object.is(value, after[index]))) this.#schedulePublish();
		else this.#commit();
	}

	#setAgents(agents: readonly AgentSnapshot[]): void {
		this.#agents = [...agents];
		this.#agentRoster = agents.map(agent => `${agent.id}:${agent.status}`).join("\n");
	}

	/** What turn ends, questions, the connection, helper status and the thinking menu depend on. A change here publishes at once. */
	#semanticMark(): readonly unknown[] {
		const idle = this.#idleCandidate;
		return [
			this.#phase, this.#working, this.#awaitingAsyncWork, this.#continuing, this.#completion, this.#activeTools.size,
			this.#backgroundTools.size, idle?.revision, idle?.ready, idle?.confirmed, this.#agentRoster, this.#progressStatusRevision,
			this.#thinkingEvent,
		];
	}

	#schedulePublish(): void {
		if (this.#scheduledPublish) return;
		// Whichever of the display frame and the fallback timer fires first publishes; the commit cancels the other.
		const publish = (): void => this.#commit();
		const timer = setTimeout(publish, this.#foreground ? FOREGROUND_PUBLISH_MS : BACKGROUND_PUBLISH_MS);
		if (this.#foreground && typeof requestAnimationFrame === "function") {
			const frame = requestAnimationFrame(publish);
			this.#scheduledPublish = {
				cancel: () => {
					cancelAnimationFrame(frame);
					clearTimeout(timer);
				},
			};
		} else this.#scheduledPublish = { cancel: () => clearTimeout(timer) };
	}

	#cancelScheduledPublish(): void {
		this.#scheduledPublish?.cancel();
		this.#scheduledPublish = null;
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#markWorking();
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#markWorking();
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				this.#markWorking();
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const ended = this.#endedTools.has(event.toolCallId);
				const existing = (ended ? this.#backgroundTools : this.#activeTools).get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				if (ended) this.#backgroundTools = new Map(this.#backgroundTools).set(event.toolCallId, tool);
				else {
					this.#markWorking();
					this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				}
				break;
			}
			case "tool_execution_end": {
				this.#finishTool(event.toolCallId);
				break;
			}
			case "agent_start":
				this.#continuing = false;
				this.#markWorking();
				this.#resumedToolCallIds.clear();
				for (const id of event.resumedToolCallIds ?? []) {
					this.#resumedToolCallIds.add(id);
					this.#endedTools.delete(id);
				}
				this.#seedResumedTools();
				break;
			case "agent_end":
				this.#clearIdle();
				this.#working ||= this.#awaitingAsyncWork;
				this.#awaitingAsyncWork = event.awaitingAsyncWork === true;
				this.#continuing = !this.#awaitingAsyncWork && (event.isTerminal === false || event.willContinue === true);
				this.#asyncWaitRevision++;
				const origin = ((event.isTerminal === undefined ? 0 : event.isTerminal ? 2 : 1)
					| (event.willContinue === undefined ? 0 : event.willContinue ? 8 : 4)
					| (event.awaitingAsyncWork === undefined ? 0 : event.awaitingAsyncWork ? 32 : 16)) << 3;
				if (this.#awaitingAsyncWork) {
					this.#working = false;
					this.#recordCompletion(origin, 1);
				} else if (this.#continuing) {
					this.#working = true;
					this.#recordCompletion(origin, 1);
				} else {
					// A terminal end also retires cards whose tool end was missed.
					for (const id of this.#activeTools.keys()) this.#endedTools.add(id);
					this.#activeTools = new Map();
					this.#observeIdle(origin, true);
				}
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice("info", `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? "retry failed");
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", `compacting context (${event.reason})`);
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? "compaction aborted"
							: event.errorMessage
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			case "thinking_level_changed":
				this.#thinkingSelector = event.configured ?? event.thinkingLevel ?? null;
				this.#thinkingEvent = event;
				break;
			default:
				// turn_start/turn_end/unknown — ignore
				break;
		}
	}

	#clearIdleTimer(): void {
		if (this.#idleTimer !== null) {
			clearTimeout(this.#idleTimer);
			this.#idleTimer = null;
		}
	}

	#clearIdle(): void {
		this.#clearIdleTimer();
		this.#idleCandidate = null;
	}

	#markWorking(): void {
		if (this.#idleCandidate) this.#recordCompletion(this.#idleCandidate.origin, 2);
		this.#clearIdle();
		this.#continuing = false;
		this.#working = true;
		this.#awaitingAsyncWork = false;
	}

	/** A second host sample can confirm state-only idle; silence cannot. */
	#observeIdle(origin: number, terminal = false): void {
		if (!this.#working) return;
		if (this.#idleCandidate) {
			if (this.#idleCandidate.ready) this.#idleCandidate.confirmed = true;
		} else this.#idleCandidate = { revision: ++this.#idleRevision, terminal, confirmed: false, ready: false, origin };
		this.#scheduleIdle();
	}

	#scheduleIdle(): void {
		const candidate = this.#idleCandidate;
		if (!candidate || !this.#working || this.#continuing || this.#awaitingAsyncWork || this.#activeTools.size > 0 || this.#phase !== "live" || this.#pendingSnapshot !== null) return;
		if (candidate.ready) {
			if (!candidate.terminal && !candidate.confirmed) return;
			this.#recordCompletion(candidate.origin, 0);
			this.#clearIdle();
			this.#working = false;
			if (this.#streamDone) {
				this.#stream = null;
				this.#streamDone = false;
			}
		} else if (this.#idleTimer === null) {
			this.#idleTimer = setTimeout(() => {
				this.#idleTimer = null;
				candidate.ready = true;
				this.#scheduleIdle();
				this.#commit();
			}, IDLE_CONFIRMATION_MS);
		}
	}

	#recordCompletion(origin: number, suppression: number): void {
		this.#completion = [++this.#completionRevision, origin, suppression];
	}

	/** Restored calls execute without a new assistant message or message_start event. */
	#seedResumedTools(): void {
		if (this.#resumedToolCallIds.size === 0) return;
		const missing = new Set([...this.#resumedToolCallIds].filter(id => !this.#activeTools.has(id)));
		if (missing.size === 0) return;
		const active = new Map(this.#activeTools);
		const read = (message: AssistantMessage): void => {
			for (const block of message.content) {
				if (block.type !== "toolCall" || !missing.delete(block.id)) continue;
				active.set(block.id, { toolCallId: block.id, toolName: block.name, args: block.arguments, intent: block.intent, startedAt: Date.now() });
			}
		};
		if (this.#stream) read(this.#stream);
		for (let index = this.#entries.length - 1; index >= 0 && missing.size > 0; index--) {
			const entry = this.#entries[index]!;
			if (entry.type === "message" && entry.message.role === "assistant") read(entry.message);
		}
		this.#activeTools = active;
	}

	#finishTool(callId: string): void {
		this.#endedTools.add(callId);
		this.#resumedToolCallIds.delete(callId);
		if (!this.#activeTools.has(callId)) return;
		const next = new Map(this.#activeTools);
		next.delete(callId);
		this.#activeTools = next;
		this.#scheduleIdle();
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	/** Socket loss invalidates matching authority without changing the visible question lifecycle. */
	#invalidateQuestionAuthority(): void {
		this.#pendingUiRequests.clear();
		this.#uiConnection++;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestQueue = [];
		this.#invalidateQuestionAuthority();
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			// Publish the cached array: identical reference until an
			// entry-mutating frame replaces it, so non-entry frames
			// (streaming updates, state, bus) don't invalidate entry-identity
			// consumers per token.
			entries: this.#publishedEntries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			backgroundTools: this.#backgroundTools,
			working: this.#working,
			awaitingAsyncWork: this.#awaitingAsyncWork,
			asyncWaitRevision: this.#asyncWaitRevision,
			idleCheckRevision: this.#idleCandidate?.ready && !this.#idleCandidate.terminal && !this.#idleCandidate.confirmed ? this.#idleCandidate.revision : undefined,
			completion: this.#completion,
			lastStreamingAt: this.#lastStreamingAt,
			readOnly: this.#readOnly,
			uiRequest: this.#uiRequest,
			pendingUiRequests: [...this.#pendingUiRequests.values()],
			uiConnection: this.#uiConnection,
			notices: this.#notices,
			thinkingSelector: this.#thinkingSelector,
			thinkingEvent: this.#thinkingEvent,
			loading: this.#pendingSnapshot && {
				received: this.#pendingSnapshot.entries.length,
				total: this.#pendingSnapshot.total,
			},
		};
	}

	#commit(): void {
		this.#cancelScheduledPublish();
		if (this.#progressDraft) {
			this.#progress = this.#progressDraft;
			this.#progressDraft = null;
		}
		this.#snapshot = this.#buildSnapshot();
		for (const listener of this.#listeners) listener();
	}
}

/** Frames a later frame of the same kind supersedes: their only effect can be newer visual state. */
function deferrable(frame: HostFrame): boolean {
	switch (frame.t) {
		case "bus":
			return frame.channel === "task:subagent:progress";
		case "agents":
		case "state":
			return true;
		case "event":
			return frame.event.type === "message_update" || frame.event.type === "tool_execution_update";
		case "snapshot-chunk":
			return !frame.final;
		default:
			return false;
	}
}
