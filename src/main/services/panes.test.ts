import { mkdtemp, mkdir, open, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobImage, findPlanFile, inspectPaneFile, MADE_SCAN, previewablePath, readPaneFile, readPdfFile, readWhole, scanMadeFiles, svgForImage, svgImagePrefix } from "./panes";

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

describe("inspectPaneFile", () => {
	it.each([["movie.mp4", "video"], ["movie.m4v", "video"], ["movie.mov", "video"], ["movie.webm", "video"], ["song.mp3", "audio"], ["song.m4a", "audio"], ["song.wav", "audio"], ["song.ogg", "audio"], ["poster.png", "image"], ["pages.pdf", "pdf"]])("routes an arbitrarily large %s without returning its bytes", async (name, media) => {
		const path = join(dir, name), file = await open(path, "w");
		await file.truncate(120 * 1024 * 1024);
		await file.close();
		expect(await inspectPaneFile(path)).toEqual({ kind: "media", media, size: 120 * 1024 * 1024 });
	});
	it("returns the start of large text without a partial UTF-8 character", async () => {
		const path = join(dir, "large.txt");
		await writeFile(path, `${"a".repeat(2 * 1024 * 1024 - 1)}π after boundary`);
		const result = await inspectPaneFile(path);
		expect(result).toMatchObject({ kind: "text", text: "a".repeat(2 * 1024 * 1024 - 1), truncated: true });
	});
	it("sniffs a large binary before treating it as text", async () => {
		const path = join(dir, "binary.bin");
		await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1));
		expect(await inspectPaneFile(path)).toEqual({ kind: "binary", size: 2 * 1024 * 1024 + 1 });
	});
	it("rejects a directory with a media extension", async () => {
		const path = join(dir, "folder.mp4");
		await mkdir(path);
		await expect(inspectPaneFile(path)).rejects.toThrow("Not a file");
	});
});

it("repairs an SVG stream prefix without corrupting split UTF-8 or omitting later xlink declarations", () => {
	const original = Buffer.from("<svg viewBox='0 0 1 1'>π</svg>");
	const split = original.indexOf(Buffer.from("π")) + 1;
	const prefix = svgImagePrefix(Buffer.from(original.subarray(0, split)));
	const restored = Buffer.concat([prefix, original.subarray(split)]).toString("utf8");
	expect(restored).toContain('xmlns="http://www.w3.org/2000/svg"');
	expect(restored).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
	expect(restored).toContain("π</svg>");
});

