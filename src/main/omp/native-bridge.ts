import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ModeRequestSchema, ModeResultSchema, NativeSnapshotSchema, SessionAccountsSchema, type ModeRequest, type ModeResult, type NativeSnapshot, type SessionAccounts } from "@shared/contracts/native";
import type { EditorDraftRequest, EditorDraftResult } from "@shared/contracts/composer";
import { broadcast } from "../ipc";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

export interface NativePromptWatch { id: string; sessionId: string; text: string; images?: number; classicEditor?: { expected: string } }
export interface NativePromptWatchResult { emptyResume: boolean }
interface PromptWatch {
	watch: NativePromptWatch | null;
	sessionId: string;
	epoch: string;
	delivered: boolean;
	armed: boolean;
	resolve(result: NativePromptWatchResult): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

const bridges = new Map<string, NativeBridge>();
export class NativeBridge {
	readonly #token = randomUUID();
	readonly #pending = new Map<string, { request: ModeRequest; delivered: boolean; resolve(result: ModeResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #commands = new Map<string, { delivered: boolean; resolve(commands: string[]): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #editors = new Map<string, { request: EditorDraftRequest; delivered: boolean; resolve(result: EditorDraftResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #asyncWork = new Map<string, { delivered: boolean; resolve(pending: boolean | null): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #accounts = new Map<string, { delivered: boolean; resolve(accounts: SessionAccounts | null): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #prompts = new Map<string, PromptWatch>();
	readonly #forgottenPrompts = new Set<string>();
	onPromptInput: ((id: string) => void) | undefined;
	#closed = false;
	readonly #server: Server;
	snapshot: NativeSnapshot = { modes: null, theme: null };
	#jobsEpoch = randomUUID();
	#generation = 0;
	#hasCurrentJobs = false;
	#shutdownRequest: "pending" | "delivered" | null = null;
	readonly extensionPath: string;
	url = "";
	constructor(readonly hostId: string, privateDir: string) {
		this.extensionPath = join(privateDir, "visual-omp-native.mjs");
		this.#server = createServer(async (request, response) => {
			const path = request.url?.split("?")[0] ?? "";
			if (!path.startsWith(`/${this.#token}/`) || request.headers.origin) { response.writeHead(403).end(); return; }
			response.setHeader("Content-Type", "application/json");
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("X-Vomp-Jobs-Epoch", this.#jobsEpoch);
			const route = path.slice(this.#token.length + 1);
			try {
				if (request.method === "GET" && route === "/requests") {
					const items = [
						...[...this.#pending].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, request: item.request }; }),
						...[...this.#commands].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "sideCommands" }; }),
						...[...this.#editors].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "editorDraft", editor: item.request }; }),
						...[...this.#asyncWork].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "asyncWork" }; }),
						...[...this.#accounts].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "sessionAccounts" }; }),
						...[...this.#forgottenPrompts].map(id => ({ id, kind: "forgetPrompt", epoch: this.#jobsEpoch })),
						...[...this.#prompts].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "watchPrompt", prompt: item.watch, epoch: item.epoch }; }),
						...(this.#shutdownRequest === "pending" ? [{ kind: "shutdown" }] : []),
					];
					if (this.#shutdownRequest === "pending") this.#shutdownRequest = "delivered";
					this.#forgottenPrompts.clear();
					response.end(JSON.stringify(items)); return;
				}
				if (request.method !== "POST") { response.writeHead(404).end(); return; }
				let body = "";
				for await (const chunk of request) { body += chunk; if (body.length > 65536) { response.writeHead(413).end(); return; } }
				const parsed: unknown = JSON.parse(body);
				if (route === "/snapshot") {
					const incoming = NativeSnapshotSchema.parse(parsed);
					const epoch = z.object({ asyncJobsEpoch: z.string().nullable().optional() }).parse(parsed).asyncJobsEpoch;
					const current = epoch === this.#jobsEpoch;
					// Bootstrap may report modes before its first poll. Once the epoch is known, reject old snapshots whole.
					if (!current && (epoch != null || this.#hasCurrentJobs || incoming.shutdown)) { response.end("{}"); return; }
					if (current && !incoming.shutdown) this.#hasCurrentJobs = true;
					if (incoming.shutdown) {
						this.beginGeneration(this.#generation);
						response.setHeader("X-Vomp-Jobs-Epoch", this.#jobsEpoch);
					}
					this.snapshot = {
						...incoming,
						asyncJobs: incoming.shutdown ? [] : current ? incoming.asyncJobs ?? [] : this.snapshot.asyncJobs ?? [],
						asyncJobsGeneration: this.#generation,
					};
					broadcast("native:changed", { hostId, snapshot: this.snapshot });
				} else if (route.startsWith("/prompt/")) {
					const id = decodeURIComponent(route.slice("/prompt/".length));
					const result = z.object({ state: z.enum(["armed", "input", "error"]), epoch: z.string(), sessionId: z.string(), emptyResume: z.boolean().optional(), error: z.string().optional() }).parse(parsed);
					const item = this.#prompts.get(id);
					if (!item || !item.delivered || item.epoch !== result.epoch || result.epoch !== this.#jobsEpoch || item.sessionId !== result.sessionId) { response.writeHead(409).end(); return; }
					if (result.state === "armed" && !item.armed) {
						clearTimeout(item.timer);
						item.watch = null;
						item.armed = true;
						item.timer = setTimeout(() => this.forgetPrompt(id), 30_000);
						item.resolve({ emptyResume: result.emptyResume === true });
					} else if (result.state === "input" && item.armed) {
						clearTimeout(item.timer);
						this.#prompts.delete(id);
						this.onPromptInput?.(id);
					} else if (result.state === "error") {
						this.forgetPrompt(id, result.error);
					} else { response.writeHead(409).end(); return; }
				} else if (route.startsWith("/accounts/")) {
					const id = route.slice("/accounts/".length);
					const result = SessionAccountsSchema.nullable().parse(parsed);
					const item = this.#accounts.get(id);
					if (item?.delivered) {
						clearTimeout(item.timer);
						this.#accounts.delete(id);
						this.snapshot = { ...this.snapshot, sessionAccounts: result };
						broadcast("native:changed", { hostId, snapshot: this.snapshot });
						item.resolve(result);
					}
				} else if (route.startsWith("/async-work/")) {
					const id = route.slice("/async-work/".length);
					const result = z.object({ pending: z.boolean().nullable() }).parse(parsed);
					const item = this.#asyncWork.get(id);
					if (item) {
						clearTimeout(item.timer);
						this.#asyncWork.delete(id);
						item.resolve(result.pending);
					}
				} else if (route.startsWith("/commands/")) {
					const id = route.slice("/commands/".length);
					const item = this.#commands.get(id);
					const result = z.object({ commands: z.array(z.string()).optional(), error: z.string().optional() }).parse(parsed);
					if (item) {
						clearTimeout(item.timer);
						this.#commands.delete(id);
						if (result.error || !result.commands) item.reject(new Error(result.error ?? "omp did not report its side commands."));
						else item.resolve(result.commands);
					}
				} else if (route.startsWith("/editor/")) {
					const id = route.slice("/editor/".length);
					const item = this.#editors.get(id);
					const result = z.object({ text: z.string().nullable(), cleared: z.boolean(), restored: z.boolean().optional(), imageChips: z.number().int().nonnegative().optional(), imageSymbol: z.string().optional(), error: z.string().optional() }).parse(parsed);
					if (item) {
						clearTimeout(item.timer);
						this.#editors.delete(id);
						item.resolve(result);
					}
				} else if (route.startsWith("/result/")) {
					const id = route.slice("/result/".length);
					const item = this.#pending.get(id);
					const result = ModeResultSchema.parse(parsed);
					if (item) {
						clearTimeout(item.timer);
						this.#pending.delete(id);
						this.snapshot = { ...this.snapshot, modes: result.state };
						broadcast("native:changed", { hostId, snapshot: this.snapshot });
						item.resolve(result);
					}
				} else { response.writeHead(404).end(); return; }
				response.end("{}");
			} catch { response.writeHead(400).end(); }
		});
	}
	/** Called before publishing a new room, including same-session restarts. Old POSTs cannot repopulate its jobs. */
	beginGeneration(generation: number): void {
		this.#clearAsyncWork("omp changed rooms before reporting its background work.");
		this.#clearPrompts("omp changed rooms before observing the prompt.");
		this.#clearAccounts("omp changed rooms before reporting its accounts.");
		this.#shutdownRequest = null;
		this.#generation = generation;
		this.#jobsEpoch = randomUUID();
		this.#hasCurrentJobs = false;
		this.snapshot = { ...this.snapshot, sessionAccounts: null, asyncJobs: [], asyncJobsGeneration: generation };
	}
	async start(): Promise<void> {
		await writeFile(this.extensionPath, NATIVE_EXTENSION_SOURCE, { mode: 0o600 });
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#server.once("error", reject);
		this.#server.listen(0, "127.0.0.1", () => { this.#server.off("error", reject); resolve(); });
		await promise;
		const address = this.#server.address();
		if (!address || typeof address === "string") throw new Error("Native bridge did not open a loopback port");
		this.url = `http://127.0.0.1:${address.port}/${this.#token}`;
		bridges.set(this.hostId, this);
	}
	setMode(request: ModeRequest): Promise<ModeResult> {
		const valid = ModeRequestSchema.parse(request);
		if (!this.snapshot.modes) return Promise.reject(new Error("omp's native mode controls are unavailable"));
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<ModeResult>();
		const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error("omp did not answer the mode request")); }, 10_000);
		this.#pending.set(id, { request: valid, delivered: false, resolve, reject, timer });
		return promise;
	}
	/** Reload only identity summaries on explicit reads, never refresh provider tokens. */
	sessionAccounts(generation: number): Promise<SessionAccounts | null> {
		if (this.#closed || generation !== this.#generation) return Promise.reject(new Error("omp's room changed."));
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<SessionAccounts | null>();
		const timer = setTimeout(() => { this.#accounts.delete(id); reject(new Error("omp did not report its accounts in time.")); }, 5000);
		this.#accounts.set(id, { delivered: false, resolve, reject, timer });
		return promise;
	}
	#clearAccounts(message: string): void {
		for (const item of this.#accounts.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
		this.#accounts.clear();
	}
	/** Sample after the caller observed a wait; cached job metadata may predate that turn. */
	asyncWork(generation: number): Promise<boolean | null> {
		if (generation !== this.#generation) return Promise.reject(new Error("omp's room changed."));
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<boolean | null>();
		const timer = setTimeout(() => { this.#asyncWork.delete(id); reject(new Error("omp did not report its background work.")); }, 5000);
		this.#asyncWork.set(id, { delivered: false, resolve, reject, timer });
		return promise;
	}
	#clearAsyncWork(message: string): void {
		for (const item of this.#asyncWork.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
		this.#asyncWork.clear();
	}
	sideCommands(): Promise<string[]> {
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<string[]>();
		const timer = setTimeout(() => { this.#commands.delete(id); reject(new Error("omp did not report its side commands in time.")); }, 10_000);
		this.#commands.set(id, { delivered: false, resolve, reject, timer });
		return promise;
	}
	/** One SDK request per process generation. Lack of progress never falls back to editor input. */
	requestShutdown(): void {
		this.#shutdownRequest ??= "pending";
	}
	editorDraft(request: EditorDraftRequest): Promise<EditorDraftResult> {
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<EditorDraftResult>();
		const timer = setTimeout(() => { this.#editors.delete(id); reject(new Error("omp did not answer the exact editor request in time.")); }, 10_000);
		this.#editors.set(id, { request, delivered: false, resolve, reject, timer });
		return promise;
	}
	/** Observe normal UI input only after the extension confirms its exact watch is armed. */
	watchPrompt(watch: NativePromptWatch): Promise<NativePromptWatchResult> {
		if (this.#closed) return Promise.reject(new Error("omp's prompt observation is unavailable."));
		if (!watch.id || !watch.sessionId || this.#prompts.has(watch.id) || this.#prompts.size >= 64 || watch.text.length > 1_048_576) return Promise.reject(new Error("omp could not arm the exact prompt observation."));
		if (watch.images !== undefined && (!Number.isSafeInteger(watch.images) || watch.images < 1)) return Promise.reject(new Error("omp could not arm the exact prompt attachment observation."));
		if (watch.classicEditor && (typeof watch.classicEditor.expected !== "string" || watch.classicEditor.expected.length > 1_048_576)) return Promise.reject(new Error("omp could not check its editor before sending. Try again when omp is ready."));
		const { promise, resolve, reject } = Promise.withResolvers<NativePromptWatchResult>();
		const timer = setTimeout(() => this.forgetPrompt(watch.id), 5000);
		this.#prompts.set(watch.id, { watch: { ...watch }, sessionId: watch.sessionId, epoch: this.#jobsEpoch, delivered: false, armed: false, resolve, reject, timer });
		return promise;
	}
	forgetPrompt(id: string, error = "omp did not arm its input observation. Your message was not sent. Try again when omp is ready."): void {
		const item = this.#prompts.get(id);
		if (!item) return;
		clearTimeout(item.timer);
		this.#prompts.delete(id);
		if (!item.armed) item.reject(new Error(error));
		if (item.delivered) {
			this.#forgottenPrompts.add(id);
			if (this.#forgottenPrompts.size > 64) this.#forgottenPrompts.delete(this.#forgottenPrompts.values().next().value!);
		}
	}
	#clearPrompts(message: string): void {
		for (const item of this.#prompts.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
		this.#prompts.clear();
		this.#forgottenPrompts.clear();
	}
	async close(): Promise<void> {
		bridges.delete(this.hostId);
		this.#closed = true;
		this.#clearPrompts("omp stopped before observing the prompt.");
		this.onPromptInput = undefined;
		this.#clearAsyncWork("omp stopped before reporting its background work.");
		this.#clearAccounts("omp stopped before reporting its accounts.");
		for (const item of this.#pending.values()) { clearTimeout(item.timer); item.reject(new Error("omp stopped before answering the mode request")); }
		this.#pending.clear();
		for (const item of this.#commands.values()) { clearTimeout(item.timer); item.reject(new Error("omp stopped before reporting its side commands.")); }
		this.#commands.clear();
		for (const item of this.#editors.values()) { clearTimeout(item.timer); item.reject(new Error("omp stopped before answering the exact editor request.")); }
		this.#editors.clear();
		this.#server.closeAllConnections();
		if (this.#server.listening) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => resolve());
			await promise;
		}
	}
}
export async function createNativeBridge(hostId: string, privateDir: string): Promise<NativeBridge> {
	const bridge = new NativeBridge(hostId, privateDir);
	try { await bridge.start(); return bridge; }
	catch (error) { await bridge.close(); throw error; }
}
export function nativeBridge(hostId: string): NativeBridge {
	const bridge = bridges.get(hostId);
	if (!bridge) throw new Error("The hosted omp bridge is unavailable");
	return bridge;
}
