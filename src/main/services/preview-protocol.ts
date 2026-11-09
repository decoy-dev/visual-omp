import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { ReadStream } from "node:fs";
import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { app, protocol } from "electron";
import { PREVIEW_SCHEME, type PreviewGrant, type PreviewGrantRequest, type PreviewBlockedNavigation, type PreviewPrepared, type PreviewPolicy } from "@shared/contracts/preview";
import { handleWithEvent } from "../ipc";
import { blobImage, broadFolders, isBroadFolder, svgImagePrefix } from "./panes";
import { isIsolationTestDocument, type IsolationReadIdentity } from "./preview-isolation-test";
import type { PreviewBinary } from "@shared/contracts/preview";
import { OFFICE_LIMITS, validateOfficeZip } from "@shared/preview-office-zip";
import { markHtmlChange } from "./preview-html-follow";

const TEXT_LIMIT = 2 * 1024 * 1024;
const VIDEO_BUFFER_SIZE = 64 * 1024;
// Four requests allow playback, metadata and overlapping seeks; sixteen bound all preview players together.
const VIDEO_REQUESTS_PER_GRANT = 4;
const VIDEO_REQUESTS_GLOBAL = 16;
const VIDEO_SLOT_WAIT_MS = 1000;
/** Phase 1 policy, evaluated per grant so later permissions do not change unrelated subjects. */
export function previewPolicy(_grant: PreviewPolicy): string {
	return "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' vomp-preview:; img-src vomp-preview: data: blob:; font-src vomp-preview: data:; media-src vomp-preview:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'self'";
}

interface ResponseType { type: string; cap: number; cors: boolean }
const text = (type: string): ResponseType => ({ type, cap: TEXT_LIMIT, cors: false });
const image = (type: string): ResponseType => ({ type, cap: Infinity, cors: true });
const font = (type: string): ResponseType => ({ type, cap: TEXT_LIMIT, cors: true });
const video = (type: string): ResponseType => ({ type, cap: Infinity, cors: false });
const TYPES: Record<string, ResponseType> = {
	".html": text("text/html; charset=utf-8"), ".htm": text("text/html; charset=utf-8"),
	".css": text("text/css; charset=utf-8"), ".svg": image("image/svg+xml"),
	".txt": text("text/plain; charset=utf-8"), ".md": text("text/plain; charset=utf-8"), ".markdown": text("text/plain; charset=utf-8"),
	".mmd": text("text/plain; charset=utf-8"), ".csv": text("text/csv; charset=utf-8"), ".tsv": text("text/tab-separated-values; charset=utf-8"),
	".json": text("application/json"), ".xml": text("application/xml"),
	".png": image("image/png"), ".jpg": image("image/jpeg"), ".jpeg": image("image/jpeg"), ".gif": image("image/gif"),
	".webp": image("image/webp"), ".avif": image("image/avif"), ".bmp": image("image/bmp"), ".ico": image("image/x-icon"), ".apng": image("image/apng"),
	".pdf": { type: "application/pdf", cap: Infinity, cors: false },
	".mp4": video("video/mp4"), ".m4v": video("video/mp4"), ".webm": video("video/webm"), ".mov": video("video/quicktime"),
	".mp3": video("audio/mpeg"), ".m4a": video("audio/mp4"), ".aac": video("audio/aac"),
	".wav": video("audio/wav"), ".ogg": video("audio/ogg"), ".oga": video("audio/ogg"), ".opus": video("audio/ogg"), ".flac": video("audio/flac"),
	".woff": font("font/woff"), ".woff2": font("font/woff2"), ".ttf": font("font/ttf"), ".otf": font("font/otf"), ".eot": text("application/vnd.ms-fontobject"),
};

interface PdfRequest {
	revision: number;
	promise: Promise<PreviewPrepared>;
	resolve(value: PreviewPrepared): void;
}

