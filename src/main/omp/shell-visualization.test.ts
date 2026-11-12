import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellFailureReason, ShellFrame, ShellInvalidation, ShellResult } from "@shared/shell-visualization";
import type { ShellVizPreferences, ShellVizPresentation } from "@shared/tsp/shell";
import type { SavedShellTrace } from "./session-tool-output";
import { ShellVisualizationService, SHELL_SERVICE_LIMITS, shellTraceClock, type ShellVisualizationServiceOptions } from "./shell-visualization";
import { ShellWorkerFailure, ShellWorkerRefusal, type ShellPresentationWorker, type ShellWorkerRequest } from "./shell-visualization-worker";
import { hasShellTraceElision } from "./shell-visualization-source";

const trace = (extra = {}) => JSON.stringify({ v: 1, seq: 4, t_ns: 240_000_000, script: 'printf "café"', units: [],
	history: [{ seq: 1, t_ns: 0 }, { seq: 2, t_ns: 80_000_000 }, { seq: 3, t_ns: 160_000_000 }, { seq: 4, t_ns: 240_000_000 }], ...extra });
const envelope = (json = trace()): SavedShellTrace => ({ status: "ready", json, cwd: "/verified/project", sessionId: "saved", identity: "1:2:saved" });
function canonical(options: ShellVizPreferences, length = 4): ShellVizPresentation {
	const cursor = options.cursor ?? length;
	return { preferences: structuredClone(options), rows: [{ id: "row", depth: 0, node: "opaque:node", state: "ok", segments: [{ text: "canonical display" }], effects: [] }],
		original: [], watches: [], output: "canonical replay output", executing: false, timeline: { length, cursor, elapsedNs: cursor * 60_000_000, durationNs: Math.max(length, cursor) * 60_000_000 } };
}
function fixture(overrides: Partial<ShellVisualizationServiceOptions> = {}) {
	const frames: ShellFrame[] = [];
	const invalidated: ShellInvalidation[] = [];
	const requests: ShellWorkerRequest[] = [];
	const workers: ShellPresentationWorker[] = [];
	const losses: ((reason: ShellFailureReason) => void)[] = [];
	const loadTrace = vi.fn(async () => envelope());
	const getSetting = vi.fn(async () => ({ key: "display.shellVisualization", type: "boolean", value: true }));
	let intercept: ((request: ShellWorkerRequest) => Promise<unknown> | undefined) | undefined;
	let concurrency = 0;
	let maximum = 0;
	const createWorker = vi.fn(async (onLoss: (reason: ShellFailureReason) => void, signal: AbortSignal) => {
		losses.push(onLoss);
		const sources = new Map<string, number>();
		const stopped = Promise.withResolvers<never>();
		void stopped.promise.catch(() => {});
		const stop = () => stopped.reject(new ShellWorkerFailure("cancelled"));
		signal.addEventListener("abort", stop, { once: true });
		const worker: ShellPresentationWorker = { close: vi.fn(async () => { stop(); signal.removeEventListener("abort", stop); }), request: vi.fn(async request => {
			requests.push(request);
			concurrency++;
			maximum = Math.max(maximum, concurrency);
			try {
				const custom = intercept?.(request);
				if (custom) return await Promise.race([custom, stopped.promise]);
				if (request.op === "restore") sources.set(request.handle, JSON.parse(request.json).history?.length ?? 0);
				else if (request.op === "release") sources.delete(request.handle);
				return request.op === "present" ? canonical(request.options, sources.get(request.handle)) : null;
			} finally { concurrency--; }
		}) };
		workers.push(worker);
		return worker;
	});
	const service = new ShellVisualizationService({ loadTrace, getSetting, createWorker, onFrame: frame => frames.push(frame), onInvalidated: event => invalidated.push(event), ...overrides });
	const open = (requestId = "request") => service.open({ requestId, file: "/exact/chat.jsonl", toolCallId: "exact-call" });
	const snapshot = (requestId = "snapshot", json = trace(), sourceRevision = 1, sourceId = "host:1:session:call") =>
		service.openSnapshot({ requestId, toolCallId: "exact-call", sourceId, sourceRevision, json, cwd: "/verified/project" });
	return { service, open, snapshot, frames, invalidated, requests, workers, losses, loadTrace, getSetting, createWorker,
		intercept(value: typeof intercept) { intercept = value; }, maximum: () => maximum };
}
function ready(result: ShellResult): Extract<ShellResult, { status: "ready" }> {
	expect(result.status).toBe("ready");
	if (result.status !== "ready") throw new Error("Expected ready shell result");
	return result;
}
afterEach(() => { vi.useRealTimers(); });

