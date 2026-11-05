import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiagnosticEvent, DiagnosticsLog } from "./log";
import { formatDiagnostic } from "./log";
import { settleWithin } from "./deadline";

/** Public ingestion key, never an API/auth token. Development requires VOMP_SENTRY_DSN. */
export const SENTRY_DSN = "https://f52f8fc21b3cc40f5c64a9ea23a0fd09@o4512380493037568.ingest.us.sentry.io/4512380498739200";

export function sentryEndpoints(dsn: string) {
	try {
		const url = new URL(dsn);
		const parts = url.pathname.split("/").filter(Boolean);
		const project = parts.pop();
		const key = decodeURIComponent(url.username);
		if (url.protocol !== "https:" || url.password || !project || !/^\d+$/.test(project) || !/^[a-zA-Z0-9]+$/.test(key) || url.search || url.hash) return null;
		const base = `${url.origin}/${[...parts, "api", project].join("/")}`;
		return { key, envelope: `${base}/envelope/`, minidump: `${base}/minidump/?sentry_key=${encodeURIComponent(key)}` };
	} catch { return null; }
}

export function redactHome(value: string, home: string): string {
	if (!home) return value;
	const variants = new Set([home, home.replaceAll("\\", "/"), home.replaceAll("/", "\\")]);
	let result = value;
	for (const variant of variants) result = result.replace(new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "~");
	return result;
}

/** Recurse before serialization so escaped Windows paths are redacted too. */
function redact(value: unknown, home: string): unknown {
	if (typeof value === "string") return redactHome(value, home);
	if (Array.isArray(value)) return value.map(item => redact(item, home));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactHome(key, home), redact(item, home)]));
	return value;
}

export function sentryEnvelope(event: Record<string, unknown>, home: string): string {
	const safe = redact(event, home) as Record<string, unknown>;
	const payload = JSON.stringify(safe);
	return `${JSON.stringify({ event_id: safe.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event", content_type: "application/json", length: Buffer.byteLength(payload) })}\n${payload}\n`;
}

export async function diagnosticInstallId(file: string): Promise<string> {
	try {
		const stored = (await readFile(file, "utf8")).trim();
		if (/^[a-f0-9]{32}$/.test(stored)) return stored;
	} catch { /* A new profile gets a random id unrelated to the person or their computer. */ }
	const id = randomBytes(16).toString("hex");
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, id, { mode: 0o600 });
	return id;
}

export interface SenderOptions {
	dsn: string;
	packaged: boolean;
	developmentOverride: boolean;
	enabled: boolean;
	version: string;
	platform: string;
	arch: string;
	transport: "tsp" | "classic";
	classic: boolean;
	home: string;
	installId: Promise<string>;
	log: DiagnosticsLog;
	fetch?: typeof fetch;
	now?: () => number;
}

/** A launch-local budget with bounded in-flight requests, no retries and no renderer dependency. */
export class SentrySender {
	#enabled: boolean;
	#epoch: number;
	#sent = 0;
	#seen = new Set<string>();
	#pending = new Set<Promise<void>>();
	#controllers = new Set<AbortController>();
	readonly endpoints;
	constructor(readonly options: SenderOptions) {
		this.#enabled = options.enabled;
		this.endpoints = sentryEndpoints(options.dsn);
		this.#epoch = this.#now();
	}
	#now(): number { return (this.options.now ?? Date.now)(); }
	get enabled(): boolean {
		return this.#enabled && !!this.endpoints && (this.options.packaged || this.options.developmentOverride);
	}
	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		if (!enabled) for (const controller of this.#controllers) controller.abort();
	}
	capture(event: DiagnosticEvent): void {
		if (!this.enabled || this.#pending.size >= 3 || !["renderer-gone", "child-gone", "window-responsive", "main-exception", "diagnostics-test"].includes(event.event)) return;
		if (event.event === "window-responsive" && (event.durationMs === null || event.durationMs < 10_000)) return;
		if ((event.event === "renderer-gone" || event.event === "child-gone") && event.reason === "clean-exit") return;
		const line = formatDiagnostic(event);
		if (!line) return;
		if (this.#now() - this.#epoch >= 3600_000) { this.#epoch = this.#now(); this.#sent = 0; this.#seen.clear(); }
		const data = JSON.parse(line.slice(line.indexOf("{")).trim()) as Record<string, unknown>;
		// Window ids, timings and reload choices do not make identical failures new events.
		const key = JSON.stringify([event.event, data.reason, data.exitCode, data.type, data.serviceName, data.kind, data.fingerprint]);
		if (this.#sent >= 10 || this.#seen.has(key)) return;
		this.#sent++;
		this.#seen.add(key);
		const request = this.#send(event.event, data).finally(() => this.#pending.delete(request));
		this.#pending.add(request);
	}
	async flush(): Promise<void> { await Promise.all(this.#pending); }
	async #send(name: string, data: Record<string, unknown>): Promise<void> {
		const controller = new AbortController();
		this.#controllers.add(controller);
		const deadline = performance.now() + 5000;
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const preparation = await settleWithin(Promise.all([this.options.log.recent(200), this.options.installId]), 1500);
			if (!preparation.completed) throw new Error("Report preparation timed out.");
			const [diagnostics, installId] = preparation.value;
			if (!this.enabled || controller.signal.aborted) return;
			const event = {
				event_id: randomUUID().replaceAll("-", ""), timestamp: this.#now() / 1000,
				platform: "node", level: "error", logger: "visual-omp.diagnostics", message: `visual-omp ${name}`,
				release: `visual-omp@${this.options.version}`, environment: this.options.packaged ? "production" : "development",
				...(installId ? { user: { id: installId } } : {}),
				tags: { platform: this.options.platform, arch: this.options.arch, transport: this.options.transport, classic: String(this.options.classic) },
				contexts: { runtime: { name: "Electron", version: process.versions.electron ?? "" } },
				fingerprint: [name, String(data.reason ?? ""), String(data.exitCode ?? ""), String(data.fingerprint ?? "")],
				extra: { event: data, diagnostics },
			};
			const responseResult = await settleWithin((this.options.fetch ?? fetch)(this.endpoints!.envelope, {
				method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${this.endpoints!.key}, sentry_client=visual-omp/${this.options.version}` },
				body: sentryEnvelope(event, this.options.home), signal: controller.signal, redirect: "error",
			}), Math.max(0, deadline - performance.now()));
			if (!responseResult.completed) throw new Error("Report sending timed out.");
			const response = responseResult.value;
			void response.body?.cancel().catch(() => {});
			this.options.log.write({ event: "report-send", outcome: response.ok ? "sent" : "failed", status: response.status });
		} catch {
			this.options.log.write({ event: "report-send", outcome: "failed", status: null });
		} finally { clearTimeout(timeout); controller.abort(); this.#controllers.delete(controller); }
	}
}
