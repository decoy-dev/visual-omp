/**
 * omp collab link handling for publishing a loopback room (see oh-my-pi
 * `packages/coding-agent/src/collab/protocol.ts`: `parseCollabLink`, `formatCollabWebLink`).
 *
 * The room secret is base64url(key ∥ writeToken) — 48 bytes for a control link, the bare 32-byte
 * key for a view-only link. Browser links put the whole collab link in the fragment so secrets
 * never reach an HTTP server; the default relay collapses it to `<roomId>.<secret>`.
 */

export const DEFAULT_RELAY_ORIGIN = "wss://my.omp.sh";

const ROOM_KEY_BYTES = 32;
const WRITE_TOKEN_BYTES = 16;
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:[.#]([A-Za-z0-9_-]+))?$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

export interface RoomLink {
	/** Relay origin the link points at (`ws://localhost:1234`). */
	origin: string;
	roomId: string;
	/** 32-byte room key. */
	key: Buffer;
	/** 16-byte write token; null for a view-only link. */
	writeToken: Buffer | null;
}

export function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES[hostname] === true;
}

/**
 * Parse a collab link in any form omp prints: the browser link `http(s)://<web>/#<collab link>`
 * (what `omp collab link` returns), a direct `ws(s)://host[:port]/r/<roomId>.<secret>`, scheme-less
 * `host[:port]/r/…` (wss) or bare `<roomId>.<secret>` (default relay).
 */
export function parseRoomLink(link: string): RoomLink {
	let text = link.trim().replace(/%23/gi, "#");
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_ORIGIN}/r/${bare[1]}.${bare[2]}`;
	else if (!text.includes("://")) text = `wss://${text}`;
	const url = new URL(text);
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash.length > 1) return parseRoomLink(url.hash.slice(1));
	const match = ROOM_PATH_RE.exec(url.pathname);
	const roomId = match?.[1];
	if (!roomId) throw new Error(`Not a collab room link: ${link}`);
	const secretText = match[2] ?? url.hash.replace(/^#/, "");
	const secret = B64URL_RE.test(secretText) ? Buffer.from(secretText, "base64url") : null;
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		throw new Error("Collab link key must be 32 (view) or 48 (full) base64url bytes");
	}
	return {
		origin: normalizeRelayOrigin(url.origin),
		roomId,
		key: secret.subarray(0, ROOM_KEY_BYTES),
		writeToken: secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : null,
	};
}

/** `wss://host[:port]` for a relay URL (ws/wss/http/https). Plain ws is only accepted for localhost, like omp. */
export function normalizeRelayOrigin(relayUrl: string): string {
	const url = new URL(relayUrl);
	const scheme = url.protocol === "wss:" || url.protocol === "https:" ? "wss:" : url.protocol === "ws:" || url.protocol === "http:" ? "ws:" : null;
	if (!scheme) throw new Error(`Unsupported relay URL scheme: ${url.protocol}`);
	if (scheme === "ws:" && !isLocalHostname(url.hostname)) {
		throw new Error("relay link must be wss:// (plain ws:// is only allowed for localhost)");
	}
	return `${scheme}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
}

/**
 * omp's browser link for a room on `relayOrigin`: `https://my.omp.sh/#<roomId>.<secret>` for the
 * default relay, `https://<host>/#<host>/r/<roomId>.<secret>` for another wss relay. `webUrl`
 * (omp's `collab.webUrl`) overrides where the browser client is served from.
 */
export function formatWebLink(relayOrigin: string, roomId: string, key: Buffer, writeToken: Buffer | null, webUrl?: string): string {
	const origin = normalizeRelayOrigin(relayOrigin);
	const secret = (writeToken ? Buffer.concat([key, writeToken]) : key).toString("base64url");
	const collab =
		origin === DEFAULT_RELAY_ORIGIN
			? `${roomId}.${secret}`
			: `${origin.startsWith("wss://") ? origin.slice("wss://".length) : origin}/r/${roomId}.${secret}`;
	return `${webBase(origin, webUrl)}/#${collab}`;
}

function webBase(origin: string, webUrl: string | undefined): string {
	const explicit = webUrl?.trim();
	if (!explicit) return origin.startsWith("wss://") ? `https://${origin.slice("wss://".length)}` : `http://${origin.slice("ws://".length)}`;
	const url = new URL(explicit);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("collab.webUrl must start with http:// or https://");
	if (url.protocol === "http:" && !isLocalHostname(url.hostname)) {
		throw new Error("collab.webUrl must use https:// unless it targets localhost");
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}
