import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostFrame } from "@oh-my-pi/pi-wire";
import { GuestClient } from "./client";

/** The socket the client creates; frames from omp's host are fed through `onFrame`. */
const socket = vi.hoisted(() => ({ current: null as null | { onFrame: (frame: unknown) => void; onClose: (reason: string, reconnect: boolean) => void }, sent: [] as unknown[] }));
vi.mock("./socket", () => ({
	CollabSocket: class {
		onOpen = () => undefined;
		onFrame: (frame: unknown) => void = () => undefined;
		onClose = () => undefined;
		constructor() {
			socket.current = this;
		}
		connect() {}
		send(frame: unknown) { socket.sent.push(frame); }
	},
}));
vi.mock("./link", () => ({
	COLLAB_PROTO: 1,
	encodeBase64Url: () => "token",
	parseCollabLink: () => ({ wsUrl: "ws://localhost/r/room", key: new Uint8Array(32) }),
}));
vi.mock("./codec", () => ({ importRoomKey: () => ({}) }));

const welcome = { t: "welcome", header: null, entryCount: 0, state: { isStreaming: false, participants: [] }, agents: [] };
const thinking = (configured?: string) => ({ t: "event", event: { type: "thinking_level_changed", thinkingLevel: "high", configured } });

let client: GuestClient;
const feed = (frame: object) => socket.current?.onFrame(frame as HostFrame);

beforeEach(() => {
	socket.sent = [];
	client = new GuestClient("link", "visual-omp");
	feed(welcome);
});

describe("autoThinking", () => {
	it("follows omp's thinking events", () => {
		expect(client.getSnapshot().autoThinking).toBeNull();
		feed(thinking("auto"));
		expect(client.getSnapshot().autoThinking).toBe(true);
		feed(thinking());
		expect(client.getSnapshot().autoThinking).toBe(false);
	});

	it("forgets what it saw before a reconnect, in both directions", () => {
		feed(thinking("auto"));
		feed(welcome);
		expect(client.getSnapshot().autoThinking).toBeNull();
		feed(thinking());
		feed(welcome);
		expect(client.getSnapshot().autoThinking).toBeNull();
	});
});

describe("late background tool frames", () => {
	const call = { toolCallId: "bash-1", toolName: "bash", args: { command: "make", async: true } };
	const start = () => feed({ t: "event", event: { type: "tool_execution_start", ...call } });
	const update = (state: string) => feed({ t: "event", event: { type: "tool_execution_update", ...call, partialResult: { details: { output: state, async: { jobId: "bg_1", state } } } } });
	const end = () => feed({ t: "event", event: { type: "tool_execution_end", ...call, result: { content: [], details: { async: { jobId: "bg_1", state: "running" } } }, isError: false } });

	it("keeps later output separate from active calls, including after an idle frame", () => {
		start();
		update("running");
		expect(client.getSnapshot().activeTools.has(call.toolCallId)).toBe(true);
		end();
		update("completed");
		expect(client.getSnapshot().activeTools.size).toBe(0);
		expect(client.getSnapshot().backgroundTools.get(call.toolCallId)?.partialResult).toMatchObject({ details: { async: { state: "completed" } } });
		feed({ t: "state", state: welcome.state });
		update("completed");
		expect(client.getSnapshot().activeTools.size).toBe(0);
		expect(client.getSnapshot().backgroundTools.size).toBe(1);
	});

	it("recognizes saved tool results when joining an existing session", () => {
		feed({ ...welcome, entryCount: 1 });
		feed({ t: "snapshot-chunk", entries: [{ type: "message", id: "result", parentId: null, timestamp: "", message: { role: "toolResult", ...call, content: [], timestamp: 1 } }], final: true });
		update("cancelled");
		expect(client.getSnapshot().activeTools.size).toBe(0);
		expect(client.getSnapshot().backgroundTools.size).toBe(1);
		feed(welcome);
		update("completed");
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});

	it("recognizes committed live tool results without a matching end event", () => {
		start();
		feed({ t: "entry", entry: { type: "message", id: "result", parentId: null, timestamp: "", message: { role: "toolResult", ...call, content: [], timestamp: 1 } } });
		update("failed");
		expect(client.getSnapshot().activeTools.size).toBe(0);
		expect(client.getSnapshot().backgroundTools.size).toBe(1);
	});

	it("still adopts an update whose foreground start was missed", () => {
		update("running");
		expect(client.getSnapshot().activeTools.size).toBe(1);
		expect(client.getSnapshot().backgroundTools.size).toBe(0);
	});
});

