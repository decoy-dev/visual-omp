/**
 * Client for omp's `OMP_TUI_DEBUG` NDJSON socket (packages/tui/src/debug-server.ts): injects input
 * through the TUI's own pipeline and reports focus, overlays and painted screen text.
 *
 * The server answers requests on one connection strictly in order, so responses are matched FIFO.
 * `/restart` re-execs omp in place and re-listens on the same path; the client reconnects lazily.
 */
import { connect, type Socket } from "node:net";
import { z } from "zod";
import type { TuiFocus } from "@shared/ipc";

const Info = z.object({
	ok: z.literal(true),
	overlays: z.number(),
	focused: z.string().nullable(),
	alt_screen: z.boolean(),
});

interface TreeNode {
	kind: string;
	children?: TreeNode[];
}
const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
	z.object({ kind: z.string(), children: z.array(TreeNodeSchema).optional() }),
);
const Tree = z.object({
	ok: z.literal(true),
	tree: z.object({ overlays: z.array(z.object({ hidden: z.boolean().optional(), root: TreeNodeSchema })) }),
});
const Text = z.object({ ok: z.literal(true), lines: z.array(z.string()) });
const Values = z.object({ ok: z.literal(true), values: z.record(z.string(), z.unknown()) });
const Failure = z.object({ ok: z.literal(false), error: z.string() });

interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 3000;

export class TuiDebugClient {
	readonly #path: string;
	#socket: Socket | null = null;
	#connecting: Promise<Socket> | null = null;
	#buffer = "";
	readonly #pending: Pending[] = [];

	constructor(path: string) {
		this.#path = path;
	}

	async info(): Promise<TuiFocus> {
		const info = Info.parse(await this.#request({ op: "info" }));
		let overlayKinds: string[] = [];
		if (info.overlays > 0) {
			const tree = Tree.parse(await this.#request({ op: "tree" }));
			overlayKinds = tree.tree.overlays.filter(overlay => !overlay.hidden).map(overlay => overlay.root.kind);
		}
		return { overlays: info.overlays, focused: info.focused, altScreen: info.alt_screen, overlayKinds };
	}

	async screen(): Promise<string[]> {
		return Text.parse(await this.#request({ op: "text" })).lines;
	}

	/** Component debug state (`debugState()` of each TUI component, keyed by kind/id). */
	async values(): Promise<Record<string, unknown>> {
		return Values.parse(await this.#request({ op: "values" })).values;
	}

	/** Press tmux-style key tokens, e.g. `"escape"`, `"down down enter"`, `"C-q"`. */
	async keys(keys: string): Promise<void> {
		await this.#request({ op: "keys", keys });
	}

	close(): void {
		this.#socket?.destroy();
		this.#socket = null;
		this.#failAll(new Error("debug client closed"));
	}

	async #request(body: Record<string, unknown>): Promise<unknown> {
		const socket = await this.#connect();
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const timer = setTimeout(() => {
			const index = this.#pending.findIndex(entry => entry.timer === timer);
			if (index >= 0) this.#pending.splice(index, 1);
			// A timed-out slot desynchronises FIFO matching; start over on a fresh connection.
			this.#socket?.destroy();
			reject(new Error(`TUI debug ${String(body.op)} timed out`));
		}, REQUEST_TIMEOUT_MS);
		this.#pending.push({ resolve, reject, timer });
		socket.write(`${JSON.stringify(body)}\n`);
		const response = await promise;
		const failure = Failure.safeParse(response);
		if (failure.success) throw new Error(failure.data.error);
		return response;
	}

	#connect(): Promise<Socket> {
		if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
		if (this.#connecting) return this.#connecting;
		const { promise, resolve, reject } = Promise.withResolvers<Socket>();
		this.#connecting = promise;
		const socket = connect(this.#path);
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			this.#socket = socket;
			this.#connecting = null;
			resolve(socket);
		});
		socket.once("error", error => {
			this.#connecting = null;
			reject(error);
		});
		socket.on("data", chunk => this.#onData(String(chunk)));
		socket.on("close", () => {
			if (this.#socket === socket) this.#socket = null;
			this.#buffer = "";
			this.#failAll(new Error("TUI debug socket closed"));
		});
		return promise;
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		let newline = this.#buffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			const pending = this.#pending.shift();
			if (pending) {
				clearTimeout(pending.timer);
				try {
					pending.resolve(JSON.parse(line));
				} catch (error) {
					pending.reject(error instanceof Error ? error : new Error(String(error)));
				}
			}
			newline = this.#buffer.indexOf("\n");
		}
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.splice(0)) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}