describe("saved shell visualization service", () => {
	it("passes only the exact local source into a separate worker and only canonical props to consumers", async () => {
		const f = fixture();
		try {
			const result = ready(await f.open());
			expect(f.loadTrace).toHaveBeenCalledWith("/exact/chat.jsonl", "exact-call");
			expect(f.getSetting).toHaveBeenCalledWith("display.shellVisualization", "/verified/project");
			expect(f.requests[0]).toMatchObject({ op: "restore", handle: result.handle, json: trace() });
			expect(result.props).toMatchObject({ liveOrigin: false, presentation: { output: "canonical replay output" } });
			expect(result.props).not.toHaveProperty("cwd");
			expect(JSON.stringify(result)).not.toContain('printf');
			expect(JSON.stringify(result)).not.toContain('1:2:saved');
			expect(f.frames).toEqual([{ handle: result.handle, revision: 1, props: result.props }]);
			f.service.release(result.handle);
			await f.service.close();
			expect(f.workers[0]!.close).toHaveBeenCalledOnce();
		} finally { await f.service.close(); }
	});

	it("separates the chat's setting scope from hoisted execution context through replay and snapshot updates", async () => {
		const f = fixture({ loadTrace: async () => ({ ...envelope(), executionCwd: "/", cdSeparator: ";" }) });
		try {
			const saved = ready(await f.open());
			expect(f.getSetting).toHaveBeenCalledWith("display.shellVisualization", "/verified/project");
			expect(saved).toMatchObject({ props: { cwd: "/" }, cdSeparator: ";" });
			expect(ready(await f.service.action(saved.handle, "view:raw"))).toMatchObject({ props: { cwd: "/" }, cdSeparator: ";" });
			const observed = ready(await f.service.openSnapshot({ requestId: "observed", toolCallId: "call", sourceId: "host:call", sourceRevision: 1, cwd: "/chat", executionCwd: "/executed", cdSeparator: ";", json: trace() }));
			expect(observed).toMatchObject({ props: { cwd: "/executed" }, cdSeparator: ";" });
			expect(f.getSetting).toHaveBeenCalledWith("display.shellVisualization", "/chat");
			const updated = ready(await f.service.updateSnapshot({ handle: observed.handle, sourceId: "host:call", sourceRevision: 2, executionCwd: "/", json: trace() }));
			expect(updated.props.cwd).toBe("/");
			expect(updated).not.toHaveProperty("cdSeparator");
		} finally { await f.service.close(); }
	});

	it("forwards every byte-bearing trace field unchanged to canonical restoration", async () => {
		const bytes = [255, 195, 169];
		const json = trace({ units: [{ source: bytes, nodes: [{ argv: ["printf", bytes], env: [["NAME", bytes], [bytes, "value"]], redirs: [{ fd: 1, op: ">", target: bytes }] }] }],
			diags: [{ code: "fixture", message: bytes }], history: [{ seq: 1, t_ns: 0, kind: "Assign", name: bytes, value: bytes }, { seq: 2, t_ns: 1, kind: "CmdExpanded", argv: [bytes], assigns: [[bytes, bytes]], redirs: [{ fd: 1, op: ">", target: bytes }] }, { seq: 3, t_ns: 2, kind: "Diag", text: bytes }] });
		const f = fixture({ loadTrace: async () => envelope(json) });
		try {
			ready(await f.open());
			expect(f.requests[0]).toMatchObject({ op: "restore", json });
		} finally { await f.service.close(); }
	});

	it.each([false, undefined, "true"])("refuses disabled/missing capability (%s) before native construction", async value => {
		const f = fixture({ getSetting: async () => ({ key: "display.shellVisualization", type: "boolean", value }) });
		try {
			expect(await f.open()).toEqual({ status: "unavailable", reason: value === false ? "disabled" : "unavailable" });
			expect(f.createWorker).not.toHaveBeenCalled();
		} finally { await f.service.close(); }
	});

	it("does not treat a version or another setting as native display capability", async () => {
		const f = fixture({ getSetting: async () => ({ key: "version.18.17", type: "boolean", value: true }) });
		try { expect(await f.open()).toEqual({ status: "unavailable", reason: "unavailable" }); expect(f.createWorker).not.toHaveBeenCalled(); }
		finally { await f.service.close(); }
	});

	it.each([trace({ v: 2 }), trace({ seq: -1 }), trace({ history: ["…[4 items elided for collab session]"] }), "{bad", trace({ script: "x".repeat(SHELL_SERVICE_LIMITS.traceBytes) })])("refuses malformed or oversized source before construction", async json => {
		const f = fixture({ loadTrace: async () => envelope(json) });
		try { expect((await f.open()).status).toBe("unavailable"); expect(f.createWorker).not.toHaveBeenCalled(); }
		finally { await f.service.close(); }
	});

	it("admits four independent handles, refuses a fifth, and releases one native owner without affecting others", async () => {
		const f = fixture();
		try {
			const opened = await Promise.all([0, 1, 2, 3].map(index => f.open(String(index))));
			expect(new Set(opened.map(result => ready(result).handle)).size).toBe(4);
			expect(await f.open("fifth")).toEqual({ status: "unavailable", reason: "too-large" });
			expect(f.createWorker).toHaveBeenCalledOnce();
			const first = ready(opened[0]!);
			f.service.release(first.handle);
			const next = ready(await f.open("fifth"));
			expect(next.handle).not.toBe(first.handle);
			expect(f.requests).toContainEqual({ op: "release", handle: first.handle });
			expect(f.maximum()).toBe(1);
		} finally { await f.service.close(); }
	});

	it("bounds retained JSON across handles independently of the per-trace limit", async () => {
		const json = trace({ script: "x".repeat(12 * 1024 * 1024) });
		const f = fixture({ loadTrace: async () => envelope(json) });
		try {
			ready(await f.open("one")); ready(await f.open("two"));
			expect(await f.open("three")).toEqual({ status: "unavailable", reason: "too-large" });
			expect(f.requests.filter(request => request.op === "restore")).toHaveLength(2);
		} finally { await f.service.close(); }
	});

	it("cancels a source read without starting a worker and retains its admission reservation until settled", async () => {
		const source = Promise.withResolvers<SavedShellTrace>();
		const f = fixture({ loadTrace: () => source.promise });
		const pending = f.open();
		f.service.cancel("request");
		source.resolve(envelope());
		try { expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" }); expect(f.createWorker).not.toHaveBeenCalled(); }
		finally { await f.service.close(); }
	});

	it("aborts worker startup when its last consumer cancels", async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const createWorker = vi.fn(async (_loss: (reason: ShellFailureReason) => void, signal: AbortSignal) => {
			started.resolve(signal);
			const stopped = Promise.withResolvers<ShellPresentationWorker>();
			signal.addEventListener("abort", () => stopped.reject(new ShellWorkerFailure("cancelled")), { once: true });
			return stopped.promise;
		});
		const f = fixture({ createWorker });
		const pending = f.open();
		const signal = await started.promise;
		f.service.cancel("request");
		expect(signal.aborted).toBe(true);
		expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
		await f.service.close();
	});

	it.each(["timeout", "crash", "memory", "unavailable"] as const)("invalidates all handles after %s and permits a clean retry", async reason => {
		const f = fixture();
		try {
			const first = ready(await f.open("one")); const second = ready(await f.open("two"));
			f.losses[0]!(reason);
			expect(f.invalidated).toContainEqual({ handles: [first.handle, second.handle], reason });
			expect(await f.service.action(first.handle, "view:raw")).toEqual({ status: "unavailable", reason: "unavailable" });
			ready(await f.open("retry"));
			expect(f.createWorker).toHaveBeenCalledTimes(2);
			expect(f.workers[0]!.close).toHaveBeenCalledOnce();
		} finally { await f.service.close(); }
	});

	it.each(["row", "value", "response"] as const)("refuses excessive canonical %s data before emitting a frame", async kind => {
		const f = fixture();
		f.intercept(request => {
			if (request.op !== "present") return undefined;
			const value = canonical(request.options);
			if (kind === "row") value.rows[0]!.segments = [{ text: "x".repeat(64 * 1024 + 1) }];
			else if (kind === "value") value.watches = [{ name: "reported", value: "x".repeat(16 * 1024 + 1) }];
			else value.output = "x".repeat(2 * 1024 * 1024);
			return Promise.resolve(value);
		});
		try { expect(await f.open()).toEqual({ status: "unavailable", reason: "unavailable" }); expect(f.frames).toEqual([]); }
		finally { await f.service.close(); }
	});

	it("rejects invalid canonical output without invalidating a healthy sibling", async () => {
		const f = fixture();
		try {
			const sibling = ready(await f.open("sibling"));
			f.intercept(request => request.op === "present" && request.handle !== sibling.handle ? Promise.resolve({ output: "not a presentation" }) : undefined);
			expect(await f.open()).toEqual({ status: "unavailable", reason: "unavailable" });
			expect(f.frames).toHaveLength(1);
			expect(f.invalidated).toHaveLength(1);
			expect(f.invalidated[0]!.handles).not.toContain(sibling.handle);
			ready(await f.service.action(sibling.handle, "view:raw"));
			expect(f.workers[0]!.close).not.toHaveBeenCalled();
			expect(f.requests.filter(request => request.op === "release")).toHaveLength(1);
		} finally { await f.service.close(); }
	});

	it("coalesces one queued latest update per handle and discards stale native responses/revisions", async () => {
		const f = fixture();
		try {
			const first = ready(await f.open());
			const dispatched = Promise.withResolvers<void>();
			const response = Promise.withResolvers<unknown>();
			let held = false;
			f.intercept(request => { if (request.op === "present" && !held) { held = true; dispatched.resolve(); return response.promise; } return undefined; });
			const old = f.service.action(first.handle, "seek:1");
			await dispatched.promise;
			const superseded = f.service.action(first.handle, "seek:2");
			const latest = f.service.action(first.handle, "seek:3");
			response.resolve(canonical({ ...first.props.presentation.preferences, cursor: 1 }));
			expect(await old).toEqual({ status: "unavailable", reason: "cancelled" });
			expect(await superseded).toEqual({ status: "unavailable", reason: "cancelled" });
			const result = ready(await latest);
			expect(result.revision).toBe(4);
			expect(result.props.presentation.preferences.cursor).toBe(3);
			expect(f.frames.map(frame => frame.revision)).toEqual([1, 4]);
			expect(f.requests.filter(request => request.op === "present")).toHaveLength(3);
			expect(f.maximum()).toBe(1);
		} finally { await f.service.close(); }
	});

	it("never publishes a result that finishes after release/cancel", async () => {
		const f = fixture();
		const first = ready(await f.open());
		const dispatched = Promise.withResolvers<void>(); const response = Promise.withResolvers<unknown>();
		f.intercept(request => { if (request.op === "present") { dispatched.resolve(); return response.promise; } return undefined; });
		const action = f.service.action(first.handle, "view:raw");
		await dispatched.promise;
		f.service.cancel("request");
		response.resolve(canonical({ ...first.props.presentation.preferences, view: "raw" }));
		expect(await action).toEqual({ status: "unavailable", reason: "cancelled" });
		await f.service.close();
		expect(f.frames).toHaveLength(1);
	});

	it("maps all canonical preferences and node actions without interpreting shell state", async () => {
		const f = fixture();
		try {
			const first = ready(await f.open());
			for (const action of ["view:raw", "split", "layer:color", "layer:inline", "layer:idioms", "layer:effects", "layer:unwrap", "select:opaque:node", "expand:opaque:node", "speed:0.5", "inspect", "seek:2", "step", "reset", "live", "pause"]) ready(await f.service.action(first.handle, action));
			const last = f.frames.at(-1)!;
			expect(last.props).toMatchObject({ inspector: true, liveOrigin: false, presentation: { preferences: { view: "raw", split: true, playing: false, speed: 0.5, selectedNode: "opaque:node", expandedNodes: ["opaque:node"], layers: { color: false, inline: false, idioms: false, effects: false, unwrap: false } } } });
			expect(last.props.presentation.preferences.cursor).toBeUndefined();
			const seek = f.requests.find(request => request.op === "present" && request.options.cursor === 2);
			expect(seek).toMatchObject({ options: { cursor: 2, cursorSeq: 2 } });
			expect(await f.service.action(first.handle, "select:unknown")).toEqual({ status: "unavailable", reason: "unavailable" });
			expect(await f.service.action(first.handle, "seek:5")).toEqual({ status: "unavailable", reason: "unavailable" });
			expect(await f.service.action(first.handle, "speed:3")).toEqual({ status: "unavailable", reason: "unavailable" });
		} finally { await f.service.close(); }
	});

	it("advances only the measured event cursor at 80 ms and stops at retained history end", async () => {
		vi.useFakeTimers();
		const f = fixture({ now: () => Date.now() });
		try {
			const first = ready(await f.open());
			ready(await f.service.action(first.handle, "play"));
			await vi.advanceTimersByTimeAsync(80);
			expect(f.frames.at(-1)!.props.presentation.preferences.cursor).toBe(2);
			await vi.advanceTimersByTimeAsync(160);
			expect(f.frames.at(-1)!.props.presentation.preferences).toMatchObject({ cursor: 4, playing: false });
			expect(f.frames.at(-1)!.props.presentation.output).toBe("canonical replay output");
		} finally { await f.service.close(); }
	});

	it("drops local inspection on setting invalidation without any owning-host interface", async () => {
		const f = fixture();
		try {
			const first = ready(await f.open());
			f.getSetting.mockResolvedValue({ key: "display.shellVisualization", type: "boolean", value: false });
			await f.service.settingsChanged("/other/project");
			expect(f.invalidated).toEqual([]);
			await f.service.settingsChanged("/verified/project");
			expect(f.invalidated).toEqual([{ handles: [first.handle], reason: "disabled" }]);
			expect(await f.service.action(first.handle, "play")).toEqual({ status: "unavailable", reason: "unavailable" });
		} finally { await f.service.close(); }
	});
	it("bounds source reads even when all pending consumers cancel before the reads settle", async () => {
		const source = Promise.withResolvers<SavedShellTrace>();
		const f = fixture({ loadTrace: () => source.promise });
		const pending = [0, 1, 2, 3].map(index => f.open(String(index)));
		for (const index of [0, 1, 2, 3]) f.service.cancel(String(index));
		try {
			expect(await f.open("fifth")).toEqual({ status: "unavailable", reason: "too-large" });
			source.resolve(envelope());
			expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => ({ status: "unavailable", reason: "cancelled" })));
			expect(f.createWorker).not.toHaveBeenCalled();
			ready(await f.open("after-cancel"));
		} finally { await f.service.close(); }
	});

	it("rejects an admitted source read from the lost worker generation until an explicit retry", async () => {
		const source = Promise.withResolvers<SavedShellTrace>();
		let reads = 0;
		const f = fixture({ loadTrace: async () => ++reads === 1 ? envelope() : source.promise });
		try {
			ready(await f.open("one"));
			const pending = f.open("pending-source");
			f.losses[0]!("crash");
			source.resolve(envelope());
			expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
			expect(f.createWorker).toHaveBeenCalledOnce();
			ready(await f.open("explicit-retry"));
			expect(f.createWorker).toHaveBeenCalledTimes(2);
		} finally { await f.service.close(); }
	});

	it("does not terminate sibling handles when a frame consumer immediately releases its completed handle", async () => {
		let consume: ((frame: ShellFrame) => void) | undefined;
		const f = fixture({ onFrame: frame => consume?.(frame) });
		try {
			const first = ready(await f.open("one"));
			consume = frame => f.service.release(frame.handle);
			ready(await f.open("two"));
			consume = undefined;
			expect(f.invalidated).toEqual([]);
			expect(f.workers[0]!.close).not.toHaveBeenCalled();
			ready(await f.service.action(first.handle, "view:raw"));
			expect(f.createWorker).toHaveBeenCalledOnce();
			expect(f.requests.filter(request => request.op === "release")).toHaveLength(1);
		} finally { await f.service.close(); }
	});

	it("ignores an obsolete worker's loss callback after a fresh retry", async () => {
		const f = fixture();
		try {
			ready(await f.open("one"));
			f.losses[0]!("crash");
			const retry = ready(await f.open("retry"));
			f.losses[0]!("memory");
			ready(await f.service.action(retry.handle, "seek:1"));
			expect(f.invalidated).toHaveLength(1);
			expect(f.workers[1]!.close).not.toHaveBeenCalled();
		} finally { await f.service.close(); }
	});

	it("discards a cancelled worker's late presentation before serving a queued fresh retry", async () => {
		const f = fixture();
		const old = ready(await f.open("one"));
		const dispatched = Promise.withResolvers<void>();
		const response = Promise.withResolvers<unknown>();
		let held = false;
		f.intercept(request => {
			if (request.op !== "present" || held) return undefined;
			held = true; dispatched.resolve(); return response.promise;
		});
		const stale = f.service.action(old.handle, "seek:1");
		await dispatched.promise;
		f.service.cancel("one");
		const retry = f.open("retry");
		response.resolve(canonical({ ...old.props.presentation.preferences, cursor: 1 }));
		try {
			expect(await stale).toEqual({ status: "unavailable", reason: "cancelled" });
			const current = ready(await retry);
			expect(current.handle).not.toBe(old.handle);
			expect(f.frames.map(frame => frame.handle)).toEqual([old.handle, current.handle]);
			expect(f.createWorker).toHaveBeenCalledTimes(2);
		} finally { await f.service.close(); }
	});

	it("releases idle native state while keeping the visible frame, source and preferences usable", async () => {
		vi.useFakeTimers();
		const f = fixture({ now: () => Date.now() });
		try {
			const first = ready(await f.open("one"));
			const inspected = ready(await f.service.action(first.handle, "view:raw"));
			await vi.advanceTimersByTimeAsync(SHELL_SERVICE_LIMITS.idleMs / 2);
			const second = ready(await f.open("two"));
			await vi.advanceTimersByTimeAsync(SHELL_SERVICE_LIMITS.idleMs / 2);
			expect(f.invalidated).toEqual([]);
			expect(f.requests).toContainEqual({ op: "release", handle: first.handle });
			expect(f.frames.find(frame => frame.revision === inspected.revision && frame.handle === first.handle)).toEqual(expect.objectContaining({ props: inspected.props }));
			expect(f.workers[0]!.close).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(SHELL_SERVICE_LIMITS.idleMs / 2);
			expect(f.invalidated).toEqual([]);
			expect(f.workers[0]!.close).toHaveBeenCalledOnce();
			const restored = ready(await f.service.action(first.handle, "seek:2"));
			expect(restored.handle).toBe(first.handle);
			expect(restored.props.presentation.preferences).toMatchObject({ view: "raw", cursor: 2 });
			ready(await f.service.action(second.handle, "view:raw"));
			expect(f.createWorker).toHaveBeenCalledTimes(2);
			expect(f.loadTrace).toHaveBeenCalledTimes(2);
			expect(f.requests.filter(request => request.op === "restore" && request.handle === first.handle)).toHaveLength(2);
		} finally { await f.service.close(); }
	});

	it("disposal during a source read never starts a worker and refuses future inspection", async () => {
		const source = Promise.withResolvers<SavedShellTrace>();
		const f = fixture({ loadTrace: () => source.promise });
		const pending = f.open();
		await f.service.close();
		source.resolve(envelope());
		expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
		expect(await f.open("after-close")).toEqual({ status: "unavailable", reason: "unavailable" });
		expect(f.createWorker).not.toHaveBeenCalled();
	});

	it("awaits a worker returned after shutdown interrupts startup, then closes it exactly once", async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const startup = Promise.withResolvers<ShellPresentationWorker>();
		const cleanup = Promise.withResolvers<void>();
		const closing = Promise.withResolvers<void>();
		const worker: ShellPresentationWorker = { request: vi.fn(), close: vi.fn(() => { closing.resolve(); return cleanup.promise; }) };
		const f = fixture({ createWorker: async (_onLoss, signal) => { started.resolve(signal); return startup.promise; } });
		const pending = f.open();
		const signal = await started.promise;
		const stopped = f.service.close();
		expect(f.service.close()).toBe(stopped);
		expect(signal.aborted).toBe(true);
		expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
		let settled = false; void stopped.then(() => { settled = true; });
		startup.resolve(worker);
		await closing.promise;
		expect(settled).toBe(false);
		expect(worker.request).not.toHaveBeenCalled();
		cleanup.resolve(); await stopped;
		expect(worker.close).toHaveBeenCalledOnce();
	});

	it("cancels an in-flight native computation but awaits its independent process cleanup", async () => {
		const f = fixture();
		const first = ready(await f.open());
		const computing = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		vi.mocked(f.workers[0]!.close).mockImplementation(() => cleanup.promise);
		f.intercept(request => { if (request.op === "present") { computing.resolve(); return new Promise(() => {}); } return undefined; });
		const pending = f.service.action(first.handle, "view:raw");
		await computing.promise;
		const stopped = f.service.close();
		let settled = false; void stopped.then(() => { settled = true; });
		expect(await pending).toEqual({ status: "unavailable", reason: "cancelled" });
		expect(settled).toBe(false);
		expect(await f.open("after-shutdown")).toEqual({ status: "unavailable", reason: "unavailable" });
		cleanup.resolve(); await stopped;
		expect(f.workers[0]!.close).toHaveBeenCalledOnce();
		expect(f.frames).toHaveLength(1);
	});

	it("awaits cleanup that was already pending before shutdown without starting a queued replacement", async () => {
		const f = fixture();
		const first = ready(await f.open());
		const cleanup = Promise.withResolvers<void>();
		const closing = Promise.withResolvers<void>();
		vi.mocked(f.workers[0]!.close).mockImplementation(() => { closing.resolve(); return cleanup.promise; });
		f.service.release(first.handle);
		await closing.promise;
		const retry = f.snapshot("replacement");
		// Let the replacement scheduler queue behind the previous worker's cleanup barrier.
		await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
		const stopped = f.service.close();
		let settled = false; void stopped.then(() => { settled = true; });
		expect(await retry).toEqual({ status: "unavailable", reason: "cancelled" });
		expect(settled).toBe(false);
		cleanup.resolve(); await stopped;
		expect(f.createWorker).toHaveBeenCalledOnce();
		expect(f.workers[0]!.close).toHaveBeenCalledOnce();
	});

	it("keeps a failed close barrier poisoned through explicit retries and reports shutdown failure", async () => {
		const f = fixture();
		const first = ready(await f.open());
		const failure = new Error("Descendant cleanup was not confirmed");
		vi.mocked(f.workers[0]!.close).mockRejectedValue(failure);
		f.service.release(first.handle);
		expect(await f.open("retry")).toEqual({ status: "unavailable", reason: "unavailable" });
		expect(await f.open("retry-again")).toEqual({ status: "unavailable", reason: "unavailable" });
		expect(f.createWorker).toHaveBeenCalledOnce();
		const stopped = f.service.close();
		expect(f.service.close()).toBe(stopped);
		await expect(stopped).rejects.toBe(failure);
	});

	it("does not replace a bootstrap worker whose cleanup rejected before startup returned", async () => {
		const failure = new Error("Startup descendant cleanup was not confirmed");
		const createWorker = vi.fn(async () => { throw failure; });
		const f = fixture({ createWorker });
		expect(await f.open()).toEqual({ status: "unavailable", reason: "unavailable" });
		expect(await f.open("retry")).toEqual({ status: "unavailable", reason: "unavailable" });
		expect(createWorker).toHaveBeenCalledOnce();
		await expect(f.service.close()).rejects.toBe(failure);
	});

	it.each(["restore", "present"] as const)("drops only the failing handle after a native %s refusal", async op => {
		const f = fixture();
		try {
			const sibling = ready(await f.open("sibling"));
			let refused: string | undefined;
			f.intercept(request => {
				if (request.op !== op || request.handle === sibling.handle) return undefined;
				refused = request.handle;
				return Promise.reject(new ShellWorkerRefusal("too-large"));
			});
			expect(await f.open("refused")).toEqual({ status: "unavailable", reason: "too-large" });
			expect(f.invalidated).toEqual([{ handles: [refused], reason: "too-large" }]);
			ready(await f.service.action(sibling.handle, "seek:1"));
			expect(f.workers[0]!.close).not.toHaveBeenCalled();
			if (op === "present") expect(f.requests).toContainEqual({ op: "release", handle: refused });
			f.intercept(undefined);
			ready(await f.open("refused"));
			expect(f.createWorker).toHaveBeenCalledOnce();
		} finally { await f.service.close(); }
	});

	it("keeps deferred play and view waiters alive across playback ticks", async () => {
		vi.useFakeTimers();
		const f = fixture({ now: () => Date.now() });
		try {
			const first = ready(await f.open());
			for (const action of ["play", "view:raw"]) {
				const dispatched = Promise.withResolvers<ShellVizPreferences>();
				const response = Promise.withResolvers<unknown>();
				f.intercept(request => {
					if (request.op !== "present") return undefined;
					dispatched.resolve(request.options);
					return response.promise;
				});
				let settled = false;
				const pending = f.service.action(first.handle, action).then(result => { settled = true; return result; });
				const options = await dispatched.promise;
				const count = f.requests.length;
				await vi.advanceTimersByTimeAsync(160);
				expect(settled).toBe(false);
				expect(f.requests).toHaveLength(count);
				response.resolve(canonical(options));
				ready(await pending);
			}
			f.intercept(undefined);
			await vi.advanceTimersByTimeAsync(80);
			expect(f.frames.at(-1)!.props.presentation.preferences).toMatchObject({ view: "raw", cursor: 4, playing: false });
			expect(f.invalidated).toEqual([]);
		} finally { await f.service.close(); }
	});

	it("does not let playback ticks replace a presentation queued behind another card", async () => {
		vi.useFakeTimers();
		const f = fixture({ now: () => Date.now() });
		try {
			const first = ready(await f.open("one"));
			const second = ready(await f.open("two"));
			ready(await f.service.action(second.handle, "play"));
			const dispatched = Promise.withResolvers<ShellVizPreferences>();
			const response = Promise.withResolvers<unknown>();
			f.intercept(request => {
				if (request.op !== "present" || request.handle !== first.handle) return undefined;
				dispatched.resolve(request.options);
				return response.promise;
			});
			const held = f.service.action(first.handle, "view:raw");
			const options = await dispatched.promise;
			let settled = false;
			const queued = f.service.action(second.handle, "view:raw").then(result => { settled = true; return result; });
			await vi.advanceTimersByTimeAsync(160);
			expect(settled).toBe(false);
			response.resolve(canonical(options));
			ready(await held);
			ready(await queued);
			expect(f.invalidated).toEqual([]);
			expect(f.maximum()).toBe(1);
		} finally { await f.service.close(); }
	});

	it("cancels active work without losing sibling frames or queued sibling waiters", async () => {
		const f = fixture();
		try {
			const first = ready(await f.open("one"));
			const second = ready(await f.open("two"));
			const third = ready(await f.open("three"));
			const dispatched = Promise.withResolvers<ShellVizPreferences>();
			const response = Promise.withResolvers<unknown>();
			f.intercept(request => {
				if (request.op !== "present" || request.handle !== first.handle) return undefined;
				dispatched.resolve(request.options);
				return response.promise;
			});
			const cancelled = f.service.action(first.handle, "seek:1");
			const options = await dispatched.promise;
			const sibling = f.service.action(second.handle, "view:raw");
			f.service.cancel("one");
			expect(await cancelled).toEqual({ status: "unavailable", reason: "cancelled" });
			const next = ready(await sibling);
			expect(next.handle).toBe(second.handle);
			expect(next.props.presentation.preferences.view).toBe("raw");
			expect(f.workers[0]!.close).toHaveBeenCalledOnce();
			expect(f.createWorker).toHaveBeenCalledTimes(2);
			expect(f.invalidated).toEqual([]);
			f.losses[0]!("memory");
			response.resolve(canonical(options));
			ready(await f.service.action(third.handle, "seek:2"));
			expect(f.frames.filter(frame => frame.handle === first.handle)).toHaveLength(1);
			expect(f.requests.filter(request => request.op === "restore" && request.handle === third.handle)).toHaveLength(2);
			expect(f.maximum()).toBe(1);
		} finally { await f.service.close(); }
	});

	it("evicts only idle LRU handles when admitting a fifth card and reuses its reservation", async () => {
		vi.useFakeTimers();
		const f = fixture({ now: () => Date.now() });
		try {
			const opened = [];
			for (let index = 0; index < 4; index++) {
				opened.push(ready(await f.open(String(index))));
				if (index < 3) await vi.advanceTimersByTimeAsync(100);
			}
			expect(await f.open("fifth")).toEqual({ status: "unavailable", reason: "too-large" });
			await vi.advanceTimersByTimeAsync(SHELL_SERVICE_LIMITS.idleMs - 200);
			expect(f.invalidated).toEqual([]);
			ready(await f.open("fifth"));
			expect(f.invalidated).toEqual([{ handles: [opened[0]!.handle], reason: "cancelled" }]);
			ready(await f.service.action(opened[1]!.handle, "view:raw"));
			expect(await f.open("0")).toEqual({ status: "unavailable", reason: "too-large" });
			f.service.release(opened[3]!.handle);
			ready(await f.open("0"));
			expect(f.loadTrace).toHaveBeenCalledTimes(6);
		} finally { await f.service.close(); }
	});

	it("opens explicit snapshots without reading a session file and binds updates to their exact source", async () => {
		const f = fixture();
		try {
			const first = ready(await f.snapshot());
			expect(first.sourceRevision).toBe(1);
			expect(f.loadTrace).not.toHaveBeenCalled();
			const update = { handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json: trace() };
			expect(await f.service.updateSnapshot({ ...update, sourceId: "host:2:session:call" })).toEqual({ status: "unavailable", reason: "unavailable" });
			expect(await f.service.updateSnapshot({ ...update, sourceRevision: 1 })).toEqual({ status: "unavailable", reason: "cancelled" });
			expect(ready(await f.service.updateSnapshot(update)).sourceRevision).toBe(2);
			const file = ready(await f.open("file"));
			expect(file).not.toHaveProperty("sourceRevision");
			expect(await f.service.updateSnapshot({ ...update, handle: file.handle })).toEqual({ status: "unavailable", reason: "unavailable" });
		} finally { await f.service.close(); }
	});

	it.each([
		{ sourceId: "" }, { sourceId: "host\0call" }, { toolCallId: "" }, { cwd: "" },
		{ sourceRevision: -1 }, { sourceRevision: 0.5 }, { sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ json: trace({ units: ["…[4 items elided for collab session]"] }) }, { json: "{bad" },
	])("refuses invalid snapshot identity, revision or elided source %j", async extra => {
		const f = fixture();
		try {
			expect(await f.service.openSnapshot({ requestId: "snapshot", toolCallId: "call", cwd: "/project", sourceId: "host:1:session:call", sourceRevision: 1, json: trace(), ...extra })).toEqual({ status: "unavailable", reason: "unavailable" });
			expect(f.createWorker).not.toHaveBeenCalled();
			ready(await f.snapshot());
		} finally { await f.service.close(); }
	});

	it("applies configuration invalidation to snapshot handles and refuses disabled snapshot construction", async () => {
		const f = fixture();
		try {
			const first = ready(await f.snapshot());
			f.getSetting.mockResolvedValue({ key: "display.shellVisualization", type: "boolean", value: false });
			await f.service.settingsChanged("/verified/project");
			expect(f.invalidated).toEqual([{ handles: [first.handle], reason: "disabled" }]);
			expect(await f.snapshot("disabled")).toEqual({ status: "unavailable", reason: "disabled" });
			expect(await f.service.updateSnapshot({ handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json: trace() })).toEqual({ status: "unavailable", reason: "unavailable" });
			expect(f.createWorker).toHaveBeenCalledOnce();
		} finally { await f.service.close(); }
	});

	it("coalesces source replacements and discards an old in-flight presentation", async () => {
		const f = fixture();
		try {
			const first = ready(await f.snapshot());
			const dispatched = Promise.withResolvers<ShellVizPreferences>();
			const response = Promise.withResolvers<unknown>();
			let held = false;
			f.intercept(request => {
				if (request.op !== "present" || held) return undefined;
				held = true;
				dispatched.resolve(request.options);
				return response.promise;
			});
			const old = f.service.action(first.handle, "seek:2");
			const options = await dispatched.promise;
			const update = { handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json: trace({ script: "revision two" }) };
			const superseded = f.service.updateSnapshot(update);
			const latest = f.service.updateSnapshot({ ...update, sourceRevision: 3, json: trace({ script: "revision three" }) });
			response.resolve(canonical(options));
			expect(await old).toEqual({ status: "unavailable", reason: "cancelled" });
			expect(await superseded).toEqual({ status: "unavailable", reason: "cancelled" });
			const current = ready(await latest);
			expect(current.sourceRevision).toBe(3);
			expect(current.props.presentation.preferences.cursor).toBe(2);
			expect(f.frames.map(frame => frame.sourceRevision)).toEqual([1, 3]);
			const restores = f.requests.filter(request => request.op === "restore");
			expect(restores).toHaveLength(2);
			expect(restores[1]).toMatchObject({ json: trace({ script: "revision three" }) });
			expect(f.maximum()).toBe(1);
		} finally { await f.service.close(); }
	});

	it("remaps held cursors by retained sequence while preserving all presentation preferences", async () => {
		const f = fixture();
		try {
			const first = ready(await f.snapshot());
			for (const action of ["view:raw", "split", "layer:color", "select:opaque:node", "expand:opaque:node", "speed:2", "inspect", "seek:3"]) ready(await f.service.action(first.handle, action));
			const json = trace({ seq: 6, t_ns: 400_000_000, historyTruncated: true, history: [{ seq: 3, t_ns: 160_000_000 }, { seq: 4, t_ns: 240_000_000 }, { seq: 6, t_ns: 400_000_000 }] });
			const update = { handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json };
			const remapped = ready(await f.service.updateSnapshot(update));
			expect(remapped.props).toMatchObject({ inspector: true, presentation: { preferences: { view: "raw", cursor: 1, split: true, playing: false, speed: 2, selectedNode: "opaque:node", expandedNodes: ["opaque:node"], layers: { color: false } } } });
			expect(f.requests.at(-1)).toMatchObject({ op: "present", options: { cursor: 1, cursorSeq: 3 } });
			ready(await f.service.action(first.handle, "live"));
			const latest = ready(await f.service.updateSnapshot({ ...update, sourceRevision: 3 }));
			expect(latest.props.presentation.preferences.cursor).toBeUndefined();
		} finally { await f.service.close(); }
	});

	it("accounts for replacement bytes once and frees source bytes and reservations on refusal and release", async () => {
		const big = trace({ script: "x".repeat(12 * 1024 * 1024) });
		const f = fixture();
		try {
			const first = ready(await f.snapshot("one", big));
			ready(await f.snapshot("two", big));
			expect(await f.snapshot("three", big)).toEqual({ status: "unavailable", reason: "too-large" });
			const update = { handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json: big };
			ready(await f.service.updateSnapshot(update));
			expect(await f.snapshot("three", big)).toEqual({ status: "unavailable", reason: "too-large" });
			expect(await f.service.updateSnapshot({ ...update, sourceRevision: 3, json: trace({ script: "x".repeat(SHELL_SERVICE_LIMITS.traceBytes) }) })).toEqual({ status: "unavailable", reason: "too-large" });
			expect(await f.service.updateSnapshot({ ...update, sourceRevision: 3, json: trace({ script: "…[22 chars elided for collab session]" }) })).toEqual({ status: "unavailable", reason: "unavailable" });
			ready(await f.service.updateSnapshot({ ...update, sourceRevision: 3, json: trace() }));
			ready(await f.snapshot("three", big));
			expect(await f.service.updateSnapshot({ ...update, sourceRevision: 4 })).toEqual({ status: "unavailable", reason: "too-large" });
			f.service.release(first.handle);
			ready(await f.snapshot("one"));
			expect(f.maximum()).toBe(1);
		} finally { await f.service.close(); }
	});

	it("coalesces replacement revisions arriving during native release before restoring again", async () => {
		const f = fixture();
		try {
			const first = ready(await f.snapshot());
			const dispatched = Promise.withResolvers<void>();
			const response = Promise.withResolvers<unknown>();
			let held = false;
			f.intercept(request => {
				if (request.op !== "release" || held) return undefined;
				held = true;
				dispatched.resolve();
				return response.promise;
			});
			const update = { handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json: trace({ script: "two" }) };
			const old = f.service.updateSnapshot(update);
			await dispatched.promise;
			const latest = f.service.updateSnapshot({ ...update, sourceRevision: 3, json: trace({ script: "three" }) });
			response.resolve(null);
			expect(await old).toEqual({ status: "unavailable", reason: "cancelled" });
			expect(ready(await latest).sourceRevision).toBe(3);
			expect(f.requests.filter(request => request.op === "restore")).toHaveLength(2);
			expect(f.requests.filter(request => request.op === "release")).toHaveLength(1);
			expect(f.frames.map(frame => frame.sourceRevision)).toEqual([1, 3]);
		} finally { await f.service.close(); }
	});

	it.each([false, true])("replaces an obsolete restore without publishing its source (refusal=%s)", async refused => {
		const f = fixture();
		const dispatched = Promise.withResolvers<string>();
		const response = Promise.withResolvers<unknown>();
		let held = false;
		f.intercept(request => {
			if (request.op !== "restore" || held) return undefined;
			held = true;
			dispatched.resolve(request.handle);
			return response.promise;
		});
		try {
			const initial = f.snapshot();
			const handle = await dispatched.promise;
			const next = f.service.updateSnapshot({ handle, sourceId: "host:1:session:call", sourceRevision: 2, json: trace({ script: "new source" }) });
			if (refused) response.reject(new ShellWorkerRefusal("unavailable"));
			else response.resolve(null);
			expect(await initial).toEqual({ status: "unavailable", reason: "cancelled" });
			expect(ready(await next).sourceRevision).toBe(2);
			expect(f.frames.map(frame => frame.sourceRevision)).toEqual([2]);
			expect(f.invalidated).toEqual([]);
			expect(f.requests.filter(request => request.op === "release")).toHaveLength(refused ? 0 : 1);
		} finally { await f.service.close(); }
	});

	it("cancels replacement release in the isolated worker and restores healthy siblings lazily", async () => {
		const f = fixture();
		try {
			const first = ready(await f.snapshot());
			const sibling = ready(await f.open("sibling"));
			const dispatched = Promise.withResolvers<void>();
			const response = Promise.withResolvers<unknown>();
			f.intercept(request => {
				if (request.op !== "release" || request.handle !== first.handle) return undefined;
				dispatched.resolve();
				return response.promise;
			});
			const replacement = f.service.updateSnapshot({ handle: first.handle, sourceId: "host:1:session:call", sourceRevision: 2, json: trace() });
			await dispatched.promise;
			f.service.release(first.handle);
			expect(await replacement).toEqual({ status: "unavailable", reason: "cancelled" });
			ready(await f.service.action(sibling.handle, "view:raw"));
			response.resolve(null);
			expect(f.invalidated).toEqual([]);
			expect(f.workers[0]!.close).toHaveBeenCalledOnce();
			expect(f.createWorker).toHaveBeenCalledTimes(2);
			expect(f.frames.filter(frame => frame.handle === first.handle)).toHaveLength(1);
		} finally { await f.service.close(); }
	});

	it("evicts idle source bytes only as needed and retains the other idle source for lazy inspection", async () => {
		vi.useFakeTimers();
		const big = trace({ script: "x".repeat(12 * 1024 * 1024) });
		const f = fixture({ now: () => Date.now() });
		try {
			const first = ready(await f.snapshot("one", big));
			await vi.advanceTimersByTimeAsync(100);
			const second = ready(await f.snapshot("two", big));
			await vi.advanceTimersByTimeAsync(SHELL_SERVICE_LIMITS.idleMs);
			expect(f.invalidated).toEqual([]);
			const third = ready(await f.snapshot("three", big));
			expect(f.invalidated).toEqual([{ handles: [first.handle], reason: "cancelled" }]);
			ready(await f.service.action(second.handle, "view:raw"));
			expect(await f.snapshot("one", big)).toEqual({ status: "unavailable", reason: "too-large" });
			f.service.release(third.handle);
			ready(await f.snapshot("one", big));
			expect(f.loadTrace).not.toHaveBeenCalled();
		} finally { await f.service.close(); }
	});

});

