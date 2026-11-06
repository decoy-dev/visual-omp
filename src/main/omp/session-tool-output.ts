import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SavedOutputBlock, SavedToolOutput } from "@shared/session-output";
import { userEnv } from "../env";
import { helperFileValidation } from "./helper-file";
import { sessionsDir } from "./paths";

const SCAN_BYTES = 64 * 1024 * 1024;
const LINE_BYTES = 16 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const AUTO_BYTES = 256 * 1024;
const MANUAL_BYTES = 1024 * 1024;
const unavailable: SavedToolOutput = { status: "unavailable" };
export const SAVED_TOOL_OUTPUT_LIMITS = { scanBytes: SCAN_BYTES, lineBytes: LINE_BYTES, autoBytes: AUTO_BYTES, manualBytes: MANUAL_BYTES } as const;
const tooLarge: SavedToolOutput = { status: "too-large" };

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only indexed project files or explicitly registered helper files are eligible, never artifacts. */
async function validationFor(file: string): Promise<(handle: FileHandle) => Promise<void>> {
	const helper = helperFileValidation(file);
	if (helper) return helper;
	const root = resolve(sessionsDir(await userEnv()));
	const within = relative(root, file);
	const parts = within.split(sep);
	if (isAbsolute(within) || parts.length !== 2 || parts.some(part => !part || part === "." || part === "..")) throw new Error("Not a project session file");
	const canonicalRoot = await realpath(root);
	return async handle => {
		const [bucket, current, opened, canonicalFile, currentRoot] = await Promise.all([
			lstat(dirname(file)), lstat(file), handle.stat(), realpath(file), realpath(root),
		]);
		if (!bucket.isDirectory() || bucket.isSymbolicLink() || !current.isFile() || current.isSymbolicLink() ||
			!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino ||
			currentRoot !== canonicalRoot || canonicalFile !== join(canonicalRoot, within)) throw new Error("Session path changed");
	};
}

function contentOf(value: unknown, limit: number): SavedToolOutput {
	if (!Array.isArray(value)) return unavailable;
	const content: SavedOutputBlock[] = [];
	let bytes = 2; // JSON array brackets, including the escaping and UTF-8 cost of each block below.
	for (const item of value) {
		if (!record(item) || typeof item.type !== "string") return unavailable;
		const block: SavedOutputBlock = { type: item.type };
		for (const key of ["text", "data", "mimeType"] as const) {
			if (item[key] !== undefined) {
				if (typeof item[key] !== "string") return unavailable;
				block[key] = item[key];
			}
		}
		bytes += Buffer.byteLength(JSON.stringify(block), "utf8") + (content.length ? 1 : 0);
		if (bytes > limit) return tooLarge;
		content.push(block);
	}
	return { status: "ready", content };
}

const QUEUED_REQUESTS = 128;
const BATCH_CALLS = 16;
type OutputRequest = {
	file: string;
	toolCallId: string;
	manual: boolean;
	resolve: (result: SavedToolOutput) => void;
};
const pendingRequests: OutputRequest[] = [];
let draining = false;

