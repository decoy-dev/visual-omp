import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPlanFile, MADE_SCAN, previewablePath, readBlobImage, readPaneFile, readPdfFile, readWhole, scanMadeFiles } from "./panes";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vomp-panes-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("readPaneFile", () => {
	it("reads UTF-8 text, including multi-byte characters", async () => {
		const file = join(dir, "a.ts");
		await writeFile(file, "const π = '✓';\n");
		expect(await readPaneFile(file)).toEqual({ kind: "text", text: "const π = '✓';\n", size: 18 });
	});

	it("reports binary content instead of decoding it", async () => {
		const file = join(dir, "blob.dat");
		await writeFile(file, Buffer.from([0x48, 0x00, 0xff, 0x10]));
		expect(await readPaneFile(file)).toEqual({ kind: "binary", size: 4 });
	});

	it("returns images as data URLs typed by extension", async () => {
		const file = join(dir, "dot.png");
		await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const result = await readPaneFile(file);
		expect(result).toEqual({ kind: "image", dataUrl: "data:image/png;base64,iVBORw==", size: 4 });
	});

	it("refuses text over the size limit without reading it", async () => {
		const file = join(dir, "big.txt");
		await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
		expect(await readPaneFile(file)).toMatchObject({ kind: "tooLarge", limit: 2 * 1024 * 1024 });
	});

	it("rejects directories", async () => {
		await expect(readPaneFile(dir)).rejects.toThrow("Not a file");
	});
});

