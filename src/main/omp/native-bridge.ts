import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ModeRequestSchema, ModeResultSchema, NativeSnapshotSchema, type ModeRequest, type ModeResult, type NativeSnapshot } from "@shared/contracts/native";
import type { EditorDraftRequest, EditorDraftResult } from "@shared/contracts/composer";
import { broadcast } from "../ipc";
import { NATIVE_EXTENSION_SOURCE } from "./native-extension";

const bridges = new Map<string, NativeBridge>();
export class NativeBridge {
	readonly #token = randomUUID();
	readonly #pending = new Map<string, { request: ModeRequest; delivered: boolean; resolve(result: ModeResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #commands = new Map<string, { delivered: boolean; resolve(commands: string[]): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #editors = new Map<string, { request: EditorDraftRequest; delivered: boolean; resolve(result: EditorDraftResult): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
	readonly #server: Server;
	snapshot: NativeSnapshot = { modes: null, theme: null };
	readonly extensionPath: string;
	url = "";
	constructor(readonly hostId: string, privateDir: string) {
		this.extensionPath = join(privateDir, "visual-omp-native.mjs");
		this.#server = createServer(async (request, response) => {
			const path = request.url?.split("?")[0] ?? "";
			if (!path.startsWith(`/${this.#token}/`) || request.headers.origin) { response.writeHead(403).end(); return; }
			response.setHeader("Content-Type", "application/json");
			response.setHeader("Cache-Control", "no-store");
			const route = path.slice(this.#token.length + 1);
			try {
				if (request.method === "GET" && route === "/requests") {
					const items = [
						...[...this.#pending].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, request: item.request }; }),
						...[...this.#commands].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "sideCommands" }; }),
						...[...this.#editors].filter(([, item]) => !item.delivered).map(([id, item]) => { item.delivered = true; return { id, kind: "editorDraft", editor: item.request }; }),
					];
					response.end(JSON.stringify(items)); return;
				}
				if (request.method !== "POST") { response.writeHead(404).end(); return; }
				let body = "";
				for await (const chunk of request) { body += chunk; if (body.length > 65536) { response.writeHead(413).end(); return; } }
				const parsed: unknown = JSON.parse(body);
				if (route === "/snapshot") {
					this.snapshot = NativeSnapshotSchema.parse(parsed);
					broadcast("native:changed", { hostId, snapshot: this.snapshot });
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
					const result = z.object({ text: z.string().nullable(), cleared: z.boolean(), error: z.string().optional() }).parse(parsed);
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
	sideCommands(): Promise<string[]> {
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<string[]>();
		const timer = setTimeout(() => { this.#commands.delete(id); reject(new Error("omp did not report its side commands in time.")); }, 10_000);
		this.#commands.set(id, { delivered: false, resolve, reject, timer });
		return promise;
	}
	editorDraft(request: EditorDraftRequest): Promise<EditorDraftResult> {
		const id = randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<EditorDraftResult>();
		const timer = setTimeout(() => { this.#editors.delete(id); reject(new Error("omp did not answer the exact editor request in time.")); }, 10_000);
		this.#editors.set(id, { request, delivered: false, resolve, reject, timer });
		return promise;
	}
	async close(): Promise<void> {
		bridges.delete(this.hostId);
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
