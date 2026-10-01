/** File reads for the Files viewer and Outputs pane, and plan-file lookup for the Plan pane (pure fs, no Electron). */
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { PaneFileContent, PanePlanFile } from "@shared/contracts/panes";

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

/** Passive raster type from a file's leading bytes; null for anything else (SVG included, since it can carry script). */
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

/** Extensions the OS opens in an image viewer; the extension picks the app, so it is checked as well as the bytes. */
const RASTER_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;

/**
 * The real path of an image that is safe to hand to the default app: symlinks resolved, a regular file, a raster
 * extension, and leading bytes of a passive raster format. Throws otherwise.
 */
export async function openableImagePath(path: string): Promise<string> {
	const real = await realpath(path);
	if (!(await stat(real)).isFile()) throw new Error("Not a file");
	if (!RASTER_EXT.test(real) || !imageType(await sniff(real, 16))) throw new Error("Not an image");
	return real;
}

/** A blob-store image as a data URL; null when the blob is missing, over the image cap, or not an image. */
export async function readBlobImage(blobsDir: string, hash: string): Promise<string | null> {
	if (!BLOB_HASH.test(hash)) throw new Error("Not a blob id");
	const path = join(blobsDir, hash);
	const info = await stat(path).catch(() => null);
	if (!info?.isFile() || info.size > IMAGE_LIMIT) return null;
	const data = await readFile(path);
	const mime = imageType(data);
	return mime ? `data:${mime};base64,${data.toString("base64")}` : null;
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
