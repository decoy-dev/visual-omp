import { Unzip, UnzipInflate } from "fflate";
import { OFFICE_LIMITS, validateOfficeZip } from "./preview-office-zip";
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
	return value >>> 0;
});

/** Inflate in small input increments, counting actual bytes before retaining each chunk. */
export function inflateOffice(bytes: Uint8Array, { retain = true, docx = false }: { retain?: boolean; docx?: boolean } = {}): Record<string, Uint8Array> {
	const checked = validateOfficeZip(bytes);
	if (!checked.ok) throw new Error(checked.reason);
	if (docx && checked.entries.some(entry => entry.name === "word/document.xml" && entry.size > OFFICE_LIMITS.document)) throw new Error("unsafe");
	const expected = new Map(checked.entries.map(entry => [entry.name, entry]));
	const files: Record<string, Uint8Array> = Object.create(null);
	let total = 0, seen = 0, error: Error | null = null;
	const unzip = new Unzip(file => {
		const entry = expected.get(file.name);
		if (!entry || Object.hasOwn(files, file.name)) throw new Error("unsafe");
		let size = 0, crc = 0xffffffff;
		const chunks: Uint8Array[] = [];
		file.ondata = (failure, chunk, final) => {
			if (failure) { error = new Error("unsafe"); file.terminate(); return; }
			size += chunk.length; total += chunk.length;
			if (size > OFFICE_LIMITS.entry || total > OFFICE_LIMITS.total || size > entry.size) {
				error = new Error("unsafe"); file.terminate(); return;
			}
			for (const byte of chunk) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255]!;
			if (retain) chunks.push(chunk);
			if (final) {
				if (size !== entry.size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) { error = new Error("unsafe"); return; }
				const output = new Uint8Array(retain ? size : 0);
				let at = 0;
				for (const part of chunks) { output.set(part, at); at += part.length; }
				files[file.name] = output; seen++;
			}
		};
		file.start();
	});
	unzip.register(UnzipInflate);
	for (let at = 0; at < bytes.length; at += 4096) {
		unzip.push(bytes.subarray(at, at + 4096), at + 4096 >= bytes.length);
		if (error) throw error;
	}
	if (seen !== expected.size) throw new Error("unsafe");
	return files;
}
