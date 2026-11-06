// @vitest-environment happy-dom
import type { NativeSnapshot } from "@shared/contracts/native";
import type * as MotionReact from "motion/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranscriptResult } from "../../collab/lib/client";
import "../../i18n";
import type { SessionController, SessionView } from "../../state/session";
import { TooltipProvider } from "../../ui";
import { TasksPane } from "./TasksPane";
import { openHelper } from "./helperFocus";
import { HelperStrip } from "./HelperStrip";
import { usePinnedHelpers } from "./pinnedHelpers";
import { TaskRuns } from "../../tool-render/tools/task";
import type { Helper } from "./derive";

vi.mock("../session-tools/typed", () => ({ sendSlashCommand: vi.fn() }));
vi.mock("../session-tools/drive", () => ({ reportFailure: vi.fn() }));
vi.mock("./helperFocus", () => ({ openHelper: vi.fn() }));
vi.mock("./pinnedHelpers", async importOriginal => ({ ...await importOriginal<object>(), usePinnedHelpers: vi.fn() }));
vi.mock("../../ui/TargetContextMenu", () => ({ TargetContextMenu: ({ children }: { children: ReactNode }) => children }));
vi.mock("./common", async importOriginal => ({ ...await importOriginal<object>(), usePaneVisible: () => true }));
vi.mock("motion/react", async importOriginal => {
	const actual = await importOriginal<typeof MotionReact>();
	// The hoisted mock loads React before this test module's imports initialize.
	const { createElement, forwardRef } = await import("react");
	const Div = forwardRef<HTMLDivElement, { children?: ReactNode; className?: string; id?: string }>(({ children, className, id }, ref) => createElement("div", { ref, className, id }, children));
	const Li = forwardRef<HTMLLIElement, { children?: ReactNode; className?: string }>(({ children, className }, ref) => createElement("li", { ref, className }, children));
	return {
		...actual,
		motion: new Proxy(actual.motion, { get: (target, key) => key === "div" ? Div : key === "li" ? Li : Reflect.get(target, key) }),
		AnimatePresence: ({ children }: { children: ReactNode }) => children,
	};
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: { root: Root; container: HTMLElement }[] = [];
const originalVomp = window.vomp;

afterEach(async () => {
	for (const { root, container } of mounted.splice(0)) {
		await act(async () => root.unmount());
		container.remove();
	}
	window.vomp = originalVomp;
});

const childTranscript = [
	{ type: "session", id: "child-session", cwd: "/helper" },
	{ type: "message", id: "call", timestamp: "2026-10-29T12:00:00Z", message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "bash", name: "bash", arguments: { command: "make", async: true } }] } },
	{ type: "message", id: "result", timestamp: "2026-10-29T12:00:01Z", message: { role: "toolResult", toolCallId: "bash", toolName: "bash", timestamp: 2, content: [], details: { async: { jobId: "child-job", state: "running" } } } },
].map(entry => JSON.stringify(entry)).join("\n") + "\n";

async function mountHelpers(ids: string[], fetchTranscript: (id: string, offset: number) => Promise<TranscriptResult | null>, options: { status?: "running" | "idle" | "parked"; transcript?: boolean; live?: boolean } = {}) {
	const client = { fetchTranscript };
	const view = {
		mode: options.live === false ? "history" : "live", working: false, history: null, displayLeaf: null, readOnly: false,
		guest: {
			phase: options.live === false ? "ended" : "live", entries: [], header: { cwd: "/project" },
			agents: ids.map((id, index) => ({ id, displayName: id, kind: "sub", status: options.status ?? "idle", hasSessionFile: options.transcript ?? true, createdAt: 0, lastActivity: 100 - index })),
			progress: new Map(), lifecycle: new Map(), activeTools: new Map(), backgroundTools: new Map(),
		},
	} as unknown as SessionView;
	const session = { tabId: "test", projectPath: "/project", getSnapshot: () => view, subscribe: () => () => {}, guestClient: () => client } as unknown as SessionController;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(TasksPane, { session, projectPath: "/project" }))));
	return container;
}

function button(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll("button")].find(element => element.textContent?.trim() === label);
	expect(match).toBeDefined();
	return match!;
}

