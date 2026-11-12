import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ShellVisualizationServiceOptions } from "./shell-visualization";
import type * as ShellVisualizationFeature from "../features/shell-visualization";
import { loadSavedShellTrace } from "./session-tool-output";
import { reportedSessionFiles } from "../features/sessions";

type FakeService = { options: ShellVisualizationServiceOptions; open: Mock; openSnapshot: Mock; updateSnapshot: Mock; action: Mock; release: Mock; cancel: Mock; settingsChanged: Mock; close: Mock };
type FakeSender = EventEmitter & { id: number; isDestroyed(): boolean; send: Mock };
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), broadcasts: new Map<string, (event: { cwd: string | null }) => void>(), services: [] as FakeService[], workers: vi.fn(async () => ({ request: vi.fn(), close: vi.fn() })) }));
vi.mock("../ipc", () => ({ handleWithEvent: (name: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(name, handler), onBroadcast: (name: string, handler: (event: { cwd: string | null }) => void) => state.broadcasts.set(name, handler) }));
vi.mock("../env", () => ({ userEnv: async () => ({ PATH: "/safe" }) }));
vi.mock("./locate", () => ({ ompPath: async () => "/installed/omp" }));
vi.mock("./session-tool-output", () => ({ loadSavedShellTrace: vi.fn() }));
vi.mock("../features/config", () => ({ getSetting: vi.fn() }));
vi.mock("../features/sessions", () => ({ reportedSessionFiles: vi.fn(() => ["/reported/current.jsonl"]) }));
vi.mock("./shell-visualization-worker", () => ({
	createInstalledShellWorker: (...args: unknown[]) => Reflect.apply(state.workers, undefined, args),
	ShellWorkerFailure: class extends Error { constructor(readonly reason: string) { super(reason); } },
}));
vi.mock("./shell-visualization", () => ({ ShellVisualizationService: class {
	constructor(options: ShellVisualizationServiceOptions) {
		const service = { options, open: vi.fn(), openSnapshot: vi.fn(), updateSnapshot: vi.fn(), action: vi.fn(), release: vi.fn(), cancel: vi.fn(), settingsChanged: vi.fn(async () => {}), close: vi.fn(async () => {}) };
		state.services.push(service);
		return service;
	}
} }));
function sender(id: number): FakeSender { return Object.assign(new EventEmitter(), { id, isDestroyed: () => false, send: vi.fn() }); }
function invoke(name: string, source: FakeSender, ...args: unknown[]) { return state.handlers.get(name)!({ sender: source }, ...args); }
let feature: typeof ShellVisualizationFeature;
beforeEach(async () => {
	vi.resetModules();
	state.handlers.clear(); state.broadcasts.clear(); state.services = []; state.workers.mockClear();
	// Each case needs fresh module-owned shutdown state; a static runtime import would retain it.
	feature = await import("../features/shell-visualization");
	feature.register();
});
afterEach(async () => { await feature.stopShellVisualizations(); vi.useRealTimers(); });

describe("shell visualization feature ownership", () => {
	it("uses the same current session-directory authority as content recovery", async () => {
		invoke("shell-viz:open", sender(1), { requestId: "one" });
		await state.services[0]!.options.loadTrace("/reported/current.jsonl", "exact-call");
		expect(loadSavedShellTrace).toHaveBeenCalledWith("/reported/current.jsonl", "exact-call", reportedSessionFiles);
	});
	it("scopes actions and emitted frames to the invoking webContents", () => {
		const first = sender(1); const second = sender(2);
		invoke("shell-viz:open", first, { requestId: "one", file: "/a", toolCallId: "call" });
		invoke("shell-viz:open", second, { requestId: "two", file: "/b", toolCallId: "call" });
		invoke("shell-viz:action", second, "first-window-handle", "play");
		expect(state.services[0]!.action).not.toHaveBeenCalled();
		expect(state.services[1]!.action).toHaveBeenCalledWith("first-window-handle", "play");
		const event = { handles: ["first-window-handle"], reason: "crash" as const };
		state.services[0]!.options.onInvalidated!(event);
		expect(first.send).toHaveBeenCalledWith("shell-viz:invalidated", event);
		expect(second.send).not.toHaveBeenCalled();
	});

	it("drops controller authority on reload and closes the old worker before another can start", async () => {
		const source = sender(1);
		invoke("shell-viz:open", source, { requestId: "one" });
		const stopped = Promise.withResolvers<void>();
		state.services[0]!.close.mockReturnValue(stopped.promise);
		source.emit("did-start-navigation", {}, "app://reload", false, true);
		expect(state.services[0]!.close).toHaveBeenCalledOnce();
		invoke("shell-viz:open", source, { requestId: "two" });
		const pending = state.services[1]!.options.createWorker(() => {}, new AbortController().signal);
		await Promise.resolve();
		expect(state.workers).not.toHaveBeenCalled();
		state.services[0]!.options.onInvalidated!({ handles: ["old"], reason: "cancelled" });
		expect(source.send).not.toHaveBeenCalled();
		stopped.resolve(); await pending;
		expect(state.workers).toHaveBeenCalledOnce();
	});

	it("releases on destruction, retains same-document navigation, and forwards config invalidation", () => {
		const source = sender(1);
		invoke("shell-viz:open", source, { requestId: "one" });
		source.emit("did-start-navigation", {}, "app://hash", true, true);
		expect(state.services[0]!.close).not.toHaveBeenCalled();
		state.broadcasts.get("config:changed")!({ cwd: "/project" });
		expect(state.services[0]!.settingsChanged).toHaveBeenCalledWith("/project");
		invoke("shell-viz:release", source, "handle");
		invoke("shell-viz:cancel", source, "request");
		expect(state.services[0]!.release).toHaveBeenCalledWith("handle");
		expect(state.services[0]!.cancel).toHaveBeenCalledWith("request");
		source.emit("destroyed");
		expect(state.services[0]!.close).toHaveBeenCalledOnce();
	});

	it("awaits active and already-closing services once and detaches their window listeners", async () => {
		const active = sender(1); const destroyed = sender(2);
		invoke("shell-viz:open", active, {});
		invoke("shell-viz:open", destroyed, {});
		const first = Promise.withResolvers<void>(); const second = Promise.withResolvers<void>();
		state.services[0]!.close.mockReturnValue(first.promise);
		state.services[1]!.close.mockReturnValue(second.promise);
		destroyed.emit("destroyed");
		const stopped = feature.stopShellVisualizations();
		expect(feature.stopShellVisualizations()).toBe(stopped);
		let settled = false; void stopped.then(() => { settled = true; });
		first.resolve(); await Promise.resolve();
		expect(settled).toBe(false);
		for (const source of [active, destroyed]) {
			expect(source.listenerCount("did-start-navigation")).toBe(0);
			expect(source.listenerCount("destroyed")).toBe(0);
			expect(source.listenerCount("render-process-gone")).toBe(0);
		}
		second.resolve();
		expect(await stopped).toBe(true);
		for (const service of state.services) expect(service.close).toHaveBeenCalledOnce();
	});

	it("refuses every new inspection request and config event as soon as shutdown begins", async () => {
		const source = sender(1);
		invoke("shell-viz:open", source, {});
		const cleanup = Promise.withResolvers<void>();
		state.services[0]!.close.mockReturnValue(cleanup.promise);
		const stopped = feature.stopShellVisualizations();
		for (const name of ["open", "openSnapshot", "updateSnapshot", "action"]) {
			expect(await invoke(`shell-viz:${name}`, sender(2), {}, "play")).toEqual({ status: "unavailable", reason: "cancelled" });
		}
		invoke("shell-viz:release", source, "handle");
		invoke("shell-viz:cancel", source, "request");
		state.broadcasts.get("config:changed")!({ cwd: "/project" });
		state.services[0]!.options.onFrame!({} as never);
		expect(state.services).toHaveLength(1);
		expect(state.services[0]!.release).not.toHaveBeenCalled();
		expect(state.services[0]!.cancel).not.toHaveBeenCalled();
		expect(state.services[0]!.settingsChanged).not.toHaveBeenCalled();
		expect(source.send).not.toHaveBeenCalled();
		cleanup.resolve(); expect(await stopped).toBe(true);
	});

	it("does not let deferred startup await its own close after a reload and quit", async () => {
		const source = sender(1);
		invoke("shell-viz:open", source, {});
		const previous = Promise.withResolvers<void>();
		state.services[0]!.close.mockReturnValue(previous.promise);
		source.emit("destroyed");
		invoke("shell-viz:open", source, {});
		const abort = new AbortController();
		// The scheduler has queued startup, but disposal runs before that microtask.
		const startup = Promise.resolve().then(() => state.services[1]!.options.createWorker(() => {}, abort.signal));
		const rejected = expect(startup).rejects.toMatchObject({ reason: "cancelled" });
		state.services[1]!.close.mockImplementation(async () => { abort.abort(); await startup.catch(() => {}); });
		const stopped = feature.stopShellVisualizations();
		previous.resolve();
		await rejected;
		expect(await stopped).toBe(true);
		expect(state.workers).not.toHaveBeenCalled();
	});

	it("retains failed cleanup ownership across reloads and reports shutdown failure", async () => {
		const source = sender(1);
		invoke("shell-viz:open", source, {});
		const failure = new Error("Unconfirmed descendant cleanup");
		state.services[0]!.close.mockRejectedValue(failure);
		source.emit("destroyed");
		await Promise.resolve();
		invoke("shell-viz:open", source, {});
		await expect(state.services[1]!.options.createWorker(() => {}, new AbortController().signal)).rejects.toBe(failure);
		expect(state.workers).not.toHaveBeenCalled();
		expect(await feature.stopShellVisualizations()).toBe(false);
	});

	it.each(["settled", "deadline"])("awaits current cleanup despite a rejected predecessor until %s", async finish => {
		vi.useFakeTimers();
		const source = sender(1);
		invoke("shell-viz:open", source, {});
		const failure = new Error("Unconfirmed predecessor cleanup");
		state.services[0]!.close.mockRejectedValue(failure);
		source.emit("destroyed");
		invoke("shell-viz:open", source, {});
		await expect(state.services[1]!.options.createWorker(() => {}, new AbortController().signal)).rejects.toBe(failure);
		const cleanup = Promise.withResolvers<void>();
		state.services[1]!.close.mockReturnValue(cleanup.promise);
		const stopped = feature.stopShellVisualizations();
		let settled = false; void stopped.then(() => { settled = true; });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(settled).toBe(false);
		if (finish === "settled") cleanup.resolve();
		else await vi.advanceTimersByTimeAsync(1_000);
		expect(await stopped).toBe(false);
		expect(state.workers).not.toHaveBeenCalled();
		cleanup.resolve();
		expect(await feature.stopShellVisualizations()).toBe(false);
	});

	it("bounds an unresponsive cleanup without claiming success or reopening requests", async () => {
		vi.useFakeTimers();
		const source = sender(1);
		invoke("shell-viz:open", source, {});
		const cleanup = Promise.withResolvers<void>();
		state.services[0]!.close.mockReturnValue(cleanup.promise);
		source.emit("destroyed");
		const stopped = feature.stopShellVisualizations();
		await vi.advanceTimersByTimeAsync(6_000);
		expect(await stopped).toBe(false);
		cleanup.resolve(); await Promise.resolve();
		expect(await feature.stopShellVisualizations()).toBe(false);
		expect(await invoke("shell-viz:open", source, {})).toEqual({ status: "unavailable", reason: "cancelled" });
	});
});
