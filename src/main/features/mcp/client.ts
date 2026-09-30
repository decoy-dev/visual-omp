/**
 * Minimal MCP client for `mcp:test`: one short-lived connection over stdio (newline-delimited JSON-RPC),
 * Streamable HTTP (POST with JSON or SSE responses, `Mcp-Session-Id`, `MCP-Protocol-Version`) or legacy SSE
 * (GET event stream + `endpoint` event + POSTs). Mirrors omp's handshake (packages/coding-agent/src/mcp/client.ts)
 * and its pre-connect `env`/`headers` resolution (mcp/manager.ts + config/resolve-config-value.ts).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type {
	McpPromptInfo,
	McpResourceInfo,
	McpServerConfig,
	McpTestResult,
	McpTestStage,
	McpToolInfo,
	McpTransport,
} from "@shared/contracts/mcp";
import { expandEnvVarsDeep, JsonRecord, normalizeEntry, transportOf, validateServerConfig } from "./config";

/** Latest MCP revision omp negotiates (`MCP_PROTOCOL_VERSION`). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

const STDERR_LIMIT = 8 * 1024;
const COMMAND_VALUE_TIMEOUT_MS = 10_000;
const MAX_PAGES = 50;

export interface TestRequest {
	config: McpServerConfig;
	/** Project directory (stdio default cwd, `!command` cwd, advertised root). */
	cwd?: string;
	timeoutMs: number;
	/** Base environment (the user's login-shell env). */
	env: NodeJS.ProcessEnv;
	clientInfo: { name: string; version: string };
}

interface FailureDetails {
	stage?: McpTestStage;
	timedOut?: boolean;
	httpStatus?: number;
	authChallenge?: string | null;
	exitCode?: number | null;
	exitSignal?: string | null;
}

class TestFailure extends Error {
	constructor(
		message: string,
		readonly details: FailureDetails = {},
	) {
		super(message);
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Framing (pure)
// ---------------------------------------------------------------------------------------------------------------

/** Split newline-delimited text; `rest` is the trailing partial line. */
export function splitLines(buffer: string): { lines: string[]; rest: string } {
	const parts = buffer.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.map(line => line.replace(/\r$/, "")), rest };
}

export interface SseEvent {
	event: string;
	data: string;
	id: string | null;
}

/** Incremental `text/event-stream` parser (WHATWG rules: `event`/`data`/`id` fields, comments, blank-line dispatch). */
export class SseParser {
	#buffer = "";
	#event = "";
	#data: string[] = [];
	#id: string | null = null;