describe("background-job waits", () => {
	const endWaiting = () => feed({ t: "event", event: { type: "agent_end", awaitingAsyncWork: true } });
	it("retains the distinct wait across idle state frames without claiming a foreground turn", () => {
		endWaiting();
		feed({ t: "state", state: welcome.state });
		expect(client.getSnapshot()).toMatchObject({ working: false, awaitingAsyncWork: true });
	});
	it("clears the wait when a continuation starts, including a missed start recovered by state", () => {
		endWaiting();
		feed({ t: "event", event: { type: "agent_start" } });
		expect(client.getSnapshot()).toMatchObject({ working: true, awaitingAsyncWork: false });
		endWaiting();
		feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		expect(client.getSnapshot()).toMatchObject({ working: true, awaitingAsyncWork: false });
	});
	it("clears a terminal settle and never carries a previous room's wait through welcome", () => {
		endWaiting();
		feed({ t: "event", event: { type: "agent_end" } });
		expect(client.getSnapshot().awaitingAsyncWork).toBe(false);
		endWaiting();
		feed(welcome);
		expect(client.getSnapshot().awaitingAsyncWork).toBe(false);
	});
	it("sends abort and dismisses the waiting row, without sending job cancellation commands", () => {
		endWaiting();
		client.sendAbort();
		expect(socket.sent).toEqual([{ t: "abort" }]);
		expect(client.getSnapshot().awaitingAsyncWork).toBe(false);
	});
});

describe("restored tool calls", () => {
	const assistant = { type: "message", id: "assistant", parentId: null, timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "restored-call", name: "bash", arguments: { command: "make" }, intent: "Finishing the interrupted build" }], timestamp: 1 } };
	it("seeds only the calls omp says it resumes and settles their results normally", () => {
		feed({ t: "entry", entry: assistant });
		feed({ t: "event", event: { type: "agent_start", resumedToolCallIds: ["restored-call", "unknown"] } });
		expect(client.getSnapshot().activeTools.get("restored-call")).toMatchObject({ toolName: "bash", args: { command: "make" }, intent: "Finishing the interrupted build" });
		expect(client.getSnapshot().activeTools.has("unknown")).toBe(false);
		feed({ t: "event", event: { type: "tool_execution_end", toolCallId: "restored-call", toolName: "bash", result: {} } });
		expect(client.getSnapshot().activeTools.size).toBe(0);
	});
	it("seeds a resume event that arrives before its snapshot finishes downloading", () => {
		feed({ ...welcome, entryCount: 1 });
		feed({ t: "event", event: { type: "agent_start", resumedToolCallIds: ["restored-call"] } });
		feed({ t: "snapshot-chunk", entries: [assistant], final: true });
		expect(client.getSnapshot().activeTools.has("restored-call")).toBe(true);
	});
});

describe("pending question authority", () => {
	it("retains a locally answered request until omp ends it", () => {
		const request = { reqId: 1, kind: "editor", title: "Answer", prefill: "draft" };
		feed({ t: "ui-request", request });
		client.sendUiResponse(1, "done");
		expect(client.getSnapshot().uiRequest).toBeNull();
		expect(client.getSnapshot().pendingUiRequests).toEqual([request]);
		feed({ t: "ui-request-end", reqId: 1 });
		expect(client.getSnapshot().pendingUiRequests).toEqual([]);
	});
	it("ends a remote answer and queued cancellation without losing other requests", () => {
		feed({ t: "ui-request", request: { reqId: 1, kind: "editor", title: "First" } });
		feed({ t: "ui-request", request: { reqId: 2, kind: "editor", title: "Next" } });
		feed({ t: "ui-request-end", reqId: 2 });
		expect(client.getSnapshot().pendingUiRequests?.map(request => request.reqId)).toEqual([1]);
		feed({ t: "ui-request-end", reqId: 1 });
		expect(client.getSnapshot().uiRequest).toBeNull();
		expect(client.getSnapshot().pendingUiRequests).toEqual([]);
	});
	it("clears visible requests and matching authority on a fresh welcome", () => {
		feed({ t: "ui-request", request: { reqId: 1, kind: "editor", title: "First" } });
		const connection = client.getSnapshot().uiConnection!;
		feed(welcome);
		expect(client.getSnapshot().pendingUiRequests).toEqual([]);
		expect(client.getSnapshot().uiConnection).toBeGreaterThan(connection);
		expect(client.getSnapshot().uiRequest).toBeNull();
	});
	it("invalidates matching authority on disconnect while retaining the visible request and queue until welcome", () => {
		const first = { reqId: 1, kind: "editor", title: "First" };
		const next = { reqId: 2, kind: "editor", title: "Next" };
		feed({ t: "ui-request", request: first });
		feed({ t: "ui-request", request: next });
		const connection = client.getSnapshot().uiConnection!;
		socket.current?.onClose("connection lost", true);
		expect(client.getSnapshot().phase).toBe("reconnecting");
		expect(client.getSnapshot().uiRequest).toEqual(first);
		expect(client.getSnapshot().pendingUiRequests).toEqual([]);
		expect(client.getSnapshot().uiConnection).toBeGreaterThan(connection);
		// The queue retains its original behavior during reconnect.
		feed({ t: "ui-request-end", reqId: 1 });
		expect(client.getSnapshot().uiRequest).toEqual(next);
		feed(welcome);
		expect(client.getSnapshot().uiRequest).toBeNull();
		feed({ t: "ui-request", request: { reqId: 3, kind: "editor", title: "New room" } });
		feed({ t: "ui-request-end", reqId: 3 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});
});
