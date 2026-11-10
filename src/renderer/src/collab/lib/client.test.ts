import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostFrame } from "@oh-my-pi/pi-wire";
import { GuestClient } from "./client";
import { thinkingState } from "../../features/session-tools/thinking";
import { workInFlight } from "../../state/chatWork";
import type { SessionView } from "../../state/session";

/** The socket the client creates; frames from omp's host are fed through `onFrame`. */
const socket = vi.hoisted(() => ({ current: null as null | { onOpen: () => void; onFrame: (frame: unknown) => void; onClose: (reason: string, reconnect: boolean) => void }, sent: [] as unknown[] }));
vi.mock("./socket", () => ({
	CollabSocket: class {
		onOpen = () => undefined;
		onFrame: (frame: unknown) => void = () => undefined;
		onClose = () => undefined;
		constructor() {
			socket.current = this;
		}
		connect() {}
		close() {}
		send(frame: unknown) { socket.sent.push(frame); }
		sendConnected(frame: unknown, beforeSend: () => void, dispatched?: () => void) { beforeSend(); socket.sent.push(frame); dispatched?.(); return Promise.resolve(); }
	},
}));
vi.mock("./link", () => ({
	COLLAB_PROTO: 1,
	encodeBase64Url: () => "token",
	parseCollabLink: () => ({ wsUrl: "ws://localhost/r/room", key: new Uint8Array(32) }),
}));
vi.mock("./codec", () => ({ importRoomKey: () => ({}) }));

const welcome = { t: "welcome", header: null, entryCount: 0, state: { isStreaming: false, participants: [] }, agents: [] };
const thinking = (configured?: string, thinkingLevel = "high") => ({ t: "event", event: { type: "thinking_level_changed", thinkingLevel, configured } });

let client: GuestClient;
const feed = (frame: object) => socket.current?.onFrame(frame as HostFrame);

beforeEach(() => {
	socket.sent = [];
	client = new GuestClient("link", "visual-omp");
	feed(welcome);
});

afterEach(() => {
	client.close();
	vi.useRealTimers();
});

