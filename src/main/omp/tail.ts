/**
 * Incremental reader for a session file another omp process is writing.
 *
 * omp appends one JSON line per entry and rewrites only the fixed-width title slot (first 256
 * bytes) in place (`session-listing.ts`). {@link SessionTail} reads the bytes appended since the
 * last read, hands out complete lines and leaves a partial trailing line for the next read. A
 * shorter file, a new inode, or changed bytes just before the read offset mean the file was
 * rewritten, so the whole file is read again (`reset`).
 *
 * Limit: the in-place check compares only the last {@link GUARD_BYTES} bytes before the offset.
 * A same-inode rewrite that keeps those bytes and does not shrink the file between two reads
 * (including truncate-and-regrow past the offset) is taken for an append. omp's own full
 * rewrites publish through rename (new inode), which is always detected.
 */
import { type FileHandle, open } from "node:fs/promises";

/** omp's `SESSION_TITLE_SLOT_BYTES`: the title slot line, newline included. */
const TITLE_SLOT_BYTES = 256;
/** Bytes before the read offset compared on every read to detect an in-place rewrite. */
const GUARD_BYTES = 64;
const NEWLINE = 0x0a;

export interface TailUpdate {
	/** Complete JSONL lines (each ending in "\n"). */
	text: string;
	/** `text` is the whole file rather than a continuation. */
	reset: boolean;
}

async function readRange(handle: FileHandle, from: number, to: number): Promise<Buffer> {
	const buffer = Buffer.alloc(Math.max(0, to - from));
	let filled = 0;
	while (filled < buffer.length) {
		const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, from + filled);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

/** The physical title slot line (with its newline), or "" when the file has none. */
function titleSlotOf(head: Buffer): string {
	const newline = head.indexOf(NEWLINE);
	if (newline < 0 || newline >= TITLE_SLOT_BYTES) return "";
	const line = head.subarray(0, newline + 1).toString("utf8");
	return /^\{\s*"type"\s*:\s*"title"/.test(line) ? line : "";
}

/** Incremental reader for one append-only session file. */
export class SessionTail {
	readonly file: string;
	#ino = -1;
	#offset = 0;
	#guard: Buffer = Buffer.alloc(0);
	#slot = "";
	#size = -1;
	#mtimeMs = -1;

	constructor(file: string) {
		this.file = file;
	}

	/**
	 * What changed since the last read; null when nothing new is complete. Throws when the file
	 * cannot be opened, stat'ed or read (missing, permissions), so callers can tell unchanged from
	 * unreadable; the next successful read continues from the same offset.
	 */
	async read(): Promise<TailUpdate | null> {
		const handle = await open(this.file, "r");
		try {
			const stats = await handle.stat();
			if (stats.ino !== this.#ino || stats.size < this.#offset) return await this.#readAll(handle, stats.ino, stats.size, stats.mtimeMs);
			if (stats.size === this.#size && stats.mtimeMs === this.#mtimeMs) return null;
			const from = this.#offset - this.#guard.length;
			const bytes = await readRange(handle, from, stats.size);
			if (!bytes.subarray(0, this.#guard.length).equals(this.#guard)) return await this.#readAll(handle, stats.ino, stats.size, stats.mtimeMs);
			this.#size = stats.size;
			this.#mtimeMs = stats.mtimeMs;
			const end = bytes.lastIndexOf(NEWLINE) + 1;
			let text = end > this.#guard.length ? bytes.subarray(this.#guard.length, end).toString("utf8") : "";
			if (end > this.#guard.length) this.#advance(bytes, from, end);
			// A title rename rewrites the slot in place; resend it so the reader picks up the new title.
			const slot = titleSlotOf(await readRange(handle, 0, Math.min(TITLE_SLOT_BYTES, stats.size)));
			if (slot !== this.#slot) {
				this.#slot = slot;
				text = slot + text;
			}
			return text ? { text, reset: false } : null;
		} finally {
			await handle.close();
		}
	}

	async #readAll(handle: FileHandle, ino: number, size: number, mtimeMs: number): Promise<TailUpdate> {
		const bytes = await readRange(handle, 0, size);
		const end = bytes.lastIndexOf(NEWLINE) + 1;
		this.#ino = ino;
		this.#size = bytes.length;
		this.#mtimeMs = mtimeMs;
		this.#offset = 0;
		this.#guard = Buffer.alloc(0);
		this.#advance(bytes, 0, end);
		this.#slot = titleSlotOf(bytes.subarray(0, TITLE_SLOT_BYTES));
		return { text: bytes.subarray(0, end).toString("utf8"), reset: true };
	}

	/** Consume `bytes[..end]` (read from file offset `from`) and remember its last bytes as the guard. */
	#advance(bytes: Buffer, from: number, end: number): void {
		this.#offset = from + end;
		this.#guard = Buffer.from(bytes.subarray(Math.max(0, end - GUARD_BYTES), end));
	}
}