interface GrantState {
	owner: number | null;
	subject: string;
	base: string;
	root: string | null;
	files: Map<string, string>;
	url: string;
	revision: number;
	live: string | null;
	saved: boolean;
	policy: PreviewPolicy;
	snapshots: Map<number, DocumentSnapshot>;
	streams: Set<ReadStream>;
	videoRequests: number;
	previousHtml?: string;
	subjectType?: ResponseType;
	pdfRevisions: Map<number, PreviewGrant>;
	pdfPreparation?: { request: PdfRequest; abort: AbortController };
	pdfPending?: PdfRequest;
	parentToken?: string;
	privateDirectory?: string;
}
interface DocumentSnapshot {
	body: string | Uint8Array<ArrayBuffer>;
	type: ResponseType;
	isolationTest?: true;
	anchor?: string;
	saved?: boolean;
	readIdentity?: IsolationReadIdentity;
}
type DocumentRead = { ok: true; snapshot: DocumentSnapshot } | { ok: false; status: number };
const grants = new Map<string, GrantState>();
let epoch = 0;
let registered = false;
let videoRequests = 0;
const revokeListeners = new Set<(token: string) => void>();
const streamWaiters = new Set<() => void>();

/** Office conversion cleanup follows the same token lifecycle as protocol streams. */
export function onPreviewRevoke(listener: (token: string) => void): () => void {
	revokeListeners.add(listener);
	return () => { revokeListeners.delete(listener); };
}

export function hasPreviewGrant(token: string, owner: number | null = null): boolean {
	return grants.get(token)?.owner === owner;
}

export async function readPreviewBinary(token: string, owner: number | null = null): Promise<PreviewBinary> {
	const grant = grants.get(token);
	if (!grant || grant.owner !== owner) return { ok: false, reason: "revoked" };
	if (!/\.(?:docx|xlsx|pptx)$/i.test(grant.subject)) return { ok: false, reason: "unsafe" };
	const opened = await openPreviewFile(token, grant, grant.subject, { cap: OFFICE_LIMITS.input, type: "application/zip", cors: false });
	if (!opened.ok) return { ok: false, reason: opened.status === 413 ? "tooLarge" : opened.status === 403 ? "notFile" : "missing" };
	try {
		const before = await opened.file.stat();
		const bytes = new Uint8Array(opened.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const read = await opened.file.read(bytes, length, bytes.length - length, length);
			if (!read.bytesRead) break;
			length += read.bytesRead;
		}
		const after = await opened.file.stat();
		if (grants.get(token) !== grant) return { ok: false, reason: "revoked" };
		if (length !== opened.size || after.size !== opened.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { ok: false, reason: "incomplete" };
		const snapshot = bytes.slice(0, length);
		const checked = validateOfficeZip(snapshot);
		return checked.ok ? { ok: true, bytes: snapshot, size: length, mtimeMs: after.mtimeMs } : checked;
	} catch { return { ok: false, reason: "missing" }; }
	finally { await opened.file.close(); }
}

function inside(root: string, path: string): boolean {
	const from = relative(root, path);
	return from === "" || (!isAbsolute(from) && from !== ".." && !from.startsWith(`..${sep}`));
}

/** Resolves existing ancestors so a file still being written gets the same containment checks. */
async function prospectiveRealpath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return join(await prospectiveRealpath(parent), basename(path));
	}
}

function encodedPath(path: string): string {
	return path.split(sep).map(encodeURIComponent).join("/");
}

export function registerPreviewScheme(): void {
	protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: {
		standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true,
	} }]);
}