describe("confirmed foreground completion", () => {
	const start = () => feed({ t: "event", event: { type: "agent_start" } });
	const idle = () => feed({ t: "state", state: welcome.state });
	const end = (fields: object = {}) => feed({ t: "event", event: { type: "agent_end", ...fields } });
	const call = { toolCallId: "wait-1", toolName: "wait", args: { i: "Awaiting background results" } };
	const tool = (type: string) => feed({ t: "event", event: { type, ...call, result: {}, partialResult: {} } });

	it.each([{ isTerminal: false }, { willContinue: true }])("retains a continuation through idle state frames: %o", async fields => {
		vi.useFakeTimers();
		start();
		end(fields);
		idle();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(client.getSnapshot().working).toBe(true);
		start();
		end({ isTerminal: true });
		await vi.advanceTimersByTimeAsync(1_499);
		expect(client.getSnapshot().working).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.getSnapshot().working).toBe(false);
	});

	it("does not finish a long wait when a helper and its async result arrive", async () => {
		vi.useFakeTimers();
		let finished = 0;
		let working = false;
		client.subscribe(() => {
			const next = client.getSnapshot().working || client.getSnapshot().awaitingAsyncWork === true;
			if (working && !next) finished++;
			working = next;
		});
		start();
		tool("tool_execution_start");
		feed({ t: "agents", agents: [{ id: "AstraFreeze", kind: "sub", status: "idle" }] });
		feed({ t: "entry", entry: { type: "custom_message", id: "delivery", parentId: null, timestamp: "", customType: "async-result", content: "AstraFreeze completed", display: true } });
		idle();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(finished).toBe(0);
		expect(client.getSnapshot().activeTools.has(call.toolCallId)).toBe(true);
		tool("tool_execution_end");
		await vi.advanceTimersByTimeAsync(800);
		start();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(finished).toBe(0);
		end({ isTerminal: true });
		await vi.advanceTimersByTimeAsync(1_500);
		expect(finished).toBe(1);
		idle();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(finished).toBe(1);
	});

	it.each(["agent_start", "state", "tool_execution_start", "message_update"])("cancels an idle candidate on %s", async activity => {
		vi.useFakeTimers();
		start();
		end();
		await vi.advanceTimersByTimeAsync(1_000);
		if (activity === "state") feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		else if (activity === "message_update") feed({ t: "event", event: { type: activity, message: { role: "assistant", content: [] } } });
		else if (activity === "tool_execution_start") tool(activity);
		else start();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().working).toBe(true);
	});

	it("keeps the request working until a full idle interval follows a terminal end", async () => {
		vi.useFakeTimers();
		start();
		end({ isTerminal: true, yielded: true });
		await vi.advanceTimersByTimeAsync(1_499);
		expect(client.getSnapshot().working).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.getSnapshot().working).toBe(false);
	});

	it("does not reuse the welcome's idle sample after a tool finishes", async () => {
		vi.useFakeTimers();
		start();
		tool("tool_execution_start");
		tool("tool_execution_end");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(client.getSnapshot().working).toBe(true);
	});

	it.each([500, 2_000].flatMap(downloadMs => ["state", "sdk"].map(confirmation => ({ downloadMs, confirmation }))))("requires fresh $confirmation confirmation after a $downloadMs ms reconnect snapshot", async ({ downloadMs, confirmation }) => {
		vi.useFakeTimers();
		start();
		socket.current!.onClose("reconnecting", true);
		feed({ ...welcome, entryCount: 1 });
		idle();
		await vi.advanceTimersByTimeAsync(downloadMs);
		expect(client.getSnapshot().working).toBe(true);
		expect(client.getSnapshot().idleCheckRevision).toBeUndefined();
		feed({ t: "snapshot-chunk", entries: [], final: true });
		await vi.advanceTimersByTimeAsync(1_499);
		expect(client.getSnapshot().working).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(client.getSnapshot().working).toBe(true);
		const revision = client.getSnapshot().idleCheckRevision!;
		expect(revision).toBeTypeOf("number");
		if (confirmation === "state") idle();
		else client.settleIdle(revision);
		expect(client.getSnapshot().working).toBe(false);
	});

	it("confirms a state-only idle once, without extending it for repeated idle frames", async () => {
		vi.useFakeTimers();
		start();
		idle();
		await vi.advanceTimersByTimeAsync(1_000);
		idle();
		await vi.advanceTimersByTimeAsync(500);
		expect(client.getSnapshot().working).toBe(true);
		expect(client.getSnapshot().idleCheckRevision).toBeTypeOf("number");
		idle();
		expect(client.getSnapshot().working).toBe(false);
	});

	it("does not treat silence as confirmation before corrective streaming arrives at two seconds", async () => {
		vi.useFakeTimers();
		start();
		idle();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().working).toBe(true);
		expect(client.getSnapshot().idleCheckRevision).toBeTypeOf("number");
		feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().working).toBe(true);
		expect(client.getSnapshot().idleCheckRevision).toBeUndefined();
	});

	it("accepts only a fresh SDK confirmation for the matching idle interval", async () => {
		vi.useFakeTimers();
		start();
		idle();
		await vi.advanceTimersByTimeAsync(1_500);
		const previous = client.getSnapshot().idleCheckRevision!;
		start();
		idle();
		await vi.advanceTimersByTimeAsync(1_500);
		client.settleIdle(previous);
		expect(client.getSnapshot().working).toBe(true);
		client.settleIdle(client.getSnapshot().idleCheckRevision!);
		expect(client.getSnapshot().working).toBe(false);
	});

	it("recovers a missed continuation start and missing terminal end through host states", async () => {
		vi.useFakeTimers();
		start();
		end({ isTerminal: false });
		feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		idle();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().working).toBe(true);
		idle();
		expect(client.getSnapshot().working).toBe(false);
	});

	it("retains working on Stop until a fresh idle confirmation arrives", async () => {
		vi.useFakeTimers();
		start();
		end({ isTerminal: false });
		idle();
		client.sendAbort();
		expect(client.getSnapshot().working).toBe(true);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(client.getSnapshot().working).toBe(true);
		client.settleIdle(client.getSnapshot().idleCheckRevision!);
		expect(client.getSnapshot().working).toBe(false);
	});

	it("settles an error termination through a terminal end without retaining the continuation latch", async () => {
		vi.useFakeTimers();
		start();
		end({ isTerminal: false });
		feed({ t: "event", event: { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Provider failed" } } });
		end({ isTerminal: true });
		await vi.advanceTimersByTimeAsync(1_500);
		expect(client.getSnapshot().working).toBe(false);
	});

	it("retains only packed completion flags and the latest streaming observation time", async () => {
		vi.useFakeTimers();
		start();
		feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		feed({ t: "agents", agents: [{ id: "Main", kind: "main", status: "running" }, { id: "One", kind: "sub", status: "running" }, { id: "Two", kind: "sub", status: "idle" }] });
		end({ isTerminal: true, willContinue: false, awaitingAsyncWork: false, messages: [{ content: "PRIVATE CHAT TEXT" }] });
		idle();
		await vi.advanceTimersByTimeAsync(1_500);
		expect(client.getSnapshot().completion).toEqual([expect.any(Number), 176, 0]);
		expect(client.getSnapshot().lastStreamingAt).toBe(Date.now() - 1_500);
		expect(JSON.stringify(client.getSnapshot().completion)).not.toContain("PRIVATE");
	});

	it("records a cancelled state-only idle candidate once", async () => {
		vi.useFakeTimers();
		start();
		idle();
		await vi.advanceTimersByTimeAsync(2_000);
		feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		const evidence = client.getSnapshot().completion;
		expect(evidence).toEqual([expect.any(Number), 513, 2]);
		feed({ t: "state", state: { ...welcome.state, isStreaming: true } });
		expect(client.getSnapshot().completion).toBe(evidence);
	});

	it("reconciles a missed tool end only on a terminal end", async () => {
		vi.useFakeTimers();
		start();
		tool("tool_execution_start");
		idle();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().activeTools.size).toBe(1);
		end({ isTerminal: true });
		expect(client.getSnapshot().activeTools.size).toBe(0);
		await vi.advanceTimersByTimeAsync(1_500);
		expect(client.getSnapshot().working).toBe(false);
		tool("tool_execution_update");
		expect(client.getSnapshot().working).toBe(false);
		expect(client.getSnapshot().backgroundTools.size).toBe(1);
	});

	it("does not publish a pending completion after disconnect or close", async () => {
		vi.useFakeTimers();
		start();
		end();
		socket.current!.onClose("reconnecting", true);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().working).toBe(true);
		feed(welcome);
		await vi.advanceTimersByTimeAsync(1_499);
		expect(client.getSnapshot().working).toBe(true);
		client.close();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(client.getSnapshot().working).toBe(true);
	});
});