describe("helper list controls", () => {
	it.each([
		{ status: "running" as const, transcript: true, live: true, opens: true, stop: true },
		{ status: "running" as const, transcript: false, live: true, opens: true, stop: true },
		{ status: "idle" as const, transcript: true, live: true, opens: true, stop: false },
		{ status: "parked" as const, transcript: false, live: true, opens: true, stop: false },
		{ status: "idle" as const, transcript: true, live: false, opens: true, stop: false },
		{ status: "idle" as const, transcript: false, live: false, opens: false, stop: false },
	])("offers one conversation entry and independent Stop for $status, transcript=$transcript, live=$live", async options => {
		vi.mocked(openHelper).mockClear();
		const container = await mountHelpers(["Atlas"], async () => ({ kind: "rows", text: "", newSize: 0 }), options);
		const row = container.querySelector('[role="group"]')!;
		const actions = [...row.querySelectorAll<HTMLButtonElement>("button")];
		expect(actions).toHaveLength(Number(options.opens) + Number(options.stop));
		const entry = actions.find(action => action.getAttribute("aria-label") === "Open Atlas's conversation");
		expect(!!entry).toBe(options.opens);
		if (entry) {
			expect(entry.type).toBe("button");
			expect(entry.disabled).toBe(false);
			entry.focus();
			expect(document.activeElement).toBe(entry);
			await act(async () => entry.click());
			expect(openHelper).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ tabId: "test" }), expect.objectContaining({ id: "Atlas" }));
		}
		expect(actions.some(action => action.getAttribute("aria-label") === "Stop Atlas")).toBe(options.stop);
	});

	it("keeps Show fewer available after expansion and retains an older helper with a running child on collapse", async () => {
		const ids = ["D1", "D2", "D3", "P1", "P2", "P3"];
		const container = await mountHelpers(ids, async (id, offset) => ({ kind: "rows", text: id === "P2" && offset === 0 ? childTranscript : "", newSize: id === "P2" ? childTranscript.length : 0 }));
		expect(container.querySelector('p[title="P2"]')).not.toBeNull();
		await act(async () => button(container, "Show 3 earlier helpers").click());
		for (const id of ids) expect(container.querySelector(`p[title="${id}"]`)).not.toBeNull();
		expect(button(container, "Show fewer helpers").getAttribute("aria-expanded")).toBe("true");
		await act(async () => button(container, "Show fewer helpers").click());
		expect(container.querySelector('p[title="P2"]')).not.toBeNull();
		expect(container.querySelector('p[title="P1"]')).toBeNull();
		expect(container.querySelector('p[title="P3"]')).toBeNull();
		expect(button(container, "Show 3 earlier helpers").getAttribute("aria-expanded")).toBe("false");
	});

	it("shows a concise unavailable state when omp reports a terminal helper transcript error", async () => {
		const fetchTranscript = vi.fn(async (): Promise<TranscriptResult> => ({ kind: "error", message: "no transcript available" }));
		const container = await mountHelpers(["Atlas"], fetchTranscript);
		const unavailable = [...container.querySelectorAll('[role="status"]')].find(element => element.textContent === "Background jobs unavailable.");
		expect(unavailable?.getAttribute("title")).toBe("no transcript available");
		expect(fetchTranscript).toHaveBeenCalledTimes(1);
	});
});

describe("other helper entry controls", () => {
	const helper = (hasTranscript: boolean, messageable: boolean): Helper => ({
		id: "Atlas", name: "Atlas", status: messageable ? "running" : "done", hasTranscript, messageable,
		activity: "Reading the source", tokens: null, toolCount: null, durationMs: null, durationAt: null,
		contextTokens: null, contextWindow: null, model: null,
	});
	async function mount(content: ReactNode) {
		const container = document.createElement("div"); document.body.append(container);
		const root = createRoot(container); mounted.push({ root, container });
		await act(async () => root.render(createElement(TooltipProvider, null, content)));
		return container;
	}
	it.each([[true, true], [false, true], [true, false], [false, false]])("keeps one transcript card entry for transcript=%s, messageable=%s", async (hasTranscript, messageable) => {
		const run = helper(hasTranscript, messageable);
		const onOpen = vi.fn();
		const container = await mount(createElement(TaskRuns, { runs: [run], onOpen }));
		const actions = [...container.querySelectorAll<HTMLButtonElement>("button")];
		expect(actions).toHaveLength(hasTranscript || messageable ? 1 : 0);
		if (actions[0]) {
			expect(actions[0].getAttribute("aria-label")).toBe("Open Atlas's conversation");
			await act(async () => actions[0]!.click());
			expect(onOpen).toHaveBeenCalledExactlyOnceWith(run);
		}
	});
	it.each([true, false])("keeps one pinned row entry before and after the transcript appears (%s)", async hasTranscript => {
		const run = helper(hasTranscript, true);
		vi.mocked(usePinnedHelpers).mockReturnValue({ all: [run], shown: [run], more: 0, ids: new Set([run.id]) });
		vi.mocked(openHelper).mockClear();
		const session = { tabId: "pinned", getSnapshot: () => null, subscribe: () => () => {}, agentCommand: vi.fn() } as unknown as SessionController;
		const container = await mount(createElement(HelperStrip, { session }));
		const actions = [...container.querySelectorAll<HTMLButtonElement>("button")];
		expect(actions).toHaveLength(2);
		expect(actions[0]!.getAttribute("aria-label")).toBe("Open Atlas's conversation, Working");
		expect(actions[1]!.getAttribute("aria-label")).toBe("Stop Atlas");
		await act(async () => actions[0]!.click());
		expect(openHelper).toHaveBeenCalledExactlyOnceWith(session, run);
	});
});