export async function grantPreview(request: PreviewGrantRequest, owner: number | null = null): Promise<PreviewGrant> {
	if (!request || typeof request.path !== "string" || !isAbsolute(request.path)
		|| (request.root !== null && (typeof request.root !== "string" || !isAbsolute(request.root)))
		|| (request.fileOnly !== undefined && typeof request.fileOnly !== "boolean")
		|| !Array.isArray(request.related) || !request.related.every(path => typeof path === "string" && isAbsolute(path))) {
		throw new Error("Invalid preview grant.");
	}
	const generation = epoch;
	const subject = await prospectiveRealpath(resolve(request.path));
	const folder = dirname(subject);
	const broad = await broadFolders();
	const candidate = request.root ? await prospectiveRealpath(resolve(request.root)) : null;
	const root = request.fileOnly ? null : candidate && inside(candidate, subject) && !isBroadFolder(candidate, broad) ? candidate
		: !isBroadFolder(folder, broad) ? folder : null;
	const base = root ?? folder;
	const files = new Map<string, string>();
	if (!root && !request.fileOnly) {
		for (const path of request.related) {
			const real = await prospectiveRealpath(resolve(path));
			// Related files outside the subject folder have an absolute-path address, without a drive or leading slash.
			const route = inside(base, real) ? relative(base, real) : real.slice(parse(real).root.length);
			files.set(encodedPath(route), real);
		}
	}
	const documentPath = encodedPath(relative(base, subject));
	files.set(documentPath, subject);
	const token = randomBytes(24).toString("hex");
	const url = `${PREVIEW_SCHEME}://${token}/${documentPath}`;
	if (generation !== epoch) throw new Error("The preview window reloaded.");
	grants.set(token, { owner, subject, base, root, files, url, revision: -1, live: null, saved: false, policy: { scripts: false, network: false }, snapshots: new Map(), streams: new Set(), videoRequests: 0, pdfRevisions: new Map() });
	return { token, url, assetRoot: root !== null };
}

/** Extensionless omp blobs use main's signature check, never a renderer-supplied MIME type. */
export async function grantBlobPreview(blobsDir: string, hash: string, owner: number | null = null): Promise<PreviewGrant | null> {
	const blob = await blobImage(blobsDir, hash);
	if (!blob) return null;
	const grant = await grantPreview({ path: blob.path, root: null, related: [], fileOnly: true }, owner);
	grants.get(grant.token)!.subjectType = image(blob.mime);
	return grant;
}

export function setPreviewLive(token: string, revision: number, text: string, owner: number | null = null): void {
	const grant = grants.get(token);
	if (!grant || grant.owner !== owner || grant.saved) return;
	if (!Number.isSafeInteger(revision) || revision < 0 || typeof text !== "string") throw new Error("Invalid preview revision.");
	if (revision <= grant.revision) return;
	if (Buffer.byteLength(text, "utf8") > TEXT_LIMIT) throw new Error("This preview is too large.");
	grant.revision = revision;
	grant.live = text;
}

export function savePreview(token: string, owner: number | null = null): void {
	const grant = grants.get(token);
	if (grant?.owner === owner) { grant.live = null; grant.saved = true; }
}

export function revokePreview(token: string, owner: number | null = null): void {
	const grant = grants.get(token);
	if (!grant || grant.owner !== owner) return;
	grants.delete(token);
	grant.pdfPreparation?.abort.abort();
	grant.pdfPending?.resolve({ ok: false, reason: "revoked" });
	grant.pdfPending = undefined;
	for (const child of grant.pdfRevisions.values()) revokePreview(child.token, owner);
	if (grant.parentToken) {
		const parent = grants.get(grant.parentToken);
		for (const [revision, child] of parent?.pdfRevisions ?? []) {
			if (child.token === token) parent!.pdfRevisions.delete(revision);
		}
	}
	for (const wake of streamWaiters) wake();
	for (const stream of grant.streams) stream.destroy(new Error("The preview was revoked."));
	for (const listener of revokeListeners) listener(token);
	if (grant.privateDirectory) void rm(grant.privateDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }).catch(error => console.warn("Could not remove a PDF preview revision.", error));
}
export function revokeAllPreviews(): void {
	epoch++;
	for (const [token, grant] of grants) revokePreview(token, grant.owner);
}

