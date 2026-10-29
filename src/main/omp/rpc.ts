/**
 * One request to a short-lived `omp --mode rpc` process: start omp in a folder, send a single
 * command, resolve its `data`, then stop the process. Used for listings omp offers only over RPC
 * (sign-in providers, available slash commands) and for builtin slash commands whose printed output
 * omp sends as `command_output` events before the response (`/usage reset`).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { userEnv } from "../env";
import { ompPath } from "./locate";
import { ompStartError } from "./refused";
import { OMP_DISCOVERY_ISOLATION } from "./discovery-isolation";
import { draftEnvironment } from "./draft-environment";

const RpcResponseSchema = z
	.object({ type: z.literal("response"), id: z.string(), success: z.boolean(), error: z.string().optional(), data: z.unknown().optional() })
	.loose();

export interface RpcRequestOptions {
	/** Flags after `--mode rpc` (session, tools and skills switches). */
	flags: readonly string[];
	timeoutMs: number;
	/** Error messages: no answer in time, omp exited first, omp answered with a failure and no reason. */
	messages: { timeout: string; exited: string; failed: string };
	/** Every other JSON line omp writes before the response (events such as `command_output`). */
	onMessage?: (message: unknown) => void;
	/** Wait for process termination before handing a newly written session to another host. */
	waitForExit?: boolean;
}

/** Send `{ type, ...params }` and resolve the response's `data`. */
export async function rpcRequest(folder: string, type: string, options: RpcRequestOptions, params: Record<string, unknown> = {}): Promise<unknown> {
	const [data] = await rpcRequests(folder, [{ type, params }], options);
	return data;
}

/** Execute dependent requests in one short-lived process, returning their data in order. */
export async function rpcRequests(
	folder: string,
	requests: readonly { type: string; params?: Record<string, unknown>; validate?: (data: unknown) => void }[],
	options: RpcRequestOptions,
): Promise<unknown[]> {
	if (!requests.length) return [];
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(bin, ["--mode", "rpc", ...options.flags], { cwd: folder, env: { ...env, NO_COLOR: "1" }, stdio: "pipe" });
	} catch (error) {
		throw await ompStartError(error, bin);
	}
	let index = 0;
	const results: unknown[] = [];
	let id = `vomp-${requests[0]!.type}`;
	const { promise, resolve, reject } = Promise.withResolvers<unknown[]>();
	const timer = setTimeout(() => reject(new Error(options.messages.timeout)), options.timeoutMs);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
	child.stdin.on("error", () => {});
	child.on("error", reject);
	const lines = createInterface({ input: child.stdout });
	// omp's last lines can still be buffered when the process exits, so the request fails once its
	// output has ended; a process that exits while something else holds its output open fails shortly after.
	lines.on("close", () => reject(new Error(stderr.trim() || options.messages.exited)));
	child.on("exit", () => setTimeout(() => reject(new Error(stderr.trim() || options.messages.exited)), EXIT_DRAIN_MS).unref());
	lines.on("line", line => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		const response = RpcResponseSchema.safeParse(message);
		if (!response.success || response.data.id !== id) {
			options.onMessage?.(message);
			return;
		}
		if (!response.data.success) {
			reject(new Error(response.data.error ?? options.messages.failed));
			return;
		}
		try {
			requests[index]?.validate?.(response.data.data);
		} catch (error) {
			reject(error);
			return;
		}
		results.push(response.data.data);
		const next = requests[++index];
		if (!next) resolve(results);
		else {
			id = `vomp-${next.type}-${index}`;
			child.stdin.write(`${JSON.stringify({ ...next.params, id, type: next.type })}\n`);
		}
	});
	child.stdin.write(`${JSON.stringify({ ...requests[0]!.params, id, type: requests[0]!.type })}\n`);
	try {
		const result = await promise;
		if (options.waitForExit) await stopAndWait(child);
		return result;
	} finally {
		clearTimeout(timer);
		stop(child);
	}
}

/** How long omp gets to exit by itself once its input closes (and to stop the MCP servers it started). */
const EXIT_GRACE_MS = 3000;
/** How long after omp exits its remaining output may still arrive. */
const EXIT_DRAIN_MS = 500;

/** omp in RPC mode exits when stdin closes; kill it only when it is still running after the grace period. */
function stop(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const force = setTimeout(() => child.kill(), EXIT_GRACE_MS);
	child.once("exit", () => clearTimeout(force));
	child.stdin.end();
}