/** Read one exact physical session once for a bounded batch. Never return details/trace. */
async function scanSavedToolOutputs(file: string, requests: readonly OutputRequest[]): Promise<SavedToolOutput[]> {
	const results: (SavedToolOutput | undefined)[] = requests.map(() => undefined);
	const wanted = new Map<string, number[]>();
	for (const [index, request] of requests.entries()) {
		const indices = wanted.get(request.toolCallId);
		if (indices) indices.push(index);
		else wanted.set(request.toolCallId, [index]);
	}
	const finishPending = (result: SavedToolOutput): void => {
		for (const indices of wanted.values()) for (const index of indices) results[index] = result;
		wanted.clear();
	};
	let handle: FileHandle | undefined;
	try {
		const validate = await validationFor(file);
		// Nonblocking open also avoids hanging if a regular file is raced into a FIFO.
		if (!(await lstat(file)).isFile()) return requests.map(() => unavailable);
		handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
		await validate(handle);
		const initial = await handle.stat();
		const end = Math.min(initial.size, SCAN_BYTES);
		const chunk = Buffer.alloc(CHUNK_BYTES);
		let pending: Buffer | undefined;
		let pendingBytes = 0;
		let position = 0;
		let header: Buffer | undefined;
		let headerEnd = 0;
		let titleSeen = false;
		const consume = (line: Buffer, lineEnd: number): void => {
			const text = line.toString("utf8");
			if (!text.trim()) return;
			let entry: unknown;
			try { entry = JSON.parse(text); } catch { finishPending(unavailable); return; }
			if (!record(entry)) { finishPending(unavailable); return; }
			if (!header) {
				if (!titleSeen && entry.type === "title" && (entry.title === undefined || typeof entry.title === "string")) { titleSeen = true; return; }
				if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id.trim() ||
					typeof entry.cwd !== "string" || !isAbsolute(entry.cwd)) { finishPending(unavailable); return; }
				header = Buffer.from(line);
				headerEnd = lineEnd;
				return;
			}
			if (entry.type === "session") { finishPending(unavailable); return; }
			const message = entry.message;
			if (entry.type !== "message" || !record(message) || message.role !== "toolResult" ||
				message.toolName !== "bash" || typeof message.toolCallId !== "string") return;
			const indices = wanted.get(message.toolCallId);
			if (!indices) return;
			let automatic: SavedToolOutput | undefined;
			let manual: SavedToolOutput | undefined;
			for (const index of indices) {
				results[index] = requests[index]!.manual
					? (manual ??= contentOf(message.content, MANUAL_BYTES))
					: (automatic ??= contentOf(message.content, AUTO_BYTES));
			}
			wanted.delete(message.toolCallId);
		};
		while (position < end && wanted.size) {
			const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - position), position);
			if (!bytesRead) { finishPending(unavailable); break; }
			let start = 0;
			while (start < bytesRead && wanted.size) {
				const newline = chunk.indexOf(0x0a, start);
				const stop = newline >= 0 && newline < bytesRead ? newline : bytesRead;
				const length = stop - start;
				if (pendingBytes + length > LINE_BYTES) { finishPending(tooLarge); break; }
				if (stop === bytesRead || pendingBytes) {
					if (!pending || pending.length < pendingBytes + length) {
						const grown = Buffer.allocUnsafe(Math.min(LINE_BYTES, Math.max(CHUNK_BYTES, (pending?.length ?? 0) * 2, pendingBytes + length)));
						if (pendingBytes) pending!.copy(grown, 0, 0, pendingBytes);
						pending = grown;
					}
					chunk.copy(pending, pendingBytes, start, stop);
					pendingBytes += length;
				}
				if (stop < bytesRead) {
					consume(pendingBytes ? pending!.subarray(0, pendingBytes) : chunk.subarray(start, stop), position + stop + 1);
					pendingBytes = 0;
				}
				start = stop + 1;
			}
			position += bytesRead;
		}
		finishPending(initial.size > SCAN_BYTES ? tooLarge : unavailable);
		if (header && results.some(result => result?.status === "ready")) {
			// Reject atomic replacement, truncation and changed session identity during this read.
			await validate(handle);
			const current = await stat(file);
			if (current.size < initial.size) return requests.map(() => unavailable);
			const check = Buffer.alloc(header.length);
			const { bytesRead } = await handle.read(check, 0, check.length, headerEnd - header.length - 1);
			if (bytesRead !== check.length || !check.equals(header)) return requests.map(() => unavailable);
		}
		// Every index was filled by its matched record or finishPending above.
		return results as SavedToolOutput[];
	} catch {
		return requests.map(() => unavailable);
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function drainRequests(): Promise<void> {
	try {
		while (pendingRequests.length) {
			const file = pendingRequests[0]!.file;
			const batch: OutputRequest[] = [];
			for (let index = 0; index < pendingRequests.length && batch.length < BATCH_CALLS;) {
				if (pendingRequests[index]!.file === file) batch.push(pendingRequests.splice(index, 1)[0]!);
				else index++;
			}
			const results = await scanSavedToolOutputs(file, batch);
			for (const [index, request] of batch.entries()) request.resolve(results[index]!);
		}
	} finally {
		draining = false;
	}
}

/** Queue bounded work globally, coalescing same-file callers before opening their exact file. */
export async function loadSavedToolOutput(file: string, toolCallId: string, manual?: boolean): Promise<SavedToolOutput> {
	if (typeof file !== "string" || !isAbsolute(file) || file.includes("\0") || !file.endsWith(".jsonl") ||
		typeof toolCallId !== "string" || !toolCallId || toolCallId.includes("\0") || toolCallId.length > 4096 ||
		(manual !== undefined && typeof manual !== "boolean")) return unavailable;
	if (pendingRequests.length >= QUEUED_REQUESTS) return unavailable;
	file = resolve(file);
	const request = Promise.withResolvers<SavedToolOutput>();
	pendingRequests.push({ file, toolCallId, manual: manual === true, resolve: request.resolve });
	if (!draining) {
		draining = true;
		// Gather concurrent IPC deliveries before taking the first bounded batch.
		setImmediate(() => { void drainRequests(); });
	}
	return request.promise;
}