function previewAddress(raw: string): { token: string; path: string; segments: string[]; url: URL } | null {
	try {
		// Inspect the unparsed path first, before URL parsing can remove dot segments.
		const match = /^vomp-preview:\/\/([a-f0-9]+)(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(raw);
		if (!match) return null;
		const path = match[2] ?? "/";
		if (/%2f|%5c|\\/i.test(path)) return null;
		const segments = path.slice(1).split("/").map(decodeURIComponent);
		if (segments.some(part => part === "." || part === ".." || part.includes("\0") || part.includes(":") || part.includes("\\") || part.includes("/"))) return null;
		return { token: match[1]!, path: segments.map(encodeURIComponent).join("/"), segments, url: new URL(raw) };
	} catch { return null; }
}

function headers(type?: ResponseType, grant?: GrantState, isolationTest = false): HeadersInit {
	const policy = previewPolicy(grant?.policy ?? { scripts: false, network: false });
	return {
		...(type ? { "Content-Type": type.type } : {}),
		"Content-Security-Policy": isolationTest ? policy.replace("script-src 'none'", "script-src 'unsafe-inline'") : policy,
		"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
		...(type?.cors ? { "Access-Control-Allow-Origin": "*" } : {}),
	};
}
function refused(status: number): Response { return new Response(null, { status, headers: headers() }); }

type OpenedPreview = { ok: true; file: FileHandle; size: number; readIdentity: IsolationReadIdentity } | { ok: false; status: number };

async function pdfReady(file: FileHandle, size: number, complete: boolean): Promise<boolean> {
	const head = Buffer.alloc(8);
	await file.read(head, 0, head.length, 0);
	if (!head.toString("latin1").startsWith("%PDF-")) return false;
	if (!complete) return true;
	const tail = Buffer.alloc(Math.min(size, 1024));
	await file.read(tail, 0, tail.length, Math.max(0, size - tail.length));
	return /%%EOF[\s\0]*$/.test(tail.toString("latin1"));
}

/** Both bounded documents and streamed video validate the opened inode against its current granted path. */
async function openPreviewFile(token: string, grant: GrantState, path: string, type: ResponseType, completePdf = false): Promise<OpenedPreview> {
	let file: FileHandle | undefined;
	try {
		const real = await realpath(path);
		if (grant.root ? !inside(grant.root, real) : real !== path) return { ok: false, status: 403 };
		const info = await stat(real);
		if (!info.isFile()) return { ok: false, status: 403 };
		if (info.size > type.cap) return { ok: false, status: 413 };
		file = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		const opened = await file.stat();
		const checked = await realpath(path);
		const current = await stat(checked);
		if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
			|| (grant.root ? !inside(grant.root, checked) : checked !== path)) return { ok: false, status: 403 };
		if (opened.size > type.cap) return { ok: false, status: 413 };
		if (type.type === "application/pdf" && !await pdfReady(file, opened.size, completePdf)) return { ok: false, status: 409 };
		if (grants.get(token) !== grant) return { ok: false, status: 404 };
		const result: OpenedPreview = { ok: true, file, size: opened.size, readIdentity: { path: checked, dev: opened.dev, ino: opened.ino } };
		file = undefined;
		return result;
	} catch { return { ok: false, status: 404 }; }
	finally { await file?.close(); }
}

/** The same bounded read serves assets and prepares immutable subject revisions. */
async function readPreviewDocument(token: string, grant: GrantState, path: string, type: ResponseType): Promise<DocumentRead> {
	if (path === grant.subject && grant.live !== null) return { ok: true, snapshot: { body: grant.live, type } };
	const result = await openPreviewFile(token, grant, path, type);
	if (!result.ok) return result;
	const { file, size } = result;
	try {
		// One extra byte detects growth without letting a concurrent writer bypass the cap.
		const data = new Uint8Array(size + 1);
		let length = 0;
		while (length < data.length) {
			const { bytesRead } = await file.read(data, length, data.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > size || (await file.stat()).size !== size) return { ok: false, status: 409 };
		if (grants.get(token) !== grant) return { ok: false, status: 404 };
		return { ok: true, snapshot: { body: data.subarray(0, length), type, ...(isIsolationTestDocument(grant.subject, grant.saved) ? { readIdentity: result.readIdentity } : {}) } };
	} catch { return { ok: false, status: 404 }; }
	finally { await file.close(); }
}

/** Open-ended ranges reach EOF: Chromium derives non-HTTP media length from this response's extent. */
function videoRange(range: string, size: number): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
	if (!match || (!match[1] && !match[2]) || size === 0) return null;
	const length = BigInt(size);
	if (!match[1]) {
		const suffix = BigInt(match[2]!);
		return suffix > 0n ? { start: Number(suffix >= length ? 0n : length - suffix), end: size - 1 } : null;
	}
	const start = BigInt(match[1]);
	if (start >= length) return null;
	const end = match[2] ? BigInt(match[2]) : length - 1n;
	if (end < start) return null;
	return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}