/** A copied session's lease must be released before its next host starts. */
async function stopAndWait(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const exited = () => resolve();
	child.once("exit", exited);
	const terminate = setTimeout(() => child.kill(), EXIT_GRACE_MS);
	const force = setTimeout(() => child.kill("SIGKILL"), EXIT_GRACE_MS + 1000);
	const deadline = setTimeout(() => reject(new Error("omp did not stop after saving the chat. Its session lease may still be held.")), EXIT_GRACE_MS + 2000);
	child.stdin.end();
	try {
		await promise;
	} finally {
		child.off("exit", exited);
		clearTimeout(terminate);
		clearTimeout(force);
		clearTimeout(deadline);
	}
}

const DRAFT_RPC_FLAGS = ["--no-session", "--no-tools", "--no-extensions", "--no-context-files", "--no-rules", "--no-skills", "--no-lsp", "--no-title"];

/** A folder-scoped RPC transport for draft-only requests. It never sends a prompt. */
export class PersistentRpc {
	#child: ChildProcessWithoutNullStreams | null = null;
	#opening: Promise<ChildProcessWithoutNullStreams> | null = null;
	#pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	#nextId = 0;
	#closed = false;
	#privateDir: string | null = null;

	constructor(
		readonly folder: string,
		readonly flags: readonly string[],
		readonly onMessage?: (message: unknown) => void,
		readonly onTerminated?: (error: Error) => void,
	) {}

	async request(type: string, params: Record<string, unknown>, timeoutMs = 155_000): Promise<unknown> {
		if (this.#closed) throw new Error("omp prediction process is closed.");
		const child = await this.#open();
		if (this.#closed) throw new Error("omp prediction process is closed.");
		const id = `vomp-draft-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error("omp did not answer the draft request in time."));
		}, timeoutMs);
		this.#pending.set(id, { resolve, reject, timer });
		child.stdin.write(`${JSON.stringify({ ...params, id, type })}\n`);
		return promise;
	}

	close(force = false): void {
		this.#closed = true;
		if (this.#child) {
			if (force) this.#child.kill();
			else stop(this.#child);
		}
		this.#fail(new Error("omp prediction process is closed."));
		this.#cleanup();
	}

	#fail(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#cleanup(): void {
		const directory = this.#privateDir;
		this.#privateDir = null;
		if (directory) rmSync(directory, { recursive: true, force: true });
	}

	#open(): Promise<ChildProcessWithoutNullStreams> {
		if (this.#child) return Promise.resolve(this.#child);
		if (this.#opening) return this.#opening;
		const opening = Promise.all([ompPath(), userEnv()]).then(async ([bin, env]) => {
			if (this.#closed) throw new Error("omp prediction process is closed.");
			this.#privateDir = await mkdtemp(join(tmpdir(), "vomp-draft-"));
			const overlay = join(this.#privateDir, "isolation.yml");
			await writeFile(overlay, JSON.stringify(OMP_DISCOVERY_ISOLATION), { mode: 0o600 });
			if (this.#closed) { this.#cleanup(); throw new Error("omp prediction process is closed."); }
			// Isolation must remain the last overlay, after project and caller-supplied configuration.
			const child = spawn(bin, ["--mode", "rpc", ...this.flags, ...DRAFT_RPC_FLAGS, "--config", overlay], { cwd: this.folder, env: draftEnvironment(env), stdio: "pipe" });
			this.#child = child;
			child.stderr.resume();
			const failed = (error: Error) => {
				if (this.#child !== child) return;
				this.#child = null;
				this.#fail(error);
				this.#cleanup();
				if (!this.#closed) this.onTerminated?.(error);
			};
			child.stdin.on("error", failed);
			child.on("error", failed);
			const lines = createInterface({ input: child.stdout });
			lines.on("close", () => failed(new Error("omp prediction process stopped.")));
			child.on("exit", () => setTimeout(() => failed(new Error("omp prediction process stopped.")), EXIT_DRAIN_MS).unref());
			lines.on("line", line => {
				let value: unknown;
				try { value = JSON.parse(line); } catch { return; }
				const parsed = RpcResponseSchema.safeParse(value);
				if (!parsed.success) { this.onMessage?.(value); return; }
				const response = parsed.data;
				const pending = this.#pending.get(response.id);
				if (!pending) return;
				this.#pending.delete(response.id);
				clearTimeout(pending.timer);
				if (response.success) pending.resolve(response.data);
				else pending.reject(new Error(response.error ?? "omp rejected the draft request."));
			});
			return child;
		}).catch(error => { this.#cleanup(); throw error; }).finally(() => { if (this.#opening === opening) this.#opening = null; });
		this.#opening = opening;
		return opening;
	}
}
