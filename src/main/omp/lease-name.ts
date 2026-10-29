/** omp 18.14 pi-natives file_lock/mod.rs: two seeded xxh64 hashes of the absolute sidecar path. */
const MASK = 0xffffffffffffffffn;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;
const wrap = (value: bigint) => value & MASK;
const rotate = (value: bigint, count: bigint) => wrap((value << count) | (value >> (64n - count)));
const round = (accumulator: bigint, input: bigint) => wrap(rotate(wrap(accumulator + input * P2), 31n) * P1);

function xxh64(bytes: Buffer, seed: bigint): string {
	let offset = 0;
	let hash: bigint;
	if (bytes.length >= 32) {
		let a = wrap(seed + P1 + P2);
		let b = wrap(seed + P2);
		let c = seed;
		let d = wrap(seed - P1);
		while (offset <= bytes.length - 32) {
			a = round(a, bytes.readBigUInt64LE(offset));
			b = round(b, bytes.readBigUInt64LE(offset + 8));
			c = round(c, bytes.readBigUInt64LE(offset + 16));
			d = round(d, bytes.readBigUInt64LE(offset + 24));
			offset += 32;
		}
		hash = wrap(rotate(a, 1n) + rotate(b, 7n) + rotate(c, 12n) + rotate(d, 18n));
		for (const value of [a, b, c, d]) hash = wrap((hash ^ round(0n, value)) * P1 + P4);
	} else hash = wrap(seed + P5);
	hash = wrap(hash + BigInt(bytes.length));
	while (offset <= bytes.length - 8) {
		hash = wrap(rotate(hash ^ round(0n, bytes.readBigUInt64LE(offset)), 27n) * P1 + P4);
		offset += 8;
	}
	if (offset <= bytes.length - 4) {
		hash = wrap(rotate(hash ^ wrap(BigInt(bytes.readUInt32LE(offset)) * P1), 23n) * P2 + P3);
		offset += 4;
	}
	while (offset < bytes.length) {
		hash = wrap(rotate(hash ^ wrap(BigInt(bytes[offset++]!) * P5), 11n) * P1);
	}
	hash ^= hash >> 33n;
	hash = wrap(hash * P2);
	hash ^= hash >> 29n;
	hash = wrap(hash * P3);
	hash ^= hash >> 32n;
	return hash.toString(16).padStart(16, "0");
}

export function leaseMemoryName(sidecar: string): string {
	const bytes = Buffer.from(sidecar);
	return `omp-file-lock-${xxh64(bytes, 0x4f4d502d4c4f434bn)}${xxh64(bytes, 0x50492d46494c454cn)}`;
}