async function streamPreviewVideo(request: Request, token: string, grant: GrantState, path: string, type: ResponseType): Promise<Response> {
	request.signal.throwIfAborted();
	let deadline: number | undefined;
	while (grant.videoRequests >= VIDEO_REQUESTS_PER_GRANT || videoRequests >= VIDEO_REQUESTS_GLOBAL) {
		// A seek can replace aborted streams before their descriptors close. Wait without
		// releasing those reservations early; native players get a bounded grace period.
		const nativePlayer = type.type.startsWith("video/") || type.type.startsWith("audio/");
		if (nativePlayer) {
			deadline ??= performance.now() + VIDEO_SLOT_WAIT_MS;
			if (performance.now() >= deadline) return refused(429);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const wake = () => {
			clearTimeout(timeout);
			streamWaiters.delete(wake);
			request.signal.removeEventListener("abort", wake);
			resolve();
		};
		const timeout = deadline === undefined ? undefined : setTimeout(wake, Math.max(0, deadline - performance.now()));
		streamWaiters.add(wake);
		request.signal.addEventListener("abort", wake, { once: true });
		if (request.signal.aborted || grants.get(token) !== grant) wake();
		await promise;
		request.signal.throwIfAborted();
		if (grants.get(token) !== grant) return refused(404);
	}
	// Reserve before any asynchronous path validation or open, including opens still pending on revocation.
	grant.videoRequests++;
	videoRequests++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		grant.videoRequests--;
		videoRequests--;
		for (const wake of streamWaiters) wake();
	};
	let file: FileHandle | undefined;
	let streaming = false;
	try {
		const result = await openPreviewFile(token, grant, path, type);
		if (!result.ok) return refused(result.status);
		file = result.file;
		const { size } = result;
		request.signal.throwIfAborted();
		if (grants.get(token) !== grant) return refused(404);
		const svg = type.type === "image/svg+xml";
		// Namespace repair changes offsets. SVG responses ignore Range and stream a full representation.
		const range = svg ? null : request.headers.get("range");
		const extent = range === null ? { start: 0, end: size - 1 } : videoRange(range, size);
		const responseHeaders = new Headers(headers(type, grant));
		responseHeaders.set("Accept-Ranges", "bytes");
		if (!extent) {
			responseHeaders.set("Content-Range", `bytes */${size}`);
			return new Response(null, { status: 416, headers: responseHeaders });
		}
		responseHeaders.set("Content-Length", String(extent.end - extent.start + 1));
		if (range !== null) responseHeaders.set("Content-Range", `bytes ${extent.start}-${extent.end}/${size}`);
		if (svg) { responseHeaders.delete("Content-Length"); responseHeaders.set("Accept-Ranges", "none"); }
		const init = { status: range === null ? 200 : 206, headers: responseHeaders };
		if (request.method === "HEAD" || size === 0) return new Response(null, init);
		// FileHandle owns the descriptor, so EOF, cancellation and destruction all close the same opened file.
		const stream = file.createReadStream({ ...extent, highWaterMark: VIDEO_BUFFER_SIZE, autoClose: true });
		// Keep the native byte-bounded queue, but reject premature EOF instead of completing a short body.
		const source = (Readable.toWeb(stream, {
			strategy: { highWaterMark: VIDEO_BUFFER_SIZE, size: chunk => chunk.byteLength },
		}) as ReadableStream<Uint8Array>).getReader();
		let received = 0;
		let first = true;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				void source.closed.catch(error => controller.error(error));
			},
			async pull(controller) {
				try {
					const chunk = await source.read();
					if (chunk.done) {
						if (received !== extent.end - extent.start + 1) {
							controller.error(new Error("The preview file ended before its advertised length."));
						} else controller.close();
					} else {
						received += chunk.value.byteLength;
						// Repair only the first 64 KiB chunk, so a pathological XML prolog never accumulates in memory.
						controller.enqueue(svg && first ? svgImagePrefix(Buffer.from(chunk.value)) : chunk.value);
						first = false;
					}
				} catch (error) { controller.error(error); }
			},
			cancel: reason => source.cancel(reason),
		}, { highWaterMark: 0 });
		const abort = () => { stream.destroy(new DOMException("The preview request was aborted.", "AbortError")); };
		grant.streams.add(stream);
		stream.once("close", () => {
			grant.streams.delete(stream);
			request.signal.removeEventListener("abort", abort);
			release();
		});
		request.signal.addEventListener("abort", abort, { once: true });
		const response = new Response(body, init);
		streaming = true;
		return response;
	} finally {
		if (!streaming) {
			try { await file?.close(); } finally { release(); }
		}
	}
}

