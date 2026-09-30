/** File reads for the Files viewer and plan-file lookup for the Plan pane (pure fs, no Electron). */
import { open, readdir, readFile, stat } from "node:fs/promises";
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
