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
 *
 * A room can also be *published* to an upstream relay (omp's public `wss://my.omp.sh`): a
 * {@link RoomBridge} connects upstream as that room's host and splices remote guests into the local
 * room under peer ids allocated from the same counter as local guests, so the omp host sees one
 * room and ids never collide.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;
const MAX_PAYLOAD = 256 * 1024 * 1024;

interface Room {
	host: WebSocket;
	guests: Map<number, WebSocket>;
	nextPeerId: number;
	bridge: RoomBridge | null;
}

export interface RelayEvents {
	/** A collab host opened `roomId` on this relay. */
	onHostOpen?(roomId: string): void;
	/** The host of `roomId` disconnected (room ended, session switched, or process exited). */
	onHostClose?(roomId: string): void;
}

/** Relays that are listening, so a room can be found from its id alone (rooms ids are random 16-byte values). */
const runningRelays = new Set<LoopbackRelay>();

/** The running loopback relay that currently hosts `roomId`, or null. */
export function relayHosting(roomId: string): LoopbackRelay | null {
	for (const relay of runningRelays) if (relay.hasRoom(roomId)) return relay;
	return null;
}


export class LoopbackRelay {
	readonly #servers: Server[] = [];
	readonly #wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
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
		runningRelays.add(this);
	}

	stop(): void {
		runningRelays.delete(this);
		const closure = JSON.stringify({ t: "room-closed" });
		for (const room of this.#rooms.values()) {
			room.bridge?.stop("room-closed");
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

	hasRoom(roomId: string): boolean {
		return this.#rooms.has(roomId);
	}

	/** The bridge publishing `roomId` upstream, or null when the room is private. */
	bridgeFor(roomId: string): RoomBridge | null {
		return this.#rooms.get(roomId)?.bridge ?? null;
	}

	/**
	 * Publish `roomId` on `upstreamOrigin` (`wss://host[:port]`, or `ws://` for localhost) by
	 * hosting it there too. Returns the running bridge; publishing again to the same origin keeps it.
	 * @throws Error when this relay has no such room.
	 */
	publish(roomId: string, upstreamOrigin: string): RoomBridge {
		const room = this.#rooms.get(roomId);
		if (!room) throw new Error("This chat is not live right now.");
		if (room.bridge && room.bridge.phase !== "stopped" && room.bridge.upstreamOrigin === upstreamOrigin) {
			return room.bridge;
		}
		room.bridge?.stop("stopped");
		const bridge = new RoomBridge(roomId, upstreamOrigin, {
			allocatePeer: () => room.nextPeerId++,
			sendToHost: data => room.host.send(data),
		});
		room.bridge = bridge;
		bridge.start();
		return bridge;
	}

	/** Stop publishing `roomId` upstream; remote guests are dropped. */
	unpublish(roomId: string): void {
		const room = this.#rooms.get(roomId);
		if (!room?.bridge) return;
		room.bridge.stop("stopped");
		room.bridge = null;
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
		const room: Room = { host: ws, guests: new Map(), nextPeerId: 1, bridge: null };
		this.#rooms.set(roomId, room);
		ws.on("message", (data, isBinary) => {
			if (!isBinary) return;
			const frame = toBuffer(data);
			if (frame.byteLength < ENVELOPE_HEADER_LENGTH) return;
			const peerId = frame.readUInt32BE(0);
			if (peerId === 0) {
				for (const guest of room.guests.values()) guest.send(frame);
				room.bridge?.fromHost(frame, 0);
				return;
			}
			const guest = room.guests.get(peerId);
			if (guest) guest.send(frame);
			else room.bridge?.fromHost(frame, peerId);
		});
		ws.on("close", () => {
			if (this.#rooms.get(roomId) !== room) return;
			this.#rooms.delete(roomId);
			room.bridge?.stop("room-closed");
			room.bridge = null;
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

// ═══════════════════════════════════════════════════════════════════════════
// Upstream bridge
// ═══════════════════════════════════════════════════════════════════════════

/**
 * - `connecting`: first connection to the upstream relay.
 * - `live`: hosting the room upstream; remote guests can join.
 * - `reconnecting`: the upstream connection dropped; retrying (remote guests rejoin on their own).
 * - `stopped`: torn down (Stop sharing, or the local room closed — see {@link BridgeStatus.reason}).
 */
export type BridgePhase = "connecting" | "live" | "reconnecting" | "stopped";

export interface BridgeStatus {
	phase: BridgePhase;
	/** Remote guests currently spliced into the local room. */
	remoteGuests: number;
	/** Latest upstream connection problem; null while healthy. */
	error: string | null;
	/** Why the bridge stopped: the user stopped it, or the local room (chat session) ended. */
	reason: "stopped" | "room-closed" | null;
}

/** The local room as the bridge sees it. */
export interface BridgeRoom {
	/** Reserve a peer id from the local room's counter (shared with local guests). */
	allocatePeer(): number;
	/** Deliver a frame or TEXT control message to the local room's host. */
	sendToHost(data: Buffer | string): void;
}

const RelayControlToHost = z.object({ t: z.enum(["peer-joined", "peer-left"]), peer: z.number().int().positive() });

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * omp's relay client notes that the public relay can hold a silently dropped host connection for
 * ~40s (and Bun's idle timeout is 120s) and refuses the reconnect with 4009 until then; keep
 * retrying for that long before reporting the duplicate host as a real conflict.
 */
const DUPLICATE_HOST_GRACE_MS = 150_000;

const CLOSE_REASONS: Record<number, string> = {
	4001: "the public relay closed the room",
	4009: "another computer is already sharing this chat",
	4029: "the public relay says the room is full",
};

/**
 * Hosts one local room on an upstream relay and forwards frames both ways:
 * - upstream `peer-joined N` → a fresh local id M; the local host sees `peer-joined M`.
 * - remote guest frames (envelope N) → rewritten to M → local host.
 * - local host frames: peerId 0 → upstream unchanged (the upstream relay fans out);
 *   peerId M of a remote guest → rewritten to N → upstream.
 * - upstream `peer-left N` / upstream disconnect → `peer-left M` to the local host.
 */
export class RoomBridge {
	readonly roomId: string;
	readonly upstreamOrigin: string;
	readonly #room: BridgeRoom;
	readonly #remoteToLocal = new Map<number, number>();
	readonly #localToRemote = new Map<number, number>();
	readonly #listeners = new Set<(status: BridgeStatus) => void>();
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | null = null;
	#pingTimer: NodeJS.Timeout | null = null;
	#attempt = 0;
	#duplicateSince: number | null = null;
	#status: BridgeStatus = { phase: "connecting", remoteGuests: 0, error: null, reason: null };

	constructor(roomId: string, upstreamOrigin: string, room: BridgeRoom) {
		this.roomId = roomId;
		this.upstreamOrigin = upstreamOrigin.replace(/\/+$/, "");
		this.#room = room;
	}

	get phase(): BridgePhase {
		return this.#status.phase;
	}

	get status(): BridgeStatus {
		return this.#status;
	}

	/** Listen for status changes; returns an unsubscribe function. */
	onStatus(listener: (status: BridgeStatus) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(): void {
		if (this.#status.phase === "stopped" || this.#ws) return;
		const ws = new WebSocket(`${this.upstreamOrigin}/r/${this.roomId}?role=host`, {
			maxPayload: MAX_PAYLOAD,
			handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
		});
		this.#ws = ws;
		ws.on("open", () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			this.#duplicateSince = null;
			this.#pingTimer = setInterval(() => ws.ping(), PING_INTERVAL_MS);
			this.#update({ phase: "live", error: null });
		});
		ws.on("message", (data, isBinary) => {
			if (this.#ws !== ws) return;
			if (isBinary) this.#fromUpstream(toBuffer(data));
			else this.#control(toBuffer(data).toString("utf8"));
		});
		ws.on("error", error => {
			if (this.#ws === ws) this.#update({ error: error.message });
		});
		ws.on("close", code => {
			if (this.#ws !== ws) return;
			this.#onUpstreamClose(code);
		});
	}

	/** Tear down: close upstream and tell the local host every remote guest left. */
	stop(reason: "stopped" | "room-closed"): void {
		if (this.#status.phase === "stopped") return;
		this.#clearTimers();
		const ws = this.#ws;
		this.#ws = null;
		ws?.close(1000, "sharing stopped");
		// The local room is gone already when it closed; nobody is left to notify.
		this.#dropRemotePeers(reason === "stopped");
		this.#update({ phase: "stopped", reason, remoteGuests: 0 });
	}

	/**
	 * A frame the local host addressed to peer 0 (everyone) or to one peer. Broadcasts go upstream
	 * unchanged; frames for a remote guest are re-addressed to its upstream id. The buffer is only
	 * mutated for targeted frames, which have a single destination.
	 */
	fromHost(frame: Buffer, localPeerId: number): void {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (localPeerId === 0) {
			ws.send(frame);
			return;
		}
		const remote = this.#localToRemote.get(localPeerId);
		if (remote === undefined) return;
		frame.writeUInt32BE(remote, 0);
		ws.send(frame);
	}

	#fromUpstream(frame: Buffer): void {
		if (frame.byteLength < ENVELOPE_HEADER_LENGTH) return;
		const local = this.#remoteToLocal.get(frame.readUInt32BE(0));
		if (local === undefined) return;
		frame.writeUInt32BE(local, 0);
		this.#room.sendToHost(frame);
	}

	#control(text: string): void {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return;
		}
		const parsed = RelayControlToHost.safeParse(json);
		if (!parsed.success) return;
		const { t, peer } = parsed.data;
		if (t === "peer-joined") {
			// A reissued id without a `peer-left` first: retire the stale mapping before reusing it.
			const stale = this.#remoteToLocal.get(peer);
			if (stale !== undefined) this.#retire(peer, stale);
			const local = this.#room.allocatePeer();
			this.#remoteToLocal.set(peer, local);
			this.#localToRemote.set(local, peer);
			this.#room.sendToHost(JSON.stringify({ t: "peer-joined", peer: local }));
		} else {
			const local = this.#remoteToLocal.get(peer);
			if (local !== undefined) this.#retire(peer, local);
		}
		this.#update({ remoteGuests: this.#remoteToLocal.size });
	}

	#retire(remote: number, local: number): void {
		this.#remoteToLocal.delete(remote);
		this.#localToRemote.delete(local);
		this.#room.sendToHost(JSON.stringify({ t: "peer-left", peer: local }));
	}

	#dropRemotePeers(notify: boolean): void {
		for (const [remote, local] of this.#remoteToLocal) {
			if (notify) this.#retire(remote, local);
		}
		this.#remoteToLocal.clear();
		this.#localToRemote.clear();
	}

	#onUpstreamClose(code: number): void {
		this.#clearTimers();
		this.#ws = null;
		// The upstream relay recreates the room on reconnect and reissues ids from 1 without a
		// `peer-left`, so every remote guest is gone now; they rejoin by themselves.
		this.#dropRemotePeers(true);
		const now = Date.now();
		if (code === 4009) {
			this.#duplicateSince ??= now;
			if (now - this.#duplicateSince > DUPLICATE_HOST_GRACE_MS) {
				this.stop("stopped");
				this.#update({ error: CLOSE_REASONS[4009] ?? null });
				return;
			}
		}
		const error = CLOSE_REASONS[code] ?? (this.#status.error || `lost the connection to the public relay (code ${code})`);
		this.#update({ phase: "reconnecting", remoteGuests: 0, error });
		const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.#attempt++);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null;
			this.start();
		}, delay);
	}

	#clearTimers(): void {
		clearTimeout(this.#retryTimer ?? undefined);
		clearInterval(this.#pingTimer ?? undefined);
		this.#retryTimer = null;
		this.#pingTimer = null;
	}

	#update(patch: Partial<BridgeStatus>): void {
		this.#status = { ...this.#status, ...patch };
		for (const listener of this.#listeners) listener(this.#status);
	}
}

function toBuffer(data: RawData): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (Array.isArray(data)) return Buffer.concat(data);
	return Buffer.from(data);
}