describe("user prompts while a question waits", () => {
	it("sends the collab prompt and images without answering or locally dismissing the question", () => {
		const request = { reqId: 7, kind: "select", title: "Which database?", options: ["SQLite"] };
		feed({ t: "ui-request", request });
		const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
		client.sendPrompt("Use Postgres.", images);
		expect(socket.sent).toEqual([{ t: "prompt", text: "Use Postgres.", images }]);
		expect(client.getSnapshot().uiRequest).toEqual(request);
		feed({ t: "ui-request-end", reqId: 7 });
		expect(client.getSnapshot().uiRequest).toBeNull();
	});
	it("refuses disconnected and read-only prompts instead of buffering them into a later question", () => {
		socket.current!.onClose("reconnecting", true);
		expect(() => client.sendPrompt("Keep this draft.")).toThrow("not ready");
		expect(socket.sent).toEqual([]);
		feed({ ...welcome, readOnly: true });
		expect(() => client.sendPrompt("Keep this draft.")).toThrow("not ready");
		expect(socket.sent).toEqual([]);
	});
});

describe("helper Stop commands", () => {
	it("rejects a terminally closed guest instead of silently dropping Stop", async () => {
		socket.current!.onClose("closed", false);
		await expect(client.sendAgentCmd("kill", "Atlas")).rejects.toThrow("Restart omp");
		expect(socket.sent).toEqual([]);
	});
	it("does not buffer Stop across a transient reconnect, and allows a fresh attempt once live", async () => {
		socket.current!.onClose("reconnecting", true);
		await expect(client.sendAgentCmd("kill", "Atlas")).rejects.toThrow("not ready");
		expect(socket.sent).toEqual([]);
		feed(welcome);
		await client.sendAgentCmd("kill", "Atlas");
		expect(socket.sent).toEqual([{ t: "agent-cmd", cmd: "kill", agentId: "Atlas", text: undefined }]);
	});
});

