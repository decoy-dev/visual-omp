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
