import { randomUUID } from "node:crypto";
import type { ShellFailureReason, ShellFrame, ShellInvalidation, ShellOpenRequest, ShellResult, ShellSnapshotOpenRequest, ShellSnapshotUpdateRequest } from "@shared/shell-visualization";
import { isShellAction, shellProps, type ShellVizLayer, type ShellVizPreferences, type TspShellProps } from "@shared/tsp/shell";
import type { SavedShellTrace } from "./session-tool-output";
import { ShellWorkerFailure, ShellWorkerRefusal, type ShellPresentationWorker, type ShellWorkerRequest } from "./shell-visualization-worker";
import { hasShellTraceElision } from "./shell-visualization-source";

export const SHELL_SERVICE_LIMITS = { handles: 4, traceBytes: 16 * 1024 * 1024, sourceBytes: 32 * 1024 * 1024, history: 20_000, tickMs: 80, idleMs: 5 * 60_000 } as const;
export interface ShellVisualizationServiceOptions {
	loadTrace(file: string, toolCallId: string): Promise<SavedShellTrace>;
	getSetting(key: "display.shellVisualization", cwd: string): Promise<{ key: string; type: string; value: unknown }>;
	createWorker(onLoss: (reason: ShellFailureReason) => void, signal: AbortSignal): Promise<ShellPresentationWorker>;
	onFrame?(frame: ShellFrame): void;
	onInvalidated?(event: ShellInvalidation): void;
	now?: () => number;
}
type ResultWaiter = { resolve(result: ShellResult): void };
type PendingSource = { cancelled: boolean; handle?: string };
type WorkerSlot = { abort: AbortController; promise: Promise<ShellPresentationWorker> };
type Handle = {
	id: string;
	requestId: string;
	sourceId?: string;
	sourceRevision?: number;
	sourceVersion: number;
	toolCallId: string;
	cwd: string;
	executionCwd?: string;
	cdSeparator?: ";";
	json: string;
	bytes: number;
	history: { seq: number; t_ns: number }[];
	trimmed: boolean;
	preferences: ShellVizPreferences;
	props?: TspShellProps;
	revision: number;
	epoch: number;
	nativeVersion?: number;
	inspector: boolean;
	clockNs: number;
	clockAt: number;
	lastUsed: number;
	waiter?: ResultWaiter;
};
const failure = (reason: ShellFailureReason): ShellResult => ({ status: "unavailable", reason });
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const unsigned = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");

/** Validate the raw v1 envelope and clock only. Native compiled units and syntax archives stay opaque. */
export function shellTraceClock(json: string): { history: { seq: number; t_ns: number }[]; trimmed: boolean } | null {
	if (typeof json !== "string" || Buffer.byteLength(json) > SHELL_SERVICE_LIMITS.traceBytes || hasShellTraceElision(json)) return null;
	try {
		const trace: unknown = JSON.parse(json);
		if (!record(trace) || trace.v !== 1 || !unsigned(trace.seq) || !finite(trace.t_ns) || typeof trace.script !== "string" || !Array.isArray(trace.units)
			|| !trace.units.every(record) || (trace.historyTruncated !== undefined && typeof trace.historyTruncated !== "boolean")
			|| (trace.history !== undefined && !Array.isArray(trace.history))) return null;
		const events = (trace.history ?? []) as unknown[];
		if (events.length > SHELL_SERVICE_LIMITS.history) return null;
		const history: { seq: number; t_ns: number }[] = [];
		let seq = -1;
		let at = 0;
		for (const event of events) {
			if (!record(event) || !unsigned(event.seq) || !finite(event.t_ns) || event.seq <= seq || event.seq > trace.seq || event.t_ns > trace.t_ns) return null;
			seq = event.seq;
			// Native journals are sequence-ordered, but concurrent event timestamps can regress.
			// Keep that order and use a monotonic envelope only for the local playback clock.
			at = Math.max(at, event.t_ns);
			history.push({ seq, t_ns: at });
		}
		return { history, trimmed: trace.historyTruncated === true };
	} catch { return null; }
}