const jobEntries = [{
	type: "message", id: "poll", timestamp: "2026-11-01T12:00:00Z",
	message: { role: "toolResult", toolCallId: "poll", toolName: "job", timestamp: 0, content: [], details: { jobs: [
		{ id: "bg_1", type: "bash", status: "running", label: "npm run build", intent: "Checking the release build" },
		{ id: "bg_old", type: "bash", status: "running", label: "npm test" },
	] } },
}];

async function mountJobs(initial: Promise<NativeSnapshot> = Promise.resolve({ modes: null, theme: null })) {
	const listeners = new Set<() => void>();
	const nativeListeners = new Set<(event: { hostId: string; snapshot: NativeSnapshot }) => void>();
	const invoke = vi.fn(async () => { const snapshot = await initial; return { ...snapshot, asyncJobsGeneration: snapshot.asyncJobsGeneration ?? 1 }; });
	window.vomp = { invoke, on: (_channel: string, listener: (event: { hostId: string; snapshot: NativeSnapshot }) => void) => {
		nativeListeners.add(listener); return () => nativeListeners.delete(listener);
	} } as unknown as typeof window.vomp;
	let view = {
		mode: "live", working: false, history: null, displayLeaf: null, readOnly: false,
		host: { hostId: "host", generation: 1, phase: "live" },
		guest: { phase: "live", entries: jobEntries, header: { id: "session", cwd: "/project" }, agents: [], progress: new Map(), lifecycle: new Map(), activeTools: new Map(), backgroundTools: new Map() },
	} as unknown as SessionView;
	const session = { tabId: "jobs", projectPath: "/project", getSnapshot: () => view, subscribe: (listener: () => void) => {
		listeners.add(listener); return () => listeners.delete(listener);
	}, guestClient: () => null } as unknown as SessionController;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted.push({ root, container });
	await act(async () => root.render(createElement(TooltipProvider, null, createElement(TasksPane, { session, projectPath: "/project" }))));
	return {
		container, invoke, nativeListeners,
		publish: async (snapshot: NativeSnapshot, hostId = "host") => { await act(async () => { for (const listener of nativeListeners) listener({ hostId, snapshot: { asyncJobsGeneration: 1, ...snapshot } }); }); },
		update: async (patch: Partial<SessionView>) => { await act(async () => { view = { ...view, ...patch }; for (const listener of listeners) listener(); }); },
	};
}

