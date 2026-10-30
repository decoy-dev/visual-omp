/**
 * Adapted from oh-my-pi v18.14.0, commit 31147f9d1a76608549821c3759f8487b4d66c72d.
 * Copyright (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc.
 * MIT licensed; see LICENSE in this directory.
 */
/**
 * Tern Surface Protocol framing: `ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \`.
 *
 * Bodies are UTF-8 JSON (JSON escapes every control character, so a body can
 * never contain ESC or BEL) or base64 for blob chunks. A body larger than the
 * negotiated `apc` limit is split across messages with the same verb, tagged
 * `c=<chunk-id>`, with `m=1` on every chunk but the last; the receiver joins
 * the bodies byte-wise. Chunks split on code-point boundaries, so every chunk
 * is valid UTF-8 on its own and the joined bytes equal the original body, and
 * never where the next chunk would lead with a `key=value;` segment the
 * receiver would read as a parameter (Tern's `tsp_chunks`).
 */
import {
	TSP_APC_ID,
	TSP_DEFAULT_APC_LIMIT,
	type TspVerb,
} from "../../../shared/tsp";

const APC = "\x1b_";
const ST = "\x1b\\";
/** Every TSP message starts with this. */
export const TSP_PREFIX = `${APC}${TSP_APC_ID};`;

/** Message parameters (`k=v`, ASCII, never containing `;`). */
export type TspParams = Readonly<Record<string, string | number>>;

let nextChunkId = 1;

/** Whether `bytes` from `at` leads with a `key=value;` segment, which a receiver reads as one more parameter. */
function leadsWithParameter(bytes: Uint8Array, at: number): boolean {
	let i = at;
	// Key bytes: `[A-Za-z0-9_-]`.
	for (; i < bytes.length; i++) {
		const b = bytes[i]!;
		if (
			!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x5f || b === 0x2d)
		)
			break;
	}
	if (i === at || bytes[i] !== 0x3d) return false;
	i++;
	// Value bytes: printable ASCII other than `;`.
	while (i < bytes.length && bytes[i]! >= 0x21 && bytes[i]! <= 0x7e && bytes[i] !== 0x3b) i++;
	return bytes[i] === 0x3b;
}

/**
 * Where the chunk of `bytes` starting at `start` ends: the safe cut nearest
 * below `start + limit` (above `start`), else the nearest above it, else the
 * end. A cut is safe on a UTF-8 character boundary where the rest doesn't
 * lead with a parameter-shaped segment.
 */
function chunkEnd(bytes: Uint8Array, start: number, limit: number): number {
	const target = start + limit;
	if (target >= bytes.length) return bytes.length;
	const safe = (at: number): boolean => (bytes[at]! & 0xc0) !== 0x80 && !leadsWithParameter(bytes, at);
	for (let at = target; at > start; at--) if (safe(at)) return at;
	for (let at = target + 1; at < bytes.length; at++) if (safe(at)) return at;
	return bytes.length;
}

/**
 * Chunk bodies for `body` of `byteLength` UTF-8 bytes, cut as Tern's
 * `tsp_chunks` cuts. Pure ASCII without `;` (every base64 blob) has no
 * parameter-shaped segment and no multibyte character, so it is cut every
 * `limit` characters.
 */
function chunkBodies(body: string, byteLength: number, limit: number): string[] {
	const max = Math.max(1, Math.trunc(limit));
	const pieces: string[] = [];
	if (byteLength === body.length && !body.includes(";")) {
		for (let at = 0; at < body.length; at += max) pieces.push(body.slice(at, at + max));
		return pieces;
	}
	const bytes = Buffer.from(body, "utf8");
	for (let start = 0; start < bytes.length;) {
		const end = chunkEnd(bytes, start, max);
		pieces.push(bytes.toString("utf8", start, end));
		start = end;
	}
	return pieces;
}

function frame(verb: TspVerb, params: string, body: string): string {
	return `${TSP_PREFIX}${verb}${params};${body}${ST}`;
}

function encodeParams(params: TspParams | undefined): string {
	if (!params) return "";
	let out = "";
	for (const key in params) out += `;${key}=${params[key]}`;
	return out;
}

/**
 * Encode one logical message, chunked when `body` exceeds `limit` UTF-8 bytes:
 * the first chunk carries `params`, every chunk `c=<id>` and all but the last
 * `m=1`. Returns the complete byte string to write (all chunks, in order).
 */
export function encodeTspMessage(
	verb: TspVerb,
	body: string,
	params?: TspParams,
	limit: number = TSP_DEFAULT_APC_LIMIT,
): string {
	const base = encodeParams(params);
	// Fast path: ASCII-length bound first, exact byte count only near the limit.
	if (body.length * 3 <= limit) return frame(verb, base, body);
	const byteLength = Buffer.byteLength(body, "utf8");
	if (byteLength <= limit) return frame(verb, base, body);
	const chunkId = (nextChunkId++).toString(36);
	const pieces = chunkBodies(body, byteLength, limit);
	let out = "";
	for (let i = 0; i < pieces.length; i++) {
		const more = i < pieces.length - 1 ? ";m=1" : "";
		out += frame(verb, `${i === 0 ? base : ""};c=${chunkId}${more}`, pieces[i]!);
	}
	return out;
}

/** Encode a JSON message body. */
export function encodeTspJson(verb: TspVerb, value: unknown, params?: TspParams, limit?: number): string {
	return encodeTspMessage(verb, JSON.stringify(value), params, limit);
}

