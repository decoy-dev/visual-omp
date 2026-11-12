// @vitest-environment happy-dom
import { act, createElement, Fragment, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellFrame, ShellResult, ShellSnapshotOpenRequest, ShellSnapshotUpdateRequest } from "@shared/shell-visualization";
import type { TspShellProps } from "@shared/tsp/shell";
import { FileRefContext } from "../../chat/transcript/fileRefScope";
import { SavedToolOutputContext } from "../../chat/transcript/savedBashOutput";
import { PresentationVisibility } from "../../state/tsp/presentation-claims";
import { SavedShellContent } from "./SavedShellContent";
import { useShellCommandHost } from "./ToolCommandHost";
import { ObservedShellProvider, type ObservedShellStore } from "./observed";
import type { ActiveTool } from "../../collab/lib/client";
import type { ShellCommandContext } from "../../tool-render/types";

const env = vi.hoisted(() => ({
	invoke: vi.fn(), listeners: new Map<string, Set<(value: never) => void>>(),
	setting: true as boolean | undefined, covered: false,
	action: undefined as ((value: string) => void) | undefined,
	observers: new Set<(entries: { isIntersecting: boolean }[]) => void>(),
}));
vi.hoisted(() => { Object.defineProperty(window, "vomp", { configurable: true, value: { platform: "darwin", on: () => () => {}, invoke: async () => undefined } }); });
vi.mock("../../i18n", () => ({ useDeferredTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../state/app", () => ({ useApp: (selector: (state: object) => unknown) => selector({ terminalTabId: env.covered ? "terminal" : null, sheet: null }) }));
vi.mock("../../state/tsp/useTsp", () => ({ useTsp: () => ({ snapshot: null, store: { getSnapshot: () => null } }) }));
vi.mock("../../registry/lazy", () => ({
	lazyView: (load: () => unknown) => load.toString().includes("SavedShellContent") ? SavedShellContent : () => null,
	LoadFailedNotice: () => null,
}));
vi.mock("./ShellView", () => ({ ShellView: ({ props, context, onAction, showOutput }: { props: TspShellProps; context?: ShellCommandContext; onAction(value: string): void; showOutput: boolean }) => {
	env.action = onAction;
	return createElement("section", { "data-shell": "", "data-output": String(showOutput), "data-cwd": props.cwd ?? context?.cwd, "data-cd-separator": context?.cdSeparator },
		props.presentation.rows[0]?.segments[0]?.text,
		createElement("button", { onClick: () => onAction("view:raw") }, "Raw"),
		createElement("button", { onClick: () => onAction("play") }, "Play"));
} }));
vi.mock("../../ui/Button", () => ({ Button: ({ children, size: _size, variant: _variant, ...props }: { children: ReactNode; size: string; variant: string; onClick(): void }) => createElement("button", props, children) }));

const props: TspShellProps = { presentation: {
	preferences: { view: "pseudo", layers: { color: true, inline: true, idioms: true, effects: true, unwrap: true }, split: false, playing: false, speed: 1, expandedNodes: [] },
	rows: [{ id: "row", depth: 0, node: "node", segments: [{ text: "recorded command", node: "node" }], effects: [] }], original: [], output: "", executing: true, watches: [], timeline: { length: 2, cursor: 2, elapsedNs: 1, durationNs: 1 },
} };
function ready(handle = "handle", revision = 1, text = "recorded command"): ShellFrame & { status: "ready" } {
	return { status: "ready", handle, revision, props: { ...props, presentation: { ...props.presentation, rows: [{ ...props.presentation.rows[0]!, segments: [{ text, node: "node" }] }] } } };
}
const deferred = <T,>() => Promise.withResolvers<T>();
let root: Root;
let element: HTMLDivElement;
let file: string | null;
let identity: string;
let running: boolean;
let hasResult: boolean;
let observing: boolean;
const activeTools = new Map<string, ActiveTool>();
const backgroundTools = new Map<string, ActiveTool>();
const sourceListeners = new Set<() => void>();
const observedStore: ObservedShellStore = {
	subscribe: listener => { sourceListeners.add(listener); return () => { sourceListeners.delete(listener); }; },
	getSnapshot: () => ({ activeTools, backgroundTools }),
};
async function traceFrame(seq: number) {
	backgroundTools.set("call-exact", { toolCallId: "call-exact", toolName: "bash", args: {}, startedAt: 0, partialResult: { details: { trace: { v: 1, seq, t_ns: seq, script: "printf source", units: [], history: [] } } } });
	await act(async () => { for (const listener of sourceListeners) listener(); });
}
let open: boolean;
let visible: boolean;
let call: string | undefined;
function Card() {
	const result = useShellCommandHost("bash", call, undefined, running, hasResult);
	return createElement(Fragment, null, result.availability, open ? result.host?.renderShellCommand?.("printf source", createElement("pre", null, "ordinary command"), "ENV=recorded") ?? createElement("pre", null, "ordinary command") : "closed", createElement("p", null, "ordinary result output"));
}
async function render() {
	const content = createElement(PresentationVisibility, { visible, children: createElement(SavedToolOutputContext.Provider, { value: { file, identity }, children: createElement(FileRefContext.Provider, { value: { chat: "read-only", bases: ["/source/cwd", "/other/base"] }, children: createElement(Card) }) }) });
	await act(async () => root.render(observing ? createElement(ObservedShellProvider, { store: observedStore, identity: "host:1:session:branch", cwd: "/source/cwd", children: content }) : content));
}
async function emit(channel: string, value: unknown) {
	await act(async () => { for (const listener of env.listeners.get(channel) ?? []) listener(value as never); });
}
function calls(channel: string) { return env.invoke.mock.calls.filter(args => args[0] === channel); }
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	file = "/saved/exact.jsonl"; identity = "branch:result"; running = false; open = true; visible = true; call = "call-exact";
	hasResult = true; observing = false; activeTools.clear(); backgroundTools.clear(); sourceListeners.clear();
	env.setting = true; env.covered = false; env.action = undefined; env.listeners.clear(); env.observers.clear();
	vi.stubGlobal("IntersectionObserver", class {
		constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) { env.observers.add(callback); }
		observe() {} disconnect() { env.observers.delete(this.callback); }
	});
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	env.invoke.mockReset().mockImplementation(async (channel: string) => {
		if (channel === "config:get") {
			if (env.setting === undefined) throw new Error("Unknown setting");
			return { key: "display.shellVisualization", type: "boolean", value: env.setting };
		}
		if (channel === "shell-viz:open") {
			expect(env.listeners.get("shell-viz:frame")?.size).toBe(1);
			expect(env.listeners.get("shell-viz:invalidated")?.size).toBe(1);
			return ready();
		}
		if (channel === "shell-viz:action") return ready("handle", 2, "local raw");
	});
	Object.defineProperty(window, "vomp", { configurable: true, value: {
		platform: "darwin", invoke: env.invoke,
		on: (channel: string, callback: (value: never) => void) => {
			const listeners = env.listeners.get(channel) ?? new Set();
			listeners.add(callback); env.listeners.set(channel, listeners);
			return () => listeners.delete(callback);
		},
	} });
	element = document.createElement("div"); document.body.append(element); root = createRoot(element);
});
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });

describe("saved shell command capability", () => {
	it.each([undefined, false])("keeps missing or disabled settings on ordinary output (%s)", async setting => {
		env.setting = setting; await render();
		expect(calls("shell-viz:open")).toHaveLength(0);
		expect(element.textContent).toBe("ordinary commandordinary result output");
		expect(element.querySelector("button")).toBeNull();
	});
	it("does no optional work for a closed card", async () => {
		open = false; await render(); expect(env.invoke).not.toHaveBeenCalled();
		open = true; await render(); expect(calls("shell-viz:open")).toHaveLength(1);
		open = false; await render(); expect(calls("shell-viz:release")).toEqual([["shell-viz:release", "handle"]]);
	});
	it.each(["running", "result", "file", "identity", "call"])("requires a settled exact saved source (%s)", async missing => {
		if (missing === "running") running = true;
		if (missing === "result") hasResult = false;
		if (missing === "file") file = null;
		if (missing === "identity") identity = "";
		if (missing === "call") call = undefined;
		await render(); expect(env.invoke).not.toHaveBeenCalled();
	});
	it("waits for the helper result before opening its persisted trace", async () => {
		hasResult = false; await render();
		expect(calls("shell-viz:open")).toHaveLength(0);
		expect(element.textContent).not.toContain("saved.failure");
		hasResult = true; await render();
		expect(calls("shell-viz:open")).toHaveLength(1);
		expect(element.querySelector("[data-shell]")).not.toBeNull();
	});
	it("opens the exact file and call using the first file-reference base", async () => {
		await render();
		expect(calls("config:get")).toEqual([["config:get", "display.shellVisualization", "/source/cwd"]]);
		expect(calls("shell-viz:open")).toEqual([["shell-viz:open", { requestId: expect.any(String), file, toolCallId: call }]]);
		expect(element.textContent).toContain("ENV=recorded");
		expect(element.textContent).toContain("saved.recorded");
		expect(element.textContent).toContain("ordinary result output");
		expect(element.querySelector("[data-shell]")?.getAttribute("data-output")).toBe("false");
	});
	it.each(["/saved/exact.jsonl", "/saved/parent/Helper/Helper.jsonl"])("retains native execution context for saved and helper cards (%s)", async source => {
		file = source;
		env.invoke.mockImplementation(async (channel: string) => {
			if (channel === "config:get") return { key: "display.shellVisualization", type: "boolean", value: true };
			if (channel === "shell-viz:open") return { ...ready(), props: { ...props, cwd: "/" }, cdSeparator: ";" };
		});
		await render();
		expect(element.querySelector("[data-shell]")?.getAttribute("data-cwd")).toBe("/");
		expect(element.querySelector("[data-shell]")?.getAttribute("data-cd-separator")).toBe(";");
		expect(calls("config:get")[0]?.[2]).toBe("/source/cwd");
	});

	it("allows read-only local Raw and replay without host events or session writes", async () => {
		await render();
		await act(async () => { element.querySelectorAll("button")[0]!.click(); element.querySelectorAll("button")[1]!.click(); });
		expect(calls("shell-viz:action")).toEqual([["shell-viz:action", "handle", "view:raw"], ["shell-viz:action", "handle", "play"]]);
		expect(env.invoke.mock.calls.every(args => /^(config:|shell-viz:)/.test(args[0]))).toBe(true);
	});
	it("resamples config changes and releases before disabled presentation disappears", async () => {
		await render(); env.setting = false;
		await emit("config:changed", { scope: "global", cwd: null });
		expect(element.textContent).toBe("ordinary commandordinary result output");
		expect(calls("shell-viz:release")).toHaveLength(1);
		env.setting = true; await emit("config:changed", { scope: "project", cwd: "/source/cwd" });
		expect(calls("shell-viz:open")).toHaveLength(2);
	});
	it("recovers when a confirmed re-enable supersedes the disabled sample without retrying stale configuration", async () => {
		await render();
		const disabledRead = deferred<{ key: string; type: string; value: boolean }>();
		let reads = 0;
		env.invoke.mockImplementation(async (channel: string) => {
			if (channel === "config:get") return ++reads === 1 ? disabledRead.promise : { key: "display.shellVisualization", type: "boolean", value: true };
			if (channel === "shell-viz:open") return ready("resumed");
			return undefined;
		});
		await emit("shell-viz:invalidated", { handles: ["handle"], reason: "disabled" });
		expect(calls("shell-viz:open")).toHaveLength(1);
		await emit("config:changed", { scope: "global", cwd: null });
		expect(calls("shell-viz:open")).toHaveLength(2);
		expect(element.querySelector("[data-shell]")).not.toBeNull();
		await act(async () => disabledRead.resolve({ key: "display.shellVisualization", type: "boolean", value: false }));
		expect(calls("shell-viz:open")).toHaveLength(2);
		expect(element.querySelector("[data-shell]")).not.toBeNull();
	});
	it("restores after a production disabled invalidation followed by re-enabling the setting", async () => {
		await render(); env.setting = false;
		await emit("shell-viz:invalidated", { handles: ["handle"], reason: "disabled" });
		await emit("config:changed", { scope: "global", cwd: null });
		expect(element.querySelector("[data-shell]")).toBeNull();
		env.setting = true;
		await emit("config:changed", { scope: "global", cwd: null });
		expect(calls("shell-viz:open")).toHaveLength(2);
		expect(element.querySelector("[data-shell]")).not.toBeNull();
	});
	it("does not reopen on its own true refresh when the saved header folder disables visualization", async () => {
		const rendererFolder = "/source/cwd";
		const savedHeaderFolder = "/recorded/disabled-project";
		let serviceReads = 0;
		env.invoke.mockImplementation(async (channel: string, _key: unknown, folder: unknown) => {
			if (channel === "config:get") {
				expect(folder).toBe(rendererFolder);
				expect(folder).not.toBe(savedHeaderFolder);
				return { key: "display.shellVisualization", type: "boolean", value: true };
			}
			if (channel === "shell-viz:open") {
				serviceReads++;
				return serviceReads === 1 ? ready() : { status: "unavailable", reason: "disabled" };
			}
			return undefined;
		});
		await render();
		await emit("shell-viz:invalidated", { handles: ["handle"], reason: "disabled" });
		expect(calls("config:get")).toHaveLength(2);
		expect(calls("shell-viz:open")).toHaveLength(1);
		expect(element.textContent).toBe("ordinary commandordinary result output");
		await render();
		expect(calls("shell-viz:open")).toHaveLength(1);
		await emit("config:changed", { scope: "global", cwd: null });
		expect(calls("shell-viz:open")).toHaveLength(2);
		expect(calls("config:get")).toHaveLength(4);
		expect(element.textContent).toBe("ordinary commandordinary result output");
		await render();
		expect(calls("shell-viz:open")).toHaveLength(2);
	});
	it("recovers a disabled saved trace when its differing recorded folder is re-enabled", async () => {
		let serviceEnabled = false;
		env.invoke.mockImplementation(async (channel: string) => {
			if (channel === "config:get") return { key: "display.shellVisualization", type: "boolean", value: true };
			if (channel === "shell-viz:open") return serviceEnabled ? ready("recorded-folder-enabled") : { status: "unavailable", reason: "disabled" };
			return undefined;
		});
		await render();
		expect(calls("shell-viz:open")).toHaveLength(1);
		expect(element.querySelector("[data-shell]")).toBeNull();
		serviceEnabled = true;
		await emit("config:changed", { scope: "project", cwd: "/recorded/disabled-project" });
		expect(calls("shell-viz:open")).toHaveLength(2);
		expect(element.querySelector("[data-shell]")).not.toBeNull();
	});
	it("keeps fallback visible while opening and releases a late open after collapse", async () => {
		const pending = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string) => channel === "config:get" ? { key: "display.shellVisualization", type: "boolean", value: true } : channel === "shell-viz:open" ? pending.promise : undefined);
		await render(); expect(element.textContent).toBe("ordinary commandordinary result output");
		const request = calls("shell-viz:open")[0]![1];
		open = false; await render();
		expect(calls("shell-viz:cancel")).toEqual([["shell-viz:cancel", request.requestId]]);
		await act(async () => pending.resolve(ready("late")));
		expect(calls("shell-viz:release")).toEqual([["shell-viz:release", "late"]]);
		expect(element.querySelector("[data-shell]")).toBeNull();
	});
	it("cancels opening work when the card goes offscreen", async () => {
		const pending = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string) => channel === "config:get" ? { key: "display.shellVisualization", type: "boolean", value: true } : channel === "shell-viz:open" ? pending.promise : undefined);
		await render();
		await act(async () => { for (const callback of env.observers) callback([{ isIntersecting: false }]); });
		expect(calls("shell-viz:cancel")).toHaveLength(1);
		expect(element.textContent).toBe("ordinary commandordinary result output");
		await act(async () => pending.resolve(ready("offscreen-late")));
		expect(calls("shell-viz:release")).toEqual([["shell-viz:release", "offscreen-late"]]);
	});
	it.each(["covered", "pane", "window"])("releases a ready viewer when %s hides it", async hidden => {
		await render(); const oldAction = env.action;
		if (hidden === "covered") { env.covered = true; await render(); }
		if (hidden === "pane") { visible = false; await render(); }
		if (hidden === "window") {
			vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
			await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		}
		expect(calls("shell-viz:release")).toHaveLength(1);
		expect(element.textContent).toBe("ordinary commandordinary result output");
		await act(async () => oldAction?.("play")); expect(calls("shell-viz:action")).toHaveLength(0);
		vi.restoreAllMocks();
	});
	it("applies only matching newer revisions, including events before open resolves", async () => {
		const pending = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string) => channel === "config:get" ? { key: "display.shellVisualization", type: "boolean", value: true } : channel === "shell-viz:open" ? pending.promise : undefined);
		await render(); await emit("shell-viz:frame", ready("handle", 3, "newest event"));
		await act(async () => pending.resolve(ready("handle", 1, "old open")));
		await emit("shell-viz:frame", ready("other", 99, "wrong handle"));
		await emit("shell-viz:frame", ready("handle", 2, "old event"));
		expect(element.textContent).toContain("newest event");
		expect(element.textContent).not.toContain("old open"); expect(element.textContent).not.toContain("wrong handle");
	});
	it("rejects late action replies after a newer frame", async () => {
		const pending = deferred<ShellResult>(); await render();
		env.invoke.mockImplementation(async (channel: string) => channel === "shell-viz:action" ? pending.promise : undefined);
		await act(async () => env.action?.("view:raw"));
		await emit("shell-viz:frame", ready("handle", 5, "new frame"));
		await act(async () => pending.resolve(ready("handle", 2, "late action")));
		expect(element.textContent).toContain("new frame"); expect(element.textContent).not.toContain("late action");
	});
	it("rejects an older action reply as soon as a newer action is requested", async () => {
		await render();
		const old = deferred<ShellResult>();
		const newest = deferred<ShellResult>();
		env.invoke.mockImplementation((channel: string, _handle: string, value: string) => channel === "shell-viz:action" ? value === "seek:0" ? old.promise : newest.promise : Promise.resolve(undefined));
		await act(async () => { env.action?.("seek:0"); env.action?.("seek:1"); });
		await act(async () => old.resolve(ready("handle", 2, "obsolete seek")));
		expect(element.textContent).not.toContain("obsolete seek");
		await act(async () => newest.resolve(ready("handle", 3, "chosen seek")));
		expect(element.textContent).toContain("chosen seek");
	});

	it("keeps the measured disclosure height while releasing an offscreen saved viewer", async () => {
		const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 480 } as DOMRect);
		await render();
		await act(async () => { for (const callback of env.observers) callback([{ isIntersecting: false }]); });
		expect(calls("shell-viz:release")).toHaveLength(1);
		expect(element.querySelector<HTMLElement>('[style*="min-height"]')?.style.minHeight).toBe("480px");
		expect(element.textContent).toContain("ordinary result output");
		const pending = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string) => channel === "config:get" ? { key: "display.shellVisualization", type: "boolean", value: true } : channel === "shell-viz:open" ? pending.promise : undefined);
		measure.mockReturnValue({ height: 20 } as DOMRect);
		await act(async () => { for (const callback of env.observers) callback([{ isIntersecting: true }]); });
		expect(element.querySelector<HTMLElement>('[style*="min-height"]')?.style.minHeight).toBe("480px");
		await act(async () => pending.resolve(ready("restored")));
		expect(element.querySelector('[style*="min-height"]')).toBeNull();
		expect(element.querySelector("[data-shell]")).not.toBeNull();
		measure.mockRestore();
	});
	it("releases source replacements and refuses captured callbacks and events", async () => {
		await render(); const oldAction = env.action;
		file = "/saved/replacement.jsonl"; identity = "other-result";
		env.invoke.mockImplementation(async (channel: string) => channel === "config:get" ? { key: "display.shellVisualization", type: "boolean", value: true } : channel === "shell-viz:open" ? ready("replacement", 1, "replacement source") : undefined);
		await render(); await act(async () => oldAction?.("play"));
		await emit("shell-viz:frame", ready("handle", 100, "stale source"));
		expect(calls("shell-viz:release")).toEqual([["shell-viz:release", "handle"]]);
		expect(calls("shell-viz:action")).toHaveLength(0);
		expect(element.textContent).toContain("replacement source"); expect(element.textContent).not.toContain("stale source");
		expect(calls("shell-viz:open")[1]![1]).toMatchObject({ file, toolCallId: call });
	});
	it.each(["crash", "timeout", "memory", "too-large"] as const)("requires explicit retry after %s, including across hidden views", async reason => {
		await render(); const oldAction = env.action;
		await emit("shell-viz:invalidated", { handles: ["handle"], reason });
		expect(element.textContent).toContain("ordinary command"); expect(element.textContent).toContain(`saved.failure.${reason}`);
		await act(async () => oldAction?.("play")); expect(calls("shell-viz:action")).toHaveLength(0);
		visible = false; await render(); visible = true; await render();
		expect(calls("shell-viz:open")).toHaveLength(1);
		await act(async () => element.querySelector("button")!.click());
		expect(calls("shell-viz:open")).toHaveLength(2);
	});
	it("keeps invalidation delivered during open terminal until manual retry", async () => {
		const pending = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string) => channel === "config:get" ? { key: "display.shellVisualization", type: "boolean", value: true } : channel === "shell-viz:open" ? pending.promise : undefined);
		await render(); await emit("shell-viz:invalidated", { handles: ["early"], reason: "crash" });
		await act(async () => pending.resolve(ready("early")));
		expect(element.textContent).toContain("saved.failure.crash"); expect(calls("shell-viz:release")).toEqual([["shell-viz:release", "early"]]);
		expect(calls("shell-viz:open")).toHaveLength(1);
	});
	it("rebinds when output identity changes within the same file", async () => {
		await render(); const oldAction = env.action;
		identity = "new-branch:result";
		await render();
		expect(calls("shell-viz:release")).toEqual([["shell-viz:release", "handle"]]);
		expect(calls("shell-viz:open")).toHaveLength(2);
		await act(async () => oldAction?.("play"));
		expect(calls("shell-viz:action")).toHaveLength(0);
	});
});