describe("readBlobImage", () => {
	const hash = "a".repeat(64);

	it("types extensionless blobs by their leading bytes", async () => {
		await writeFile(join(dir, hash), Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
		expect(await readBlobImage(dir, hash)).toMatch(/^data:image\/webp;base64,/);
	});

	it("returns null for missing blobs and blobs that are not images", async () => {
		expect(await readBlobImage(dir, hash)).toBeNull();
		await writeFile(join(dir, hash), "plain text");
		expect(await readBlobImage(dir, hash)).toBeNull();
	});

	it("rejects ids that are not a sha256 hex digest, so no path can escape the blob folder", async () => {
		await expect(readBlobImage(dir, "../secrets")).rejects.toThrow("Not a blob id");
		await expect(readBlobImage(dir, `${hash}.webp`)).rejects.toThrow("Not a blob id");
	});
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1");

describe("previewablePath", () => {
	it("returns the real path of a PNG or a PDF", async () => {
		await writeFile(join(dir, "poster.png"), PNG);
		await writeFile(join(dir, "flyer.pdf"), PDF);
		expect(await previewablePath(join(dir, "poster.png"))).toBe(await realpath(join(dir, "poster.png")));
		expect(await previewablePath(join(dir, "flyer.pdf"))).toBe(await realpath(join(dir, "flyer.pdf")));
	});

	it("rejects a file whose leading bytes don't match its extension", async () => {
		await writeFile(join(dir, "fake.png"), "#!/bin/sh\necho hi\n");
		await writeFile(join(dir, "fake.pdf"), PNG);
		await writeFile(join(dir, "pdf.png"), PDF);
		for (const name of ["fake.png", "fake.pdf", "pdf.png"]) await expect(previewablePath(join(dir, name))).rejects.toThrow("Not an image or PDF");
	});

	it("rejects SVG, which can carry script when another app opens it", async () => {
		const file = join(dir, "logo.svg");
		await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		await expect(previewablePath(file)).rejects.toThrow("Not an image or PDF");
	});

	it.skipIf(process.platform === "win32")("checks the symlink target, whose extension decides the app that opens it", async () => {
		const target = join(dir, "launch.command");
		await writeFile(target, "#!/bin/sh\necho hi\n");
		await symlink(target, join(dir, "shot.png"));
		await expect(previewablePath(join(dir, "shot.png"))).rejects.toThrow("Not an image or PDF");
		await writeFile(target, PNG);
		await expect(previewablePath(join(dir, "shot.png"))).rejects.toThrow("Not an image or PDF");
	});

	it("rejects directories with an image name", async () => {
		await mkdir(join(dir, "folder.png"));
		await expect(previewablePath(join(dir, "folder.png"))).rejects.toThrow("Not a file");
	});
});

describe("readPdfFile", () => {
	it("returns a PDF's bytes and refuses other files, folders and PDFs over the limit", async () => {
		await writeFile(join(dir, "flyer.pdf"), PDF);
		await writeFile(join(dir, "fake.pdf"), "<html>");
		await mkdir(join(dir, "folder.pdf"));
		expect(Buffer.from(await readPdfFile(join(dir, "flyer.pdf"))).subarray(0, 5).toString()).toBe("%PDF-");
		await expect(readPdfFile(join(dir, "fake.pdf"))).rejects.toThrow("Not a PDF");
		await expect(readPdfFile(join(dir, "folder.pdf"))).rejects.toThrow("Not a file");
		await expect(readPdfFile(join(dir, "flyer.pdf"), 8)).rejects.toThrow("too large");
	});

	it("refuses a file that grew after its size was checked instead of returning it cut short", async () => {
		// A handle whose file is 64 bytes now, although the earlier size check saw 10.
		const grown = Buffer.alloc(64, 0x41);
		const handle = {
			read: async (buffer: Buffer, offset: number, length: number, position: number) => {
				const bytesRead = Math.max(0, Math.min(length, grown.length - position));
				grown.copy(buffer, offset, position, position + bytesRead);
				return { bytesRead, buffer };
			},
		} as unknown as Parameters<typeof readWhole>[0];
		expect(await readWhole(handle, 10)).toBeNull();
		expect(await readWhole(handle, 64)).toEqual(grown);
	});
});

describe("scanMadeFiles", () => {
	const now = Date.now();
	const window = { start: now - 10_000, end: now + 10_000 };
	const past = new Date(now - 3_600_000);
	// Results use the platform's separator; the expectations are written with "/".
	const rel = (files: { path: string }[] = []) => files.map(file => file.path.slice(dir.length + 1).split(sep).join("/"));
	const home = () => join(dir, "home");

	async function put(path: string, data: Buffer | string = PNG): Promise<void> {
		await mkdir(join(dir, path, ".."), { recursive: true });
		await writeFile(join(dir, path), data);
	}

	it("scans a named folder two levels deep for PDFs and images modified while the call ran", async () => {
		await put("out/flyer.pdf", PDF);
		await put("out/old.pdf", PDF);
		await utimes(join(dir, "out/old.pdf"), past, past);
		await put("out/notes.txt", "copy");
		await put("out/icon.svg", "<svg/>");
		await put("out/previews/1.png");
		await put("out/previews/deep/2.png");
		await put("out/.cache/3.png");
		await put("out/node_modules/pkg/4.png");
		const [found] = await scanMadeFiles([{ paths: [join(dir, "out")], ...window }], home());
		expect(rel(found).sort()).toEqual(["out/flyer.pdf", "out/previews/1.png"]);
	});

	it("keeps a file the command named whatever its type, but only when it changed during the call", async () => {
		await put("notes.txt", "copy");
		await put("old.txt", "copy");
		await utimes(join(dir, "old.txt"), past, past);
		const paths = ["notes.txt", "old.txt", "missing.pdf"].map(name => join(dir, name));
		const [found] = await scanMadeFiles([{ paths: [...paths, "relative/x.png"], ...window }], home());
		expect(rel(found)).toEqual(["notes.txt"]);
	});

	it.skipIf(process.platform === "win32")("does not walk symlinked folders, the home folder or the file system root", async () => {
		await put("out/flyer.pdf", PDF);
		await put("home/shot.png");
		await symlink(join(dir, "out"), join(dir, "link"));
		const found = await scanMadeFiles(
			[
				{ paths: [join(dir, "link")], ...window },
				{ paths: [home()], ...window },
				{ paths: ["/"], ...window },
			],
			home(),
		);
		expect(found).toEqual([[], [], []]);
	});

	it("returns at most 40 files per call, newest first, and rejects malformed requests", async () => {
		for (let i = 0; i < 45; i++) {
			await put(`many/${i}.png`);
			const at = new Date(now - 5000 + i * 100);
			await utimes(join(dir, `many/${i}.png`), at, at);
		}
		const [found] = await scanMadeFiles([{ paths: [join(dir, "many")], ...window }], home());
		expect(found).toHaveLength(MADE_SCAN.filesPerQuery);
		expect(rel(found).slice(0, 2)).toEqual(["many/44.png", "many/43.png"]);
		await expect(scanMadeFiles({ paths: [] }, home())).rejects.toThrow("Invalid scan");
		await expect(scanMadeFiles([{ paths: [dir], start: "now", end: 1 }], home())).rejects.toThrow("Invalid scan");
		await expect(scanMadeFiles(Array.from({ length: MADE_SCAN.queries + 1 }, () => ({ paths: [], ...window })), home())).rejects.toThrow("Invalid scan");
	});

	it("reads no more than the entry limit from a folder larger than it, counting its subfolders against the limit too", async () => {
		for (let i = 0; i < 30; i++) await put(`big/${i}.png`);
		await put("big/sub/deep.png");
		const limits = { ...MADE_SCAN, entriesPerDir: 10, filesPerQuery: 100 };
		const [found = []] = await scanMadeFiles([{ paths: [join(dir, "big")], ...window }], home(), limits);
		expect(found.length).toBeLessThanOrEqual(10);
		expect(found.length).toBeGreaterThan(0);
		const [all = []] = await scanMadeFiles([{ paths: [join(dir, "big")], ...window }], home(), { ...limits, entriesPerDir: 100 });
		expect(all).toHaveLength(31);
	});
});

describe("findPlanFile", () => {
	it("returns null when the session has no local folder", async () => {
		expect(await findPlanFile(join(dir, "session.jsonl"))).toBeNull();
	});

	it("picks the newest *plan*.md in <session>/local and ignores other files", async () => {
		const local = join(dir, "session", "local");
		await mkdir(local, { recursive: true });
		await writeFile(join(local, "PLAN.md"), "# old");
		await writeFile(join(local, "checkout-fix-plan.md"), "# new");
		await writeFile(join(local, "notes.md"), "# not a plan");
		const past = new Date(Date.now() - 60_000);
		await utimes(join(local, "PLAN.md"), past, past);
		const plan = await findPlanFile(join(dir, "session.jsonl"));
		expect(plan?.path).toBe(join(local, "checkout-fix-plan.md"));
		expect(plan?.text).toBe("# new");
	});
});
