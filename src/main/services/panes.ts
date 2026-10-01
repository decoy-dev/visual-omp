/** File reads for the Files viewer and Outputs pane, and plan-file lookup for the Plan pane (pure fs, no Electron). */
import { type FileHandle, lstat, open, opendir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, parse, resolve } from "node:path";
import type { PaneFileContent, PaneMadeFile, PaneMadeQuery, PanePlanFile } from "@shared/contracts/panes";

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
/** Bytes sniffed for NUL / invalid UTF-8 to tell text from binary. */
const SNIFF_BYTES = 8192;

const IMAGE_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

function looksBinary(bytes: Uint8Array): boolean {
	if (bytes.includes(0)) return true;
	try {
		// `stream: true` tolerates a multi-byte character cut at the sniff boundary.
		new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
		return false;
	} catch {
		return true;
	}
}

async function sniff(path: string, size: number): Promise<Uint8Array> {
	const file = await open(path, "r");
	try {
		const buffer = new Uint8Array(Math.min(size, SNIFF_BYTES));
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}

export async function readPaneFile(path: string): Promise<PaneFileContent> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error("Not a file");
	const size = info.size;
	const mime = IMAGE_TYPES[extname(path).toLowerCase()];
	if (mime) {
		if (size > IMAGE_LIMIT) return { kind: "tooLarge", size, limit: IMAGE_LIMIT };
		const data = await readFile(path);
		return { kind: "image", dataUrl: `data:${mime};base64,${data.toString("base64")}`, size };
	}
	if (size > TEXT_LIMIT) return { kind: "tooLarge", size, limit: TEXT_LIMIT };
	if (looksBinary(await sniff(path, size))) return { kind: "binary", size };
	const data = await readFile(path);
	try {
		return { kind: "text", text: utf8.decode(data), size };
	} catch {
		return { kind: "binary", size };
	}
}

/** omp's blob ids: saved sessions store image data as `blob:sha256:<hash>`, kept in `<agentDir>/blobs/<hash>`. */
const BLOB_HASH = /^[0-9a-f]{64}$/;

/** Raster type from a file's leading bytes; null for anything else (SVG included, since it can carry script). */
function imageType(bytes: Uint8Array): string | null {
	const ascii = (start: number, text: string) => [...text].every((char, i) => bytes[start + i] === char.charCodeAt(0));
	if (bytes[0] === 0x89 && ascii(1, "PNG")) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (ascii(0, "GIF8")) return "image/gif";
	if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
	if (ascii(4, "ftypavif") || ascii(4, "ftypavis")) return "image/avif";
	if (ascii(0, "BM")) return "image/bmp";
	if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
	return null;
}

/** Raster extensions main lets the OS open or thumbnail; the extension picks the app, so it is checked as well as the bytes. */
const RASTER_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const PDF_EXT = /\.pdf$/i;
const PDF_MAGIC = "%PDF-";

function isPdf(bytes: Uint8Array): boolean {
	return Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1") === PDF_MAGIC;
}

/** The first `count` bytes of an open file, or fewer when it is shorter. */
async function readHead(file: Pick<FileHandle, "read">, count: number): Promise<Buffer<ArrayBuffer>> {
	const buffer = Buffer.alloc(count);
	let total = 0;
	while (total < buffer.length) {
		const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
		if (bytesRead === 0) break;
		total += bytesRead;
	}
	return buffer.subarray(0, total);
}

/**
 * An open file's whole content, given the `size` its handle reported. It reads one byte past `size`, so a file that
 * grew after that check (and may now be over the caller's cap) yields null instead of content cut short.
 */
export async function readWhole(file: Pick<FileHandle, "read">, size: number): Promise<Buffer<ArrayBuffer> | null> {
	const data = await readHead(file, size + 1);
	return data.length > size ? null : data;
}

/** Opens a path for reading; a folder (which Windows refuses to open) reports "Not a file", as the handle check does elsewhere. */
async function openForRead(path: string): Promise<FileHandle> {
	try {
		return await open(path, "r");
	} catch (error) {
		if ((await stat(path).catch(() => null))?.isDirectory()) throw new Error("Not a file");
		throw error;
	}
}

