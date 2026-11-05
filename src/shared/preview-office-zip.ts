/** Office packages are untrusted ZIP files. These limits also apply to actual worker output. */
export const OFFICE_LIMITS = { input: 32 * 1024 * 1024, entries: 10_000, total: 256 * 1024 * 1024, entry: 64 * 1024 * 1024, document: 20 * 1024 * 1024 } as const;
export interface OfficeZipEntry { name: string; size: number; compressed: number; crc: number; offset: number; method: number }
export type OfficeZipCheck = { ok: true; entries: OfficeZipEntry[] } | { ok: false; reason: "incomplete" | "unsafe" };

/** Check central and local headers before any decompressor sees attacker-controlled sizes. */
export function validateOfficeZip(bytes: Uint8Array): OfficeZipCheck {
	if (bytes.byteLength > OFFICE_LIMITS.input) return { ok: false, reason: "unsafe" };
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (at: number) => view.getUint16(at, true);
	const u32 = (at: number) => view.getUint32(at, true);
	let end = -1;
	for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
		if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
	}
	if (end < 0) return { ok: false, reason: "incomplete" };
	const unsafe = (): OfficeZipCheck => ({ ok: false, reason: "unsafe" });
	if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) return unsafe();
	const count = u16(end + 10), length = u32(end + 12), start = u32(end + 16);
	if (!count || count > OFFICE_LIMITS.entries || count === 0xffff || length === 0xffffffff || start === 0xffffffff
		|| start + length !== end || (end >= 20 && u32(end - 20) === 0x07064b50)) return unsafe();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const entries: OfficeZipEntry[] = [], names = new Set<string>();
	let at = start, total = 0;
	try {
		for (let index = 0; index < count; index++) {
			if (at + 46 > end || u32(at) !== 0x02014b50) return unsafe();
			const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), compressed = u32(at + 20), size = u32(at + 24);
			const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32), offset = u32(at + 42);
			const next = at + 46 + nameLength + extraLength + commentLength;
			if (next > end || !nameLength || (flags & 0x2041) || (method !== 0 && method !== 8) || u16(at + 34)
				|| size > OFFICE_LIMITS.entry || compressed === 0xffffffff || offset === 0xffffffff || ((u32(at + 38) >>> 16) & 0xf000) === 0xa000) return unsafe();
			const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
			if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[a-z]:/i.test(name)
				|| name.split("/").some(part => part === ".." || part === ".") || names.has(name)) return unsafe();
			names.add(name);
			for (let extra = at + 46 + nameLength; extra < at + 46 + nameLength + extraLength;) {
				if (extra + 4 > at + 46 + nameLength + extraLength || u16(extra) === 1) return unsafe();
				extra += 4 + u16(extra + 2);
				if (extra > at + 46 + nameLength + extraLength) return unsafe();
			}
			if (offset + 30 > start || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method) return unsafe();
			const localNameLength = u16(offset + 26), localExtraLength = u16(offset + 28);
			const data = offset + 30 + localNameLength + localExtraLength;
			if (data + compressed > start || decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)) !== name) return unsafe();
			for (let extra = offset + 30 + localNameLength; extra < data;) {
				if (extra + 4 > data || u16(extra) === 1) return unsafe();
				extra += 4 + u16(extra + 2);
				if (extra > data) return unsafe();
			}
			if (!(flags & 8) && (u32(offset + 14) !== crc || u32(offset + 18) !== compressed || u32(offset + 22) !== size)) return unsafe();
			total += size;
			if (total > OFFICE_LIMITS.total) return unsafe();
			entries.push({ name, size, compressed, crc, offset, method });
			at = next;
		}
		if (at !== end) return unsafe();
		const ordered = [...entries].sort((a, b) => a.offset - b.offset);
		for (let index = 1; index < ordered.length; index++) {
			const prev = ordered[index - 1]!;
			if (prev.offset + 30 + u16(prev.offset + 26) + u16(prev.offset + 28) + prev.compressed > ordered[index]!.offset) return unsafe();
		}
		return { ok: true, entries };
	} catch { return unsafe(); }
}