describe("raw trace clock boundary", () => {
	it("keeps syntax archives opaque and accepts run zero without inventing execution values", () => {
		const clock = shellTraceClock(trace({ units: [{ syntax: "opaque archive", nodes: [], bytes: [0, 3] }], rootVpid: 0 }));
		expect(clock?.history[0]).toEqual({ seq: 1, t_ns: 0 });
		expect(clock?.history).toHaveLength(4);
		expect(clock?.trimmed).toBe(false);
	});
	it("accepts native timestamp regressions without reordering events or mutating the source", () => {
		const json = trace({ history: [{ seq: 1, t_ns: 0 }, { seq: 4, t_ns: 325_333 }, { seq: 5, t_ns: 212_125 }], seq: 5, t_ns: 325_333 });
		expect(shellTraceClock(json)?.history).toEqual([{ seq: 1, t_ns: 0 }, { seq: 4, t_ns: 325_333 }, { seq: 5, t_ns: 325_333 }]);
		expect(JSON.parse(json).history[2]).toEqual({ seq: 5, t_ns: 212_125 });
	});
	it.each([{ history: [{ seq: 2, t_ns: 4 }, { seq: 1, t_ns: 5 }] }, { history: [{ seq: 1, t_ns: -1 }] }, { history: [{ seq: 5, t_ns: 0 }] }, { history: [{ seq: 1, t_ns: 240_000_001 }] }, { historyTruncated: "yes" }, { units: ["elided"] }])("refuses an untrustworthy source clock %j", extra => {
		expect(shellTraceClock(trace(extra))).toBeNull();
	});
});

describe("trace elision guard", () => {
	it.each(["…[22 chars elided for collab session]", "…[4 items elided for collab session]", "…[deeper levels elided for collab session]", "…[cyclic reference elided for collab session]", "[Session persistence truncated large content]"])("refuses the exact upstream marker %s", marker => {
		expect(hasShellTraceElision(JSON.stringify({ opaque: marker }))).toBe(true);
	});
	it("does not interpret opaque source or scan unbounded marker tails", () => {
		expect(hasShellTraceElision(JSON.stringify({ syntax: "…[".repeat(100_000) }))).toBe(false);
	});
});