	push(chunk: string): SseEvent[] {
		this.#buffer += chunk;
		const events: SseEvent[] = [];
		for (;;) {
			const match = /\r\n|\n|\r/.exec(this.#buffer);
			if (!match) break;
			// A lone trailing CR may be the first half of CRLF: wait for the next chunk.
			if (match[0] === "\r" && match.index === this.#buffer.length - 1) break;
			const line = this.#buffer.slice(0, match.index);
			this.#buffer = this.#buffer.slice(match.index + match[0].length);
			if (line === "") {
				if (this.#data.length > 0) events.push({ event: this.#event || "message", data: this.#data.join("\n"), id: this.#id });
				this.#event = "";
				this.#data = [];
				continue;
			}
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (field === "event") this.#event = value;
			else if (field === "data") this.#data.push(value);
			else if (field === "id") this.#id = value;
		}
		return events;
	}
}

// ---------------------------------------------------------------------------------------------------------------
// JSON-RPC session
// ---------------------------------------------------------------------------------------------------------------

const RpcId = z.union([z.string(), z.number()]);
const RpcMessage = z.looseObject({
	id: RpcId.nullable().optional(),
	method: z.string().optional(),
	params: z.unknown().optional(),
	result: z.unknown().optional(),
	error: z.looseObject({ code: z.number(), message: z.string(), data: z.unknown().optional() }).optional(),
});

interface Transport {
	/** HTTP delivers a request's response within `send`; the others deliver it asynchronously. */
	readonly respondsInline: boolean;
	open(): Promise<void>;
	send(message: Record<string, unknown>): Promise<void>;
	setProtocolVersion(version: string): void;
	close(): Promise<void>;
}

interface TransportEvents {
	onMessage(value: unknown): void;
	onClose(error: TestFailure): void;
}

class RpcSession implements TransportEvents {
	#transport: Transport | null = null;

	get hasTransport(): boolean {
		return this.#transport !== null;
	}

	get transport(): Transport {
		if (!this.#transport) throw new TestFailure("Transport not initialized");
		return this.#transport;
	}

	set transport(transport: Transport) {
		this.#transport = transport;
	}
	#nextId = 1;
	#pending = new Map<string | number, PromiseWithResolvers<unknown>>();
	#closed: TestFailure | null = null;

	constructor(private readonly rootDir: string) {}

	onMessage(value: unknown): void {
		const messages = Array.isArray(value) ? value : [value];
		for (const item of messages) {
			const parsed = RpcMessage.safeParse(item);
			if (!parsed.success) continue;
			const message = parsed.data;
			if (message.method !== undefined) {
				if (message.id !== undefined && message.id !== null) void this.#answer(message.id, message.method);
				continue;
			}
			if (message.id === undefined || message.id === null) continue;
			const pending = this.#pending.get(message.id);
			if (!pending) continue;
			this.#pending.delete(message.id);
			if (message.error) pending.reject(new TestFailure(`${message.error.message} (JSON-RPC ${message.error.code})`));
			else pending.resolve(message.result);
		}
	}

	onClose(error: TestFailure): void {
		this.#closed ??= error;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	/** Standard server→client requests omp answers: `ping` and `roots/list`. */
	async #answer(id: string | number, method: string): Promise<void> {
		const reply =
			method === "ping"
				? { jsonrpc: "2.0", id, result: {} }
				: method === "roots/list"
					? { jsonrpc: "2.0", id, result: { roots: [{ uri: pathToFileURL(this.rootDir).href, name: basename(this.rootDir) }] } }
					: { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } };
		await this.transport.send(reply).catch(() => undefined);
	}

	async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (this.#closed) throw this.#closed;
		const id = this.#nextId++;
		const pending = Promise.withResolvers<unknown>();
		this.#pending.set(id, pending);
		try {
			await this.transport.send({ jsonrpc: "2.0", id, method, params });
		} catch (error) {
			this.#pending.delete(id);
			throw error;
		}
		if (this.transport.respondsInline && this.#pending.has(id)) {
			this.#pending.delete(id);
			throw new TestFailure(`Server returned no response to ${method}`);
		}
		return pending.promise;
	}

	notify(method: string): Promise<void> {
		return this.transport.send({ jsonrpc: "2.0", method });
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------------------------

/** Quote one argument for `cmd.exe /s /c`. */
function cmdQuote(arg: string): string {
	return /^[\w\-./\\:=@+]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

class StdioTransport implements Transport {
	readonly respondsInline = false;
	stderr = "";
	#child: ChildProcess | null = null;
	#exited: Promise<void> | null = null;

	constructor(
		private readonly command: string,
		private readonly args: string[],
		private readonly cwd: string,
		private readonly env: NodeJS.ProcessEnv,
		private readonly events: TransportEvents,
	) {}

	#appendStderr(text: string): void {
		this.stderr = (this.stderr + text).slice(-STDERR_LIMIT);
	}

	async open(): Promise<void> {
		const windows = process.platform === "win32";
		const child = windows
			? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[this.command, ...this.args].map(cmdQuote).join(" ")}"`], {
					cwd: this.cwd,
					env: this.env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
					windowsVerbatimArguments: true,
				})
			: spawn(this.command, this.args, { cwd: this.cwd, env: this.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
		this.#child = child;
		const exited = Promise.withResolvers<void>();
		this.#exited = exited.promise;
		const spawned = Promise.withResolvers<void>();

		child.once("spawn", () => spawned.resolve());
		child.once("error", error => {
			const missing = "code" in error && error.code === "ENOENT";
			const failure = new TestFailure(missing ? `Command not found: ${this.command}` : error.message, { stage: "spawn" });
			spawned.reject(failure);
			this.events.onClose(failure);
			exited.resolve();
		});
		child.once("exit", (code, signal) => {
			exited.resolve();
			const how = signal ? `was killed by ${signal}` : `exited with code ${code}`;
			this.events.onClose(new TestFailure(`Server process ${how}`, { exitCode: code, exitSignal: signal }));
		});
		child.stdin?.on("error", () => undefined);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => this.#appendStderr(chunk));
		let buffer = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			const { lines, rest } = splitLines(buffer + chunk);
			buffer = rest;
			for (const line of lines) {
				if (!line.trim()) continue;
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					this.#appendStderr(`[stdout] ${line}\n`);
					continue;
				}
				this.events.onMessage(value);
			}
		});
		await spawned.promise;
	}

	send(message: Record<string, unknown>): Promise<void> {
		const stdin = this.#child?.stdin;
		if (!stdin || stdin.destroyed) return Promise.reject(new TestFailure("Server stdin is closed"));
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		stdin.write(`${JSON.stringify(message)}\n`, error => (error ? reject(new TestFailure(error.message)) : resolve()));
		return promise;
	}

	setProtocolVersion(): void {}

	/** Close stdin, then SIGTERM the process tree, escalating to SIGKILL after 2 s. */
	async close(): Promise<void> {
		const child = this.#child;
		if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
		child.stdin?.end();
		const pid = child.pid;
		const kill = (signal: NodeJS.Signals): void => {
			try {
				if (process.platform === "win32") execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => undefined);
				else process.kill(-pid, signal);
			} catch {
				child.kill(signal);
			}
		};
		kill("SIGTERM");
		const exited = this.#exited ?? Promise.resolve();
		const settled = await Promise.race([exited.then(() => true), sleep(2000).then(() => false)]);
		if (!settled) {
			kill("SIGKILL");
			await Promise.race([exited, sleep(1000)]);
		}
	}
}

async function httpFailure(response: Response, what: string): Promise<TestFailure> {
	const body = (await response.text().catch(() => "")).trim().slice(0, 300);
	const auth = response.status === 401 || response.status === 403;
	return new TestFailure(`${what} failed: HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`, {
		httpStatus: response.status,
		authChallenge: auth ? response.headers.get("www-authenticate") : null,
	});
}

function networkFailure(url: string, error: unknown): TestFailure {
	if (error instanceof TestFailure) return error;
	const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
	return new TestFailure(`Could not reach ${url}${cause || (error instanceof Error ? `: ${error.message}` : "")}`);
}

/** Pump an SSE body, handing each event to `onEvent`; stops early when it returns true. */
async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => boolean): Promise<void> {
	const parser = new SseParser();
	const decoder = new TextDecoder();
	const reader = body.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			for (const event of parser.push(decoder.decode(value, { stream: true }))) if (onEvent(event)) return;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

function parseEventData(event: SseEvent): unknown {
	try {
		return JSON.parse(event.data);
	} catch {
		return undefined;
	}
}

/** Configured headers first; transport-generated headers win case-insensitively (MCP-Protocol-Version is ours). */
function buildHeaders(configured: Record<string, string>, generated: Record<string, string>): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(configured)) {
		if (key.toLowerCase() !== "mcp-protocol-version") headers.set(key, value);
	}
	for (const [key, value] of Object.entries(generated)) headers.set(key, value);
	return headers;
}