export async function handlePreviewRequest(request: Request): Promise<Response> {
	const address = previewAddress(request.url);
	if (!address) return refused(403);
	const grant = grants.get(address.token);
	if (!grant) return refused(404);
	if (request.method !== "GET" && request.method !== "HEAD") return refused(405);
	const path = grant.root ? resolve(grant.base, ...address.segments) : grant.files.get(address.path);
	if (!path || (grant.root && !inside(grant.root, path))) return refused(403);
	const type = path === grant.subject && grant.subjectType ? grant.subjectType : TYPES[extname(path).toLowerCase()];
	if (!type) return refused(415);
	if (/^(video\/|audio\/|image\/|application\/pdf$)/.test(type.type)) return streamPreviewVideo(request, address.token, grant, path, type);
	if (path === grant.subject && type.type.startsWith("text/html") && address.url.searchParams.has("rev")) {
		const revision = address.url.searchParams.get("rev")!;
		const snapshot = /^(0|[1-9]\d*)$/.test(revision) ? grant.snapshots.get(Number(revision)) : undefined;
		if (snapshot?.isolationTest && (!snapshot.readIdentity || !isIsolationTestDocument(grant.subject, grant.saved, snapshot.readIdentity))) return refused(403);
		return snapshot ? new Response(request.method === "HEAD" ? null : snapshot.body, { headers: headers(snapshot.type, grant, snapshot.isolationTest) }) : refused(404);
	}
	const result = await readPreviewDocument(address.token, grant, path, type);
	return result.ok ? new Response(request.method === "HEAD" ? null : result.snapshot.body, { headers: headers(result.snapshot.type, grant) }) : refused(result.status);
}

/** Queue only the newest request, and wait for aborted copy cleanup before opening its replacement. */
function preparePdfRevision(token: string, grant: GrantState, revision: number, type: ResponseType): Promise<PreviewPrepared> {
	const existing = grant.pdfRevisions.get(revision);
	if (existing && grants.has(existing.token)) return Promise.resolve({ ok: true, policy: { ...grant.policy }, pdf: existing });
	if (grant.pdfPreparation?.request.revision === revision && !grant.pdfPreparation.abort.signal.aborted) return grant.pdfPreparation.request.promise;
	if (grant.pdfPending?.revision === revision) return grant.pdfPending.promise;
	grant.pdfPending?.resolve({ ok: false, reason: "revoked" });
	const { promise, resolve } = Promise.withResolvers<PreviewPrepared>();
	grant.pdfPending = { revision, promise, resolve };
	grant.pdfPreparation?.abort.abort();
	void runPdfPreparations(token, grant, type);
	return promise;
}

async function runPdfPreparations(token: string, grant: GrantState, type: ResponseType): Promise<void> {
	if (grant.pdfPreparation) return;
	while (grant.pdfPending) {
		const request = grant.pdfPending;
		grant.pdfPending = undefined;
		const job = { request, abort: new AbortController() };
		grant.pdfPreparation = job;
		try {
			request.resolve(await copyPdfRevision(token, grant, request.revision, type, job.abort));
		} catch {
			request.resolve({ ok: false, reason: job.abort.signal.aborted || grants.get(token) !== grant ? "revoked" : "missing" });
		} finally {
			grant.pdfPreparation = undefined;
		}
	}
}