/**
 * The real path of a file main may hand to the OS (default app or thumbnailer). Symlinks are resolved and the target,
 * opened once, must be a regular file whose leading bytes match its extension: a raster extension (PNG, JPEG, GIF,
 * WebP, AVIF, BMP, ICO) with the leading bytes of any of those formats (the two need not be the same format), or
 * `.pdf` with `%PDF-`. SVG is never allowed. Throws otherwise. The OS reopens the path afterwards.
 */
export async function previewablePath(path: string): Promise<string> {
	const real = await realpath(path);
	const file = await openForRead(real);
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Not a file");
		const bytes = await readHead(file, 16);
		const ok = PDF_EXT.test(real) ? isPdf(bytes) : RASTER_EXT.test(real) && imageType(bytes) !== null;
		if (!ok) throw new Error("Not an image or PDF");
		return real;
	} finally {
		await file.close();
	}
}

export const PDF_LIMIT = 64 * 1024 * 1024;

/**
 * A PDF's bytes for the in-pane viewer, read through one handle: a regular file (symlinks followed) of at most
 * `limit` bytes whose leading bytes are `%PDF-`.
 */
export async function readPdfFile(path: string, limit = PDF_LIMIT): Promise<Uint8Array<ArrayBuffer>> {
	const tooLarge = () => new Error("This PDF is too large to show here");
	const file = await openForRead(path);
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("Not a file");
		if (info.size > limit) throw tooLarge();
		const data = await readWhole(file, info.size);
		if (!data) throw new Error("This PDF changed while it was being read");
		if (!isPdf(data)) throw new Error("Not a PDF");
		return data;
	} finally {
		await file.close();
	}
}

/** A blob-store image as a data URL; null when the blob is missing, over the image cap, or not an image. */
export async function readBlobImage(blobsDir: string, hash: string): Promise<string | null> {
	if (!BLOB_HASH.test(hash)) throw new Error("Not a blob id");
	const file = await open(join(blobsDir, hash), "r").catch(() => null);
	if (!file) return null;
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > IMAGE_LIMIT) return null;
		const data = await readWhole(file, info.size);
		const mime = data ? imageType(data) : null;
		return mime && data ? `data:${mime};base64,${data.toString("base64")}` : null;
	} finally {
		await file.close();
	}
}

export interface MadeScanLimits {
	queries: number;
	pathsPerQuery: number;
	/** Entries read from each folder; the rest are never read. */
	entriesPerDir: number;
	/** Folder reads per query (the named folders and their subfolders). */
	dirsPerQuery: number;
	filesPerQuery: number;
	/** Clock slack on both ends of a call's window. */
	slackMs: number;
}

/** Hard limits for {@link scanMadeFiles}, so a command that names `/` or a huge folder stays cheap. */
export const MADE_SCAN: Readonly<MadeScanLimits> = {
	queries: 128,
	pathsPerQuery: 32,
	entriesPerDir: 500,
	dirsPerQuery: 48,
	filesPerQuery: 40,
	slackMs: 2000,
};

/** What a folder scan keeps: deliverables the pane can preview. Files a command names directly are kept whatever their type. */
const PREVIEW_EXT = /\.(pdf|png|jpe?g|gif|webp|avif|bmp|ico)$/i;

/** Folders too broad to scan: the file system root and its direct children, plus `extra` (home and temp folders). */
function isBroadFolder(real: string, extra: ReadonlySet<string>): boolean {
	const parts = real.slice(parse(real).root.length).split(/[\\/]/).filter(Boolean);
	// macOS keeps /tmp and /var under /private.
	if (process.platform === "darwin" && parts[0] === "private") parts.shift();
	return parts.length < 2 || extra.has(real);
}

function isQuery(value: unknown): value is PaneMadeQuery {
	if (typeof value !== "object" || value === null) return false;
	const { paths, start, end } = value as Record<string, unknown>;
	return Array.isArray(paths) && Number.isFinite(start) && Number.isFinite(end);
}

