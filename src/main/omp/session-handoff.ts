import { createReadStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { listHosts } from "./host";
import { sessionOwnership } from "./elsewhere";
import { rpcRequests, RpcTerminationError } from "./rpc";
import { resolveSessionFile, sessionSummary } from "./sessions";

const HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;
const Identity = z.object({ sessionFile: z.string().min(1), sessionId: z.string().min(1) });
const Header = z.object({ type: z.literal("session"), id: z.string().min(1), cwd: z.string().min(1) });
const Compaction = z.object({
	type: z.literal("compaction"), id: z.string().min(1), timestamp: z.string(),
	method: z.string().optional(), summary: z.string().min(1),
});
type Journal = { header: z.infer<typeof Header> | null; ids: Set<string>; newest: z.infer<typeof Compaction> | null };

/** Keep only compaction identities and the newest summary while streaming a potentially large chat. */
async function readJournal(file: string, signal: AbortSignal): Promise<Journal> {
	const result: Journal = { header: null, ids: new Set(), newest: null };
	const stream = createReadStream(file, { encoding: "utf8", signal });
	let pending = "";
	for await (const chunk of stream) {
		pending += chunk;
		let start = 0, end: number;
		while ((end = pending.indexOf("\n", start)) !== -1) {
			const line = pending.slice(start, end);
			start = end + 1;
			if (!line.trim()) continue;
			const entry: unknown = JSON.parse(line);
			if (!entry || typeof entry !== "object" || !("type" in entry)) continue;
			if (entry.type === "session") result.header = Header.parse(entry);
			if (entry.type === "compaction") {
				result.newest = Compaction.parse(entry);
				result.ids.add(result.newest.id);
			}
		}
		pending = pending.slice(start);
	}
	if (pending.trim()) throw new Error("This saved chat has an unfinished journal entry. Wait before creating its handoff.");
	return result;
}

/** Resume the exact saved source, let omp commit its handoff, then export that committed summary. */
async function createHandoffArtifact(input: string, folder: string, focus: string, signal: AbortSignal): Promise<{ file: string }> {
	signal.throwIfAborted();
	const source = resolve(input);
	if (!source.endsWith(".jsonl")) throw new Error("Choose a saved chat file to create its handoff.");
	if (resolve(await resolveSessionFile(source)) !== source) {
		throw new Error("This saved chat has continued in another file. Reopen its latest saved chat before creating a handoff.");
	}
	const summary = await sessionSummary(source);
	if (!summary || resolve(summary.file) !== source || resolve(summary.cwd) !== resolve(folder)) {
		throw new Error("This saved chat or its working folder has changed. Reopen it before creating a handoff.");
	}
	if (listHosts().some(host => host.sessionFile !== null && resolve(host.sessionFile) === source && host.phase !== "exited") ||
		(await sessionOwnership([source])).get(source) !== "free") {
		throw new Error("This chat may be running in omp. Stop it before creating a handoff from its saved file.");
	}
	const before = await readJournal(source, signal);
	if (before.header?.id !== summary.id || resolve(before.header.cwd) !== resolve(folder)) {
		throw new Error("The saved chat identity changed before its handoff could start.");
	}
	const validateIdentity = (data: unknown) => {
		const state = Identity.parse(data);
		if (resolve(state.sessionFile) !== source || state.sessionId !== summary.id) {
			throw new Error("omp opened a different chat. A handoff from another saved file cannot be used.");
		}
	};
	signal.throwIfAborted();
	await rpcRequests(folder, [
		{ type: "get_state", validate: validateIdentity },
		{ type: "handoff", params: { customInstructions: focus }, validate: data => {
			if (!data || typeof data !== "object") throw new Error("omp cancelled the handoff before committing its summary.");
		} },
		{ type: "get_state", validate: validateIdentity },
	], {
		flags: ["--resume", source, "--no-tools", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-title"],
		timeoutMs: HANDOFF_TIMEOUT_MS, waitForExit: true, signal,
		messages: {
			timeout: "omp did not finish the handoff within ten minutes.",
			exited: "omp stopped before it confirmed the handoff.",
			failed: "omp could not create the handoff.",
		},
	});
	signal.throwIfAborted();
	const after = await readJournal(source, signal);
	if (after.header?.id !== summary.id || resolve(after.header.cwd) !== resolve(folder)) {
		throw new Error("The saved source changed while omp created its handoff. No handoff file was exported.");
	}
	const entry = after.newest;
	const newIds = [...after.ids].filter(id => !before.ids.has(id));
	if (!entry || entry.method !== "handoff" || before.ids.has(entry.id) || newIds.length !== 1) {
		throw new Error("omp did not commit a new handoff summary to this saved chat. No handoff file was exported.");
	}
	const timestamp = new Date(entry.timestamp);
	if (!Number.isFinite(timestamp.getTime())) throw new Error("omp's committed handoff has no valid timestamp.");
	const artifacts = source.slice(0, -".jsonl".length);
	const file = join(artifacts, `handoff-${timestamp.toISOString().replace(/[:.]/g, "-")}.md`);
	signal.throwIfAborted();
	await mkdir(artifacts, { recursive: true });
	signal.throwIfAborted();
	const output = await open(file, "wx");
	try {
		await output.writeFile(entry.summary, { encoding: "utf8", signal });
		signal.throwIfAborted();
	} catch (error) {
		await output.close();
		await unlink(file);
		throw error;
	}
	await output.close();
	return { file };
}

type Operation = { controller: AbortController; stopped: Promise<void>; failure: RpcTerminationError | null; source: string };

/** Operation ids reserve cancellation before asynchronous source checks or process startup. */
export class SavedSessionHandoffService {
	#operations = new Map<string, Operation>();
	#used = new Map<string, NodeJS.Timeout>();
	#sources = new Set<string>();
	#closed = false;

	constructor(private readonly run = createHandoffArtifact) {}

	#remember(id: string): void {
		if (this.#used.has(id)) return;
		this.#used.set(id, setTimeout(() => this.#used.delete(id), HANDOFF_TIMEOUT_MS).unref());
	}

	#release(id: string, operation: Operation): void {
		this.#operations.delete(id);
		this.#sources.delete(operation.source);
		this.#remember(id);
	}

	#stop(id: string, operation: Operation): Promise<void> {
		if (operation.failure) {
			const failure = operation.failure;
			operation.failure = null;
			operation.stopped = failure.retryTermination().then(() => this.#release(id, operation), error => {
				operation.failure = error instanceof RpcTerminationError ? error : failure;
				throw error;
			});
		}
		return operation.stopped;
	}

	handoff(operationId: string, file: string, folder: string, focus: string): Promise<{ file: string }> {
		if (!operationId || operationId.length > 200) return Promise.reject(new Error("The handoff operation id is invalid."));
		if (this.#closed) return Promise.reject(new Error("visual-omp is closing. The handoff was not started."));
		if (this.#operations.has(operationId) || this.#used.has(operationId)) {
			return Promise.reject(new DOMException("This handoff was cancelled or already started.", "AbortError"));
		}
		const source = resolve(file);
		if (this.#sources.has(source)) return Promise.reject(new Error("A handoff is already being created for this saved chat."));
		const controller = new AbortController();
		const operation: Operation = { controller, stopped: Promise.resolve(), failure: null, source };
		this.#sources.add(source);
		// The microtask makes the operation visible before any work can observe cancellation.
		const result = Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return this.run(source, folder, focus, controller.signal);
		}).then(result => {
			this.#release(operationId, operation);
			return result;
		}, error => {
			if (error instanceof RpcTerminationError) operation.failure = error;
			else this.#release(operationId, operation);
			throw error;
		});
		operation.stopped = result.then(() => {}, error => { if (error instanceof RpcTerminationError) throw error; });
		// Cancellation and shutdown await this separately; keep an early teardown failure handled.
		void operation.stopped.catch(() => {});
		this.#operations.set(operationId, operation);
		return result;
	}

	async cancel(operationId: string): Promise<void> {
		const operation = this.#operations.get(operationId);
		if (!operation) { this.#remember(operationId); return; }
		operation.controller.abort(new DOMException("Handoff cancelled.", "AbortError"));
		await this.#stop(operationId, operation);
	}

	async close(): Promise<void> {
		this.#closed = true;
		const operations = [...this.#operations.entries()];
		for (const [, operation] of operations) operation.controller.abort(new DOMException("Handoff cancelled because visual-omp is closing.", "AbortError"));
		const results = await Promise.allSettled(operations.map(([id, operation]) => this.#stop(id, operation)));
		const failed = results.find(result => result.status === "rejected");
		if (failed?.status === "rejected") {
			this.#closed = false;
			throw failed.reason;
		}
		for (const timer of this.#used.values()) clearTimeout(timer);
		this.#used.clear();
	}
}

const handoffs = new SavedSessionHandoffService();

/** Headless callers exercise the same production service as sessions:handoff. */
export function handoffSavedSession(operationId: string, file: string, folder: string, focus: string): Promise<{ file: string }> {
	return handoffs.handoff(operationId, file, folder, focus);
}
export function cancelSavedSessionHandoff(operationId: string): Promise<void> {
	return handoffs.cancel(operationId);
}
export function stopSavedSessionHandoffs(): Promise<void> {
	return handoffs.close();
}