/** Live PDFs need immutable disk revisions so a renderer rollback never rereads the file being overwritten. */
async function copyPdfRevision(token: string, grant: GrantState, revision: number, type: ResponseType, abort: AbortController): Promise<PreviewPrepared> {
	// The shown frame, its predecessor and one candidate may coexist. The renderer revokes obsolete children.
	if (grant.pdfRevisions.size >= 3) return { ok: false, reason: "missing" };
	let source: FileHandle | undefined, target: FileHandle | undefined, directory: string | undefined, retained = false;
	const valid = () => !abort.signal.aborted && grants.get(token) === grant;
	try {
		const opened = await openPreviewFile(token, grant, grant.subject, type, true);
		if (!opened.ok) return { ok: false, reason: opened.status === 403 ? "notFile" : "missing" };
		source = opened.file;
		if (!valid()) return { ok: false, reason: "revoked" };
		const before = await source.stat();
		if (before.size !== opened.size) return { ok: false, reason: "missing" };
		directory = await mkdtemp(join(tmpdir(), "vomp-pdf-revision-"));
		const path = join(directory, "revision.pdf");
		target = await open(path, "wx+", 0o600);
		const buffer = Buffer.allocUnsafe(VIDEO_BUFFER_SIZE);
		for (let position = 0; position < opened.size;) {
			if (!valid()) return { ok: false, reason: "revoked" };
			const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
			if (!bytesRead) return { ok: false, reason: "missing" };
			for (let written = 0; written < bytesRead;) {
				if (!valid()) return { ok: false, reason: "revoked" };
				const { bytesWritten } = await target.write(buffer, written, bytesRead - written, position + written);
				if (!bytesWritten) return { ok: false, reason: "missing" };
				written += bytesWritten;
			}
			position += bytesRead;
		}
		const after = await source.stat(), current = await stat(grant.subject);
		if (!valid()) return { ok: false, reason: "revoked" };
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
			|| current.dev !== before.dev || current.ino !== before.ino
			|| await realpath(grant.subject) !== opened.readIdentity.path
			|| (await target.stat()).size !== opened.size || !await pdfReady(target, opened.size, true)) return { ok: false, reason: "missing" };
		await target.close(); target = undefined;
		const child = await grantPreview({ path, root: null, related: [], fileOnly: true }, grant.owner);
		if (!valid()) { revokePreview(child.token, grant.owner); return { ok: false, reason: "revoked" }; }
		const childState = grants.get(child.token)!;
		childState.privateDirectory = directory;
		childState.parentToken = token;
		grant.pdfRevisions.set(revision, child);
		retained = true;
		return { ok: true, policy: { ...grant.policy }, pdf: child };
	} catch { return { ok: false, reason: valid() ? "missing" : "revoked" }; }
	finally {
		await source?.close();
		await target?.close();
		if (directory && !retained) await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	}
}