describe("svgForImage", () => {
	const fix = (text: string) => svgForImage(Buffer.from(text)).toString();

	it("adds the SVG namespace a root without one needs to render as an image", async () => {
		expect(fix('<svg viewBox="0 0 4 2"><rect/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 2"><rect/></svg>');
		expect(fix("<svg/>")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
		// The root is found after a BOM, the XML declaration, comments and a doctype with an internal subset.
		const prolog = '\uFEFF<?xml version="1.0"?>\n<!-- made by hand -->\n<!DOCTYPE svg [<!ENTITY a "b">]>\n';
		expect(fix(`${prolog}<svg\n  width="4">`)).toBe(`${prolog}<svg xmlns="http://www.w3.org/2000/svg"\n  width="4">`);
		const file = join(dir, "bare.svg");
		await writeFile(file, "<svg width='1' height='1'/>");
		const result = await readPaneFile(file);
		expect(result.kind === "image" && Buffer.from(result.dataUrl.split(",")[1] ?? "", "base64").toString()).toBe(
			"<svg xmlns=\"http://www.w3.org/2000/svg\" width='1' height='1'/>",
		);
	});

	it("declares xlink only when the file uses it without declaring it", () => {
		expect(fix('<svg><use xlink:href="#a"/></svg>')).toBe(
			'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>',
		);
		const declared = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>';
		expect(fix(declared)).toBe(declared);
	});

	it("leaves files that already declare the namespace, prefixed roots, other roots and non-UTF-8 bytes unchanged", () => {
		const declared = [
			'<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>',
			// A `>` inside a quoted value does not end the start tag, so the declaration after it is found.
			'<svg aria-label="a > b" xmlns="http://www.w3.org/2000/svg"/>',
		];
		for (const text of [...declared, '<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>', "<svgx/>", "<html><svg/></html>"]) {
			expect(fix(text)).toBe(text);
		}
		const latin1 = Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0xe9, 0x2f, 0x3e]);
		expect(svgForImage(latin1)).toBe(latin1);
	});

	it("leaves malformed prologs and start tags unchanged", () => {
		for (const text of [
			'<?xml version="1.0"<svg/>',
			"<!-- never closed <svg/>",
			"<!DOCTYPE svg [ <!ENTITY a 'b'> <svg/>",
			"<!DOCTYPE svg <svg/>",
			'<svg width="1',
			"<svg width=1 <rect/>",
			// A second doctype is not valid XML.
			"<!DOCTYPE svg><!DOCTYPE svg><svg/>",
		]) {
			expect(fix(text)).toBe(text);
		}
	});

	it("skips quoted ids, quoted entity values, comments and processing instructions inside a doctype", () => {
		const xmlns = 'xmlns="http://www.w3.org/2000/svg"';
		const prologs = [
			'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://example.com/a>b[c].dtd">',
			"<!DOCTYPE svg SYSTEM 'odd>[name'>",
			"<!DOCTYPE svg [<!ENTITY a \"x>]y\"><!ENTITY b 'p[q'><!-- ] > ' --><?pi ] > \" ?>]>",
		];
		for (const prolog of prologs) expect(fix(`${prolog}\n<svg/>`)).toBe(`${prolog}\n<svg ${xmlns}/>`);
	});

	it("preserves long whitespace, comments, doctypes and unclosed quotes", () => {
		const inputs = [
			`${" ".repeat(1_000_000)}<html/>`,
			`${" \n<!-- c -->".repeat(100_000)}<html/>`,
			`${"<?pi ?>".repeat(100_000)}<svg${' a="1"'.repeat(100_000)}`,
			`<svg data-x='${" ".repeat(1_000_000)}`,
			`${"<!DOCTYPE svg>".repeat(100_000)}<html/>`,
			`${"<!DOCTYPE svg [".repeat(100_000)}<html/>`,
			`<!DOCTYPE svg [${"<!ENTITY a 'x>]'>".repeat(100_000)}`,
			`<!DOCTYPE svg>${"[".repeat(1_000_000)}<svg/>`,
		];
		for (const text of inputs) expect(fix(text)).toBe(text);
		expect(fix(`${" \n".repeat(500_000)}<svg/>`)).toBe(`${" \n".repeat(500_000)}<svg xmlns="http://www.w3.org/2000/svg"/>`);
	});

	it.each([
		["whitespace", (n: number) => `${" ".repeat(n * 10)}<html/>`],
		["comments", (n: number) => `${" \n<!-- c -->".repeat(n)}<html/>`],
		["processing instructions and attributes", (n: number) => `${"<?pi ?>".repeat(n)}<svg${' a="1"'.repeat(n)}`],
		["an unclosed attribute quote", (n: number) => `<svg data-x='${" ".repeat(n * 10)}`],
		["an unclosed doctype subset", (n: number) => `${"<!DOCTYPE svg [".repeat(n)}<html/>`],
		["quoted doctype entities", (n: number) => `<!DOCTYPE svg [${"<!ENTITY a 'x>]'>".repeat(n)}`],
		["whitespace before a repaired root", (n: number) => `${" \n".repeat(n * 5)}<svg/>`],
	] as const)("scans %s without quadratic rescanning", (name, make) => {
		// Windows reports process CPU in 15.6 ms ticks, so short batches can read as 0.
		// Grow the batch until its small-input median reaches 20 ms, then reuse that
		// count for the large input. Keep each path's 16x input step and 64x ceiling.
		// Allow 20 seconds because repeated CPU samples exceeded the default timeout under load.
		const MIN_SAMPLE_US = 20_000;
		const batch = (data: Buffer<ArrayBuffer>, iterations: number) => {
			const started = process.cpuUsage();
			for (let i = 0; i < iterations; i++) svgForImage(data);
			const elapsed = process.cpuUsage(started);
			return elapsed.user + elapsed.system;
		};
		const cpuTime = (data: Buffer<ArrayBuffer>, iterations: number) =>
			Array.from({ length: 3 }, () => batch(data, iterations)).sort((a, b) => a - b)[1]!;
		const small = Buffer.from(make(128));
		const large = Buffer.from(make(2048));
		// Warm both sizes before measuring.
		for (let i = 0; i < 8; i++) { svgForImage(small); svgForImage(large); }
		let iterations = 1024;
		let baseline = cpuTime(small, iterations);
		while (baseline < MIN_SAMPLE_US && iterations < 1 << 22) {
			iterations *= 2;
			baseline = cpuTime(small, iterations);
		}
		expect(baseline, `SVG ${name}: CPU sample below calibration floor`).toBeGreaterThanOrEqual(MIN_SAMPLE_US);
		const grown = cpuTime(large, iterations);
		// Process CPU excludes worker scheduling delays. Each path must stay
		// below 64x work for 16x input, rather than hiding behind other paths.
		expect(grown, `SVG ${name}: ${baseline}us -> ${grown}us`).toBeLessThan(baseline * 64);
	}, 20_000);
});

