/**
 * Port of Zig's `std.hash.Wyhash` — the algorithm behind `Bun.hash(string)` (seed 0).
 *
 * omp derives per-project memory bank ids (`<basename>-<Bun.hash(absPath).toString(36)>`) with it,
 * so the GUI needs the exact same 64-bit value to map a project directory to its bank.
 */

const MASK = (1n << 64n) - 1n;
const SECRET = [0xa0761d6478bd642fn, 0xe7037ed1a0b428dbn, 0x8ebc6af09c88c6e3n, 0x589965cc75374cc3n] as const;

/** 64x64 → 128 multiply; returns [low, high]. */
function mum(a: bigint, b: bigint): [bigint, bigint] {
	const x = a * b;
	return [x & MASK, (x >> 64n) & MASK];
}

function mix(a: bigint, b: bigint): bigint {
	const [lo, hi] = mum(a, b);
	return lo ^ hi;
}

function read(bytes: Uint8Array, offset: number, width: 4 | 8): bigint {
	let value = 0n;
	for (let i = width - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
	return value;
}

/** Wyhash of `input` (UTF-8 for strings) with `seed`, as an unsigned 64-bit bigint. */
export function wyhash(input: string | Uint8Array, seed = 0n): bigint {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const len = bytes.length;
	const s0 = (seed ^ mix(seed ^ SECRET[0], SECRET[1])) & MASK;
	const state: [bigint, bigint, bigint] = [s0, s0, s0];
	let a: bigint;
	let b: bigint;
	if (len <= 16) {
		if (len >= 4) {
			const end = len - 4;
			const quarter = (len >> 3) << 2;
			a = ((read(bytes, 0, 4) << 32n) | read(bytes, quarter, 4)) & MASK;
			b = ((read(bytes, end, 4) << 32n) | read(bytes, end - quarter, 4)) & MASK;
		} else if (len > 0) {
			a = (BigInt(bytes[0] ?? 0) << 16n) | (BigInt(bytes[len >> 1] ?? 0) << 8n) | BigInt(bytes[len - 1] ?? 0);
			b = 0n;
		} else {
			a = 0n;
			b = 0n;
		}
	} else {
		let i = 0;
		if (len >= 48) {
			for (; i + 48 < len; i += 48) {
				state[0] = mix(read(bytes, i, 8) ^ SECRET[1], read(bytes, i + 8, 8) ^ state[0]);
				state[1] = mix(read(bytes, i + 16, 8) ^ SECRET[2], read(bytes, i + 24, 8) ^ state[1]);
				state[2] = mix(read(bytes, i + 32, 8) ^ SECRET[3], read(bytes, i + 40, 8) ^ state[2]);
			}
			state[0] ^= state[1] ^ state[2];
		}
		for (let j = i; j + 16 < len; j += 16) {
			state[0] = mix(read(bytes, j, 8) ^ SECRET[1], read(bytes, j + 8, 8) ^ state[0]);
		}
		a = read(bytes, len - 16, 8);
		b = read(bytes, len - 8, 8);
	}
	a ^= SECRET[1];
	b ^= state[0];
	const [lo, hi] = mum(a, b);
	return mix(lo ^ SECRET[0] ^ BigInt(len), hi ^ SECRET[1]);
}
