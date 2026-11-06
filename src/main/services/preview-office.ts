import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { PreviewBinary, PreviewSlides } from "@shared/contracts/preview";
import { OFFICE_LIMITS } from "@shared/preview-office-zip";
import { handleWithEvent } from "../ipc";
import { hasPreviewGrant, onPreviewRevoke, readPreviewBinary } from "./preview-protocol";
import { officeRuntime, type OfficeConversionRuntime } from "./preview-office-runtime";
import { OfficeTeardownError } from "./preview-office-process";

interface OfficeDependencies {
	root(): Promise<string>;
	active(token: string, owner: number | null): boolean;
	read(token: string, owner: number | null): Promise<PreviewBinary>;
	runtime: OfficeConversionRuntime;
}
interface Conversion {
	token: string; revision: number; owner: number | null; controller: AbortController;
	promise: Promise<PreviewSlides>; resolve(result: PreviewSlides): void;
}

/** All chats share one converter and one replaceable queue slot. No original file path reaches LibreOffice. */
export class OfficePreviewService {
	private active: Conversion | null = null;
	private queued: Conversion | null = null;
	private latest = new Map<string, number>();
	private ready = new Map<string, { pdfPath: string; revision: number }>();
	private halted = false;
	private cleanups = new Set<Promise<void>>();
	private closing: Promise<boolean> | null = null;
	private scratchRoot: string | null = null;
	constructor(private deps: OfficeDependencies) {}
	async tools(): Promise<{ libreOffice: boolean }> { return { libreOffice: (await this.deps.runtime.detect()) !== null }; }
	request(token: string, revision: number, owner: number | null = null): Promise<PreviewSlides> {
		if (this.closing) return Promise.resolve({ ok: false, reason: "revoked" });
		if (!/^[a-f0-9]{48}$/.test(token) || !Number.isSafeInteger(revision) || revision < 0 || !this.deps.active(token, owner)) return Promise.resolve({ ok: false, reason: "revoked" });
		const latest = this.latest.get(token) ?? -1;
		if (revision < latest) return Promise.resolve({ ok: false, reason: "revoked" });
		const ready = this.ready.get(token);
		if (ready?.revision === revision) return Promise.resolve({ ok: true, ...ready });
		if (this.halted) return Promise.resolve({ ok: false, reason: "converterUnavailable" });
		for (const job of [this.active, this.queued]) if (job?.token === token && job.revision === revision) return job.promise;
		this.latest.set(token, revision);
		const result = Promise.withResolvers<PreviewSlides>();
		const next: Conversion = { token, revision, owner, controller: new AbortController(), promise: result.promise, resolve: result.resolve };
		if (this.queued) { this.queued.controller.abort(); this.queued.resolve({ ok: false, reason: "revoked" }); }
		this.queued = next;
		if (this.active?.token === token) this.active.controller.abort();
		this.drain();
		return result.promise;
	}
	revoke(token: string): Promise<void> {
		if (!this.latest.has(token)) return Promise.resolve();
		this.latest.delete(token); this.ready.delete(token);
		const active = this.active?.token === token ? this.active : null;
		active?.controller.abort();
		if (this.queued?.token === token) { this.queued.controller.abort(); this.queued.resolve({ ok: false, reason: "revoked" }); this.queued = null; }
		// Windows cannot remove a converter's working directory until its process tree has stopped.
		const cleanup = (async () => {
			if (active) await active.promise;
			if (!this.halted && this.scratchRoot) await rm(join(this.scratchRoot, "slides", token), { recursive: true, force: true });
		})().catch(() => {});
		this.cleanups.add(cleanup);
		void cleanup.finally(() => this.cleanups.delete(cleanup));
		return cleanup;
	}
	/** False preserves the scratch root when converter termination could not be confirmed. */
	close(): Promise<boolean> {
		if (this.closing) return this.closing;
		const done = Promise.withResolvers<boolean>();
		this.closing = done.promise;
		// Process-tree termination has its own five-second deadline; allow one more second for file cleanup.
		const timer = setTimeout(() => { this.halted = true; done.resolve(false); }, 6_000);
		void done.promise.finally(() => clearTimeout(timer));
		for (const token of this.latest.keys()) void this.revoke(token);
		void Promise.all([...this.cleanups]).then(async () => {
			if (this.halted) return false;
			if (this.scratchRoot) await rm(this.scratchRoot, { recursive: true, force: true });
			return true;
		}).then(done.resolve, () => done.resolve(false));
		return done.promise;
	}
	private drain(): void {
		if (this.active || !this.queued) return;
		const job = this.queued; this.queued = null; this.active = job;
		void this.convert(job).then(job.resolve, () => job.resolve({ ok: false, reason: "failed" })).finally(() => { this.active = null; this.drain(); });
	}
	private async convert(job: Conversion): Promise<PreviewSlides> {
		const valid = () => !job.controller.signal.aborted && this.latest.get(job.token) === job.revision && this.deps.active(job.token, job.owner);
		let directory: string | null = null, keep = false, timedOut = false, tooLarge = false;
		let watch: NodeJS.Timeout | undefined;
		const timer = setTimeout(() => { timedOut = true; job.controller.abort(); }, 60_000);
		try {
			const binary = await this.deps.read(job.token, job.owner);
			if (!valid()) return { ok: false, reason: "revoked" };
			if (!binary.ok) return { ok: false, reason: binary.reason === "tooLarge" ? "tooLarge" : binary.reason === "revoked" ? "revoked" : binary.reason === "unsafe" ? "unsafe" : "failed" };
			if (binary.bytes.length > OFFICE_LIMITS.input) return { ok: false, reason: "tooLarge" };
			const clean = await this.deps.runtime.rewrite(binary.bytes, job.controller.signal);
			if (!valid()) return { ok: false, reason: "revoked" };
			if (clean.length > OFFICE_LIMITS.input) return { ok: false, reason: "tooLarge" };
			const executable = await this.deps.runtime.detect();
			if (!valid()) return { ok: false, reason: "revoked" };
			if (!executable) return { ok: false, reason: "noLibreOffice" };
			const root = await this.deps.root();
			this.scratchRoot = root;
			directory = join(root, "slides", job.token, String(job.revision));
			const profile = join(root, "lo-profile");
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await mkdir(join(profile, "user"), { recursive: true, mode: 0o700 });
			if (!valid()) return { ok: false, reason: "revoked" };
			const input = join(directory, "input.pptx"), pdfPath = join(directory, "input.pdf");
			await writeFile(input, clean, { mode: 0o600, flag: "wx" });
			watch = setInterval(() => {
				void stat(pdfPath).then(info => { if (info.size > OFFICE_LIMITS.input) { tooLarge = true; job.controller.abort(); } }).catch(() => {});
			}, 250);
			const converted = await this.deps.runtime.convert(executable, input, directory, profile, job.controller.signal);
			if (timedOut) return { ok: false, reason: "timeout" };
			if (tooLarge) return { ok: false, reason: "tooLarge" };
			if (!valid()) return { ok: false, reason: "revoked" };
			if (!converted) return { ok: false, reason: "failed" };
			const file = await open(pdfPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const info = await file.stat();
				if (!info.isFile()) return { ok: false, reason: "failed" };
				if (info.size > OFFICE_LIMITS.input) return { ok: false, reason: "tooLarge" };
				const header = Buffer.alloc(8), trailer = Buffer.alloc(Math.min(info.size, 1024));
				await file.read(header, 0, header.length, 0);
				await file.read(trailer, 0, trailer.length, Math.max(0, info.size - trailer.length));
				if (!header.toString().startsWith("%PDF-") || !/%%EOF\s*$/.test(trailer.toString())) return { ok: false, reason: "failed" };
			} finally { await file.close(); }
			if (!valid()) return { ok: false, reason: "revoked" };
			const previous = this.ready.get(job.token);
			this.ready.set(job.token, { pdfPath, revision: job.revision }); keep = true;
			if (previous) await rm(join(root, "slides", job.token, String(previous.revision)), { recursive: true, force: true }).catch(() => {});
			return { ok: true, pdfPath, revision: job.revision };
		} catch (cause) {
			if (cause instanceof OfficeTeardownError) {
				this.halted = true;
				this.queued?.resolve({ ok: false, reason: "converterUnavailable" }); this.queued = null;
				return { ok: false, reason: "converterUnavailable" };
			}
			return { ok: false, reason: timedOut ? "timeout" : tooLarge ? "tooLarge" : !valid() ? "revoked" : cause instanceof Error && cause.message === "unsafe" ? "unsafe" : "failed" };
		} finally {
			clearTimeout(timer); clearInterval(watch);
			if (directory && !this.halted) {
				if (!keep) await rm(directory, { recursive: true, force: true }).catch(() => {});
				else await rm(join(directory, "input.pptx"), { force: true }).catch(() => {});
			}
		}
	}
}

let service: OfficePreviewService | null = null;
/** Called only by the approved shutdown coordinator, which awaits the bounded close. */
export async function stopPreviewOffice(): Promise<void> {
	await service?.close();
}
export function registerPreviewOffice(): void {
	if (service) return;
	let root: Promise<string> | null = null;
	const getRoot = () => root ??= mkdtemp(join(app.getPath("temp"), "vomp-office-"));
	service = new OfficePreviewService({ root: getRoot, active: hasPreviewGrant, read: readPreviewBinary, runtime: officeRuntime });
	const current = service;
	onPreviewRevoke(token => { void current.revoke(token); });
	handleWithEvent("preview:officeTools", () => current.tools());
	handleWithEvent("preview:slides", (event, token, revision) => current.request(token, revision, event.sender.id));
}