describe("observed classic trace continuity", () => {
	it("locally presents a detached background trace without reactivating its tool or owning host", async () => {
		observing = true;
		await traceFrame(1);
		env.invoke.mockImplementation(async (channel: string, request: ShellSnapshotOpenRequest) => {
			if (channel === "config:get") return { key: "display.shellVisualization", type: "boolean", value: true };
			if (channel === "shell-viz:openSnapshot") return { ...ready("observed", 1, "background state"), sourceRevision: request.sourceRevision };
			if (channel === "shell-viz:open") return ready("file");
			return undefined;
		});
		await render();
		expect(calls("shell-viz:open")).toHaveLength(0);
		expect(calls("shell-viz:openSnapshot")[0]![1]).toMatchObject({ sourceId: JSON.stringify(["host:1:session:branch", "call-exact"]), toolCallId: "call-exact", cwd: "/source/cwd", sourceRevision: 1 });
		expect(element.textContent).toContain("background state");
		expect(element.textContent).toContain("ordinary result output");
		expect(activeTools.size).toBe(0);
		expect(running).toBe(false);
		expect(env.invoke.mock.calls.every(args => /^(config:|shell-viz:)/.test(args[0]))).toBe(true);
		backgroundTools.clear();
		await act(async () => { for (const listener of sourceListeners) listener(); });
		expect(calls("shell-viz:release")).toContainEqual(["shell-viz:release", "observed"]);
		expect(calls("shell-viz:open")).toHaveLength(1);
	});

	it("skips identical observed snapshots without superseding the pending native response", async () => {
		observing = true;
		await traceFrame(1);
		const update = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string, request: ShellSnapshotOpenRequest | ShellSnapshotUpdateRequest) => {
			if (channel === "config:get") return { key: "display.shellVisualization", type: "boolean", value: true };
			if (channel === "shell-viz:openSnapshot") return { ...ready("observed", 1, "initial state"), sourceRevision: request.sourceRevision };
			if (channel === "shell-viz:updateSnapshot") return request.sourceRevision === 2 ? update.promise : { ...ready("observed", 3, "third state"), sourceRevision: request.sourceRevision };
			return undefined;
		});
		await render();
		await traceFrame(1); await traceFrame(1);
		expect(calls("shell-viz:updateSnapshot")).toHaveLength(0);
		await traceFrame(2); await traceFrame(2);
		expect(calls("shell-viz:updateSnapshot")).toHaveLength(1);
		await act(async () => update.resolve({ ...ready("observed", 2, "second state"), sourceRevision: 2 }));
		expect(element.textContent).toContain("second state");
		expect(calls("shell-viz:updateSnapshot")).toHaveLength(1);
		await traceFrame(3);
		expect(calls("shell-viz:updateSnapshot")[1]![1].sourceRevision).toBe(3);
		expect(element.textContent).toContain("third state");
	});

	it("coalesces source revisions and rejects old frames while the newest trace is queued", async () => {
		observing = true;
		await traceFrame(1);
		const older = deferred<ShellResult>();
		const latest = deferred<ShellResult>();
		env.invoke.mockImplementation(async (channel: string, request: ShellSnapshotOpenRequest | ShellSnapshotUpdateRequest) => {
			if (channel === "config:get") return { key: "display.shellVisualization", type: "boolean", value: true };
			if (channel === "shell-viz:openSnapshot") return { ...ready("observed", 1, "initial state"), sourceRevision: request.sourceRevision };
			if (channel === "shell-viz:updateSnapshot") return request.sourceRevision === 2 ? older.promise : latest.promise;
			return undefined;
		});
		await render();
		await traceFrame(2); await traceFrame(3); await traceFrame(4);
		expect(calls("shell-viz:updateSnapshot")).toHaveLength(1);
		await emit("shell-viz:frame", { ...ready("observed", 2, "obsolete event"), sourceRevision: 2 });
		await act(async () => older.resolve({ ...ready("observed", 2, "obsolete result"), sourceRevision: 2 }));
		expect(element.textContent).toContain("initial state");
		expect(element.textContent).not.toContain("obsolete");
		expect(calls("shell-viz:updateSnapshot")).toHaveLength(2);
		expect(calls("shell-viz:updateSnapshot")[1]![1].sourceRevision).toBe(4);
		await act(async () => latest.resolve({ ...ready("observed", 4, "latest observed state"), sourceRevision: 4 }));
		expect(element.textContent).toContain("latest observed state");
		expect(calls("shell-viz:openSnapshot")).toHaveLength(1);
		expect(element.textContent).toContain("ordinary result output");
	});
});