/**
 * Files a command made, for the Outputs pane. Best effort: for each query (one finished tool call), every absolute
 * path it names is checked; a regular file modified inside the call's window `[start, end]` (plus slack) is kept,
 * and a folder is scanned two levels deep for PDFs and raster images modified inside the window. Dot folders,
 * `node_modules`, symlinked folders and folders that are too broad are not scanned. Results are newest first and keep
 * the path as the command named it. `limits` is a test seam.
 */
export async function scanMadeFiles(queries: unknown, home: string, limits: Readonly<MadeScanLimits> = MADE_SCAN): Promise<PaneMadeFile[][]> {
	if (!Array.isArray(queries) || queries.length > limits.queries || !queries.every(isQuery)) throw new Error("Invalid scan");
	const broad = new Set(await Promise.all([home, tmpdir()].map(dir => realpath(dir).catch(() => resolve(dir)))));
	const results: PaneMadeFile[][] = [];
	for (const query of queries) results.push(await scanQuery(query, broad, limits));
	return results;
}

async function scanQuery(query: PaneMadeQuery, broad: ReadonlySet<string>, limits: Readonly<MadeScanLimits>): Promise<PaneMadeFile[]> {
	const from = query.start - limits.slackMs;
	const to = query.end + limits.slackMs;
	const found = new Map<string, PaneMadeFile>();
	let dirReads = 0;
	const keep = (path: string, info: { mtimeMs: number; size: number }) => {
		if (info.mtimeMs >= from && info.mtimeMs <= to) found.set(path, { path, mtime: info.mtimeMs, size: info.size });
	};
	/** Reads at most `entriesPerDir` entries without loading the rest of the folder, then walks its subfolders. */
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (dirReads >= limits.dirsPerQuery) return;
		dirReads++;
		const handle = await opendir(dir).catch(() => null);
		if (!handle) return;
		const files: string[] = [];
		const folders: string[] = [];
		try {
			for (let read = 0; read < limits.entriesPerDir; read++) {
				const entry = await handle.read();
				if (!entry) break;
				if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
				// Dirent types come from lstat, so symlinks are neither files nor folders here and are skipped.
				if (entry.isFile() && PREVIEW_EXT.test(entry.name)) files.push(join(dir, entry.name));
				else if (entry.isDirectory() && depth < 2) folders.push(join(dir, entry.name));
			}
		} finally {
			await handle.close().catch(() => {});
		}
		for (const path of files) {
			const info = await stat(path).catch(() => null);
			if (info?.isFile()) keep(path, info);
		}
		for (const path of folders) await walk(path, depth + 1);
	};
	for (const raw of query.paths.slice(0, limits.pathsPerQuery)) {
		if (typeof raw !== "string" || !isAbsolute(raw)) continue;
		const path = resolve(raw);
		const link = await lstat(path).catch(() => null);
		const info = link?.isSymbolicLink() ? await stat(path).catch(() => null) : link;
		if (!link || !info) continue;
		if (info.isFile()) keep(path, info);
		else if (info.isDirectory() && !link.isSymbolicLink() && !isBroadFolder(await realpath(path).catch(() => path), broad)) await walk(path, 1);
	}
	return [...found.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limits.filesPerQuery);
}

const PLAN_FILE = /.*plan.*\.md$/i;

export async function findPlanFile(sessionFile: string): Promise<PanePlanFile | null> {
	const dir = join(sessionFile.replace(/\.jsonl$/, ""), "local");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	let newest: { path: string; mtime: number } | null = null;
	for (const name of names) {
		if (!PLAN_FILE.test(name)) continue;
		const path = join(dir, name);
		const info = await stat(path).catch(() => null);
		if (info?.isFile() && (!newest || info.mtimeMs > newest.mtime)) newest = { path, mtime: info.mtimeMs };
	}
	if (!newest) return null;
	const text = await readFile(newest.path, "utf8").catch(() => null);
	return text === null ? null : { ...newest, text };
}