describe("queued helper prompts", () => {
	it("sends through the connected path only after its final idle check", async () => {
		const check = vi.fn();
		await client.sendHelperPrompt("Atlas", "Follow up.", check);
		expect(check).toHaveBeenCalledOnce();
		expect(socket.sent).toEqual([{ t: "agent-cmd", cmd: "chat", agentId: "Atlas", text: "Follow up." }]);
	});
	it("preserves the message when the helper becomes busy or the connection becomes read-only", () => {
		expect(() => client.sendHelperPrompt("Atlas", "Wait.", () => { throw new Error("Helper is busy"); })).toThrow("Helper is busy");
		expect(socket.sent).toEqual([]);
		feed({ ...welcome, readOnly: true });
		expect(() => client.sendHelperPrompt("Atlas", "Wait.", () => {})).toThrow("not ready");
		expect(socket.sent).toEqual([]);
	});
});

describe("thinkingSelector", () => {
	it("keeps the complete configured selector from omp's latest thinking event", () => {
		expect(client.getSnapshot().thinkingSelector).toBeNull();
		feed(thinking("auto", "low"));
		expect(client.getSnapshot().thinkingSelector).toBe("auto");
		expect(client.getSnapshot().thinkingEvent).toMatchObject({ configured: "auto", thinkingLevel: "low" });
		feed({ t: "event", event: { type: "thinking_level_changed", configured: "auto", thinkingLevel: "low", resolved: "low" } });
		expect(client.getSnapshot().thinkingEvent?.resolved).toBe("low");
		feed(thinking(undefined, "low"));
		expect(client.getSnapshot().thinkingSelector).toBe("low");
		feed(thinking("medium", "high"));
		expect(client.getSnapshot().thinkingSelector).toBe("medium");
		feed(thinking(undefined, "off"));
		expect(client.getSnapshot().thinkingSelector).toBe("off");
	});

	it("invalidates resolved High when changing models reapplies Auto at provisional High without a thinking event", () => {
		feed({ t: "state", state: { ...welcome.state, model: { provider: "fixture", id: "first" }, thinkingLevel: "high" } });
		feed({ t: "event", event: { type: "thinking_level_changed", configured: "auto", thinkingLevel: "high", resolved: "high" } });
		let guest = client.getSnapshot();
		expect(thinkingState(guest.thinkingSelector, [], "high", guest.thinkingEvent).resolved).toBe("high");
		// omp clears autoResolvedThinkingLevel, but its concrete default remains High.
		feed({ t: "state", state: { ...welcome.state, model: { provider: "fixture", id: "second" }, thinkingLevel: "high" } });
		guest = client.getSnapshot();
		expect(guest.thinkingSelector).toBe("auto");
		expect(guest.thinkingEvent).toBeNull();
		expect(thinkingState(guest.thinkingSelector, [], "auto", guest.thinkingEvent)).toEqual({ configured: "auto", resolved: null, provisional: true });
		// A new classifier event may still arrive before the semantic/painted display.
		feed({ t: "event", event: { type: "thinking_level_changed", configured: "auto", thinkingLevel: "high", resolved: "high" } });
		guest = client.getSnapshot();
		expect(thinkingState(guest.thinkingSelector, [], "auto", guest.thinkingEvent)).toEqual({ configured: "auto", resolved: "high", provisional: false });
	});

	it("retains the current classifier result through same-model state updates", () => {
		const state = { ...welcome.state, model: { provider: "fixture", id: "same" }, thinkingLevel: "high" };
		feed({ t: "state", state });
		feed({ t: "event", event: { type: "thinking_level_changed", configured: "auto", thinkingLevel: "high", resolved: "high" } });
		feed({ t: "state", state: { ...state, model: { ...state.model, name: "Updated name" } } });
		expect(client.getSnapshot().thinkingEvent?.resolved).toBe("high");
	});

	it("forgets what it saw before a reconnect, for Auto and concrete selectors", () => {
		feed(thinking("auto"));
		feed(welcome);
		expect(client.getSnapshot().thinkingSelector).toBeNull();
		feed(thinking());
		feed(welcome);
		expect(client.getSnapshot().thinkingSelector).toBeNull();
		expect(client.getSnapshot().thinkingEvent).toBeNull();
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
	it("settles only the wait checked by the fresh SDK result and sends no abort", () => {
		endWaiting();
		const first = client.getSnapshot().asyncWaitRevision!;
		feed({ t: "event", event: { type: "agent_start" } });
		endWaiting();
		client.settleAsyncWait(first);
		expect(client.getSnapshot().awaitingAsyncWork).toBe(true);
		client.settleAsyncWait(client.getSnapshot().asyncWaitRevision!);
		expect(client.getSnapshot()).toMatchObject({ working: false, awaitingAsyncWork: false });
		expect(socket.sent).toEqual([]);
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

describe("18.18.7 guest backlog resync", () => {
	const resync = { t: "error", message: "the host discarded your backlog; rejoin to resync", resync: true };
	const entry = { type: "custom_message", id: "kept", parentId: null, timestamp: "", customType: "test", content: "Retained transcript", display: true };
	const hellos = () => socket.sent.filter(frame => typeof frame === "object" && frame !== null && "t" in frame && frame.t === "hello").length;

	it("rejoins on the existing socket, retains the transcript and revokes old question answers", async () => {
		feed({ t: "entry", entry });
		const entries = client.getSnapshot().entries;
		feed({ t: "ui-request", request: { reqId: 7, kind: "editor", title: "Answer" } });
		const connection = client.getSnapshot().uiConnection!;
		const transcript = client.fetchTranscript("helper", 0);
		feed(resync);
		expect(client.getSnapshot()).toMatchObject({ phase: "reconnecting", uiRequest: null, pendingUiRequests: [], endedReason: null, notices: [] });
		expect(client.getSnapshot().entries).toBe(entries);
		expect(client.getSnapshot().uiConnection).toBeGreaterThan(connection);
		expect(hellos()).toBe(1);
		await expect(transcript).resolves.toBeNull();
		client.sendUiResponse(7, "stale");
		expect(socket.sent).not.toContainEqual({ t: "ui-response", reqId: 7, value: "stale" });
		feed(resync);
		expect(hellos()).toBe(1);
		feed({ ...welcome, entryCount: 1 });
		expect(client.getSnapshot().entries).toBe(entries);
		feed({ t: "snapshot-chunk", entries: [entry], final: true });
		feed({ t: "ui-request", request: { reqId: 8, kind: "editor", title: "Current answer" } });
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().entries).toEqual([entry]);
		client.sendUiResponse(8, "current");
		expect(socket.sent).toContainEqual({ t: "ui-response", reqId: 8, value: "current" });
	});

	it("stops after three automatic rejoins within five minutes", () => {
		for (let i = 1; i <= 3; i++) {
			feed(resync);
			expect(hellos()).toBe(i);
			feed(welcome);
		}
		feed(resync);
		expect(hellos()).toBe(3);
		expect(client.getSnapshot()).toMatchObject({ phase: "ended", endedReason: resync.message, uiRequest: null });
	});

	it("renews the rejoin budget after five minutes", async () => {
		vi.useFakeTimers();
		for (let i = 0; i < 3; i++) { feed(resync); feed(welcome); }
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		feed(resync);
		expect(hellos()).toBe(4);
		expect(client.getSnapshot().phase).toBe("reconnecting");
	});

	it("retries a refused rejoin welcome without flooding hello", async () => {
		vi.useFakeTimers();
		feed(resync);
		feed(resync);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(hellos()).toBe(2);
		expect(client.getSnapshot().phase).toBe("reconnecting");
		feed(welcome);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(hellos()).toBe(2);
	});

	it("retries a stalled reconnect snapshot and discards its partial entries", async () => {
		vi.useFakeTimers();
		feed({ t: "entry", entry });
		feed(resync);
		feed({ ...welcome, entryCount: 3 });
		feed({ t: "snapshot-chunk", entries: [entry], final: false });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(hellos()).toBe(2);
		expect(client.getSnapshot().entries).toEqual([entry]);
		expect(client.getSnapshot().loading).toBeNull();
	});

	it("bounds a missing welcome after an older host reconnect without requiring resync support", async () => {
		vi.useFakeTimers();
		socket.current!.onClose("connection lost", true);
		socket.current!.onOpen();
		expect(hellos()).toBe(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(hellos()).toBe(2);
		feed(welcome);
		expect(client.getSnapshot().phase).toBe("live");
	});

	it("keeps older host errors as notices without sending hello", () => {
		feed({ t: "error", message: "The command was refused." });
		expect(hellos()).toBe(0);
		expect(client.getSnapshot().phase).toBe("live");
		expect(client.getSnapshot().notices.at(-1)).toMatchObject({ level: "error", message: "The command was refused." });
	});

	it("dismisses an unavailable question through the unchanged ui-request-end grammar", () => {
		feed({ t: "ui-request", request: { reqId: 7, kind: "editor", title: "No recipient can answer" } });
		feed({ t: "ui-request-end", reqId: 7 });
		client.sendUiResponse(7, "late");
		expect(client.getSnapshot()).toMatchObject({ uiRequest: null, pendingUiRequests: [] });
		expect(socket.sent).toEqual([]);
	});

	it("joins a snapshot larger than the host send budget without publishing partial transcripts", () => {
		const text = "x".repeat(512 * 1024);
		feed({ ...welcome, entryCount: 40 });
		for (let index = 0; index < 40; index++) {
			feed({ t: "snapshot-chunk", entries: [{ ...entry, id: `large-${index}`, content: text }], final: index === 39 });
			if (index < 39) expect(client.getSnapshot().entries).toEqual([]);
		}
		expect(client.getSnapshot().entries).toHaveLength(40);
		expect(client.getSnapshot().loading).toBeNull();
		expect(client.getSnapshot().phase).toBe("live");
	});
});

describe("paced publishing", () => {
	const progress = (id: string, toolCount: number, status = "running") => ({ t: "bus", channel: "task:subagent:progress", data: { index: 0, agent: "task", task: "Build", progress: { id, status, toolCount } } });
	const text = (value: string) => ({ t: "event", event: { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: value }] } } });
	let published = 0;
	beforeEach(() => {
		vi.useFakeTimers();
		published = 0;
		client.subscribe(() => published++);
	});

	it("off screen, publishes helper progress about once a second with only the newest report per helper", async () => {
		feed(progress("A", 0));
		feed(progress("B", 0));
		published = 0;
		for (let count = 1; count <= 20; count++) feed(progress("A", count));
		feed(progress("B", 1));
		expect(published).toBe(0);
		expect(client.getSnapshot().progress.get("A")?.progress).toMatchObject({ toolCount: 0 });
		await vi.advanceTimersByTimeAsync(999);
		expect(published).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(published).toBe(1);
		expect(client.getSnapshot().progress.get("A")?.progress).toMatchObject({ toolCount: 20 });
		expect(client.getSnapshot().progress.get("B")?.progress).toMatchObject({ toolCount: 1 });
	});

	it("publishes a helper's first report and status changes at once, so close and quit guards see it running", () => {
		feed(progress("A", 0));
		expect(published).toBe(1);
		const view = { mode: "live", readOnly: false, follow: null, working: false, guest: client.getSnapshot() } as unknown as SessionView;
		expect(workInFlight(view)).toEqual({ replying: false, helpers: 1 });
		feed(progress("A", 1));
		expect(published).toBe(1);
		feed(progress("A", 2, "completed"));
		expect(published).toBe(2);
		expect(client.getSnapshot().progress.get("A")?.progress).toMatchObject({ status: "completed", toolCount: 2 });
	});

	it("publishes a question at once, together with every update received before it", () => {
		feed(progress("A", 0));
		published = 0;
		feed(progress("A", 3));
		feed({ t: "ui-request", request: { reqId: 4, kind: "select", title: "Which database?", options: ["SQLite"] } });
		expect(published).toBe(1);
		expect(client.getSnapshot().uiRequest?.reqId).toBe(4);
		expect(client.getSnapshot().progress.get("A")?.progress).toMatchObject({ toolCount: 3 });
	});

	it("publishes a turn start from streamed text at once, then paces the rest of the stream", async () => {
		feed(text("H"));
		expect(published).toBe(1);
		expect(client.getSnapshot().working).toBe(true);
		for (const value of ["He", "Hel", "Hell", "Hello"]) feed(text(value));
		expect(published).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(published).toBe(2);
		expect(client.getSnapshot().stream?.content).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("on screen, publishes within a frame, and a chat moved on screen publishes what was waiting at once", async () => {
		feed(progress("A", 0));
		published = 0;
		feed(progress("A", 1));
		expect(published).toBe(0);
		client.setForeground(true);
		expect(published).toBe(1);
		feed(progress("A", 2));
		expect(published).toBe(1);
		await vi.advanceTimersByTimeAsync(250);
		expect(published).toBe(2);
		expect(client.getSnapshot().progress.get("A")?.progress).toMatchObject({ toolCount: 2 });
	});

	it("publishes once per display frame, without a second publish from the fallback timer", async () => {
		const frames: (() => void)[] = [];
		vi.stubGlobal("requestAnimationFrame", (callback: () => void) => frames.push(callback));
		vi.stubGlobal("cancelAnimationFrame", () => undefined);
		try {
			feed(progress("A", 0));
			published = 0;
			client.setForeground(true);
			feed(progress("A", 1));
			expect(published).toBe(0);
			frames.shift()?.();
			expect(published).toBe(1);
			await vi.advanceTimersByTimeAsync(250);
			expect(published).toBe(1);
			feed(progress("A", 2));
			await vi.advanceTimersByTimeAsync(250);
			expect(published).toBe(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("publishes a helper starting or finishing at once, but not its activity", () => {
		const agent = (status: string, lastActivity: number) => ({ id: "Builder", displayName: "Builder", kind: "sub", status, hasSessionFile: true, createdAt: 0, lastActivity });
		feed({ t: "agents", agents: [agent("running", 1)] });
		expect(published).toBe(1);
		feed({ t: "agents", agents: [agent("running", 2)] });
		expect(published).toBe(1);
		feed({ t: "agents", agents: [agent("idle", 3)] });
		expect(published).toBe(2);
		expect(client.getSnapshot().agents[0]?.lastActivity).toBe(3);
	});
});