class StreamableHttpTransport implements Transport {
	readonly respondsInline = true;
	#sessionId: string | null = null;
	#protocolVersion: string | null = null;
	#controller = new AbortController();

	constructor(
		private readonly url: string,
		private readonly headers: Record<string, string>,
		private readonly events: TransportEvents,
	) {}

	async open(): Promise<void> {}

	#generated(): Record<string, string> {
		const generated: Record<string, string> = {};
		if (this.#sessionId) generated["Mcp-Session-Id"] = this.#sessionId;
		if (this.#protocolVersion) generated["MCP-Protocol-Version"] = this.#protocolVersion;
		return generated;
	}

	async send(message: Record<string, unknown>): Promise<void> {
		const isRequest = message.method !== undefined && message.id !== undefined;
		let response: Response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers: buildHeaders(this.headers, {
					...this.#generated(),
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				}),
				body: JSON.stringify(message),
				signal: this.#controller.signal,
			});
		} catch (error) {
			throw networkFailure(this.url, error);
		}
		if (!response.ok) throw await httpFailure(response, `POST ${String(message.method ?? "response")}`);
		this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
		if (!isRequest || !response.body) {
			await response.body?.cancel().catch(() => undefined);
			return;
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			await readSse(response.body, event => {
				if (event.event !== "message") return false;
				const value = parseEventData(event);
				if (value === undefined) return false;
				this.events.onMessage(value);
				const replies = Array.isArray(value) ? value : [value];
				return replies.some(reply => JsonRecord.safeParse(reply).data?.id === message.id);
			});
			return;
		}
		const text = await response.text();
		if (!text.trim()) return;
		try {
			this.events.onMessage(JSON.parse(text));
		} catch {
			throw new TestFailure(`Server sent a non-JSON response (${contentType || "no content type"}): ${text.slice(0, 200)}`);
		}
	}

	setProtocolVersion(version: string): void {
		this.#protocolVersion = version;
	}

	/** Abort in-flight requests and end the session (`DELETE`, best effort). */
	async close(): Promise<void> {
		this.#controller.abort();
		if (!this.#sessionId) return;
		await fetch(this.url, {
			method: "DELETE",
			headers: buildHeaders(this.headers, this.#generated()),
			signal: AbortSignal.timeout(2000),
		}).catch(() => undefined);
	}
}

class LegacySseTransport implements Transport {
	readonly respondsInline = false;
	#endpoint: string | null = null;
	#controller = new AbortController();

	constructor(
		private readonly url: string,
		private readonly headers: Record<string, string>,
		private readonly events: TransportEvents,
	) {}

	async open(): Promise<void> {
		let response: Response;
		try {
			response = await fetch(this.url, {
				headers: buildHeaders(this.headers, { Accept: "text/event-stream" }),
				signal: this.#controller.signal,
			});
		} catch (error) {
			throw networkFailure(this.url, error);
		}
		if (!response.ok || !response.body) throw await httpFailure(response, "SSE connection");
		const endpoint = Promise.withResolvers<void>();
		const configured = new URL(this.url);
		void readSse(response.body, event => {
			if (event.event === "endpoint" && !this.#endpoint) {
				const resolved = new URL(event.data, configured);
				if (resolved.origin !== configured.origin) {
					endpoint.reject(new TestFailure(`SSE endpoint origin mismatch: expected ${configured.origin}, got ${resolved.origin}`));
					return true;
				}
				this.#endpoint = resolved.href;
				endpoint.resolve();
			} else if (event.event === "message") {
				const value = parseEventData(event);
				if (value !== undefined) this.events.onMessage(value);
			}
			return false;
		})
			.then(() => {
				const failure = new TestFailure("SSE stream closed by the server");
				endpoint.reject(failure);
				this.events.onClose(failure);
			})
			.catch(error => {
				const failure = networkFailure(this.url, error);
				endpoint.reject(failure);
				this.events.onClose(failure);
			});
		await endpoint.promise;
	}

	async send(message: Record<string, unknown>): Promise<void> {
		if (!this.#endpoint) throw new TestFailure("SSE endpoint not received");
		let response: Response;
		try {
			response = await fetch(this.#endpoint, {
				method: "POST",
				headers: buildHeaders(this.headers, { "Content-Type": "application/json" }),
				body: JSON.stringify(message),
				signal: this.#controller.signal,
			});
		} catch (error) {
			throw networkFailure(this.#endpoint, error);
		}
		if (!response.ok) throw await httpFailure(response, `POST ${String(message.method ?? "response")}`);
		await response.body?.cancel().catch(() => undefined);
	}

	setProtocolVersion(): void {}

	async close(): Promise<void> {
		this.#controller.abort();
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------------------------------------------

/** Run a `!command` value: trimmed stdout, or undefined on failure/timeout/blank output. */
function runCommandValue(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const windows = process.platform === "win32";
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	execFile(
		windows ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
		windows ? ["/d", "/s", "/c", command] : ["-c", command],
		{ cwd, env, timeout: COMMAND_VALUE_TIMEOUT_MS, windowsHide: true },
		(error, stdout) => {
			const value = String(stdout).trim();
			resolve(error || !value ? undefined : value);
		},
	);
	return promise;
}

/** omp's `resolveConfigValue`: `!cmd` → stdout; a set env var name → its value; otherwise the literal. */
async function resolveValues(
	values: Record<string, string>,
	literalKeys: ReadonlySet<string>,
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		if (literalKeys.has(key)) {
			out[key] = value;
			continue;
		}
		const resolved = value.startsWith("!")
			? await runCommandValue(value.slice(1).trim(), cwd, env)
			: env[value] || value;
		if (resolved) out[key] = resolved;
	}
	return out;
}

const StringArray = z.array(z.string());

// ---------------------------------------------------------------------------------------------------------------
// Result parsing
// ---------------------------------------------------------------------------------------------------------------

const InitializeResult = z.looseObject({
	protocolVersion: z.string(),
	capabilities: JsonRecord.catch({}),
	serverInfo: z
		.looseObject({ name: z.string(), version: z.string().catch(""), title: z.string().optional() })
		.optional()
		.catch(undefined),
	instructions: z.string().optional().catch(undefined),
});
const Cursor = z.string().optional().catch(undefined);
const Text = z.string().optional().catch(undefined);
const ToolsPage = z.looseObject({
	tools: z.array(z.looseObject({ name: z.string(), title: Text, description: Text, inputSchema: z.unknown() })),
	nextCursor: Cursor,
});
const PromptsPage = z.looseObject({
	prompts: z.array(
		z.looseObject({
			name: z.string(),
			title: Text,
			description: Text,
			arguments: z
				.array(z.looseObject({ name: z.string(), description: Text, required: z.boolean().optional().catch(undefined) }))
				.optional()
				.catch(undefined),
		}),
	),
	nextCursor: Cursor,
});
const ResourcesPage = z.looseObject({
	resources: z.array(
		z.looseObject({ uri: z.string(), name: z.string().catch(""), title: Text, description: Text, mimeType: Text }),
	),
	nextCursor: Cursor,
});

async function paginate<T, P extends { nextCursor?: string }>(
	session: RpcSession,
	method: string,
	schema: z.ZodType<P>,
	pick: (page: P) => T[],
): Promise<T[]> {
	const items: T[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const result = schema.safeParse(await session.request(method, cursor ? { cursor } : {}));
		if (!result.success) throw new TestFailure(`Malformed ${method} result: ${result.error.issues[0]?.message ?? "invalid"}`);
		items.push(...pick(result.data));
		cursor = result.data.nextCursor;
		if (!cursor) break;
	}
	return items;
}

// ---------------------------------------------------------------------------------------------------------------
// Test driver
// ---------------------------------------------------------------------------------------------------------------

/** Connect to `request.config`, handshake, list capabilities, always tear down. Never rejects. */
export async function testServer(request: TestRequest): Promise<McpTestResult> {
	const started = performance.now();
	const rootDir = request.cwd ?? homedir();
	const errors: string[] = [];
	const unresolved = new Set<string>();
	const expanded = JsonRecord.parse(expandEnvVarsDeep(request.config, request.env, unresolved));
	const config = normalizeEntry(expanded, "native", errors);
	const transport: McpTransport = transportOf(config);
	const result: McpTestResult = {
		ok: false,
		transport,
		stage: "config",
		error: null,
		timedOut: false,
		authRequired: false,
		authChallenge: null,
		httpStatus: null,
		exitCode: null,
		exitSignal: null,
		durationMs: 0,
		command: transport === "stdio" && config.command ? [config.command, ...(config.args ?? [])] : null,
		url: transport === "stdio" ? null : (config.url ?? null),
		unresolvedVars: [...unresolved].sort(),
		serverInfo: null,
		protocolVersion: null,
		capabilities: null,
		instructions: null,
		tools: [],
		prompts: [],
		resources: [],
		listErrors: [],
		stderr: "",
	};

	const session = new RpcSession(rootDir);
	let stdio: StdioTransport | null = null;
	const deadline = Promise.withResolvers<never>();
	// The deadline may fire outside any race (e.g. during teardown); never let it surface as unhandled.
	deadline.promise.catch(() => undefined);
	const timer = setTimeout(
		() => deadline.reject(new TestFailure(`Timed out after ${request.timeoutMs} ms`, { timedOut: true })),
		request.timeoutMs,
	);
	const bounded = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, deadline.promise]);

	try {
		const invalid = validateServerConfig("test", config);
		if (invalid.length > 0) throw new TestFailure(invalid.map(message => message.replace('Server "test": ', "")).join("; "));
		if (errors.length > 0) throw new TestFailure(errors.join("; "));

		if (transport === "stdio") {
			const cwd = config.cwd ?? rootDir;
			const cwdStat = await stat(cwd).catch(() => null);
			if (!cwdStat?.isDirectory()) throw new TestFailure(`Working directory does not exist: ${cwd}`, { stage: "spawn" });
			const literal = new Set(
				config.envPolicy === "literal" ? Object.keys(config.env ?? {}) : StringArray.catch([]).parse(config.envLiteralKeys),
			);
			const extraEnv = await bounded(resolveValues(config.env ?? {}, literal, rootDir, request.env));
			result.stage = "spawn";
			stdio = new StdioTransport(config.command ?? "", config.args ?? [], cwd, { ...request.env, ...extraEnv }, session);
			session.transport = stdio;
		} else {
			const url = config.url ?? "";
			if (!URL.canParse(url)) throw new TestFailure(`Invalid URL: ${url}`);
			const headers =
				config.headerPolicy === "origin-locked"
					? (config.headers ?? {})
					: await bounded(resolveValues(config.headers ?? {}, new Set(), rootDir, request.env));
			result.stage = "connect";
			session.transport =
				transport === "http" ? new StreamableHttpTransport(url, headers, session) : new LegacySseTransport(url, headers, session);
		}

		await bounded(session.transport.open());
		result.stage = "initialize";
		const init = InitializeResult.safeParse(
			await bounded(
				session.request("initialize", {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { roots: { listChanged: false } },
					clientInfo: request.clientInfo,
				}),
			),
		);
		if (!init.success) throw new TestFailure(`Malformed initialize result: ${init.error.issues[0]?.message ?? "invalid"}`);
		result.protocolVersion = init.data.protocolVersion;
		result.capabilities = init.data.capabilities;
		result.instructions = init.data.instructions ?? null;
		const info = init.data.serverInfo;
		result.serverInfo = info ? { name: info.name, version: info.version, title: info.title ?? null } : null;
		session.transport.setProtocolVersion(init.data.protocolVersion);
		await bounded(session.notify("notifications/initialized"));

		result.stage = "list";
		const capabilities = init.data.capabilities;
		if (capabilities.tools !== undefined) {
			result.tools = await bounded(
				paginate(session, "tools/list", ToolsPage, page =>
					page.tools.map(
						(tool): McpToolInfo => ({
							name: tool.name,
							title: tool.title ?? null,
							description: tool.description ?? null,
							inputSchema: tool.inputSchema ?? null,
						}),
					),
				),
			);
		}
		if (capabilities.prompts !== undefined) {
			try {
				result.prompts = await bounded(
					paginate(session, "prompts/list", PromptsPage, page =>
						page.prompts.map(
							(prompt): McpPromptInfo => ({
								name: prompt.name,
								title: prompt.title ?? null,
								description: prompt.description ?? null,
								arguments: (prompt.arguments ?? []).map(arg => ({
									name: arg.name,
									description: arg.description ?? null,
									required: arg.required ?? false,
								})),
							}),
						),
					),
				);
			} catch (error) {
				if (error instanceof TestFailure && error.details.timedOut) throw error;
				result.listErrors.push(`prompts/list: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (capabilities.resources !== undefined) {
			try {
				result.resources = await bounded(
					paginate(session, "resources/list", ResourcesPage, page =>
						page.resources.map(
							(resource): McpResourceInfo => ({
								uri: resource.uri,
								name: resource.name,
								title: resource.title ?? null,
								description: resource.description ?? null,
								mimeType: resource.mimeType ?? null,
							}),
						),
					),
				);
			} catch (error) {
				if (error instanceof TestFailure && error.details.timedOut) throw error;
				result.listErrors.push(`resources/list: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		result.stage = "done";
		result.ok = true;
	} catch (error) {
		const failure = error instanceof TestFailure ? error : new TestFailure(error instanceof Error ? error.message : String(error));
		const details = failure.details;
		result.error = failure.message;
		result.stage = details.stage ?? result.stage;
		result.timedOut = details.timedOut ?? false;
		result.httpStatus = details.httpStatus ?? null;
		result.authRequired = details.httpStatus === 401 || details.httpStatus === 403;
		result.authChallenge = details.authChallenge ?? null;
		result.exitCode = details.exitCode ?? null;
		result.exitSignal = details.exitSignal ?? null;
	} finally {
		clearTimeout(timer);
		// Always tear down: close stdin/streams, kill the child process tree, end the HTTP session.
		await (session.hasTransport ? session.transport.close() : Promise.resolve()).catch(() => undefined);
	}
	result.stderr = stdio?.stderr ?? "";
	result.durationMs = Math.round(performance.now() - started);
	return result;
}
