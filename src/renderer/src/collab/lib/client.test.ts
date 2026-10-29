import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostFrame } from "@oh-my-pi/pi-wire";
import { GuestClient } from "./client";

/** The socket the client creates; frames from omp's host are fed through `onFrame`. */
const socket = vi.hoisted(() => ({ current: null as null | { onFrame: (frame: unknown) => void } }));
vi.mock("./socket", () => ({
	CollabSocket: class {
		onOpen = () => undefined;
		onFrame: (frame: unknown) => void = () => undefined;
		onClose = () => undefined;
		constructor() {
			socket.current = this;
		}
		connect() {}
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
