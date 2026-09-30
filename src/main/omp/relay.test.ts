import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { LoopbackRelay } from "./relay";

const ROOM = "room_ABCDEFGHIJ";

function open(relay: LoopbackRelay, role: "host" | "guest", room = ROOM): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${room}?role=${role}`);
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	ws.once("open", () => resolve(ws));
	ws.once("error", reject);
	return promise;
}

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; binary: boolean }> {
	const { promise, resolve } = Promise.withResolvers<{ data: Buffer; binary: boolean }>();
	ws.once("message", (data, binary) => resolve({ data: Buffer.from(data as Buffer), binary }));
	return promise;
}

function closed(ws: WebSocket): Promise<number> {
	const { promise, resolve } = Promise.withResolvers<number>();
	ws.once("close", code => resolve(code));
	return promise;
}

function frame(peerId: number, payload: string): Buffer {
	const buffer = Buffer.alloc(4 + payload.length);
	buffer.writeUInt32BE(peerId, 0);
	buffer.write(payload, 4);
	return buffer;
}

describe("LoopbackRelay", () => {
	let relay: LoopbackRelay;
	afterEach(() => relay.stop());

	it("announces guests to the host and rewrites guest envelopes to their peer id", async () => {
		relay = new LoopbackRelay();
		await relay.start();
		const opened: string[] = [];
		relay.events = { onHostOpen: room => opened.push(room) };
		const host = await open(relay, "host");
		const joined = nextMessage(host);
		const guest = await open(relay, "guest");
		expect(JSON.parse((await joined).data.toString())).toEqual({ t: "peer-joined", peer: 1 });
		expect(opened).toEqual([ROOM]);

		const fromGuest = nextMessage(host);
		guest.send(frame(999, "hello"));
		const received = await fromGuest;
		expect(received.binary).toBe(true);
		expect(received.data.readUInt32BE(0)).toBe(1);
		expect(received.data.subarray(4).toString()).toBe("hello");
		host.close();
		guest.close();
	});

	it("broadcasts peer 0 frames to every guest and targets peer N frames to one guest", async () => {
		relay = new LoopbackRelay();
		await relay.start();
		const host = await open(relay, "host");
		const first = await open(relay, "guest");
		const second = await open(relay, "guest");

		const both = Promise.all([nextMessage(first), nextMessage(second)]);
		host.send(frame(0, "all"));
		for (const message of await both) expect(message.data.subarray(4).toString()).toBe("all");

		let firstGotTargeted = false;
		first.once("message", () => {
			firstGotTargeted = true;
		});
		const targeted = nextMessage(second);
		host.send(frame(2, "only-second"));
		expect((await targeted).data.subarray(4).toString()).toBe("only-second");
		expect(firstGotTargeted).toBe(false);
		host.close();
	});

	it("rejects a second host and closes guests when the host leaves", async () => {
		relay = new LoopbackRelay();
		await relay.start();
		const closedRooms: string[] = [];
		relay.events = { onHostClose: room => closedRooms.push(room) };
		const host = await open(relay, "host");
		const duplicate = await open(relay, "host");
		expect(await closed(duplicate)).toBe(4009);

		const guest = await open(relay, "guest");
		const notice = nextMessage(guest);
		const guestClosed = closed(guest);
		host.close();
		expect(JSON.parse((await notice).data.toString())).toEqual({ t: "room-closed" });
		expect(await guestClosed).toBe(4001);
		await expect.poll(() => closedRooms).toEqual([ROOM]);
	});

	it("refuses guests for rooms that have no host", async () => {
		relay = new LoopbackRelay();
		await relay.start();
		const guest = await open(relay, "guest", "missing_room_1234");
		expect(await closed(guest)).toBe(4004);
	});
});
