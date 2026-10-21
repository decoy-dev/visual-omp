/**
 * One request to a short-lived `omp --mode rpc` process: start omp in a folder, send a single
 * command, resolve its `data`, then stop the process. Used for listings omp offers only over RPC
 * (sign-in providers, available slash commands) and for builtin slash commands whose printed output
 * omp sends as `command_output` events before the response (`/usage reset`).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { userEnv } from "../env";
import { ompPath } from "./locate";
import { ompStartError } from "./refused";

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
}

/** Send `{ type, ...params }` and resolve the response's `data`. */
export async function rpcRequest(folder: string, type: string, options: RpcRequestOptions, params: Record<string, unknown> = {}): Promise<unknown> {
	const [bin, env] = await Promise.all([ompPath(), userEnv()]);
	let child: ChildProcessWithoutNullStreams;
	try {
		child = spawn(bin, ["--mode", "rpc", ...options.flags], { cwd: folder, env: { ...env, NO_COLOR: "1" }, stdio: "pipe" });
	} catch (error) {
		throw await ompStartError(error, bin);
	}
	const id = `vomp-${type}`;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const timer = setTimeout(() => reject(new Error(options.messages.timeout)), options.timeoutMs);
	child.stderr.resume();
	child.stdin.on("error", () => {});
	child.on("error", reject);
	const lines = createInterface({ input: child.stdout });
	// omp's last lines can still be buffered when the process exits, so the request fails once its
	// output has ended; a process that exits while something else holds its output open fails shortly after.
	lines.on("close", () => reject(new Error(options.messages.exited)));
	child.on("exit", () => setTimeout(() => reject(new Error(options.messages.exited)), EXIT_DRAIN_MS).unref());
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
		if (response.data.success) resolve(response.data.data);
		else reject(new Error(response.data.error ?? options.messages.failed));
	});
	child.stdin.write(`${JSON.stringify({ ...params, id, type })}\n`);
	try {
		return await promise;
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
