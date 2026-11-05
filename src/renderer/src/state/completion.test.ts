import type { HostFrame } from "@oh-my-pi/pi-wire";
import type { HostState } from "@shared/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController, setSlashDelivery } from "./session";

const transport = vi.hoisted(() => ({ socket: null as null | { onFrame(frame: HostFrame): void } }));
vi.mock("../collab/lib/socket", () => ({
	CollabSocket: class {
		onOpen = () => undefined;
		onFrame = (_frame: HostFrame) => undefined;
		onClose = () => undefined;
		constructor() { transport.socket = this; }
		connect() {}
		close() {}
		send() {}
	},
}));
vi.mock("../collab/lib/link", () => ({ COLLAB_PROTO: 3, encodeBase64Url: () => "token", parseCollabLink: () => ({ wsUrl: "ws://localhost/r/fixture", key: new Uint8Array(32) }) }));
vi.mock("../collab/lib/codec", () => ({ importRoomKey: () => ({}) }));
vi.mock("../chat/composer/send", () => ({ imagePathsText: () => "" }));
vi.mock("./app", () => ({ useApp: { getState: () => ({ view: "home", terminalTabId: null, openTerminal: () => undefined }) } }));
const recordings = import.meta.glob<string>("../collab/lib/fixtures/completion-*.jsonl", { query: "?raw", import: "default", eager: true });

let session: SessionController | undefined;
afterEach(async () => {
	await session?.dispose();
	setSlashDelivery(async () => undefined);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("completion evidence before queue delivery", () => {
	it.each([1, 2])("retains the request through %i early idle samples and corrective streaming at two seconds", async idleSamples => {
		vi.useFakeTimers();
		const invoke = vi.fn(async (channel: string, _payload?: unknown) => channel === "native:asyncWork" ? true : null);
		vi.stubGlobal("window", { vomp: { invoke, on: () => () => undefined } });
		const slash = vi.fn(async () => undefined);
		setSlashDelivery(slash);
		session = new SessionController({ tabId: "completion", projectPath: "/fixture", sessionFile: null });
		const events: string[] = [];
		session.onEvent(event => events.push(event.kind));
		session.attach({ hostId: "fixture", cwd: "/fixture", phase: "live", link: "fixture", generation: 1, sessionId: "fixture", sessionFile: null, pid: 1, exitCode: null, error: null, tui: null, cols: 80, rows: 24, transport: "tsp" } satisfies HostState);
		const feed = (frame: object) => transport.socket!.onFrame(frame as HostFrame);
		const state = { isStreaming: false, participants: [] };
		feed({ t: "welcome", header: null, entryCount: 0, state, agents: [] });
		feed({ t: "event", event: { type: "agent_start" } });
		await session.send("/compact");
		feed({ t: "state", state });
		if (idleSamples === 2) {
			await vi.advanceTimersByTimeAsync(100);
			feed({ t: "state", state });
		}
		await vi.advanceTimersByTimeAsync(idleSamples === 2 ? 1_900 : 2_000);
		expect(session.getSnapshot().working).toBe(true);
		expect(events).toEqual([]);
		expect(slash).not.toHaveBeenCalled();
		feed({ t: "state", state: { ...state, isStreaming: true } });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(session.getSnapshot().working).toBe(true);
		expect(events).toEqual([]);
		expect(slash).not.toHaveBeenCalled();
		expect(session.getSnapshot().queue.map(row => row.text)).toEqual(["/compact"]);
		feed({ t: "event", event: { type: "agent_end", isTerminal: true } });
		await vi.advanceTimersByTimeAsync(1_500);
		expect(slash).toHaveBeenCalledExactlyOnceWith(session, "/compact", { report: true });
		await vi.dynamicImportSettled();
		const diagnostics = invoke.mock.calls.filter(([channel]) => channel === "app:completionDiagnostic");
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics[0]?.[1]).toEqual(["completion", expect.any(Number), expect.any(Number), 1, 2, 64, expect.any(Number), 0, 8]);
		expect(diagnostics[1]?.[1]).toEqual(["completion", expect.any(Number), expect.any(Number), 0, 2, 2, expect.any(Number), 0, 12]);
	});

	it.each(["wait", "bash", "astra"])("replays the native omp %s trace without releasing queued work at helper completion", async scenario => {
		vi.useFakeTimers();
		vi.stubGlobal("window", { vomp: { invoke: async () => null, on: () => () => undefined } });
		const slash = vi.fn(async () => undefined);
		setSlashDelivery(slash);
		session = new SessionController({ tabId: `recorded-${scenario}`, projectPath: "/fixture", sessionFile: null });
		session.attach({ hostId: "fixture", cwd: "/fixture", phase: "live", link: "fixture", generation: 1, sessionId: "fixture", sessionFile: null, pid: 1, exitCode: null, error: null, tui: null, cols: 80, rows: 24, transport: "tsp" } satisfies HostState);
		const fixture = recordings[`../collab/lib/fixtures/completion-${scenario}.jsonl`]!;
		// These are complete collab frames captured from the isolated omp 18.16 fixture run.
		const rows = fixture.trim().split("\n").map(line => JSON.parse(line) as { at: string; frame: HostFrame });
		let previous = Date.parse(rows[0]!.at);
		let queued = false;
		let ended = false;
		for (const { at, frame } of rows) {
			const now = Date.parse(at);
			await vi.advanceTimersByTimeAsync(Math.max(0, now - previous));
			previous = now;
			transport.socket!.onFrame(frame);
			if (frame.t === "event" && frame.event.type === "agent_start" && !queued) {
				await session.send("/compact");
				queued = true;
			}
			if (frame.t === "event" && frame.event.type === "agent_end" && frame.event.isTerminal === true) ended = true;
			if (queued && !ended) {
				expect(session.getSnapshot().working).toBe(true);
				expect(slash).not.toHaveBeenCalled();
			}
		}
		expect(queued && ended).toBe(true);
		expect(slash).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(slash).toHaveBeenCalledExactlyOnceWith(session, "/compact", { report: true });
	});
});
