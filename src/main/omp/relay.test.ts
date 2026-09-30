import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { type BridgeRoom, LoopbackRelay, RoomBridge } from "./relay";

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

function text(message: { data: Buffer }): unknown {
	return JSON.parse(message.data.toString());
}

/** Collects every message a socket receives, in order, so tests can await the next one of a kind. */
function inbox(ws: WebSocket) {
	const queue: { data: Buffer; binary: boolean }[] = [];
	const waiters: (() => void)[] = [];
	ws.on("message", (data, binary) => {
		queue.push({ data: Buffer.from(data as Buffer), binary });
		for (const wake of waiters.splice(0)) wake();
	});
	return {
		async next(): Promise<{ data: Buffer; binary: boolean }> {
			while (queue.length === 0) {
				const { promise, resolve } = Promise.withResolvers<void>();
				waiters.push(resolve);
				await promise;
			}
			return queue.shift() as { data: Buffer; binary: boolean };
		},
		get pending(): number {
			return queue.length;
		},
	};
}

function liveBridge(bridge: RoomBridge): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (bridge.phase === "live") resolve();
	const off = bridge.onStatus(status => {
		if (status.phase !== "live") return;
		off();
		resolve();
	});
	return promise;
}

describe("RoomBridge through a public relay", () => {
	let local: LoopbackRelay;
	let upstream: LoopbackRelay;
	afterEach(() => {
		local.stop();
		upstream.stop();
	});

	async function publishedRoom() {
		local = new LoopbackRelay();
		upstream = new LoopbackRelay();
		await Promise.all([local.start(), upstream.start()]);
		const host = await open(local, "host");
		const hostInbox = inbox(host);
		const localGuest = await open(local, "guest");
		expect(text(await hostInbox.next())).toEqual({ t: "peer-joined", peer: 1 });
		const bridge = local.publish(ROOM, `ws://127.0.0.1:${upstream.port}`);
		await liveBridge(bridge);
		return { host, hostInbox, localGuest, bridge };
	}

	it("gives remote guests local peer ids that never collide with local guests", async () => {
		const { host, hostInbox, localGuest, bridge } = await publishedRoom();
		// The upstream relay numbers its own guests from 1 too; locally that guest becomes peer 2.
		const remote = await open(upstream, "guest");
		expect(text(await hostInbox.next())).toEqual({ t: "peer-joined", peer: 2 });
		expect(bridge.status.remoteGuests).toBe(1);

		remote.send(frame(0, "from-remote"));
		const received = await hostInbox.next();
		expect(received.binary).toBe(true);
		expect(received.data.readUInt32BE(0)).toBe(2);
		expect(received.data.subarray(4).toString()).toBe("from-remote");

		localGuest.send(frame(0, "from-local"));
		expect((await hostInbox.next()).data.readUInt32BE(0)).toBe(1);

		// Targeted host frames reach only their guest, re-addressed to the upstream id for remote guests.
		const remoteInbox = inbox(remote);
		const localInbox = inbox(localGuest);
		host.send(frame(2, "to-remote"));
		const toRemote = await remoteInbox.next();
		expect(toRemote.data.readUInt32BE(0)).toBe(1);
		expect(toRemote.data.subarray(4).toString()).toBe("to-remote");
		host.send(frame(1, "to-local"));
		expect((await localInbox.next()).data.subarray(4).toString()).toBe("to-local");
		expect(remoteInbox.pending).toBe(0);

		host.send(frame(0, "everyone"));
		const [a, b] = await Promise.all([remoteInbox.next(), localInbox.next()]);
		expect(a.data.subarray(4).toString()).toBe("everyone");
		expect(b.data.subarray(4).toString()).toBe("everyone");

		remote.close();
		expect(text(await hostInbox.next())).toEqual({ t: "peer-left", peer: 2 });
		await expect.poll(() => bridge.status.remoteGuests).toBe(0);
	});

	it("drops remote guests and closes the upstream room when sharing stops", async () => {
		const { hostInbox, bridge } = await publishedRoom();
		const remote = await open(upstream, "guest");
		expect(text(await hostInbox.next())).toEqual({ t: "peer-joined", peer: 2 });
		const remoteInbox = inbox(remote);
		const remoteClosed = closed(remote);

		local.unpublish(ROOM);
		expect(text(await hostInbox.next())).toEqual({ t: "peer-left", peer: 2 });
		expect(text(await remoteInbox.next())).toEqual({ t: "room-closed" });
		expect(await remoteClosed).toBe(4001);
		expect(bridge.status).toMatchObject({ phase: "stopped", reason: "stopped", remoteGuests: 0 });
		expect(local.bridgeFor(ROOM)).toBeNull();
		expect(upstream.hasRoom(ROOM)).toBe(false);
	});

	it("stops the bridge when the local room closes", async () => {
		const { host, bridge } = await publishedRoom();
		const remote = await open(upstream, "guest");
		const remoteClosed = closed(remote);
		host.close();
		expect(await remoteClosed).toBe(4001);
		await expect.poll(() => bridge.status.phase).toBe("stopped");
		expect(bridge.status.reason).toBe("room-closed");
	});
});

