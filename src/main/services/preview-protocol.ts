import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { ReadStream } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { app, protocol } from "electron";
import { PREVIEW_SCHEME, type PreviewGrant, type PreviewGrantRequest, type PreviewBlockedNavigation, type PreviewPrepared, type PreviewPolicy } from "@shared/contracts/preview";
import { handleWithEvent } from "../ipc";
import { broadFolders, isBroadFolder } from "./panes";
import { isIsolationTestDocument, type IsolationReadIdentity } from "./preview-isolation-test";

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const PDF_LIMIT = 32 * 1024 * 1024;
const VIDEO_RANGE_LIMIT = 8 * 1024 * 1024;
const VIDEO_BUFFER_SIZE = 64 * 1024;
// Four requests allow playback, metadata and overlapping seeks; sixteen bound all preview players together.
const VIDEO_REQUESTS_PER_GRANT = 4;
const VIDEO_REQUESTS_GLOBAL = 16;
/** Phase 1 policy, evaluated per grant so later permissions do not change unrelated subjects. */
export function previewPolicy(_grant: PreviewPolicy): string {
	return "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' vomp-preview:; img-src vomp-preview: data: blob:; font-src vomp-preview: data:; media-src vomp-preview:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'self'";
}

interface ResponseType { type: string; cap: number; cors: boolean }
const text = (type: string): ResponseType => ({ type, cap: TEXT_LIMIT, cors: false });
const image = (type: string): ResponseType => ({ type, cap: IMAGE_LIMIT, cors: false });
const font = (type: string): ResponseType => ({ type, cap: TEXT_LIMIT, cors: true });
const video = (type: string): ResponseType => ({ type, cap: Infinity, cors: false });
const TYPES: Record<string, ResponseType> = {
	".html": text("text/html; charset=utf-8"), ".htm": text("text/html; charset=utf-8"),
	".css": text("text/css; charset=utf-8"), ".svg": text("image/svg+xml"),
	".txt": text("text/plain; charset=utf-8"), ".md": text("text/plain; charset=utf-8"), ".markdown": text("text/plain; charset=utf-8"),
	".mmd": text("text/plain; charset=utf-8"), ".csv": text("text/csv; charset=utf-8"), ".tsv": text("text/tab-separated-values; charset=utf-8"),
	".json": text("application/json"), ".xml": text("application/xml"),
	".png": image("image/png"), ".jpg": image("image/jpeg"), ".jpeg": image("image/jpeg"), ".gif": image("image/gif"),
	".webp": image("image/webp"), ".avif": image("image/avif"), ".bmp": image("image/bmp"), ".ico": image("image/x-icon"), ".apng": image("image/apng"),
	".pdf": { type: "application/pdf", cap: PDF_LIMIT, cors: false },
	".mp4": video("video/mp4"), ".m4v": video("video/mp4"), ".webm": video("video/webm"), ".mov": video("video/quicktime"),
	".woff": font("font/woff"), ".woff2": font("font/woff2"), ".ttf": font("font/ttf"), ".otf": font("font/otf"), ".eot": text("application/vnd.ms-fontobject"),
};

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
}
interface DocumentSnapshot {
	body: string | Uint8Array<ArrayBuffer>;
	type: ResponseType;
	isolationTest?: true;
	readIdentity?: IsolationReadIdentity;
}
type DocumentRead = { ok: true; snapshot: DocumentSnapshot } | { ok: false; status: number };
const grants = new Map<string, GrantState>();
let epoch = 0;
let registered = false;
let videoRequests = 0;

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
		|| !Array.isArray(request.related) || !request.related.every(path => typeof path === "string" && isAbsolute(path))) {
		throw new Error("Invalid preview grant.");
	}
	const generation = epoch;
	const subject = await prospectiveRealpath(resolve(request.path));
	const folder = dirname(subject);
	const broad = await broadFolders();
	const candidate = request.root ? await prospectiveRealpath(resolve(request.root)) : null;
	const root = candidate && inside(candidate, subject) && !isBroadFolder(candidate, broad) ? candidate
		: !isBroadFolder(folder, broad) ? folder : null;
	const base = root ?? folder;
	const files = new Map<string, string>();
	if (!root) {
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
	grants.set(token, { owner, subject, base, root, files, url, revision: -1, live: null, saved: false, policy: { scripts: false, network: false }, snapshots: new Map(), streams: new Set(), videoRequests: 0 });
	return { token, url, assetRoot: root !== null };
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
	for (const stream of grant.streams) stream.destroy(new Error("The preview was revoked."));
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

/** Both bounded documents and streamed video validate the opened inode against its current granted path. */
async function openPreviewFile(token: string, grant: GrantState, path: string, type: ResponseType): Promise<OpenedPreview> {
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

/** Only an open-ended range has a response cap. Explicit and suffix ranges retain their requested extent. */
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
	const end = match[2] ? BigInt(match[2]) : start + BigInt(VIDEO_RANGE_LIMIT) - 1n;
	if (end < start) return null;
	return { start: Number(start), end: Number(end >= length ? length - 1n : end) };
}

async function streamPreviewVideo(request: Request, token: string, grant: GrantState, path: string, type: ResponseType): Promise<Response> {
	request.signal.throwIfAborted();
	if (grant.videoRequests >= VIDEO_REQUESTS_PER_GRANT || videoRequests >= VIDEO_REQUESTS_GLOBAL) return refused(429);
	// Reserve before any asynchronous path validation or open, including opens still pending on revocation.
	grant.videoRequests++;
	videoRequests++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		grant.videoRequests--;
		videoRequests--;
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
		const range = request.headers.get("range");
		const extent = range === null ? { start: 0, end: size - 1 } : videoRange(range, size);
		const responseHeaders = new Headers(headers(type, grant));
		responseHeaders.set("Accept-Ranges", "bytes");
		if (!extent) {
			responseHeaders.set("Content-Range", `bytes */${size}`);
			return new Response(null, { status: 416, headers: responseHeaders });
		}
		responseHeaders.set("Content-Length", String(extent.end - extent.start + 1));
		if (range !== null) responseHeaders.set("Content-Range", `bytes ${extent.start}-${extent.end}/${size}`);
		const init = { status: range === null ? 200 : 206, headers: responseHeaders };
		if (request.method === "HEAD" || size === 0) return new Response(null, init);
		// FileHandle owns the descriptor, so EOF, cancellation and destruction all close the same opened file.
		const stream = file.createReadStream({ ...extent, highWaterMark: VIDEO_BUFFER_SIZE, autoClose: true });
		// Keep the native byte-bounded queue, but reject premature EOF instead of completing a short body.
		const source = (Readable.toWeb(stream, {
			strategy: { highWaterMark: VIDEO_BUFFER_SIZE, size: chunk => chunk.byteLength },
		}) as ReadableStream<Uint8Array>).getReader();
		let received = 0;
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
						controller.enqueue(chunk.value);
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
	const type = TYPES[extname(path).toLowerCase()];
	if (!type) return refused(415);
	if (type.type.startsWith("video/")) return streamPreviewVideo(request, address.token, grant, path, type);
	if (path === grant.subject && type.type.startsWith("text/html") && address.url.searchParams.has("rev")) {
		const revision = address.url.searchParams.get("rev")!;
		const snapshot = /^(0|[1-9]\d*)$/.test(revision) ? grant.snapshots.get(Number(revision)) : undefined;
		if (snapshot?.isolationTest && (!snapshot.readIdentity || !isIsolationTestDocument(grant.subject, grant.saved, snapshot.readIdentity))) return refused(403);
		return snapshot ? new Response(request.method === "HEAD" ? null : snapshot.body, { headers: headers(snapshot.type, grant, snapshot.isolationTest) }) : refused(404);
	}
	const result = await readPreviewDocument(address.token, grant, path, type);
	return result.ok ? new Response(request.method === "HEAD" ? null : result.snapshot.body, { headers: headers(result.snapshot.type, grant) }) : refused(result.status);
}

/** Keep the latest two exact document revisions, so validation and the iframe load use the same bytes. */
export async function preparePreview(token: string, revision: number, owner: number | null = null): Promise<PreviewPrepared> {
	const grant = grants.get(token);
	if (!grant || grant.owner !== owner) return { ok: false, reason: "revoked" };
	if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid preview revision.");
	const isolationTest = isIsolationTestDocument(grant.subject, grant.saved);
	const existing = grant.snapshots.get(revision);
	if (existing?.isolationTest && (!isolationTest || !existing.readIdentity || !isIsolationTestDocument(grant.subject, grant.saved, existing.readIdentity))) {
		grant.snapshots.delete(revision);
		return { ok: false, reason: "notFile" };
	}
	if (existing && Boolean(existing.isolationTest) === isolationTest) return { ok: true, policy: { ...grant.policy }, ...(existing.isolationTest ? { isolationTest: true } : {}) };
	const type = TYPES[extname(grant.subject).toLowerCase()];
	if (!type?.type.startsWith("text/html")) return { ok: false, reason: "notFile" };
	const result = await readPreviewDocument(token, grant, grant.subject, type);
	if (grants.get(token) !== grant) return { ok: false, reason: "revoked" };
	if (!result.ok) return { ok: false, reason: result.status === 413 ? "tooLarge" : result.status === 403 ? "notFile" : "missing" };
	if (isolationTest) {
		if (!result.snapshot.readIdentity || !isIsolationTestDocument(grant.subject, grant.saved, result.snapshot.readIdentity)) return { ok: false, reason: "notFile" };
		result.snapshot.isolationTest = true;
	}
	if (!existing || isolationTest) grant.snapshots.set(revision, result.snapshot);
	while (grant.snapshots.size > 2) grant.snapshots.delete(Math.min(...grant.snapshots.keys()));
	const prepared = grant.snapshots.get(revision);
	return prepared ? { ok: true, policy: { ...grant.policy }, ...(prepared.isolationTest ? { isolationTest: true } : {}) } : { ok: false, reason: "missing" };
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
		if (document && document.token === target.token && document.path === target.path && !target.url.hash
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
	handleWithEvent("preview:prepare", (event, token, revision) => preparePreview(token, revision, event.sender.id));
	handleWithEvent("preview:revoke", (event, token) => revokePreview(token, event.sender.id));
	// Feature registration normally runs inside whenReady; this also keeps isolated registrations safe.
	if (app.isReady()) protocol.handle(PREVIEW_SCHEME, handlePreviewRequest);
	else void app.whenReady().then(() => protocol.handle(PREVIEW_SCHEME, handlePreviewRequest));
}