describe("blobImage", () => {
	const hash = "a".repeat(64);

	it("types extensionless blobs by their leading bytes", async () => {
		await writeFile(join(dir, hash), Buffer.from("RIFF\0\0\0\0WEBPVP8 "));
		expect(await blobImage(dir, hash)).toEqual({ path: await realpath(join(dir, hash)), mime: "image/webp" });
	});

	it("returns null for missing blobs and blobs that are not images", async () => {
		expect(await blobImage(dir, hash)).toBeNull();
		await writeFile(join(dir, hash), "plain text");
		expect(await blobImage(dir, hash)).toBeNull();
	});

	it("rejects ids that are not a sha256 hex digest, so no path can escape the blob folder", async () => {
		await expect(blobImage(dir, "../secrets")).rejects.toThrow("Not a blob id");
		await expect(blobImage(dir, `${hash}.webp`)).rejects.toThrow("Not a blob id");
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
	const now = Date.UTC(2026, 0, 1, 12);
	const window = { start: now - 10_000, end: now + 10_000 };
	const made = new Date(now);
	const past = new Date(now - 3_600_000);
	// Results use the platform's separator; the expectations are written with "/".
	const rel = (files: { path: string }[] = []) => files.map(file => file.path.slice(dir.length + 1).split(sep).join("/"));
	const home = () => join(dir, "home");

	async function put(path: string, data: Buffer | string = PNG): Promise<void> {
		const file = join(dir, path);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, data);
		// Keep fixture mtimes inside the query window regardless of preceding test duration.
		await utimes(file, made, made);
	}

	it("scans a named folder two levels deep for PDFs, images and SVGs modified while the call ran", async () => {
		await put("out/flyer.pdf", PDF);
		await put("out/old.pdf", PDF);
		await utimes(join(dir, "out/old.pdf"), past, past);
		await put("out/notes.txt", "copy");
		await put("out/icon.svg", "<svg/>");
		await put("out/old.svg", "<svg/>");
		await utimes(join(dir, "out/old.svg"), past, past);
		await put("out/previews/1.png");
		await put("out/previews/deep/2.png");
		await put("out/.cache/3.png");
		await put("out/node_modules/pkg/4.png");
		const [found] = await scanMadeFiles([{ paths: [join(dir, "out")], ...window }], home());
		expect(rel(found).sort()).toEqual(["out/flyer.pdf", "out/icon.svg", "out/previews/1.png"]);
	});

	it("keeps a file the command named whatever its type, but only when it changed during the call", async () => {
		await put("notes.txt", "copy");
		await put("old.txt", "copy");
		await utimes(join(dir, "old.txt"), past, past);
		await put("future.txt", "copy");
		const future = new Date(window.end + MADE_SCAN.slackMs + 1000);
		await utimes(join(dir, "future.txt"), future, future);
		const paths = ["notes.txt", "old.txt", "future.txt", "missing.pdf"].map(name => join(dir, name));
		const [found] = await scanMadeFiles([{ paths: [...paths, "relative/x.png"], ...window }], home());
		expect(rel(found)).toEqual(["notes.txt"]);
	});

	it.skipIf(process.platform !== "darwin")("collapses both macOS path spellings in one scan", async () => {
		await put("out/frames.png");
		const long = await realpath(join(dir, "out/frames.png"));
		const short = long.replace(/^\/private\/(tmp|var|etc)(?=\/|$)/, "/$1");
		expect(short).not.toBe(long);
		const [found] = await scanMadeFiles([{ paths: [short, long], ...window }], home());
		expect(found).toEqual([{ path: long, mtime: now, size: PNG.length }]);
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