/** Keep the latest two exact document revisions, so validation and the iframe load use the same bytes. */
export async function preparePreview(token: string, revision: number, owner: number | null = null, completePdf = false): Promise<PreviewPrepared> {
	const grant = grants.get(token);
	if (!grant || grant.owner !== owner) return { ok: false, reason: "revoked" };
	if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid preview revision.");
	const type = TYPES[extname(grant.subject).toLowerCase()];
	if (type?.type === "application/pdf") {
		if (completePdf) return preparePdfRevision(token, grant, revision, type);
		const result = await openPreviewFile(token, grant, grant.subject, type, completePdf);
		if (!result.ok) return { ok: false, reason: result.status === 403 ? "notFile" : "missing" };
		await result.file.close();
		return grants.get(token) === grant ? { ok: true, policy: { ...grant.policy } } : { ok: false, reason: "revoked" };
	}
	const isolationTest = isIsolationTestDocument(grant.subject, grant.saved);
	const existing = grant.snapshots.get(revision);
	if (existing?.isolationTest && (!isolationTest || !existing.readIdentity || !isIsolationTestDocument(grant.subject, grant.saved, existing.readIdentity))) {
		grant.snapshots.delete(revision);
		return { ok: false, reason: "notFile" };
	}
	if (existing && Boolean(existing.isolationTest) === isolationTest && existing.saved === grant.saved) return { ok: true, policy: { ...grant.policy }, anchor: existing.anchor, ...(existing.isolationTest ? { isolationTest: true } : {}) };
	if (!type?.type.startsWith("text/html")) return { ok: false, reason: "notFile" };
	const result = await readPreviewDocument(token, grant, grant.subject, type);
	if (grants.get(token) !== grant) return { ok: false, reason: "revoked" };
	if (!result.ok) return { ok: false, reason: result.status === 413 ? "tooLarge" : result.status === 403 ? "notFile" : "missing" };
	if (isolationTest) {
		if (!result.snapshot.readIdentity || !isIsolationTestDocument(grant.subject, grant.saved, result.snapshot.readIdentity)) return { ok: false, reason: "notFile" };
		result.snapshot.isolationTest = true;
	}
	result.snapshot.saved = grant.saved;
	if (!isolationTest && grant.live !== null) {
		const marked = markHtmlChange(grant.previousHtml ?? null, grant.live, `vomp-${token}-${revision}`);
		result.snapshot.body = marked.body;
		result.snapshot.anchor = marked.anchor;
		grant.previousHtml = grant.live;
	}
	if (!existing || isolationTest || existing.saved !== grant.saved) grant.snapshots.set(revision, result.snapshot);
	while (grant.snapshots.size > 2) grant.snapshots.delete(Math.min(...grant.snapshots.keys()));
	const prepared = grant.snapshots.get(revision);
	return prepared ? { ok: true, policy: { ...grant.policy }, anchor: prepared.anchor, ...(prepared.isolationTest ? { isolationTest: true } : {}) } : { ok: false, reason: "missing" };
}

/** Returns only a currently granted subject address, never an asset's address. */
export function previewDocumentUrl(url: string): string | null {
	const address = previewAddress(url);
	return address ? grants.get(address.token)?.url ?? null : null;
}

export interface PreviewNavigationInput {
	url: string;
	currentUrl: string;
	isMainFrame: boolean;
	initiatedByMainFrame: boolean;
	documentUrl: string | null;
}

/** Unrelated Preview-pane frames retain their own navigation behavior. Missing initiators fail closed. */
export function previewNavigationRule(input: PreviewNavigationInput): { cancel: boolean; blocked?: PreviewBlockedNavigation } {
	if (input.isMainFrame) return { cancel: false };
	const current = previewAddress(input.currentUrl);
	const target = previewAddress(input.url);
	if (!/^vomp-preview:/i.test(input.currentUrl) && !/^vomp-preview:/i.test(input.url)) return { cancel: false };
	if (input.initiatedByMainFrame && target && input.documentUrl) {
		const document = previewAddress(input.documentUrl);
		if (document && document.token === target.token && document.path === target.path
			&& (!target.url.hash || target.url.searchParams.has("rev"))
			&& [...target.url.searchParams.keys()].every(key => key === "rev")) return { cancel: false };
	}
	const token = current?.token ?? target?.token;
	return { cancel: true, ...(token && /^https?:/i.test(input.url) ? { blocked: { token, url: input.url } } : {}) };
}

export function registerPreviewProtocol(): void {
	if (registered) return;
	registered = true;
	handleWithEvent("preview:grant", (event, request) => grantPreview(request, event.sender.id));
	handleWithEvent("preview:live", (event, token, revision, text) => setPreviewLive(token, revision, text, event.sender.id));
	handleWithEvent("preview:saved", (event, token) => savePreview(token, event.sender.id));
	handleWithEvent("preview:prepare", (event, token, revision, completePdf) => preparePreview(token, revision, event.sender.id, completePdf));
	handleWithEvent("preview:readBinary", (event, token) => readPreviewBinary(token, event.sender.id));
	handleWithEvent("preview:revoke", (event, token) => revokePreview(token, event.sender.id));
	// Feature registration normally runs inside whenReady; this also keeps isolated registrations safe.
	if (app.isReady()) protocol.handle(PREVIEW_SCHEME, handlePreviewRequest);
	else void app.whenReady().then(() => protocol.handle(PREVIEW_SCHEME, handlePreviewRequest));
}
