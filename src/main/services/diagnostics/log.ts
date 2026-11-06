import { createHash } from "node:crypto";
import { appendFile, mkdir, open, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { completionDiagnosticSchema } from "@shared/completion-diagnostics";

const count = z.number().int().nonnegative().finite();
const transport = z.enum(["tsp", "classic"]);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/).max(80);
const reason = z.enum(["clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction", "unknown"]);
const processType = z.enum(["Browser", "Tab", "Utility", "Zygote", "Sandbox helper", "GPU", "Pepper Plugin", "Pepper Plugin Broker", "Unknown"]);
const schemas = {
	"app-start": z.object({ version, platform: z.enum(["darwin", "win32", "linux", "freebsd", "openbsd", "netbsd", "cygwin", "aix", "sunos", "android", "haiku"]), arch: z.string().regex(/^[a-z0-9_]{1,20}$/), electron: version, transport, classic: z.boolean() }),
	"omp-version": z.object({ version: version.nullable() }),
	"crash-reporter": z.object({ started: z.boolean() }),
	"window-unresponsive": z.object({ windowId: count }),
	"window-responsive": z.object({ windowId: count, durationMs: count.nullable(), recovered: z.boolean().optional() }),
	"renderer-gone": z.object({ windowId: count, reason, exitCode: z.number().int(), reload: z.boolean() }),
	"child-gone": z.object({ type: processType, reason, exitCode: z.number().int(), serviceName: z.string().regex(/^[a-zA-Z0-9_.-]{0,100}$/) }),
	"host-start": z.object({ chatId: z.uuid(), transport }),
	"host-exit": z.object({ chatId: z.uuid(), transport, exitCode: z.number().int(), signal: z.number().int().nullable(), uptimeMs: count }),
	"collab-room": z.object({ chatId: z.uuid(), state: z.enum(["closed", "attached", "attach-retrying", "ignored"]), attempts: count }),
	"collab-resync": z.object({ chatId: z.uuid(), behindBytes: count }),
	"chat-completion": completionDiagnosticSchema,
	"renderer-visibility": z.object({ windowId: count, state: z.enum(["hidden", "visible"]) }),
	"main-exception": z.object({ kind: z.enum(["uncaughtException", "unhandledRejection"]), errorType: z.enum(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError", "NonError"]), fingerprint: z.string().regex(/^[a-f0-9]{16}$/) }),
	"report-send": z.object({ outcome: z.enum(["sent", "failed"]), status: count.nullable() }),
	"diagnostics-test": z.object({ kind: z.literal("event") }),
	"memory": z.object({ trigger: z.enum(["interval", "unresponsive"]), hosts: count, processes: z.array(z.object({ pid: count, type: processType, workingSetKiB: count })).max(256) }),
};
export type DiagnosticEvent = { [K in keyof typeof schemas]: { event: K } & z.infer<(typeof schemas)[K]> }[keyof typeof schemas];
type ExceptionDetails = Pick<Extract<DiagnosticEvent, { event: "main-exception" }>, "errorType" | "fingerprint">;

/** Project onto an explicit schema. Extra fields, messages, stacks and nested content never reach disk. */
export function formatDiagnostic(event: DiagnosticEvent, now = new Date()): string | null {
	const schema = Object.hasOwn(schemas, event.event) ? schemas[event.event] : undefined;
	if (!schema) return null;
	const result = schema.safeParse(event);
	if (!result.success) return null;
	return `${now.toISOString()} ${event.event} ${JSON.stringify(result.data)}\n`;
}

/** Retain an error category and stable identity without saving its message, stack, paths or thrown value. */
export function exceptionDetails(error: unknown): ExceptionDetails {
	const names = ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError"] as const;
	let errorType: ExceptionDetails["errorType"] = "NonError";
	let identity: string = typeof error;
	try {
		if (error instanceof Error) {
			errorType = names.find(name => name === error.name) ?? "Error";
			identity = error.stack ?? error.name;
		}
	} catch { /* A thrown object may expose throwing accessors. */ }
	return { errorType, fingerprint: createHash("sha256").update(identity).digest("hex").slice(0, 16) };
}

const MAX_BYTES = 1024 * 1024;
const MAX_PENDING = 256;

/** Two capped files and a bounded queue. All filesystem operations are asynchronous and serialized. */
export class DiagnosticsLog {
	#pending: string[] = [];
	#writing: Promise<void> | null = null;
	#size: number | null = null;
	constructor(readonly file: string, readonly maxBytes = MAX_BYTES) {}

	write(event: DiagnosticEvent): void {
		const line = formatDiagnostic(event);
		if (!line || Buffer.byteLength(line) > this.maxBytes || this.#pending.length >= MAX_PENDING) return;
		this.#pending.push(line);
		this.#start();
	}

	#start(): void {
		this.#writing ??= this.#drain().finally(() => {
			this.#writing = null;
			if (this.#pending.length) this.#start();
		});
	}

	async flush(): Promise<void> {
		while (this.#writing) await this.#writing;
	}

	async #drain(): Promise<void> {
		try {
			await mkdir(dirname(this.file), { recursive: true });
			if (this.#size === null) {
				this.#size = await stat(this.file).then(info => info.size, () => 0);
				// Bound a pre-existing file too, including files from a different cap in tests.
				const rotated = `${this.file}.1`;
				if (await stat(rotated).then(info => info.size > this.maxBytes, () => false)) await rm(rotated, { force: true });
				if (this.#size > this.maxBytes) { await truncate(this.file, 0); this.#size = 0; }
			}
			while (this.#pending.length) {
				const line = this.#pending.shift()!;
				const bytes = Buffer.byteLength(line);
				if (this.#size + bytes > this.maxBytes) {
					await rm(`${this.file}.1`, { force: true });
					await rename(this.file, `${this.file}.1`);
					this.#size = 0;
				}
				await appendFile(this.file, line, { mode: 0o600 });
				this.#size += bytes;
			}
		} catch {
			// A full or unavailable disk must not crash the app or grow a retry queue.
			this.#pending.length = 0;
			this.#size = null;
		}
	}

	/** The locally generated, schema-filtered event log only. No dump or other profile file is read. */
	async recent(lines = 100, bytes = 64 * 1024): Promise<string> {
		await this.flush();
		const limit = Math.max(0, Math.min(1000, Math.floor(lines)));
		const byteLimit = Math.max(0, Math.min(256 * 1024, Math.floor(bytes)));
		if (!limit || !byteLimit) return "";
		const selected: string[] = [];
		let total = 0;
		for (const file of [this.file, `${this.file}.1`]) {
			const handle = await open(file, "r").catch(() => null);
			if (!handle) continue;
			let text: string;
			try {
				const size = (await handle.stat()).size;
				const buffer = Buffer.alloc(Math.min(size, MAX_BYTES));
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
				text = buffer.toString("utf8", 0, bytesRead);
				if (size > buffer.length) text = text.slice(text.indexOf("\n") + 1);
			} finally { await handle.close(); }
			for (const line of text.trimEnd().split("\n").reverse()) {
				const match = /^(\S+) (\S+) (\{.*\})$/.exec(line);
				if (!match) continue;
				try {
					const safe = formatDiagnostic({ ...JSON.parse(match[3]!), event: match[2] } as DiagnosticEvent, new Date(match[1]!));
					if (!safe) continue;
					if (total + Buffer.byteLength(safe) > byteLimit || selected.length >= limit) return selected.reverse().join("");
					selected.push(safe);
					total += Buffer.byteLength(safe);
				} catch { /* Ignore incomplete or externally modified lines. */ }
			}
		}
		return selected.reverse().join("");
	}
}

/** A repeated death inside a minute stays stopped, including a sliding sequence of failures. */
export class RendererRecovery {
	#lastDeath: number | null = null;
	shouldReload(reason: string, now = Date.now()): boolean {
		if (reason === "clean-exit") return false;
		const reload = this.#lastDeath === null || now - this.#lastDeath >= 60_000;
		this.#lastDeath = now;
		return reload;
	}
}

export function diagnosticProcessType(type: string): z.infer<typeof processType> {
	return processType.safeParse(type).data ?? "Unknown";
}
export function diagnosticReason(value: string): z.infer<typeof reason> {
	return reason.safeParse(value).data ?? "unknown";
}