describe("RoomBridge control messages", () => {
	let server: WebSocketServer;
	afterEach(() => server.close());

	/** A scripted upstream relay: the test drives what the bridge's upstream socket receives. */
	async function scriptedUpstream() {
		server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
		const { promise: listening, resolve } = Promise.withResolvers<void>();
		server.once("listening", () => resolve());
		await listening;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("expected a TCP address");
		const sockets: WebSocket[] = [];
		const waiters: (() => void)[] = [];
		server.on("connection", (ws, req) => {
			expect(req.url).toBe(`/r/${ROOM}?role=host`);
			sockets.push(ws);
			for (const wake of waiters.splice(0)) wake();
		});
		return {
			origin: `ws://127.0.0.1:${address.port}`,
			async connection(index: number): Promise<WebSocket> {
				while (sockets.length <= index) {
					const { promise, resolve: wake } = Promise.withResolvers<void>();
					waiters.push(wake);
					await promise;
				}
				return sockets[index] as WebSocket;
			},
		};
	}

	function fakeRoom() {
		let next = 1;
		const toHost: unknown[] = [];
		const room: BridgeRoom = {
			allocatePeer: () => next++,
			sendToHost: data => toHost.push(typeof data === "string" ? JSON.parse(data) : { frameFor: data.readUInt32BE(0) }),
		};
		return { room, toHost };
	}

	it("ignores malformed and unknown control messages and frames from unknown peers", async () => {
		const upstream = await scriptedUpstream();
		const { room, toHost } = fakeRoom();
		const bridge = new RoomBridge(ROOM, upstream.origin, room);
		bridge.start();
		const ws = await upstream.connection(0);
		await liveBridge(bridge);
		ws.send("not json");
		ws.send(JSON.stringify({ t: "room-closed" }));
		ws.send(JSON.stringify({ t: "peer-joined", peer: "7" }));
		ws.send(frame(9, "who"));
		ws.send(JSON.stringify({ t: "peer-joined", peer: 5 }));
		await expect.poll(() => toHost).toEqual([{ t: "peer-joined", peer: 1 }]);
		bridge.stop("stopped");
	});

	it("retires a reissued upstream id before mapping it again", async () => {
		const upstream = await scriptedUpstream();
		const { room, toHost } = fakeRoom();
		const bridge = new RoomBridge(ROOM, upstream.origin, room);
		bridge.start();
		const ws = await upstream.connection(0);
		await liveBridge(bridge);
		ws.send(JSON.stringify({ t: "peer-joined", peer: 3 }));
		ws.send(JSON.stringify({ t: "peer-joined", peer: 3 }));
		ws.send(frame(3, "hi"));
		ws.send(JSON.stringify({ t: "peer-left", peer: 3 }));
		ws.send(JSON.stringify({ t: "peer-left", peer: 3 }));
		await expect
			.poll(() => toHost)
			.toEqual([
				{ t: "peer-joined", peer: 1 },
				{ t: "peer-left", peer: 1 },
				{ t: "peer-joined", peer: 2 },
				{ frameFor: 2 },
				{ t: "peer-left", peer: 2 },
			]);
		expect(bridge.status.remoteGuests).toBe(0);
		bridge.stop("stopped");
	});

	it("announces every remote guest as gone when upstream drops, then reconnects", async () => {
		const upstream = await scriptedUpstream();
		const { room, toHost } = fakeRoom();
		const bridge = new RoomBridge(ROOM, upstream.origin, room);
		const phases: string[] = [];
		bridge.onStatus(status => phases.push(status.phase));
		bridge.start();
		const first = await upstream.connection(0);
		await liveBridge(bridge);
		first.send(JSON.stringify({ t: "peer-joined", peer: 1 }));
		first.send(JSON.stringify({ t: "peer-joined", peer: 2 }));
		await expect.poll(() => bridge.status.remoteGuests).toBe(2);
		first.close(1011, "relay restart");
		await expect.poll(() => bridge.phase).toBe("reconnecting");
		expect(toHost.slice(2)).toEqual([
			{ t: "peer-left", peer: 1 },
			{ t: "peer-left", peer: 2 },
		]);
		const second = await upstream.connection(1);
		await liveBridge(bridge);
		// Ids restart upstream; locally they are fresh so a stale id can never be confused with a new guest.
		second.send(JSON.stringify({ t: "peer-joined", peer: 1 }));
		await expect.poll(() => toHost.at(-1)).toEqual({ t: "peer-joined", peer: 3 });
		expect(phases).toContain("reconnecting");
		bridge.stop("stopped");
		expect(bridge.status).toMatchObject({ phase: "stopped", reason: "stopped" });
	});
});
