import { open } from "node:fs/promises";

/**
 * When you last sent a chat a message, read from its session file. Recent activity sorts chats and projects by it, so
 * omp's replies, tool steps and helper results, which only append other entries, never move a chat.
 */

/** Bytes read per step. */
const CHUNK = 64 * 1024;
/** Bytes of one line kept while reading back to its start: the entry fields and the start of the message. */
const LINE_HEAD = 64 * 1024;
/** Bytes before a read's end kept to tell a later append from a rewrite of the same file. */
const TAIL = 64;
/** Appended bytes read forward at most; a bigger change is read back from the end instead. */
const APPEND_LIMIT = 8 * 1024 * 1024;

const NEWLINE = 0x0a;
const ENTRY = Buffer.from('{"type":"message"');
const USER = Buffer.from('"message":{"role":"user"');
const TIMESTAMP = /"timestamp":"([^"]+)"/;
/** omp marks the user messages it writes itself (summaries, recorded transcripts) as the agent's. */
const AGENT_WRITTEN = [Buffer.from('"attribution":"agent"'), Buffer.from('"synthetic":true')];

export interface PromptScan {
	/** Epoch ms of the newest message you sent, or null when the file has none. */
	at: number | null;
	/** Byte offset just past the last complete line read; a line omp is still writing is read next time. */
	end: number;
	/** The file's inode and up to `TAIL` bytes before `end`, so a rewrite is read again instead of as an append. */
	ino: number;
	tail: Buffer;
}

const agentWritten = (bytes: Buffer) => AGENT_WRITTEN.some(marker => bytes.indexOf(marker) !== -1);

/**
 * The time of a session line that records a message you sent, or null. `line` may be only the head of a longer line,
 * with `agent` saying whether the rest marked it as omp's own. JSON escapes quotes inside text, so the matched keys can
 * only be the entry's own.
 */
export function promptTime(line: Buffer, agent = false): number | null {
	if (line.length < ENTRY.length || !line.subarray(0, ENTRY.length).equals(ENTRY)) return null;
	const user = line.indexOf(USER);
	if (user === -1 || agent || agentWritten(line)) return null;
	const stamp = TIMESTAMP.exec(line.subarray(0, user).toString("utf8"))?.[1];
	const time = stamp ? Date.parse(stamp) : NaN;
	return Number.isFinite(time) ? time : null;
}

/** Read back from the end of the file, as far as it takes, for the newest message you sent. */
export async function newestPrompt(file: string, size: number, ino: number): Promise<PromptScan> {
	const handle = await open(file, "r");
	try {
		let end: number | null = null;
		let at: number | null = null;
		// The start of a line that began before the bytes read so far (at most `LINE_HEAD` bytes of it), and whether
		// the part of it already read marked it as omp's own.
		let carry = Buffer.alloc(0);
		let carryAgent = false;
		let position = size;
		scan: while (position > 0) {
			const start = Math.max(0, position - CHUNK);
			const chunk = Buffer.alloc(position - start);
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
			const buffer = carry.length > 0 ? Buffer.concat([chunk.subarray(0, bytesRead), carry]) : chunk.subarray(0, bytesRead);
			position = start;
			let cursor = buffer.length;
			if (end === null) {
				const last = buffer.lastIndexOf(NEWLINE);
				// Everything here belongs to the line omp is still writing.
				if (last === -1) continue;
				end = start + last + 1;
				cursor = last;
			}
			// The first line read here ends with the carried bytes.
			let lineAgent: boolean = carryAgent;
			for (;;) {
				const newline = cursor > 0 ? buffer.lastIndexOf(NEWLINE, cursor - 1) : -1;
				const line = buffer.subarray(newline + 1, cursor);
				if (newline === -1 && start > 0) {
					carryAgent = lineAgent || agentWritten(line);
					carry = Buffer.from(line.subarray(0, LINE_HEAD));
					break;
				}
				at = promptTime(line, lineAgent);
				if (at !== null || newline === -1) break scan;
				cursor = newline;
				lineAgent = false;
			}
		}
		const last = end ?? 0;
		const tail = Buffer.alloc(Math.min(TAIL, last));
		await handle.read(tail, 0, tail.length, last - tail.length);
		return { at, end: last, ino, tail };
	} finally {
		await handle.close();
	}
}

/**
 * Read what omp appended since `previous`. omp only appends while it works, so a change that appended nothing, and a
 * file that was replaced, shrank, or grew by more than `APPEND_LIMIT`, is read back from its end again. So is one whose
 * bytes before `previous.end` differ, a heuristic that catches a rewrite unless it kept those last 64 bytes. A rewrite
 * that holds no message you sent keeps the earlier time.
 */
export async function appendedPrompt(file: string, size: number, ino: number, previous: PromptScan): Promise<PromptScan> {
	const again = async () => {
		const scan = await newestPrompt(file, size, ino);
		return { ...scan, at: scan.at ?? previous.at };
	};
	if (ino !== previous.ino || size <= previous.end || size - previous.end > APPEND_LIMIT) return again();
	const from = previous.end - previous.tail.length;
	const handle = await open(file, "r");
	let read: Buffer;
	try {
		const buffer = Buffer.alloc(size - from);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
		read = buffer.subarray(0, bytesRead);
	} finally {
		await handle.close();
	}
	if (read.length < previous.tail.length || !read.subarray(0, previous.tail.length).equals(previous.tail)) return again();
	const appended = read.subarray(previous.tail.length);
	const last = appended.lastIndexOf(NEWLINE);
	if (last === -1) return previous;
	let at = previous.at;
	for (let start = 0; start <= last;) {
		const newline = appended.indexOf(NEWLINE, start);
		at = promptTime(appended.subarray(start, newline)) ?? at;
		start = newline + 1;
	}
	const end = previous.end + last + 1;
	return { at, end, ino, tail: Buffer.from(read.subarray(Math.max(0, end - from - TAIL), end - from)) };
}
