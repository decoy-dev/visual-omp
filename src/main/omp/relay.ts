/**
 * Loopback stand-in for omp's public collab relay, following the contract of oh-my-pi's
 * `packages/collab-web/scripts/local-relay.ts` (MIT):
 *
 * - `GET /r/<roomId>?role=host|guest` upgrades to a WebSocket.
 * - Host binary frames: envelope peerId 0 broadcasts to every guest, peerId N targets one guest.
 * - Guest binary frames: the first 4 envelope bytes are rewritten to the sender's peerId.
 * - TEXT control to the host: `{"t":"peer-joined","peer":N}` / `{"t":"peer-left","peer":N}`.
 * - Host disconnect: TEXT `{"t":"room-closed"}` to every guest, then close 4001.
 *
 * Payloads are sealed end to end; the relay never sees plaintext. It listens on 127.0.0.1 and
 * ::1 only, so nothing is reachable from the network.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;

interface Room {
	host: WebSocket;
	guests: Map<number, WebSocket>;
	nextPeerId: number;
}

export interface RelayEvents {
	/** A collab host opened `roomId` on this relay. */
	onHostOpen?(roomId: string): void;
	/** The host of `roomId` disconnected (room ended, session switched, or process exited). */
	onHostClose?(roomId: string): void;
}

export class LoopbackRelay {
	readonly #servers: Server[] = [];
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
	readonly #rooms = new Map<string, Room>();
	#port = 0;
	events: RelayEvents = {};

	get port(): number {
		return this.#port;
	}

	/** URL for omp's `collab.relayUrl`. omp accepts plain `ws://` only for localhost. */
	get url(): string {
		return `ws://localhost:${this.#port}`;
	}

	async start(): Promise<void> {
		const v4 = this.#createServer();
		await this.#listen(v4, "127.0.0.1", 0);
		const address = v4.address();
		if (!address || typeof address === "string") throw new Error("relay did not bind a TCP port");
		this.#port = address.port;
		// `localhost` may resolve to ::1 first; serve both loopbacks on the same port when IPv6 exists.
		const v6 = this.#createServer();
		await this.#listen(v6, "::1", this.#port).catch(() => v6.close());
	}

	stop(): void {
		const closure = JSON.stringify({ t: "room-closed" });
		for (const room of this.#rooms.values()) {
			for (const guest of room.guests.values()) {
				guest.send(closure);
				guest.close(4001, "room closed");
			}
			room.host.close(1001, "relay shutting down");
		}
		this.#rooms.clear();
		this.#wss.close();
		for (const server of this.#servers) server.close();
	}

	#createServer(): Server {
		const server = createServer((_req, res) => {
			res.writeHead(404).end("not found");
		});
		server.on("upgrade", (req, socket, head) => this.#upgrade(req, socket, head));
		this.#servers.push(server);
		return server;
	}

	#listen(server: Server, host: string, port: number): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
		return promise;
	}

	#upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(req.url ?? "/", "http://localhost");
		const match = ROOM_PATH_RE.exec(url.pathname);
		const role = url.searchParams.get("role");
		const roomId = match?.[1];
		if (!roomId || (role !== "host" && role !== "guest")) {
			socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
			return;
		}
		this.#wss.handleUpgrade(req, socket, head, ws => {
			if (role === "host") this.#openHost(roomId, ws);
			else this.#openGuest(roomId, ws);
		});
	}

	#openHost(roomId: string, ws: WebSocket): void {
		if (this.#rooms.has(roomId)) {
			ws.close(4009, "a host is already connected for this room");
			return;
		}
		const room: Room = { host: ws, guests: new Map(), nextPeerId: 1 };
		this.#rooms.set(roomId, room);
		ws.on("message", (data, isBinary) => {
			if (!isBinary) return;
			const frame = toBuffer(data);
			if (frame.byteLength < ENVELOPE_HEADER_LENGTH) return;
			const peerId = frame.readUInt32BE(0);
			if (peerId === 0) for (const guest of room.guests.values()) guest.send(frame);
			else room.guests.get(peerId)?.send(frame);
		});
		ws.on("close", () => {
			if (this.#rooms.get(roomId) !== room) return;
			this.#rooms.delete(roomId);
			const closure = JSON.stringify({ t: "room-closed" });
			for (const guest of room.guests.values()) {
				guest.send(closure);
				guest.close(4001, "room closed");
			}
			room.guests.clear();
			this.events.onHostClose?.(roomId);
		});
		this.events.onHostOpen?.(roomId);
	}

	#openGuest(roomId: string, ws: WebSocket): void {
		const room = this.#rooms.get(roomId);
		if (!room) {
			ws.close(4004, "no such room");
			return;
		}
		const peerId = room.nextPeerId++;
		room.guests.set(peerId, ws);
		room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
		ws.on("message", (data, isBinary) => {
			if (!isBinary) return;
			const frame = toBuffer(data);
			if (frame.byteLength < ENVELOPE_HEADER_LENGTH) return;
			frame.writeUInt32BE(peerId, 0);
			room.host.send(frame);
		});
		ws.on("close", () => {
			if (room.guests.delete(peerId)) room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
		});
	}
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
