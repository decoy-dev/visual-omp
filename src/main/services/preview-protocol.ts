import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { app, protocol } from "electron";
import { PREVIEW_SCHEME, type PreviewGrant, type PreviewGrantRequest, type PreviewBlockedNavigation, type PreviewPrepared } from "@shared/contracts/preview";
import { handleWithEvent } from "../ipc";
import { broadFolders, isBroadFolder } from "./panes";

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const PDF_LIMIT = 32 * 1024 * 1024;
export const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' vomp-preview:; img-src vomp-preview: data: blob:; font-src vomp-preview: data:; media-src vomp-preview:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'self'";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".markdown": "text/plain; charset=utf-8",
	".mmd": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
	".json": "application/json", ".xml": "application/xml",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon", ".apng": "image/apng",
	".pdf": "application/pdf", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
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
	snapshots: Map<number, DocumentSnapshot>;
}
interface DocumentSnapshot {
	body: string | Uint8Array<ArrayBuffer>;
	type: string;
}
type DocumentRead = { ok: true; snapshot: DocumentSnapshot } | { ok: false; status: number };
const grants = new Map<string, GrantState>();
let epoch = 0;
let registered = false;

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
	grants.set(token, { owner, subject, base, root, files, url, revision: -1, live: null, saved: false, snapshots: new Map() });
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
	if (grants.get(token)?.owner === owner) grants.delete(token);
}
export function revokeAllPreviews(): void { epoch++; grants.clear(); }

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

function headers(type?: string): HeadersInit {
	return {
		...(type ? { "Content-Type": type } : {}),
		"Content-Security-Policy": PREVIEW_CSP,
		"X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
		...(type?.startsWith("font/") ? { "Access-Control-Allow-Origin": "*" } : {}),
	};
}
function refused(status: number): Response { return new Response(null, { status, headers: headers() }); }
function cap(type: string): number {
	return type === "application/pdf" ? PDF_LIMIT : type.startsWith("image/") && type !== "image/svg+xml" ? IMAGE_LIMIT : TEXT_LIMIT;
}

/** The same bounded read serves assets and prepares immutable subject revisions. */
async function readPreviewDocument(token: string, grant: GrantState, path: string, type: string): Promise<DocumentRead> {
	if (path === grant.subject && grant.live !== null) return { ok: true, snapshot: { body: grant.live, type } };
	try {
		const real = await realpath(path);
		if (grant.root ? !inside(grant.root, real) : real !== path) return { ok: false, status: 403 };
		const info = await stat(real);
		if (!info.isFile()) return { ok: false, status: 403 };
		const limit = cap(type);
		if (info.size > limit) return { ok: false, status: 413 };
		const file = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		try {
			const opened = await file.stat();
			const checked = await realpath(path);
			const current = await stat(checked);
			if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino
				|| (grant.root ? !inside(grant.root, checked) : checked !== path)) return { ok: false, status: 403 };
			if (opened.size > limit) return { ok: false, status: 413 };
			// One extra byte detects growth without letting a concurrent writer bypass the cap.
			const data = new Uint8Array(opened.size + 1);
			let length = 0;
			while (length < data.length) {
				const { bytesRead } = await file.read(data, length, data.length - length, length);
				if (!bytesRead) break;
				length += bytesRead;
			}
			if (length > opened.size || (await file.stat()).size !== opened.size) return { ok: false, status: 409 };
			if (grants.get(token) !== grant) return { ok: false, status: 404 };
			return { ok: true, snapshot: { body: data.subarray(0, length), type } };
		} finally { await file.close(); }
	} catch { return { ok: false, status: 404 }; }
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
	if (path === grant.subject && type.startsWith("text/html") && address.url.searchParams.has("rev")) {
		const revision = address.url.searchParams.get("rev")!;
		const snapshot = /^(0|[1-9]\d*)$/.test(revision) ? grant.snapshots.get(Number(revision)) : undefined;
		return snapshot ? new Response(request.method === "HEAD" ? null : snapshot.body, { headers: headers(snapshot.type) }) : refused(404);
	}
	const result = await readPreviewDocument(address.token, grant, path, type);
	return result.ok ? new Response(request.method === "HEAD" ? null : result.snapshot.body, { headers: headers(result.snapshot.type) }) : refused(result.status);
}

/** Keep the latest two exact document revisions, so validation and the iframe load use the same bytes. */
export async function preparePreview(token: string, revision: number, owner: number | null = null): Promise<PreviewPrepared> {
	const grant = grants.get(token);
	if (!grant || grant.owner !== owner) return { ok: false, reason: "revoked" };
	if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid preview revision.");
	if (grant.snapshots.has(revision)) return { ok: true };
	const type = TYPES[extname(grant.subject).toLowerCase()];
	if (!type?.startsWith("text/html")) return { ok: false, reason: "notFile" };
	const result = await readPreviewDocument(token, grant, grant.subject, type);
	if (grants.get(token) !== grant) return { ok: false, reason: "revoked" };
	if (!result.ok) return { ok: false, reason: result.status === 413 ? "tooLarge" : result.status === 403 ? "notFile" : "missing" };
	if (!grant.snapshots.has(revision)) grant.snapshots.set(revision, result.snapshot);
	while (grant.snapshots.size > 2) grant.snapshots.delete(Math.min(...grant.snapshots.keys()));
	return grant.snapshots.has(revision) ? { ok: true } : { ok: false, reason: "missing" };
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