describe("background job purpose and captions", () => {
	it("shows report purposes, keeps old labels and displays native captions as muted text", async () => {
		const test = await mountJobs(Promise.resolve({ modes: null, theme: null, asyncJobs: [{ id: "bg_1", intent: null, caption: "Compiles the desktop bundle" }] }));
		const row = [...test.container.querySelectorAll("li")].find(element => element.textContent?.includes("Checking the release build"))!;
		expect(row.querySelector('span[title="Checking the release build"]')).not.toBeNull();
		expect(row.querySelector("code")?.textContent).toBe("npm run build");
		expect(test.container.textContent).toContain("npm test");
		const caption = row.querySelector('span[title="Compiles the desktop bundle"]')!;
		expect(caption.classList.contains("text-fg-muted")).toBe(true);
		expect(test.invoke).toHaveBeenCalledExactlyOnceWith("native:snapshot", "host");
		await test.publish({ modes: null, theme: null, asyncJobs: [{ id: "bg_1", intent: null, caption: "Wrong host" }] }, "other-host");
		expect(test.container.textContent).not.toContain("Wrong host");
		await test.publish({ modes: null, theme: null, asyncJobs: [{ id: "bg_1", intent: null, caption: "Packages the installer" }] });
		expect(test.container.textContent).toContain("Packages the installer");
		expect(test.container.textContent).not.toContain("Compiles the desktop bundle");
		await test.publish({ modes: null, theme: null, asyncJobs: [] });
		expect(test.container.textContent).not.toContain("Packages the installer");
	});

	it("keeps newer caption events over the initial read and clears captions when the host stops", async () => {
		const initial = Promise.withResolvers<NativeSnapshot>();
		const test = await mountJobs(initial.promise);
		await test.publish({ modes: null, theme: null, asyncJobs: [{ id: "bg_1", intent: null, caption: "Current caption" }] });
		await act(async () => initial.resolve({ modes: null, theme: null, asyncJobs: [{ id: "bg_1", intent: null, caption: "Old caption" }] }));
		expect(test.container.textContent).toContain("Current caption");
		expect(test.container.textContent).not.toContain("Old caption");
		await test.update({ mode: "exited" });
		expect(test.container.textContent).not.toContain("Current caption");
		expect(test.nativeListeners.size).toBe(0);
	});

	it("does not reuse captions across session and host generations", async () => {
		const test = await mountJobs(Promise.resolve({ modes: null, theme: null, location: { cwd: "/project", sessionFile: null, sessionId: "session" }, asyncJobs: [{ id: "bg_1", intent: null, caption: "Previous session caption" }] }));
		expect(test.container.textContent).toContain("Previous session caption");
		await test.update({ host: { hostId: "host", generation: 2, phase: "live" } as SessionView["host"], guest: {
			phase: "live", entries: jobEntries, header: { id: "next-session", cwd: "/project" }, agents: [], progress: new Map(), lifecycle: new Map(), activeTools: new Map(), backgroundTools: new Map(),
		} as unknown as SessionView["guest"] });
		expect(test.container.textContent).not.toContain("Previous session caption");
		await test.publish({ modes: null, theme: null, location: { cwd: "/project", sessionFile: null, sessionId: "session" }, asyncJobs: [{ id: "bg_1", intent: null, caption: "Delayed old session" }] });
		expect(test.container.textContent).not.toContain("Delayed old session");
		await test.publish({ modes: null, theme: null, asyncJobsGeneration: 2, location: { cwd: "/project", sessionFile: null, sessionId: "next-session" }, asyncJobs: [{ id: "bg_1", intent: null, caption: "New session caption" }] });
		expect(test.container.textContent).toContain("New session caption");
	});
	it("rejects cached and delayed captions after a generation-only restart of the same session", async () => {
		const test = await mountJobs(Promise.resolve({ modes: null, theme: null, asyncJobsGeneration: 1, asyncJobs: [{ id: "bg_1", intent: null, caption: "Previous process" }] }));
		expect(test.container.textContent).toContain("Previous process");
		await test.update({ host: { hostId: "host", generation: 1, phase: "restarting" } as SessionView["host"] });
		expect(test.container.textContent).not.toContain("Previous process");
		expect(test.nativeListeners.size).toBe(0);
		await test.update({ host: { hostId: "host", generation: 2, phase: "live" } as SessionView["host"] });
		expect(test.container.textContent).not.toContain("Previous process");
		await test.publish({ modes: null, theme: null, asyncJobsGeneration: 1, asyncJobs: [{ id: "bg_1", intent: null, caption: "Delayed previous process" }] });
		expect(test.container.textContent).not.toContain("Delayed previous process");
		await test.publish({ modes: null, theme: null, asyncJobsGeneration: 2, asyncJobs: [{ id: "bg_1", intent: null, caption: "Current process" }] });
		expect(test.container.textContent).toContain("Current process");
	});
	it("does not let an ignored old-generation event suppress the current initial snapshot", async () => {
		const initial = Promise.withResolvers<NativeSnapshot>();
		const test = await mountJobs(initial.promise);
		await test.publish({ modes: null, theme: null, asyncJobsGeneration: 0, asyncJobs: [{ id: "bg_1", intent: null, caption: "Old generation" }] });
		await act(async () => initial.resolve({ modes: null, theme: null, asyncJobsGeneration: 1, asyncJobs: [{ id: "bg_1", intent: null, caption: "Initial current caption" }] }));
		expect(test.container.textContent).toContain("Initial current caption");
		expect(test.container.textContent).not.toContain("Old generation");
	});
});