/** Per-window, Node-only controller. It has no session-host, Electron or owner-profile dependency. */
export class ShellVisualizationService {
	readonly #options: ShellVisualizationServiceOptions;
	readonly #handles = new Map<string, Handle>();
	readonly #requests = new Map<string, PendingSource>();
	readonly #queued = new Set<string>();
	readonly #releases = new Set<string>();
	#worker?: WorkerSlot;
	#workerBarrier: Promise<void> = Promise.resolve();
	#closePromise?: Promise<void>;
	#active?: string;
	#draining = false;
	#closed = false;
	#timer?: NodeJS.Timeout;
	#idleTimer?: NodeJS.Timeout;
	#sourceBytes = 0;

	constructor(options: ShellVisualizationServiceOptions) { this.#options = options; }

	async open(request: ShellOpenRequest): Promise<ShellResult> {
		if (!record(request) || !identity(request.requestId) || !identity(request.file) || !identity(request.toolCallId)) return failure("unavailable");
		const pending = this.#reserve(request.requestId);
		if (typeof pending === "string") return failure(pending);
		try {
			const source = await this.#options.loadTrace(request.file, request.toolCallId);
			if (pending.cancelled || this.#closed) return failure("cancelled");
			if (source.status !== "ready") return failure(source.status === "too-large" ? "too-large" : "unavailable");
			if (!source.identity || !source.sessionId) return failure("unavailable");
			return await this.#openSource(request.requestId, request.toolCallId, source, pending);
		} catch { return failure("unavailable"); }
		finally { if (!pending.handle) this.#requests.delete(request.requestId); }
	}

	async openSnapshot(request: ShellSnapshotOpenRequest): Promise<ShellResult> {
		if (!record(request) || !identity(request.requestId) || !identity(request.toolCallId) || !identity(request.sourceId)
			|| !identity(request.cwd) || request.executionCwd !== undefined && !identity(request.executionCwd) || request.cdSeparator !== undefined && request.cdSeparator !== ";"
			|| !unsigned(request.sourceRevision) || typeof request.json !== "string") return failure("unavailable");
		if (Buffer.byteLength(request.json) > SHELL_SERVICE_LIMITS.traceBytes) return failure("too-large");
		const pending = this.#reserve(request.requestId);
		if (typeof pending === "string") return failure(pending);
		try { return await this.#openSource(request.requestId, request.toolCallId, request, pending, request.sourceId, request.sourceRevision); }
		catch { return failure("unavailable"); }
		finally { if (!pending.handle) this.#requests.delete(request.requestId); }
	}

	updateSnapshot(request: ShellSnapshotUpdateRequest): Promise<ShellResult> {
		if (!record(request) || !identity(request.handle) || !identity(request.sourceId) || !unsigned(request.sourceRevision) || typeof request.json !== "string"
			|| request.executionCwd !== undefined && !identity(request.executionCwd) || request.cdSeparator !== undefined && request.cdSeparator !== ";") return Promise.resolve(failure("unavailable"));
		const handle = this.#handles.get(request.handle);
		if (!handle || handle.sourceId !== request.sourceId || handle.sourceRevision === undefined) return Promise.resolve(failure("unavailable"));
		if (request.sourceRevision <= handle.sourceRevision) return Promise.resolve(failure("cancelled"));
		const bytes = Buffer.byteLength(request.json);
		if (bytes > SHELL_SERVICE_LIMITS.traceBytes) return Promise.resolve(failure("too-large"));
		const clock = shellTraceClock(request.json);
		if (!clock) return Promise.resolve(failure("unavailable"));
		if (!this.#makeSourceRoom(bytes - handle.bytes, handle.id)) return Promise.resolve(failure("too-large"));
		const cursor = handle.preferences.cursor;
		const cursorSeq = cursor === undefined ? undefined : handle.history[cursor - 1]?.seq;
		if (cursor !== undefined) {
			let remapped = 0;
			if (cursorSeq !== undefined) while (remapped < clock.history.length && clock.history[remapped]!.seq <= cursorSeq) remapped++;
			handle.preferences = { ...handle.preferences, cursor: remapped };
		}
		this.#sourceBytes += bytes - handle.bytes;
		handle.json = request.json;
		handle.bytes = bytes;
		handle.executionCwd = request.executionCwd;
		handle.cdSeparator = request.cdSeparator;
		handle.history = clock.history;
		handle.trimmed = clock.trimmed;
		handle.sourceRevision = request.sourceRevision;
		handle.sourceVersion++;
		handle.epoch++;
		handle.clockNs = handle.history[(handle.preferences.cursor ?? 0) - 1]?.t_ns ?? (handle.trimmed ? handle.history[0]?.t_ns ?? 0 : 0);
		handle.clockAt = handle.lastUsed = this.#now();
		this.#updateIdleTimer();
		return this.#enqueue(handle);
	}

	#reserve(requestId: string): PendingSource | ShellFailureReason {
		if (this.#closed || this.#requests.has(requestId)) return "unavailable";
		this.#expireIdle();
		while (this.#requests.size >= SHELL_SERVICE_LIMITS.handles) {
			const idle = this.#idleHandles()[0];
			if (!idle) return "too-large";
			this.#drop(idle, "cancelled");
		}
		const pending: PendingSource = { cancelled: false };
		this.#requests.set(requestId, pending);
		return pending;
	}

	async #openSource(requestId: string, toolCallId: string, source: { json: string; cwd: string; executionCwd?: string; cdSeparator?: ";" }, pending: PendingSource, sourceId?: string, sourceRevision?: number): Promise<ShellResult> {
		const enabled = await this.#setting(source.cwd);
		if (pending.cancelled || this.#closed) return failure("cancelled");
		if (enabled !== true) return failure(enabled === false ? "disabled" : "unavailable");
		const bytes = Buffer.byteLength(source.json);
		if (bytes > SHELL_SERVICE_LIMITS.traceBytes) return failure("too-large");
		const clock = shellTraceClock(source.json);
		if (!clock) return failure("unavailable");
		if (!this.#makeSourceRoom(bytes)) return failure("too-large");
		const id = randomUUID();
		const handle: Handle = { id, requestId, toolCallId, cwd: source.cwd, executionCwd: source.executionCwd, cdSeparator: source.cdSeparator, sourceId, sourceRevision, sourceVersion: 0,
			json: source.json, bytes, ...clock, preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
			revision: 0, epoch: 0, inspector: false, clockNs: 0, clockAt: this.#now(), lastUsed: this.#now() };
		pending.handle = id;
		this.#handles.set(id, handle);
		this.#sourceBytes += bytes;
		this.#updateIdleTimer();
		return this.#enqueue(handle);
	}

	#makeSourceRoom(bytes: number, except?: string): boolean {
		for (const idle of this.#idleHandles()) {
			if (this.#sourceBytes + bytes <= SHELL_SERVICE_LIMITS.sourceBytes) break;
			if (idle.id !== except) this.#drop(idle, "cancelled");
		}
		return this.#sourceBytes + bytes <= SHELL_SERVICE_LIMITS.sourceBytes;
	}

	async action(id: string, value: string): Promise<ShellResult> {
		const handle = this.#handles.get(id);
		if (!handle?.props || !isShellAction(handle.props.presentation, value) || (value.startsWith("seek:") && Number(value.slice(5)) > handle.history.length)) return failure("unavailable");
		const before = handle.preferences;
		const next = { ...before, layers: { ...before.layers }, expandedNodes: [...before.expandedNodes] };
		const length = handle.history.length;
		const now = this.#now();
		handle.lastUsed = now;
		if (before.playing) handle.clockNs += (now - handle.clockAt) * 1_000_000 * before.speed;
		handle.clockAt = now;
		if (value.startsWith("view:")) next.view = value === "view:raw" ? "raw" : "pseudo";
		else if (value.startsWith("layer:")) { const layer = value.slice(6) as ShellVizLayer; next.layers[layer] = !next.layers[layer]; }
		else if (value === "split") next.split = !next.split;
		else if (value === "inspect") handle.inspector = !handle.inspector;
		else if (value === "play") { next.playing = length > 0; if (next.cursor === undefined || next.cursor >= length) next.cursor = 0; }
		else if (value === "pause") next.playing = false;
		else if (value === "step") { next.playing = false; next.cursor = Math.min(length, (next.cursor ?? length) + 1); }
		else if (value === "reset") { next.playing = false; next.cursor = 0; }
		else if (value === "live") { next.playing = false; delete next.cursor; }
		else if (value.startsWith("seek:")) { next.playing = false; next.cursor = Number(value.slice(5)); }
		else if (value.startsWith("speed:")) next.speed = Number(value.slice(6));
		else if (value.startsWith("select:")) next.selectedNode = value.slice(7);
		else if (value.startsWith("expand:")) { const key = value.slice(7); next.expandedNodes = next.expandedNodes.includes(key) ? next.expandedNodes.filter(node => node !== key) : [...next.expandedNodes, key]; }
		const restarting = value === "play" && (before.cursor === undefined || before.cursor >= length);
		if (value === "reset" || value === "live" || value.startsWith("seek:") || restarting) handle.epoch++;
		if (value === "reset" || value === "step" || value.startsWith("seek:") || restarting) {
			handle.clockNs = handle.history[(next.cursor ?? 0) - 1]?.t_ns ?? (handle.trimmed ? handle.history[0]?.t_ns ?? 0 : 0);
		}
		handle.preferences = next;
		this.#updateTimer();
		this.#updateIdleTimer();
		return this.#enqueue(handle);
	}

	release(id: string): void {
		const handle = this.#handles.get(id);
		if (!handle) return;
		this.#handles.delete(id);
		this.#requests.delete(handle.requestId);
		this.#sourceBytes -= handle.bytes;
		this.#queued.delete(id);
		handle.waiter?.resolve(failure("cancelled"));
		handle.waiter = undefined;
		if (this.#active === id) this.#restartWorker();
		else if (this.#handles.size === 0) this.#stopWorker();
		else if (handle.nativeVersion !== undefined) { this.#releases.add(id); void this.#drain(); }
		this.#updateTimer();
		this.#updateIdleTimer();
	}

	cancel(requestId: string): void {
		const request = this.#requests.get(requestId);
		if (!request) return;
		request.cancelled = true;
		if (request.handle) this.release(request.handle);
		// Keep an in-progress read reserved until it settles, preventing an unbounded read/cancel queue.
	}

	/** Called by config invalidation; local settings never grant live host authority. */
	async settingsChanged(cwd?: string | null): Promise<void> {
		await Promise.all([...this.#handles.values()].filter(handle => !cwd || handle.cwd === cwd).map(async handle => {
			const enabled = await this.#setting(handle.cwd);
			if (this.#handles.get(handle.id) === handle && enabled !== true) this.#drop(handle, enabled === false ? "disabled" : "unavailable");
		}));
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#lost("cancelled");
		return this.#closePromise = this.#workerBarrier;
	}

	#now(): number { return this.#options.now?.() ?? performance.now(); }
	async #setting(cwd: string): Promise<boolean | undefined> {
		try {
			const setting = await this.#options.getSetting("display.shellVisualization", cwd);
			return setting.key === "display.shellVisualization" && setting.type === "boolean" && typeof setting.value === "boolean" ? setting.value : undefined;
		} catch { return undefined; }
	}
	#drop(handle: Handle, reason: ShellFailureReason): void {
		handle.waiter?.resolve(failure(reason));
		handle.waiter = undefined;
		this.release(handle.id);
		this.#options.onInvalidated?.({ handles: [handle.id], reason });
	}
	#stopWorker(): void {
		const slot = this.#worker;
		this.#worker = undefined;
		this.#releases.clear();
		for (const handle of this.#handles.values()) handle.nativeVersion = undefined;
		if (slot) {
			slot.abort.abort();
			const previous = this.#workerBarrier;
			const cleanup = slot.promise.then(worker => worker.close(), error => {
				// Bootstrap reports an ordinary worker failure only after confirming its own cleanup.
				// A cleanup error must retain ownership, including if startup never returned a worker.
				if (!(error instanceof ShellWorkerFailure)) throw error;
			});
			this.#workerBarrier = Promise.allSettled([previous, cleanup]).then(results => {
				for (const result of results) if (result.status === "rejected") throw result.reason;
			});
			// Observe fire-and-forget disposal without converting a failed close into permission to restart.
			void this.#workerBarrier.catch(() => {});
		}
	}
	#restartWorker(): void {
		this.#stopWorker();
		for (const handle of this.#handles.values()) if (handle.waiter) this.#queued.add(handle.id);
		void this.#drain();
	}
	#lost(reason: ShellFailureReason): void {
		const ids = [...this.#handles.keys()];
		// Reads already admitted in this worker generation must not restart it after a loss.
		for (const request of this.#requests.values()) request.cancelled = true;
		for (const handle of this.#handles.values()) handle.waiter?.resolve(failure(reason));
		for (const handle of this.#handles.values()) this.#requests.delete(handle.requestId);
		this.#handles.clear();
		this.#sourceBytes = 0;
		this.#queued.clear();
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		this.#stopWorker();
		this.#updateTimer();
		if (ids.length) this.#options.onInvalidated?.({ handles: ids, reason });
	}
	#enqueue(handle: Handle): Promise<ShellResult> {
		handle.waiter?.resolve(failure("cancelled"));
		const waiter = Promise.withResolvers<ShellResult>();
		handle.waiter = waiter;
		handle.revision++;
		this.#queued.add(handle.id);
		void this.#drain();
		return waiter.promise;
	}
	/** Abort releases the scheduler even while an isolated synchronous native call cannot respond. */
	async #request(slot: WorkerSlot, worker: ShellPresentationWorker, request: ShellWorkerRequest): Promise<unknown> {
		if (slot.abort.signal.aborted) throw new ShellWorkerFailure("cancelled");
		const cancelled = Promise.withResolvers<never>();
		const abort = () => cancelled.reject(new ShellWorkerFailure("cancelled"));
		slot.abort.signal.addEventListener("abort", abort, { once: true });
		try { return await Promise.race([worker.request(request), cancelled.promise]); }
		finally { slot.abort.signal.removeEventListener("abort", abort); }
	}
	async #drain(): Promise<void> {
		if (this.#draining || this.#closed) return;
		this.#draining = true;
		let dispatched: WorkerSlot | undefined;
		try {
			while (this.#handles.size && (this.#queued.size || this.#releases.size)) {
				if (!this.#worker) {
					const abort = new AbortController();
					const barrier = this.#workerBarrier;
					const slot: WorkerSlot = { abort, promise: barrier.then(() => {
						if (abort.signal.aborted) throw new ShellWorkerFailure("cancelled");
						return this.#options.createWorker(reason => { if (this.#worker === slot) this.#lost(reason); }, abort.signal);
					}) };
					this.#worker = slot;
				}
				const slot = this.#worker;
				dispatched = slot;
				const worker = await slot.promise;
				if (this.#worker !== slot) continue;
				const released = this.#releases.values().next().value as string | undefined;
				if (released) {
					this.#releases.delete(released);
					try { await this.#request(slot, worker, { op: "release", handle: released }); }
					catch (error) { if (!(error instanceof ShellWorkerRefusal)) throw error; }
					continue;
				}
				const id = this.#queued.values().next().value as string;
				this.#queued.delete(id);
				const handle = this.#handles.get(id);
				if (!handle) continue;
				this.#active = id;
				const revision = handle.revision;
				const sourceVersion = handle.sourceVersion;
				try {
					if (handle.nativeVersion !== undefined && handle.nativeVersion !== sourceVersion) {
						await this.#request(slot, worker, { op: "release", handle: id });
						if (this.#worker !== slot || this.#handles.get(id) !== handle) continue;
						handle.nativeVersion = undefined;
						if (handle.sourceVersion !== sourceVersion || handle.revision !== revision) continue;
					}
					if (handle.nativeVersion === undefined) {
						await this.#request(slot, worker, { op: "restore", handle: id, json: handle.json });
						if (this.#worker !== slot || this.#handles.get(id) !== handle) continue;
						handle.nativeVersion = sourceVersion;
						if (handle.sourceVersion !== sourceVersion || handle.revision !== revision) continue;
					}
					const preferences = handle.preferences;
					const presentation = await this.#request(slot, worker, { op: "present", handle: id, options: { ...preferences,
						cursorSeq: preferences.cursor === undefined ? undefined : handle.history[preferences.cursor - 1]?.seq } });
					if (this.#worker !== slot || this.#handles.get(id) !== handle || handle.revision !== revision || handle.sourceVersion !== sourceVersion) continue;
					const props = shellProps({ presentation, inspector: handle.inspector, replayEpoch: handle.epoch, liveOrigin: false, ...(handle.executionCwd ? { cwd: handle.executionCwd } : {}), lang: "bash", preview: { lines: 12 } });
					if (!props || props.presentation.timeline.length !== handle.history.length) throw new ShellWorkerRefusal("unavailable");
					handle.props = props;
					// Native owns any canonical preference normalization and all execution reduction.
					handle.preferences = { ...props.presentation.preferences, layers: { ...props.presentation.preferences.layers }, expandedNodes: [...props.presentation.preferences.expandedNodes] };
					const frame: ShellFrame = { handle: id, revision, props, ...(handle.cdSeparator ? { cdSeparator: handle.cdSeparator } : {}), ...(handle.sourceRevision === undefined ? {} : { sourceRevision: handle.sourceRevision }) };
					handle.waiter?.resolve({ status: "ready", ...frame });
					handle.waiter = undefined;
					this.#active = undefined;
					this.#options.onFrame?.(frame);
				} catch (error) {
					if (!(error instanceof ShellWorkerRefusal)) throw error;
					if (this.#worker === slot && this.#handles.get(id) === handle && handle.sourceVersion === sourceVersion && handle.revision === revision) {
						this.#active = undefined;
						this.#drop(handle, error.reason);
					}
				} finally { this.#active = undefined; }
			}
		} catch (error) { if (this.#worker === dispatched) this.#lost(error instanceof ShellWorkerFailure ? error.reason : "unavailable"); }
		finally {
			this.#active = undefined;
			this.#draining = false;
			this.#updateIdleTimer();
			if (!this.#closed && this.#handles.size && (this.#queued.size || this.#releases.size)) void this.#drain();
			else this.#stopUnusedWorker();
		}
	}
	#idleHandles(): Handle[] {
		const now = this.#now();
		return [...this.#handles.values()].filter(handle => !handle.preferences.playing && !handle.waiter && this.#active !== handle.id
			&& !this.#queued.has(handle.id) && now - handle.lastUsed >= SHELL_SERVICE_LIMITS.idleMs).sort((a, b) => a.lastUsed - b.lastUsed);
	}
	#stopUnusedWorker(): void {
		if (!this.#active && !this.#queued.size && ![...this.#handles.values()].some(handle => handle.nativeVersion !== undefined)) this.#stopWorker();
	}
	#expireIdle(): void {
		for (const handle of this.#idleHandles()) {
			if (handle.nativeVersion === undefined) continue;
			handle.nativeVersion = undefined;
			this.#releases.add(handle.id);
		}
		this.#stopUnusedWorker();
		if (this.#releases.size) void this.#drain();
	}
	#updateIdleTimer(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		if (this.#closed) return;
		let next = Infinity;
		for (const handle of this.#handles.values()) {
			if (!handle.preferences.playing && handle.nativeVersion !== undefined && !handle.waiter && this.#active !== handle.id && !this.#queued.has(handle.id)) next = Math.min(next, handle.lastUsed + SHELL_SERVICE_LIMITS.idleMs);
		}
		if (!Number.isFinite(next)) return;
		this.#idleTimer = setTimeout(() => { this.#expireIdle(); this.#updateIdleTimer(); }, Math.max(1, next - this.#now()));
		this.#idleTimer.unref();
	}
	#updateTimer(): void {
		const playing = [...this.#handles.values()].some(handle => handle.preferences.playing);
		if (!playing) { clearInterval(this.#timer); this.#timer = undefined; return; }
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			const now = this.#now();
			for (const handle of this.#handles.values()) {
				if (!handle.preferences.playing) continue;
				handle.clockNs += (now - handle.clockAt) * 1_000_000 * handle.preferences.speed;
				handle.clockAt = now;
				handle.lastUsed = now;
				if (this.#active === handle.id || this.#queued.has(handle.id)) continue;
				let cursor = handle.preferences.cursor ?? 0;
				while (cursor < handle.history.length && handle.history[cursor]!.t_ns <= handle.clockNs) cursor++;
				const playing = cursor < handle.history.length;
				if (cursor !== handle.preferences.cursor || !playing) {
					handle.preferences = { ...handle.preferences, cursor, playing };
					void this.#enqueue(handle);
				}
			}
			this.#updateTimer();
			this.#updateIdleTimer();
		}, SHELL_SERVICE_LIMITS.tickMs);
		this.#timer.unref();
	}
}
